// Spaced-review scheduling (a simple Leitner system). Pure functions, no chrome.* calls.
import { INTERVALS_DAYS, DAILY_CAP } from "./config.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const RATINGS = ["remembered", "fuzzy", "forgot"];

export function endOfDay(ms) {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function localDayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function newCard({ id, videoId, title, t, courseId = "", now }) {
  return {
    id, videoId, title, t: Math.max(0, Math.floor(t)), courseId,
    note: "", createdAt: now, box: 0, due: now + INTERVALS_DAYS[0] * DAY_MS,
    reviews: 0, lastRating: null,
  };
}

/** Returns { card, reviewNumber } with the card rescheduled. Does not mutate the input. */
export function rate(card, rating, now) {
  if (!RATINGS.includes(rating)) throw new Error(`Unknown rating: ${rating}`);
  const c = { ...card, reviews: card.reviews + 1, lastRating: rating, lastReviewedAt: now };
  if (rating === "remembered") {
    c.box = Math.min(card.box + 1, INTERVALS_DAYS.length - 1);
    c.due = now + INTERVALS_DAYS[c.box] * DAY_MS;
  } else if (rating === "fuzzy") {
    c.box = card.box;
    c.due = now + DAY_MS;
  } else {
    c.box = 0;
    c.due = now + DAY_MS;
  }
  return { card: c, reviewNumber: c.reviews };
}

/** Cards due by the end of today, oldest first, capped by what's left of the daily limit. */
export function selectDue(cards, now, reviewedToday = 0, cap = DAILY_CAP) {
  const cutoff = endOfDay(now);
  const left = Math.max(0, cap - reviewedToday);
  return Object.values(cards)
    .filter((c) => c.due <= cutoff)
    .sort((a, b) => a.due - b.due || a.box - b.box)
    .slice(0, left);
}

export function countDue(cards, now) {
  const cutoff = endOfDay(now);
  return Object.values(cards).filter((c) => c.due <= cutoff).length;
}

export function nextDueAfterToday(cards, now) {
  const cutoff = endOfDay(now);
  const later = Object.values(cards).map((c) => c.due).filter((d) => d > cutoff);
  return later.length ? Math.min(...later) : null;
}

/** Cram mode: every card in a course, weakest first. Does not change the schedule. */
export function cramOrder(cards, courseId) {
  const weight = { forgot: 0, fuzzy: 1, null: 2, remembered: 3 };
  return Object.values(cards)
    .filter((c) => !courseId || c.courseId === courseId)
    .sort((a, b) => a.box - b.box || weight[a.lastRating] - weight[b.lastRating] || a.createdAt - b.createdAt);
}

export function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
