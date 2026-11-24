// Service worker: the only place that writes to storage. Every change goes through a
// queue so two tabs can't overwrite each other's updates.
import { normalize, handlers, dueNow } from "./lib/state.js";
import { eventsToCSV } from "./lib/csv.js";
import { UNINSTALL_FORM_URL, CLIP_BEFORE_SEC, CLIP_AFTER_SEC } from "./lib/config.js";

const READ_ONLY = new Set(["getState", "pageInfo", "reviewQueue", "cram"]);
let queue = Promise.resolve();
let pendingClip = null; // { videoId, start, end, at }

function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

async function load() {
  return normalize(await chrome.storage.local.get(null));
}

async function run(type, msg) {
  const fn = handlers[type];
  if (!fn) throw new Error(`Unknown message: ${type}`);
  return serial(async () => {
    const s = await load();
    const ctx = { now: Date.now(), newId: () => crypto.randomUUID() };
    const result = fn(s, msg, ctx);
    if (!READ_ONLY.has(type)) {
      await chrome.storage.local.set(s);
      updateBadge(s);
    }
    return result;
  });
}

function updateBadge(s) {
  const n = dueNow(s, Date.now());
  chrome.action.setBadgeBackgroundColor({ color: "#2a78d6" });
  chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" });
}

async function refreshBadge() {
  updateBadge(await load());
}

function setUninstallUrl(userId) {
  if (UNINSTALL_FORM_URL && userId) {
    chrome.runtime.setUninstallURL(UNINSTALL_FORM_URL.replace("{USER_ID}", encodeURIComponent(userId)));
  }
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { userId } = await run("install", {});
  setUninstallUrl(userId);
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("app/app.html#welcome") });
  chrome.alarms.create("badge", { periodInMinutes: 30 });
  refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  const s = await load();
  setUninstallUrl(s.userId);
  chrome.alarms.create("badge", { periodInMinutes: 30 });
  updateBadge(s);
});

chrome.alarms.onAlarm.addListener((a) => { if (a.name === "badge") refreshBadge(); });

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "flag-moment") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "flagNow" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "exportCSV": {
        const s = await load();
        return { csv: eventsToCSV(s.events), userId: s.userId, count: s.events.length };
      }
      case "exportCards": {
        const s = await load();
        return { cards: Object.values(s.cards), courses: Object.values(s.courses) };
      }
      case "resetAll":
        // Wipes everything and starts as a brand-new user (new anonymous id + install event).
        return serial(async () => {
          await chrome.storage.local.clear();
          const s = normalize({});
          handlers.install(s, {}, { now: Date.now(), newId: () => crypto.randomUUID() });
          await chrome.storage.local.set(s);
          updateBadge(s);
          setUninstallUrl(s.userId);
          return { ok: true };
        });
      case "openApp": {
        const hash = /^[a-z=A-Z0-9_-]*$/.test(msg.hash || "") ? msg.hash : "review";
        await chrome.tabs.create({ url: chrome.runtime.getURL(`app/app.html#${hash || "review"}`) });
        return { ok: true };
      }
      case "openClip": {
        const start = Math.max(0, Math.floor(msg.t) - CLIP_BEFORE_SEC);
        pendingClip = { videoId: msg.videoId, t: Math.floor(msg.t), start, end: Math.floor(msg.t) + CLIP_AFTER_SEC, at: Date.now() };
        await chrome.storage.session.set({ pendingClip });
        await chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${encodeURIComponent(msg.videoId)}&t=${start}s` });
        return { ok: true };
      }
      case "takeClip": {
        if (!pendingClip) pendingClip = (await chrome.storage.session.get("pendingClip")).pendingClip || null;
        const c = pendingClip;
        if (c && c.videoId === msg.videoId && Date.now() - c.at < 3 * 60 * 1000) {
          pendingClip = null;
          await chrome.storage.session.remove("pendingClip");
          return { clip: c };
        }
        return { clip: null };
      }
      default:
        return run(msg.type, msg);
    }
  })()
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // keep the channel open for the async response
});
