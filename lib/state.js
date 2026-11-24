// All state changes live here as plain functions on a state object, so they can be
// tested in Node. background.js loads state, calls a handler, then saves it.
import { newCard, rate, selectDue, countDue, nextDueAfterToday, cramOrder, localDayKey } from "./srs.js";
import { DAILY_CAP } from "./config.js";

export const DEFAULT_SETTINGS = { focusMode: false, dailyCap: DAILY_CAP };
const COMPLETE_AT = 0.9;
const MIN_SESSION_SEC = 30;

export function normalize(raw = {}) {
  return {
    userId: raw.userId || null,
    courses: raw.courses || {},
    progress: raw.progress || {},
    cards: raw.cards || {},
    events: raw.events || [],
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
  };
}

export function logEvent(s, ctx, event, fields = {}) {
  s.events.push({
    user_id: s.userId, ts: new Date(ctx.now).toISOString(), event,
    course_id: "", video_id: "", card_id: "", rating: "", review_number: "", duration_sec: "",
    ...fields,
  });
}

export function reviewedToday(s, now) {
  const today = localDayKey(now);
  return s.events.filter((e) => e.event === "card_reviewed" && localDayKey(Date.parse(e.ts)) === today).length;
}

export function dueNow(s, now) {
  const left = Math.max(0, s.settings.dailyCap - reviewedToday(s, now));
  return Math.min(left, countDue(s.cards, now));
}

function mergeItems(course, items) {
  const byId = new Map(course.videos.map((v) => [v.videoId, v]));
  let added = 0;
  for (const it of items || []) {
    if (!it || !it.videoId) continue;
    const v = byId.get(it.videoId);
    if (v) {
      if (!v.title && it.title) v.title = it.title;
      if (!v.durationSec && it.durationSec) v.durationSec = it.durationSec;
      if (it.index && (!v.index || v.index > 9999)) v.index = it.index;
    } else {
      const nv = { videoId: it.videoId, title: it.title || "", durationSec: it.durationSec || 0,
                   index: it.index || 10000 + course.videos.length };
      course.videos.push(nv);
      byId.set(nv.videoId, nv);
      added++;
    }
  }
  course.videos.sort((a, b) => a.index - b.index);
  return added;
}

export function courseForVideo(s, videoId, listId) {
  if (listId && s.courses[listId]) return listId;
  for (const c of Object.values(s.courses)) if (c.videos.some((v) => v.videoId === videoId)) return c.id;
  return "";
}

export function courseSummary(s, course) {
  const total = course.videos.length;
  const done = course.videos.filter((v) => s.progress[v.videoId]?.completed).length;
  const totalSec = course.videos.reduce((a, v) => a + (v.durationSec || 0), 0);
  const doneSec = course.videos.reduce((a, v) => a + (s.progress[v.videoId]?.completed ? v.durationSec || 0 : 0), 0);
  const flags = Object.values(s.cards).filter((c) => c.courseId === course.id).length;
  const next = course.videos.find((v) => !s.progress[v.videoId]?.completed) || null;
  return { id: course.id, title: course.title, total, done, totalSec, doneSec, flags, next };
}

// --------------------------------------------------------------- message handlers
export const handlers = {
  install(s, msg, ctx) {
    if (!s.userId) s.userId = ctx.newId();
    if (!s.events.some((e) => e.event === "install")) logEvent(s, ctx, "install");
    return { userId: s.userId };
  },

  getState(s, msg, ctx) {
    return {
      userId: s.userId, settings: s.settings, courses: s.courses, progress: s.progress, cards: s.cards,
      courseSummaries: Object.values(s.courses).sort((a, b) => b.addedAt - a.addedAt).map((c) => courseSummary(s, c)),
      due: dueNow(s, ctx.now), reviewedToday: reviewedToday(s, ctx.now),
      nextDue: nextDueAfterToday(s.cards, ctx.now), eventCount: s.events.length,
    };
  },

  trackCourse(s, { playlistId, title, items }, ctx) {
    if (!playlistId) throw new Error("No playlist id");
    let created = false;
    if (!s.courses[playlistId]) {
      s.courses[playlistId] = { id: playlistId, title: title || `Playlist ${playlistId}`, addedAt: ctx.now, videos: [] };
      logEvent(s, ctx, "course_added", { course_id: playlistId });
      created = true;
    }
    const added = mergeItems(s.courses[playlistId], items);
    return { created, added, summary: courseSummary(s, s.courses[playlistId]) };
  },

  untrackCourse(s, { playlistId }) {
    delete s.courses[playlistId];
    return { ok: true };
  },

  mergeItems(s, { playlistId, title, items }) {
    const c = s.courses[playlistId];
    if (!c) return { tracked: false };
    if (title && c.title.startsWith("Playlist ")) c.title = title;
    return { tracked: true, added: mergeItems(c, items), summary: courseSummary(s, c) };
  },

  pageInfo(s, { videoId, listId }) {
    const courseId = courseForVideo(s, videoId, listId);
    return {
      courseId, listTracked: !!(listId && s.courses[listId]),
      summary: courseId ? courseSummary(s, s.courses[courseId]) : null,
      completed: !!s.progress[videoId]?.completed,
      flagsOnVideo: Object.values(s.cards).filter((c) => c.videoId === videoId).length,
      settings: s.settings,
    };
  },

  progress(s, { videoId, courseId, pct, durationSec, title }, ctx) {
    if (!videoId || !courseId || !s.courses[courseId]) return { tracked: false };
    const course = s.courses[courseId];
    mergeItems(course, [{ videoId, title, durationSec: Math.round(durationSec || 0) }]);
    const p = s.progress[videoId] || { maxPct: 0, completed: false };
    p.maxPct = Math.max(p.maxPct, Math.min(1, pct || 0));
    let justCompleted = false;
    if (!p.completed && p.maxPct >= COMPLETE_AT) {
      p.completed = true;
      p.completedAt = ctx.now;
      justCompleted = true;
      logEvent(s, ctx, "video_completed", { course_id: courseId, video_id: videoId });
    }
    s.progress[videoId] = p;
    return { tracked: true, justCompleted, summary: courseSummary(s, course) };
  },

  studySession(s, { courseId, videoId, seconds }, ctx) {
    if (!courseId || !s.courses[courseId] || !(seconds >= MIN_SESSION_SEC)) return { logged: false };
    logEvent(s, ctx, "study_session", { course_id: courseId, video_id: videoId || "", duration_sec: Math.round(seconds) });
    return { logged: true };
  },

  flag(s, { videoId, title, t, courseId }, ctx) {
    if (!videoId) throw new Error("No video");
    const id = ctx.newId();
    const cid = courseId && s.courses[courseId] ? courseId : courseForVideo(s, videoId, "");
    s.cards[id] = newCard({ id, videoId, title: title || "", t: t || 0, courseId: cid, now: ctx.now });
    logEvent(s, ctx, "flag_created", { course_id: cid, video_id: videoId, card_id: id });
    return { cardId: id, flagsOnVideo: Object.values(s.cards).filter((c) => c.videoId === videoId).length };
  },

  flagNote(s, { cardId, note }) {
    if (s.cards[cardId]) s.cards[cardId].note = String(note || "").trim().slice(0, 200);
    return { ok: !!s.cards[cardId] };
  },

  deleteCard(s, { cardId }) {
    delete s.cards[cardId];
    return { ok: true };
  },

  reviewQueue(s, msg, ctx) {
    return { cards: selectDue(s.cards, ctx.now, reviewedToday(s, ctx.now), s.settings.dailyCap),
             reviewedToday: reviewedToday(s, ctx.now), totalDue: countDue(s.cards, ctx.now) };
  },

  cram(s, { courseId }) {
    return { cards: cramOrder(s.cards, courseId) };
  },

  rate(s, { cardId, rating }, ctx) {
    const card = s.cards[cardId];
    if (!card) throw new Error("Card not found");
    const { card: next, reviewNumber } = rate(card, rating, ctx.now);
    s.cards[cardId] = next;
    logEvent(s, ctx, "card_reviewed", { course_id: card.courseId, video_id: card.videoId, card_id: cardId,
                                        rating, review_number: reviewNumber });
    return { card: next };
  },

  reviewDone(s, { seconds, count }, ctx) {
    if (!(count > 0)) return { logged: false };
    logEvent(s, ctx, "review_session_completed", { duration_sec: Math.max(1, Math.round(seconds || 0)) });
    return { logged: true };
  },

  detectionError(s, { where, courseId }, ctx) {
    logEvent(s, ctx, "detection_error", { course_id: courseId || "", rating: "", video_id: "" });
    return { logged: true, where };
  },

  setSettings(s, { patch }) {
    const allowed = {};
    if (typeof patch?.focusMode === "boolean") allowed.focusMode = patch.focusMode;
    s.settings = { ...s.settings, ...allowed };
    return { settings: s.settings };
  },
};
