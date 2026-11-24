"""End-to-end test: loads the real extension in Chrome, runs a full student journey on
mock YouTube pages (served at youtube.com URLs, so the content script runs), takes
screenshots, and exports events.csv.

    pip install playwright pillow && python -m playwright install chromium
    python tests/e2e/run_e2e.py
"""
import io, json, pathlib, sys, time
from playwright.sync_api import sync_playwright, expect
from PIL import Image, ImageDraw

import os, tempfile
HERE = pathlib.Path(__file__).resolve().parent
EXT = str(HERE.parents[1])                      # the extension folder
FIX = HERE / "fixtures"
OUT = HERE / "shots"; OUT.mkdir(exist_ok=True)
PROFILE = os.path.join(tempfile.gettempdir(), "recall-e2e-profile")
CHROME = os.environ.get("CHROME_PATH")          # optional; defaults to Playwright's Chromium
EXPORT = os.path.join(tempfile.gettempdir(), "recall-browser-events.csv")
errors, checks = [], []

def check(name, ok, detail=""):
    checks.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))

def thumb_bytes():
    im = Image.new("RGB", (320, 180), (40, 44, 52)); d = ImageDraw.Draw(im)
    d.rectangle([0, 150, 320, 180], fill=(200, 30, 50)); d.text((14, 70), "Lecture thumbnail (mock)", fill=(230, 230, 230))
    b = io.BytesIO(); im.save(b, "JPEG"); return b.getvalue()
THUMB = thumb_bytes()

def yt_route(route):
    url = route.request.url
    if "/playlist" in url:
        route.fulfill(status=200, body=(FIX / "playlist.html").read_bytes(), headers={"content-type": "text/html"})
    elif "/watch" in url:
        route.fulfill(status=200, body=(FIX / "watch.html").read_bytes(), headers={"content-type": "text/html"})
    elif url.endswith("/test.webm"):
        route.fulfill(status=200, body=(FIX / "test.webm").read_bytes(), headers={"content-type": "video/webm"})
    else:
        route.fulfill(status=204, body="")

def storage(sw):
    return sw.evaluate("chrome.storage.local.get(null)")

import shutil; shutil.rmtree(PROFILE, ignore_errors=True)
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        PROFILE, executable_path=CHROME, headless=True,
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--autoplay-policy=no-user-gesture-required"],
        viewport={"width": 1280, "height": 760}, accept_downloads=True)
    ctx.route("https://www.youtube.com/**", yt_route)
    ctx.route("https://i.ytimg.com/**", lambda r: r.fulfill(status=200, body=THUMB, headers={"content-type": "image/jpeg"}))
    ctx.on("page", lambda pg: pg.on("pageerror", lambda e: errors.append(f"{pg.url}: {e}")))

    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
    ext = sw.url.split("/")[2]
    base = f"chrome-extension://{ext}"
    print("extension id", ext)

    # 1. Install opens the welcome page and logs an install event
    time.sleep(1.5)
    # Playwright can't attach to a tab opened before it connected, so ask the extension.
    tabs = sw.evaluate("chrome.runtime.getContexts({contextTypes:['TAB']}).then(c => c.map(x => x.documentUrl))")
    check("welcome page opens on install", any(u.endswith("app/app.html#welcome") for u in tabs), str(tabs))
    welcome = ctx.new_page(); welcome.goto(f"{base}/app/app.html#welcome")
    welcome.wait_for_selector("ol.steps"); welcome.screenshot(path=str(OUT / "01_welcome.png"), full_page=True)
    welcome.close()
    s = storage(sw)
    check("install event + anonymous id", s.get("userId") and s["events"][0]["event"] == "install")

    # 2. Track a playlist as a course
    page = ctx.new_page()
    for pg in list(ctx.pages):
        if pg is not page and "about:blank" in pg.url: pg.close()
    page.goto("https://www.youtube.com/playlist?list=PLTEST")
    page.wait_for_selector("#recall-bar .recall-primary", timeout=10000)
    page.screenshot(path=str(OUT / "02_playlist_offer.png"))
    page.click("#recall-bar .recall-primary")
    page.wait_for_selector("#recall-bar .recall-title", timeout=5000)
    time.sleep(6)  # the mock page lazy-loads 2 more videos after 4 s
    s = storage(sw)
    vids = s["courses"]["PLTEST"]["videos"]
    check("course created from playlist", "PLTEST" in s["courses"], s["courses"]["PLTEST"]["title"])
    check("lazy-loaded videos merged into the course", len(vids) == 5, f"{len(vids)} videos")
    check("durations parsed", [v["durationSec"] for v in vids] == [14, 2890, 3753, 3300, 2480], str([v["durationSec"] for v in vids]))
    check("videos in playlist order", [v["videoId"] for v in vids] == ["vid1", "vid2", "vid3", "vid4", "vid5"])
    page.screenshot(path=str(OUT / "03_playlist_tracked.png"))

    # 3. Watch a video, flag 3 moments, add a note
    page.goto("https://www.youtube.com/watch?v=vid1&list=PLTEST&index=1")
    page.wait_for_selector("#recall-flag:not([hidden])", timeout=10000)
    page.wait_for_function("document.querySelector('video').currentTime > 2", timeout=10000)
    page.click("#recall-flag")
    page.wait_for_selector("#recall-toast.recall-show input", timeout=5000)
    page.fill("#recall-toast input", "Two pointers: move the smaller side inward")
    page.screenshot(path=str(OUT / "04_flag_note.png"))
    page.press("#recall-toast input", "Enter")
    expect(page.locator("#recall-toast")).to_contain_text("Note saved", timeout=3000)
    for _ in range(2):
        time.sleep(2.5); page.click("#recall-flag")
    time.sleep(0.5)
    s = storage(sw)
    cards = list(s["cards"].values())
    check("3 flags saved", len(cards) == 3, str(len(cards)))
    check("flags carry course + timestamps", all(c["courseId"] == "PLTEST" for c in cards) and len({c["t"] for c in cards}) == 3,
          str(sorted(c["t"] for c in cards)))
    check("note saved on first flag", any(c["note"].startswith("Two pointers") for c in cards))
    check("flag button shows count", "3 here" in page.inner_text("#recall-flag"), page.inner_text("#recall-flag"))

    # 4. Video completes (14 s clip)
    page.wait_for_function("document.querySelector('video').ended", timeout=25000)
    time.sleep(7)
    s = storage(sw)
    check("video marked complete at the end", s["progress"].get("vid1", {}).get("completed") is True, json.dumps(s["progress"].get("vid1")))
    check("bar shows course progress", "1/5 videos done" in page.inner_text("#recall-bar"), page.inner_text("#recall-bar"))
    page.screenshot(path=str(OUT / "05_watch_page.png"))

    # 5. Popup + focus mode
    popup = ctx.new_page(); popup.set_viewport_size({"width": 372, "height": 600})
    popup.goto(f"{base}/popup/popup.html"); popup.wait_for_selector(".course")
    popup.screenshot(path=str(OUT / "06_popup.png"), full_page=True)
    popup.click("#focus"); time.sleep(0.8)
    hidden = page.evaluate("getComputedStyle(document.querySelector('#related')).display === 'none' && getComputedStyle(document.querySelector('#comments')).display === 'none'")
    panel_visible = page.evaluate("getComputedStyle(document.querySelector('ytd-playlist-panel-renderer')).display !== 'none'")
    check("focus mode hides recommendations + comments", hidden)
    check("focus mode keeps the playlist panel", panel_visible)
    page.screenshot(path=str(OUT / "07_focus_mode.png"))
    popup.close()

    # 6. Review (pretend a day has passed: make cards due now)
    sw.evaluate("""(async () => { const s = await chrome.storage.local.get('cards');
        for (const c of Object.values(s.cards)) c.due = Date.now() - 1000;
        await chrome.storage.local.set({ cards: s.cards }); })()""")
    app = ctx.new_page()
    app.goto(f"{base}/app/app.html#review"); app.wait_for_selector(".ratings")
    check("review shows due cards", "Card 1 of 3" in app.inner_text("main"), app.inner_text(".review-meta"))
    app.screenshot(path=str(OUT / "08_review_card.png"), full_page=True)
    app.keyboard.press("1"); app.wait_for_selector("text=Card 2 of 3")
    app.keyboard.press("3"); app.wait_for_selector("text=it comes back tomorrow")
    app.screenshot(path=str(OUT / "09_forgot.png"), full_page=True)
    with ctx.expect_page() as clip_info:
        app.click("button.primary:has-text('Watch the 1-minute clip')")
    clip = clip_info.value
    clip.wait_for_selector("#recall-toast.recall-show", timeout=10000)
    check("clip opens on YouTube with a note", "1-minute clip" in clip.inner_text("#recall-toast"), clip.url)
    clip.close()
    app.click("text=Next card →"); app.wait_for_selector("text=Card 3 of 3")
    app.keyboard.press("2"); app.wait_for_selector(".done-box")
    check("review finishes with a tally", "Done: 3 cards" in app.inner_text(".done-box"), app.inner_text(".done-box h1"))
    app.screenshot(path=str(OUT / "10_review_done.png"), full_page=True)
    s = storage(sw)
    ratings = [e["rating"] for e in s["events"] if e["event"] == "card_reviewed"]
    check("ratings logged in order", ratings == ["remembered", "forgot", "fuzzy"], str(ratings))
    check("badge cleared after review", sw.evaluate("chrome.action.getBadgeText({})") == "")

    # 7. Courses, cram, data export
    app.goto(f"{base}/app/app.html#courses"); app.wait_for_selector(".course-card")
    app.click("details summary"); app.screenshot(path=str(OUT / "11_courses.png"), full_page=True)
    app.click("text=Cram this course"); app.wait_for_selector("text=Cram ·")
    check("cram mode lists all flags", "of 3" in app.inner_text(".review-meta"))
    app.goto(f"{base}/app/app.html#data"); app.wait_for_selector("text=Download events.csv")
    app.screenshot(path=str(OUT / "12_data.png"), full_page=True)
    with app.expect_download() as dl:
        app.click("text=Download events.csv")
    path = EXPORT
    dl.value.save_as(path)
    print("export saved:", dl.value.suggested_filename)
    ctx.close()

check("no page script errors", not errors, "; ".join(errors[:3]))
print(f"\n{sum(ok for _, ok, _ in checks)}/{len(checks)} checks passed")
sys.exit(0 if all(ok for _, ok, _ in checks) else 1)
