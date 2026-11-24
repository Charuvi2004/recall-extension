import { h, send, progressBar, hours, dayLabel, watchUrl } from "../ui/dom.js";
import { formatTime } from "../lib/srs.js";

const root = document.getElementById("root");
let session = null;      // the review session in progress
let keyHandler = null;   // keyboard shortcuts for the current view

const thumb = (videoId) => `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function setKeys(fn) {
  if (keyHandler) document.removeEventListener("keydown", keyHandler);
  keyHandler = fn;
  if (fn) document.addEventListener("keydown", fn);
}

// ---------------------------------------------------------------- routing
async function route() {
  endReviewSession();
  setKeys(null);
  const hash = location.hash.slice(1) || "review";
  const [view, arg] = hash.split("=");
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  try {
    if (view === "review") await renderReview();
    else if (view === "cram") await renderCram(decodeURIComponent(arg || ""));
    else if (view === "courses") await renderCourses();
    else if (view === "data") await renderData();
    else renderWelcome();
  } catch (e) {
    root.replaceChildren(h("div", { class: "card" }, h("h2", {}, "Something went wrong"), h("p", { class: "muted" }, e.message)));
  }
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);
window.addEventListener("pagehide", endReviewSession);

// ---------------------------------------------------------------- review
function endReviewSession() {
  if (!session || session.logged) return;
  const count = session.rated;
  session.logged = true;
  if (count > 0) send("reviewDone", { seconds: (Date.now() - session.startedAt) / 1000, count }).catch(() => {});
}

async function renderReview() {
  const q = await send("reviewQueue");
  if (!q.cards.length) return renderNothingDue(q);
  session = { cards: q.cards, i: 0, rated: 0, startedAt: Date.now(), logged: false,
              tally: { remembered: 0, fuzzy: 0, forgot: 0 } };
  showCard();
}

async function renderNothingDue(q) {
  const st = await send("getState");
  const capped = q.totalDue > 0 && q.reviewedToday >= st.settings.dailyCap;
  root.replaceChildren(
    h("h1", {}, capped ? "Daily limit reached" : "Nothing to review right now"),
    h("p", { class: "muted" },
      capped ? `You've reviewed ${st.settings.dailyCap} cards today, which is the daily limit. The rest wait until tomorrow.`
             : Object.keys(st.cards).length
               ? `${st.nextDue ? `Your next review is ${dayLabel(st.nextDue)}. ` : ""}Flag moments while you watch to build tomorrow's review.`
               : "You haven't flagged anything yet. While watching a lecture, press Alt+Shift+F at a moment worth remembering."),
    st.courseSummaries.some((c) => c.flags)
      ? h("div", { class: "card stack", style: "margin-top:20px" },
          h("h2", {}, "Exam or interview coming up?"),
          h("p", { class: "muted" }, "Cram mode shows every flag in a course, weakest first. It doesn't change your schedule."),
          h("div", { class: "course-actions" }, st.courseSummaries.filter((c) => c.flags).map((c) =>
            h("button", { on: { click: () => (location.hash = `cram=${encodeURIComponent(c.id)}`) } }, `Cram: ${c.title}`))))
      : null);
}

function cardView(card, { position, total, cram = false }) {
  const clipBtn = h("button", { on: { click: () => send("openClip", { videoId: card.videoId, t: card.t }) } }, "▶ Watch the 1-minute clip");
  return h("div", {},
    h("div", { class: "review-meta" },
      h("span", { class: "muted" }, cram ? `Cram · card ${position} of ${total}` : `Card ${position} of ${total}`),
      h("div", { style: "width:180px" }, progressBar(position - 1, total))),
    h("article", { class: "card review-card" },
      h("img", { class: "thumb", src: thumb(card.videoId), alt: "" }),
      h("div", { class: "body" },
        h("p", { class: "title" }, card.title || "Untitled video"),
        h("div", { class: "muted" }, `Flagged at ${formatTime(card.t)}`,
          card.reviews ? ` · reviewed ${plural(card.reviews, "time")}` : " · first review"),
        card.note ? h("p", { class: "note" }, card.note) : null,
        h("p", { class: "prompt" }, "What was explained at this moment? Try to recall it before you answer."),
        h("div", { class: "after" }, clipBtn))));
}

function showCard() {
  const s = session;
  if (s.i >= s.cards.length) return showDone();
  const card = s.cards[s.i];
  const rateBtn = (rating, label, key) =>
    h("button", { class: rating === "remembered" ? "primary" : "", on: { click: () => rateCard(rating) } }, label, h("kbd", {}, key));
  root.replaceChildren(
    h("h1", {}, "Today's review"),
    cardView(card, { position: s.i + 1, total: s.cards.length }),
    h("div", { class: "ratings" },
      rateBtn("remembered", "Remembered", "1"), rateBtn("fuzzy", "Fuzzy", "2"), rateBtn("forgot", "Forgot", "3")));
  setKeys((e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const map = { 1: "remembered", 2: "fuzzy", 3: "forgot" };
    if (map[e.key]) { e.preventDefault(); rateCard(map[e.key]); }
  });
}

async function rateCard(rating) {
  const s = session;
  const card = s.cards[s.i];
  setKeys(null);
  await send("rate", { cardId: card.id, rating });
  s.rated++;
  s.tally[rating]++;
  s.i++;
  if (rating !== "forgot") return showCard();
  // Forgot: offer the clip before moving on.
  root.replaceChildren(
    h("h1", {}, "No problem, it comes back tomorrow"),
    h("div", { class: "card stack" },
      h("p", {}, h("strong", {}, card.title || "This moment"), ` at ${formatTime(card.t)}`),
      h("p", { class: "muted" }, "Rewatching just the minute around your flag is the fastest way to lock it in."),
      h("div", { class: "after" },
        h("button", { class: "primary", on: { click: () => send("openClip", { videoId: card.videoId, t: card.t }) } }, "▶ Watch the 1-minute clip"),
        h("button", { on: { click: showCard } }, s.i < s.cards.length ? "Next card →" : "Finish"))));
  setKeys((e) => { if (e.key === "Enter" || e.key === "ArrowRight") { e.preventDefault(); showCard(); } });
}

async function showDone() {
  const s = session;
  const minutes = Math.max(1, Math.round((Date.now() - s.startedAt) / 60000));
  endReviewSession();
  setKeys(null);
  const st = await send("getState");
  root.replaceChildren(h("div", { class: "card done-box" },
    h("div", { class: "big" }, "✓"),
    h("h1", {}, `Done: ${plural(s.rated, "card")} in ${plural(minutes, "minute")}`),
    h("div", { class: "tally" },
      h("div", {}, h("strong", {}, s.tally.remembered), h("span", { class: "muted small" }, "remembered")),
      h("div", {}, h("strong", {}, s.tally.fuzzy), h("span", { class: "muted small" }, "fuzzy")),
      h("div", {}, h("strong", {}, s.tally.forgot), h("span", { class: "muted small" }, "forgot"))),
    h("p", { class: "muted" }, st.due > 0 ? `${plural(st.due, "more card")} due today.`
      : st.nextDue ? `Next review: ${dayLabel(st.nextDue)}.` : "Flag more moments to keep the habit going."),
    st.due > 0 ? h("button", { class: "primary", on: { click: () => route() } }, "Keep going") : null));
}

// ---------------------------------------------------------------- cram
async function renderCram(courseId) {
  const [{ cards }, st] = await Promise.all([send("cram", { courseId }), send("getState")]);
  const course = st.courses[courseId];
  if (!cards.length) {
    root.replaceChildren(h("h1", {}, "No flags in this course yet"), h("a", { href: "#courses" }, "← Back to courses"));
    return;
  }
  let i = 0;
  const show = () => {
    if (i >= cards.length) {
      root.replaceChildren(h("div", { class: "card done-box" }, h("div", { class: "big" }, "✓"),
        h("h1", {}, `Went through all ${plural(cards.length, "flag")}`),
        h("p", { class: "muted" }, "Cram mode doesn't change your review schedule."),
        h("a", { href: "#review" }, "Back to today's review")));
      return setKeys(null);
    }
    root.replaceChildren(
      h("h1", {}, `Cram: ${course?.title || "all courses"}`),
      h("p", { class: "muted" }, "Weakest first. This doesn't change your schedule."),
      cardView(cards[i], { position: i + 1, total: cards.length, cram: true }),
      h("div", { class: "after" },
        h("button", { class: "primary", on: { click: () => { i++; show(); } } }, "Next ", h("kbd", {}, "→")),
        i > 0 ? h("button", { on: { click: () => { i--; show(); } } }, "Back") : null));
  };
  setKeys((e) => {
    if (e.key === "ArrowRight") { i++; show(); }
    if (e.key === "ArrowLeft" && i > 0) { i--; show(); }
  });
  show();
}

// ---------------------------------------------------------------- courses
async function renderCourses() {
  const st = await send("getState");
  const flagsByVideo = {};
  for (const c of Object.values(st.cards)) flagsByVideo[c.videoId] = (flagsByVideo[c.videoId] || 0) + 1;

  const list = st.courseSummaries.map((sum) => {
    const course = st.courses[sum.id];
    const videos = h("ul", { class: "videos" }, course.videos.map((v) => {
      const done = st.progress[v.videoId]?.completed;
      return h("li", {},
        h("span", { class: done ? "tick" : "todo", "aria-label": done ? "Completed" : "Not completed" }, done ? "✓" : "○"),
        h("a", { href: watchUrl(v.videoId, sum.id), target: "_blank" }, v.title || v.videoId),
        h("span", { class: "muted" }, [flagsByVideo[v.videoId] ? `⚑ ${flagsByVideo[v.videoId]}` : "",
                                        v.durationSec ? formatTime(v.durationSec) : ""].filter(Boolean).join(" · ")));
    }));
    return h("article", { class: "card course-card" },
      h("div", { class: "row spread" },
        h("h2", {}, sum.title),
        h("span", { class: "muted small" }, `${Math.round(sum.total ? (100 * sum.done) / sum.total : 0)}%`)),
      progressBar(sum.done, sum.total),
      h("div", { class: "muted small" },
        `${sum.done}/${sum.total} videos · ${hours(sum.doneSec)} of ${hours(sum.totalSec)} · ${plural(sum.flags, "flag")}`),
      h("div", { class: "course-actions" },
        sum.next ? h("a", { class: "button primary", href: watchUrl(sum.next.videoId, sum.id), target: "_blank",
                            style: "background:var(--accent);color:#fff;border-color:var(--accent)" }, "Continue on YouTube") : null,
        sum.flags ? h("button", { on: { click: () => (location.hash = `cram=${encodeURIComponent(sum.id)}`) } }, "Cram this course") : null,
        h("button", { class: "danger", on: { click: async () => {
          if (confirm(`Stop tracking “${sum.title}”? Your flags stay in your reviews.`)) { await send("untrackCourse", { playlistId: sum.id }); route(); }
        } } }, "Stop tracking")),
      h("details", {}, h("summary", {}, `Show ${plural(sum.total, "video")}`), videos));
  });

  root.replaceChildren(
    h("h1", {}, "Courses"),
    h("p", { class: "muted" }, "A course is a YouTube playlist you track. Videos count as done at 90% watched."),
    list.length ? h("div", { class: "stack", style: "margin-top:16px" }, list)
      : h("div", { class: "card", style: "margin-top:16px" },
          h("p", {}, "No courses yet. Open any YouTube playlist and click ", h("strong", {}, "Track this playlist as a course"), " at the bottom left.")));
}

// ---------------------------------------------------------------- data
async function renderData() {
  const st = await send("getState");
  const exportBtn = h("button", { class: "primary", on: { click: async () => {
    const { csv, userId } = await send("exportCSV");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = h("a", { href: URL.createObjectURL(blob),
                       download: `recall-events-${(userId || "user").slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a); a.click(); a.remove();
  } } }, "Download events.csv");

  root.replaceChildren(
    h("h1", {}, "Your data"),
    h("p", { class: "muted" }, "Everything Recall stores stays in this browser. Nothing is sent anywhere unless you download it and share it yourself."),
    h("div", { class: "card stack", style: "margin-top:16px" },
      h("h2", {}, "Pilot export"),
      h("p", {}, "If you're in the Recall pilot, download this file once a week and send it to the person running the pilot. ",
        "It contains usage events only: no video titles, no notes, no browsing history."),
      exportBtn),
    h("div", { class: "card", style: "margin-top:16px" },
      h("table", { class: "kv" }, h("tbody", {},
        h("tr", {}, h("td", {}, "Anonymous ID"), h("td", {}, h("code", {}, st.userId || "—"))),
        h("tr", {}, h("td", {}, "Events recorded"), h("td", {}, String(st.eventCount))),
        h("tr", {}, h("td", {}, "Courses"), h("td", {}, String(st.courseSummaries.length))),
        h("tr", {}, h("td", {}, "Flags"), h("td", {}, String(Object.keys(st.cards).length))),
        h("tr", {}, h("td", {}, "Flag shortcut"), h("td", {}, h("kbd", {}, "Alt+Shift+F"), " ",
          h("button", { class: "link", on: { click: () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }) } }, "Change"))))),
    ),
    h("div", { class: "card stack", style: "margin-top:16px" },
      h("h2", {}, "Start over"),
      h("p", { class: "muted" }, "Deletes all courses, flags and events in this browser and gives you a new anonymous ID."),
      h("button", { class: "danger", on: { click: async () => {
        if (confirm("Delete all Recall data in this browser? This can't be undone.")) { await send("resetAll"); route(); }
      } } }, "Delete all my Recall data")));
}

// ---------------------------------------------------------------- welcome
function renderWelcome() {
  root.replaceChildren(
    h("h1", {}, "Remember what you watch"),
    h("p", { class: "muted" }, "Recall turns YouTube playlists into courses and gives you a short daily review of the moments you flagged."),
    h("ol", { class: "steps" },
      h("li", {}, h("strong", {}, "Track a playlist. "), "Open a YouTube playlist (or a video playing from one) and click ",
        h("em", {}, "Track this playlist as a course"), " at the bottom left. Progress updates as you watch."),
      h("li", {}, h("strong", {}, "Flag what matters. "), "While watching, press ", h("kbd", {}, "Alt+Shift+F"),
        " or click ", h("em", {}, "⚑ Flag moment"), " at the bottom right. Add a one-line note if you like. Try 3 flags on your first video."),
      h("li", {}, h("strong", {}, "Review for 10 minutes a day. "), "From tomorrow, the Recall icon shows how many cards are due. ",
        "Rate each one Remembered, Fuzzy or Forgot. Remembered cards come back later and later (1, 3, 7, 14, then 30 days). Forgotten ones come back tomorrow, with a one-minute clip."),
      h("li", {}, h("strong", {}, "Before an interview, cram. "), "Cram mode shows every flag in a course, weakest first.")),
    h("p", { class: "notice" }, "Privacy: everything stays in your browser. Recall only runs on youtube.com and never reads other sites."),
    h("p", {}, h("a", { href: "#review" }, "Go to today's review →")));
}

route();
