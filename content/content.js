// Recall content script: runs on youtube.com. It never writes storage itself; it sends
// messages to the background service worker. YouTube is a single-page app, so we
// re-run setup whenever the URL changes.
(() => {
  if (window.__recallLoaded) return;
  window.__recallLoaded = true;

  const S = {
    href: "", token: 0, listId: null, listTracked: false, courseId: "", videoId: null,
    video: null, lastTick: Date.now(), sessionSec: 0, lastProgressAt: 0, lastSentTime: -1, sentEnded: false,
    clip: null, clipSought: false,
    observer: null, mergeTimer: null, lastItemCount: 0, errLogged: new Set(), toastTimer: null,
  };
  const DURATION_RE = /^(\d+:)?\d{1,2}:\d{2}$/;
  const SKIP_LISTS = /^(RD|LL|UL)/; // YouTube Mixes, liked videos, uploads mixes: not courses

  // ------------------------------------------------------------ helpers
  function send(type, payload = {}) {
    try {
      return chrome.runtime.sendMessage({ type, ...payload }).then((r) => (r && r.ok ? r : null)).catch(() => null);
    } catch {
      return Promise.resolve(null); // extension was reloaded; this page needs a refresh
    }
  }

  function params() {
    const u = new URL(location.href);
    return { path: u.pathname, v: u.searchParams.get("v"), list: u.searchParams.get("list") };
  }

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else if (k === "class") e.className = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }

  function parseDuration(text) {
    const t = (text || "").trim();
    if (!DURATION_RE.test(t)) return 0;
    return t.split(":").map(Number).reduce((a, n) => a * 60 + n, 0);
  }

  function findDuration(box) {
    if (!box) return 0;
    for (const n of box.querySelectorAll("span, div, p, badge-shape")) {
      if (n.childElementCount === 0) {
        const s = parseDuration(n.textContent);
        if (s) return s;
      }
    }
    return 0;
  }

  function cleanTitle(t) {
    return (t || "").replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "").replace(/\s+/g, " ").trim();
  }

  function videoTitle() {
    const h = document.querySelector("h1.ytd-watch-metadata yt-formatted-string, h1.ytd-watch-metadata, #title h1");
    return cleanTitle(h?.textContent) || cleanTitle(document.title);
  }

  function playlistTitle() {
    const { path } = params();
    if (path === "/playlist") return cleanTitle(document.title);
    const n = document.querySelector(
      "ytd-playlist-panel-renderer #header-description h3 a, ytd-playlist-panel-renderer h3 yt-formatted-string, ytd-playlist-panel-renderer .title");
    return cleanTitle(n?.textContent) || "";
  }

  /** Every video on the page that links into this playlist, read from the links themselves. */
  function scrapeItems(listId) {
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href*="watch?v="]')) {
      let u;
      try { u = new URL(a.href, location.origin); } catch { continue; }
      if (u.searchParams.get("list") !== listId) continue;
      const v = u.searchParams.get("v");
      if (!v) continue;
      const box = a.closest("ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, yt-lockup-view-model, ytd-rich-item-renderer")
        || a.parentElement;
      const title = cleanTitle(box?.querySelector("#video-title")?.textContent || a.getAttribute("title") || a.textContent);
      const item = seen.get(v) || { videoId: v, title: "", durationSec: 0, index: 0 };
      item.title = item.title || title;
      item.durationSec = item.durationSec || findDuration(box);
      item.index = item.index || parseInt(u.searchParams.get("index") || "0", 10) || 0;
      seen.set(v, item);
    }
    return [...seen.values()];
  }

  function logError(where) {
    const key = `${where}|${S.href}`;
    if (S.errLogged.has(key)) return;
    S.errLogged.add(key);
    send("detectionError", { where, courseId: S.courseId });
  }

  // ------------------------------------------------------------ UI
  function toast(message, { keep = false } = {}) {
    let t = document.getElementById("recall-toast");
    if (!t) { t = el("div", { id: "recall-toast", role: "status" }); document.body.append(t); }
    t.replaceChildren(el("span", { class: "recall-brand" }, "Recall"), el("span", {}, message));
    t.classList.add("recall-show");
    clearTimeout(S.toastTimer);
    if (!keep) S.toastTimer = setTimeout(() => t.classList.remove("recall-show"), 4000);
    return t;
  }

  function noteToast(cardId, t) {
    const box = toast("", { keep: true });
    const input = el("input", { type: "text", maxlength: "200", placeholder: "Add a one-line note (optional), then Enter",
                                "aria-label": "Note for this flag" });
    const close = () => box.classList.remove("recall-show");
    // Stop YouTube's keyboard shortcuts (space, k, f, …) while typing a note.
    for (const ev of ["keydown", "keyup", "keypress"]) input.addEventListener(ev, (e) => e.stopPropagation());
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        await send("flagNote", { cardId, note: input.value });
        toast(input.value.trim() ? "Note saved." : "Flag saved.");
      } else if (e.key === "Escape") close();
    });
    box.replaceChildren(el("span", { class: "recall-brand" }, "Recall"),
                        el("span", {}, `Flagged at ${fmt(t)}.`), input,
                        el("button", { class: "recall-x", "aria-label": "Close", on: { click: close } }, "×"));
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(() => { if (document.activeElement !== input && !input.value) close(); }, 8000);
  }

  function showFlagButton(count) {
    let b = document.getElementById("recall-flag");
    if (!b) {
      b = el("button", { id: "recall-flag", title: "Flag this moment for review (Alt+Shift+F)", on: { click: flagNow } });
      document.body.append(b);
    }
    b.replaceChildren(el("span", { class: "recall-flag-icon" }, "⚑"), " Flag moment",
                      el("span", { class: "recall-muted" }, count ? ` · ${count} here` : " · Alt+Shift+F"));
    b.hidden = false;
  }

  function hideFlagButton() {
    const b = document.getElementById("recall-flag");
    if (b) b.hidden = true;
  }

  function renderBar(tracked, summary) {
    let bar = document.getElementById("recall-bar");
    if (!bar) { bar = el("div", { id: "recall-bar" }); document.body.append(bar); }
    const close = el("button", { class: "recall-x", "aria-label": "Hide", on: { click: () => bar.remove() } }, "×");
    if (tracked && summary) {
      bar.replaceChildren(
        el("span", { class: "recall-brand" }, "Recall"),
        el("span", { class: "recall-title" }, summary.title),
        el("span", { class: "recall-muted" }, `${summary.done}/${summary.total} videos done`),
        el("span", { class: "recall-progress" }, el("span", { style: `width:${summary.total ? Math.round(100 * summary.done / summary.total) : 0}%` })),
        el("button", { class: "recall-btn", on: { click: () => send("openApp", { hash: "courses" }) } }, "Open course"),
        close);
    } else {
      bar.replaceChildren(
        el("span", { class: "recall-brand" }, "Recall"),
        el("button", { class: "recall-btn recall-primary", on: { click: onTrack } }, "Track this playlist as a course"),
        close);
    }
  }

  function removeBar() {
    document.getElementById("recall-bar")?.remove();
  }

  // ------------------------------------------------------------ courses
  async function onTrack() {
    const tok = S.token;
    const items = scrapeItems(S.listId);
    const r = await send("trackCourse", { playlistId: S.listId, title: playlistTitle(), items });
    if (tok !== S.token) return;
    if (!r) { toast("Couldn't track this playlist. Reload the page and try again."); return; }
    S.listTracked = true;
    S.lastItemCount = items.length;
    if (params().path === "/watch") S.courseId = S.listId;
    renderBar(true, r.summary);
    toast(`Tracking ${r.summary.total} videos. If the playlist is long, scroll it once to load the rest.`);
  }

  function startObserver() {
    stopObserver();
    S.observer = new MutationObserver(() => {
      clearTimeout(S.mergeTimer);
      S.mergeTimer = setTimeout(mergeVisible, 1500);
    });
    S.observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(mergeVisible, 1500);
  }

  function stopObserver() {
    S.observer?.disconnect();
    S.observer = null;
    clearTimeout(S.mergeTimer);
  }

  async function mergeVisible() {
    if (!S.listTracked || !S.listId) return;
    const items = scrapeItems(S.listId);
    if (items.length === S.lastItemCount) return;
    S.lastItemCount = items.length;
    const tok = S.token;
    const r = await send("mergeItems", { playlistId: S.listId, title: playlistTitle(), items });
    if (tok === S.token && r?.summary && document.getElementById("recall-bar")) renderBar(true, r.summary);
  }

  // ------------------------------------------------------------ pages
  async function setupPlaylist() {
    const tok = S.token;
    const { list } = params();
    if (!list || SKIP_LISTS.test(list)) return;
    S.listId = list;
    const info = await send("pageInfo", { videoId: "", listId: list });
    if (tok !== S.token) return;
    S.listTracked = !!info?.listTracked;
    renderBar(S.listTracked, info?.summary);
    startObserver();
    setTimeout(() => { if (tok === S.token && scrapeItems(list).length === 0) logError("playlist"); }, 8000);
  }

  async function setupWatch() {
    const tok = S.token;
    const { v, list } = params();
    S.videoId = v;
    S.listId = list && !SKIP_LISTS.test(list) ? list : null;
    const info = await send("pageInfo", { videoId: v, listId: S.listId });
    if (tok !== S.token) return;
    S.courseId = info?.courseId || "";
    S.listTracked = !!info?.listTracked;
    showFlagButton(info?.flagsOnVideo || 0);
    if (S.listId) { renderBar(S.listTracked, info?.summary); startObserver(); }
    else if (S.courseId) renderBar(true, info?.summary);
    attachVideo(tok);
    const c = await send("takeClip", { videoId: v });
    if (tok === S.token && c?.clip) {
      S.clip = c.clip;
      S.clipSought = false;
      toast(`Playing a 1-minute clip around ${fmt(c.clip.t ?? c.clip.start)}. It pauses on its own.`);
    }
  }

  function attachVideo(tok, tries = 0) {
    if (tok !== S.token) return;
    const v = document.querySelector("video.html5-main-video") || document.querySelector("#movie_player video");
    if (v) { S.video = v; S.lastTick = Date.now(); return; }
    if (tries >= 20) { logError("player"); return; }
    setTimeout(() => attachVideo(tok, tries + 1), 500);
  }

  function flushSession() {
    const sec = S.sessionSec;
    S.sessionSec = 0;
    if (sec >= 30 && S.courseId) send("studySession", { courseId: S.courseId, videoId: S.videoId, seconds: sec });
  }

  async function flagNow() {
    const { path, v } = params();
    if (path !== "/watch" || !v) { toast("Open a YouTube video to flag a moment."); return; }
    const vid = S.video || document.querySelector("video");
    if (!vid) { toast("Couldn't find the video player. Reload the page."); return; }
    const t = Math.floor(vid.currentTime || 0);
    const r = await send("flag", { videoId: v, title: videoTitle(), t, courseId: S.courseId });
    if (!r) { toast("Couldn't save the flag. Reload the page and try again."); return; }
    showFlagButton(r.flagsOnVideo);
    noteToast(r.cardId, t);
  }

  // Runs every second on every YouTube page; cheap when there's no video.
  async function tick() {
    const now = Date.now();
    const elapsed = Math.min(2, (now - S.lastTick) / 1000);
    S.lastTick = now;
    const vid = S.video;
    if (!vid || params().path !== "/watch" || !vid.isConnected) return;
    const ad = !!document.querySelector(".html5-video-player.ad-showing");
    const playing = !vid.paused && !vid.ended && vid.readyState > 2;

    if (S.clip && !ad && vid.readyState > 0) {
      if (!S.clipSought && Math.abs(vid.currentTime - S.clip.start) > 3) vid.currentTime = S.clip.start;
      S.clipSought = true;
      if (vid.currentTime >= S.clip.end) {
        vid.pause();
        S.clip = null;
        toast("Clip finished. Head back to your review tab.");
      }
    }

    if (!S.courseId || ad) return;
    if (playing) S.sessionSec += elapsed;
    if (S.sessionSec >= 600) flushSession(); // save long sessions in 10-minute pieces

    // Report progress every 5 s while playing, and also once after a seek, pause or the
    // video ending, so a skip past 90% or a short video still counts as complete.
    const dur = vid.duration;
    const moved = Math.abs(vid.currentTime - S.lastSentTime) >= 1 || (vid.ended && !S.sentEnded);
    if (isFinite(dur) && dur > 0 && moved && now - S.lastProgressAt > 5000) {
      S.lastProgressAt = now;
      S.lastSentTime = vid.currentTime;
      S.sentEnded = vid.ended;
      const tok = S.token;
      const r = await send("progress", { videoId: S.videoId, courseId: S.courseId,
                                         pct: vid.ended ? 1 : vid.currentTime / dur, durationSec: dur, title: videoTitle() });
      if (tok !== S.token || !r?.tracked) return;
      if (r.justCompleted) toast(`Video complete: ${r.summary.done}/${r.summary.total} in this course.`);
      if (document.getElementById("recall-bar") && r.summary) renderBar(true, r.summary);
    }
  }

  // ------------------------------------------------------------ focus mode
  function applyFocus(on) {
    document.documentElement.classList.toggle("recall-focus", !!on);
  }
  try {
    chrome.storage.local.get("settings").then((r) => applyFocus(r.settings?.focusMode)).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && ch.settings) applyFocus(ch.settings.newValue?.focusMode);
    });
  } catch { /* extension reloaded */ }

  // ------------------------------------------------------------ navigation
  function onNav() {
    if (location.href === S.href) return;
    flushSession();
    S.href = location.href;
    S.token++;
    S.clip = null; S.courseId = ""; S.listId = null; S.listTracked = false; S.lastItemCount = 0; S.video = null;
    S.lastSentTime = -1; S.sentEnded = false; S.lastProgressAt = 0;
    stopObserver();
    removeBar();
    hideFlagButton();
    const { path } = params();
    if (path === "/watch") setupWatch();
    else if (path === "/playlist") setupPlaylist();
  }

  try {
    chrome.runtime.onMessage.addListener((m) => { if (m?.type === "flagNow") flagNow(); });
  } catch { /* extension reloaded */ }
  document.addEventListener("yt-navigate-finish", onNav);
  setInterval(() => { if (location.href !== S.href) onNav(); }, 1000);
  setInterval(tick, 1000);
  window.addEventListener("pagehide", flushSession);
  onNav();
})();
