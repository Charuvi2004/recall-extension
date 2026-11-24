// Tiny DOM helpers shared by the popup and app pages. Text is always set with
// textContent, never innerHTML, so video titles can't inject markup.
export function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "class") e.className = v;
    else if (k === "style") e.setAttribute("style", v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

export async function send(type, payload = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...payload });
  if (!r?.ok) throw new Error(r?.error || "No response from Recall");
  return r;
}

export function progressBar(done, total) {
  const pct = total ? Math.round((100 * done) / total) : 0;
  return h("div", { class: "bar", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 },
    h("span", { style: `width:${pct}%` }));
}

export function hours(sec) {
  if (!sec || sec < 60) return "0 min";
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const hrs = sec / 3600;
  return hrs >= 10 ? `${Math.round(hrs)} h` : `${hrs.toFixed(1)} h`;
}

export function dayLabel(ms) {
  if (!ms) return "";
  const d = new Date(ms), today = new Date();
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return "tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export function watchUrl(videoId, listId, t) {
  const u = new URL("https://www.youtube.com/watch");
  u.searchParams.set("v", videoId);
  if (listId) u.searchParams.set("list", listId);
  if (t) u.searchParams.set("t", `${Math.floor(t)}s`);
  return u.toString();
}
