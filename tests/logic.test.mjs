// Run with: node --test tests/
// Tests the scheduling, export and state logic without a browser.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { rate, newCard, selectDue, cramOrder, DAY_MS, formatTime } from "../lib/srs.js";
import { eventsToCSV, csvCell, EVENT_COLUMNS } from "../lib/csv.js";
import { normalize, handlers } from "../lib/state.js";

const T0 = Date.parse("2027-01-04T10:00:00");

test("Leitner schedule: remembered moves up, fuzzy repeats tomorrow, forgot resets", () => {
  let c = newCard({ id: "k", videoId: "v", title: "t", t: 75.9, now: T0 });
  assert.equal(c.t, 75);
  assert.equal(c.due, T0 + DAY_MS);
  let r = rate(c, "remembered", T0 + DAY_MS);
  assert.equal(r.card.box, 1); assert.equal(r.card.due, T0 + DAY_MS + 3 * DAY_MS); assert.equal(r.reviewNumber, 1);
  r = rate(r.card, "remembered", T0 + 4 * DAY_MS);
  assert.equal(r.card.box, 2); assert.equal(r.reviewNumber, 2);
  const fuzzy = rate(r.card, "fuzzy", T0 + 11 * DAY_MS);
  assert.equal(fuzzy.card.box, 2); assert.equal(fuzzy.card.due, T0 + 12 * DAY_MS);
  const forgot = rate(r.card, "forgot", T0 + 11 * DAY_MS);
  assert.equal(forgot.card.box, 0); assert.equal(forgot.card.due, T0 + 12 * DAY_MS);
  let top = c;
  for (let i = 0; i < 10; i++) top = rate(top, "remembered", T0).card;
  assert.equal(top.box, 4); // capped at 30 days
  assert.throws(() => rate(c, "maybe", T0));
});

test("selectDue respects end-of-day cutoff, order and the daily cap", () => {
  const cards = {};
  for (let i = 0; i < 15; i++) cards[`c${i}`] = { ...newCard({ id: `c${i}`, videoId: "v", t: i, now: T0 - 2 * DAY_MS }), due: T0 - i * 1000 };
  cards.later = { ...newCard({ id: "later", videoId: "v", t: 1, now: T0 }), due: T0 + 2 * DAY_MS };
  const due = selectDue(cards, T0, 0, 10);
  assert.equal(due.length, 10);
  assert.equal(due[0].id, "c14"); // most overdue first
  assert.ok(!due.some((c) => c.id === "later"));
  assert.equal(selectDue(cards, T0, 8, 10).length, 2);
  assert.equal(selectDue(cards, T0, 12, 10).length, 0);
});

test("cramOrder puts weakest cards first and filters by course", () => {
  const cards = {
    a: { id: "a", courseId: "L1", box: 2, lastRating: "remembered", createdAt: 1 },
    b: { id: "b", courseId: "L1", box: 0, lastRating: "forgot", createdAt: 2 },
    c: { id: "c", courseId: "L1", box: 0, lastRating: null, createdAt: 3 },
    d: { id: "d", courseId: "L2", box: 0, lastRating: "forgot", createdAt: 4 },
  };
  assert.deepEqual(cramOrder(cards, "L1").map((c) => c.id), ["b", "c", "a"]);
});

test("CSV escaping and columns match the dashboard schema", () => {
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell(null), "");
  assert.deepEqual(EVENT_COLUMNS, ["user_id", "ts", "event", "course_id", "video_id", "card_id", "rating", "review_number", "duration_sec"]);
  assert.equal(formatTime(3725), "1:02:05");
});

/** Simulates one student's first 10 days through the real handlers. */
function simulateUser(userId, { flagsDay0 = 3, reviewDays = [1, 2, 4, 8] } = {}) {
  const s = normalize({});
  let now = T0;
  let n = 0;
  const ctx = () => ({ now, newId: () => `${userId}-id${n++}` });
  handlers.install(s, {}, { now, newId: () => userId });
  now += 60_000;
  const items = [1, 2, 3].map((i) => ({ videoId: `vid${i}`, title: `Lecture ${i}`, durationSec: 1200, index: i }));
  handlers.trackCourse(s, { playlistId: "PL1", title: "DSA", items }, ctx());
  handlers.trackCourse(s, { playlistId: "PL1", title: "DSA", items }, ctx()); // second click: no duplicate event
  for (let i = 0; i < flagsDay0; i++) { now += 60_000; handlers.flag(s, { videoId: "vid1", title: "Lecture 1", t: 100 * i, courseId: "PL1" }, ctx()); }
  now += 60_000;
  handlers.progress(s, { videoId: "vid1", courseId: "PL1", pct: 0.5, durationSec: 1200 }, ctx());
  handlers.progress(s, { videoId: "vid1", courseId: "PL1", pct: 0.95, durationSec: 1200 }, ctx());
  handlers.progress(s, { videoId: "vid1", courseId: "PL1", pct: 0.99, durationSec: 1200 }, ctx()); // no double completion
  handlers.studySession(s, { courseId: "PL1", videoId: "vid1", seconds: 1150 }, ctx());
  handlers.studySession(s, { courseId: "PL1", videoId: "vid1", seconds: 10 }, ctx()); // too short, ignored
  for (const d of reviewDays) {
    now = T0 + d * DAY_MS + 3600_000;
    const q = handlers.reviewQueue(s, {}, ctx());
    for (const c of q.cards) handlers.rate(s, { cardId: c.id, rating: "remembered" }, ctx());
    handlers.reviewDone(s, { seconds: 240, count: q.cards.length }, ctx());
  }
  return s;
}

test("a simulated student produces the events the dashboard expects", () => {
  const s = simulateUser("u1");
  const counts = {};
  for (const e of s.events) counts[e.event] = (counts[e.event] || 0) + 1;
  assert.equal(counts.install, 1);
  assert.equal(counts.course_added, 1);
  assert.equal(counts.flag_created, 3);
  assert.equal(counts.video_completed, 1);
  assert.equal(counts.study_session, 1);
  assert.ok(counts.card_reviewed >= 3);
  const second = s.events.filter((e) => e.event === "card_reviewed" && e.review_number === 2);
  assert.ok(second.length >= 1, "cards reach a second review");
  const info = handlers.pageInfo(s, { videoId: "vid1", listId: "" });
  assert.equal(info.courseId, "PL1");
  assert.equal(info.summary.done, 1);
  assert.equal(info.summary.total, 3);
});

test("export a small multi-user pilot for the dashboard check", () => {
  const users = [
    simulateUser("u1"),
    simulateUser("u2", { flagsDay0: 2, reviewDays: [1] }),   // only 2 flags: not activated
    simulateUser("u3", { flagsDay0: 5, reviewDays: [5] }),   // first review after 72h: not activated
  ];
  const csv = eventsToCSV(users.flatMap((s) => s.events));
  assert.ok(csv.startsWith("user_id,ts,event,"));
  mkdirSync("/tmp/recall-e2e", { recursive: true });
  writeFileSync("/tmp/recall-e2e/events.csv", csv);
});
