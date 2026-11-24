import { h, send, progressBar, dayLabel, watchUrl } from "../ui/dom.js";

const root = document.getElementById("root");
const openApp = (hash) => { chrome.tabs.create({ url: chrome.runtime.getURL(`app/app.html#${hash}`) }); window.close(); };
document.getElementById("open-app").addEventListener("click", () => openApp("review"));

async function render() {
  let st;
  try { st = await send("getState"); }
  catch (e) { root.replaceChildren(h("p", { class: "muted" }, `Recall couldn't load: ${e.message}`)); return; }

  const cardCount = Object.keys(st.cards).length;
  let review;
  if (st.due > 0) {
    review = h("div", { class: "card review-box" },
      h("h2", {}, `${st.due} ${st.due === 1 ? "card" : "cards"} to review today`),
      h("p", { class: "muted small" }, "About a minute per card. Try to recall each moment before you rate it."),
      h("button", { class: "primary", on: { click: () => openApp("review") } }, "Start review"));
  } else if (cardCount === 0) {
    review = h("div", { class: "card review-box" },
      h("h2", {}, "No flags yet"),
      h("p", { class: "muted small" }, "While watching a lecture, press ", h("kbd", {}, "Alt+Shift+F"),
        " or click ⚑ Flag moment at anything worth remembering. Your first review comes the next day."));
  } else {
    review = h("div", { class: "card review-box" },
      h("h2", {}, "All done for today ✓"),
      h("p", { class: "muted small" },
        st.reviewedToday ? `You reviewed ${st.reviewedToday} ${st.reviewedToday === 1 ? "card" : "cards"} today. ` : "",
        st.nextDue ? `Next review: ${dayLabel(st.nextDue)}.` : ""));
  }

  const courses = st.courseSummaries.slice(0, 4).map((c) =>
    h("a", { class: "course", href: c.next ? watchUrl(c.next.videoId, c.id) : `https://www.youtube.com/playlist?list=${encodeURIComponent(c.id)}`,
             target: "_blank", title: c.next ? `Continue: ${c.next.title}` : "Open playlist" },
      h("div", { class: "course-title" }, c.title),
      progressBar(c.done, c.total),
      h("div", { class: "muted small" }, `${c.done}/${c.total} videos · ${c.flags} ${c.flags === 1 ? "flag" : "flags"}`,
        c.next ? " · continue ›" : " · finished")));

  const focus = h("input", { type: "checkbox", id: "focus", checked: st.settings.focusMode });
  focus.addEventListener("change", () => send("setSettings", { patch: { focusMode: focus.checked } }));

  root.replaceChildren(
    review,
    h("div", {},
      h("div", { class: "section-title" }, "Courses"),
      courses.length ? courses : h("p", { class: "muted small" },
        "Open any YouTube playlist and click “Track this playlist as a course”.")),
    h("label", { class: "toggle", for: "focus" },
      h("span", {}, h("strong", {}, "Focus mode"), h("br"),
        h("span", { class: "muted small" }, "Hide recommendations, Shorts and comments")),
      focus),
    h("footer", { class: "small" },
      h("button", { class: "link", on: { click: () => openApp("courses") } }, "All courses"),
      h("button", { class: "link", on: { click: () => openApp("data") } }, "Data & export"),
      h("button", { class: "link", on: { click: () => openApp("welcome") } }, "How it works")));
}

render();
