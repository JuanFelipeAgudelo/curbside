/* Curbside motion. The design pass's spec (MOTION.md), built in stages:
   motion only when information changes, once, never looping; a cause before
   its consequence, values that changed together in a quick cascade; transform
   and opacity wherever possible; no bounce, no flash. With
   "reduce motion" on, every study is a short fade to its end state.

   Stage 1: M2 / M11. A value the app computed or the airport published (the
   two clocks, the flight's time, TERM / GATE / BELT) rolls only the characters
   that changed, then a blue underline sweeps in and stays a while: blue is
   "a time moved". Dispatch's own numbers never animate. */

const MOTION_EASE = "cubic-bezier(.2,.8,.2,1)";
const ROLL_MS = 240;          // one character's roll
const ROLL_STAGGER_MS = 90;   // left to right across the changed characters
const SEQUENCE_GAP_MS = 80;   // after one change finishes, before the next kind
const CASCADE_MS = 120;       // between values that changed together: a cascade,
                              // so eight changes take a second, not three
const ROLL_MARK_MS = 2 * 60000;
const ADVANCE_MS = 400;       // M1's transition: rolls wait for it
const GHOST_MS = 520;         // M5: settle, strike, then UNDO (index.html)

function reduceMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* A repaint rebuilds the screen from scratch, so what a value was before lives
   here, by the key its element carries in data-roll. The first sight of a key
   only remembers it: a screen opening is not a change. */
const rollSeen = new Map(); // key -> { text, changedAt }

/** After a screen is painted: roll every [data-roll] value that changed since
 *  the last paint, in a cascade, and keep the underline on the ones that
 *  changed in the last two minutes. */
function rollChanged(root, start) {
  const now = Date.now();
  // Painted inside the stop's transition: one thing at a time, so the rolls
  // start when it has finished (or when settleMarks' changes have).
  let delay = start ?? (advancing ? ADVANCE_MS + SEQUENCE_GAP_MS : 0);
  root.querySelectorAll("[data-roll]").forEach((el) => {
    const key = el.dataset.roll;
    const text = el.textContent;
    const seen = rollSeen.get(key);
    if (!seen) { rollSeen.set(key, { text, changedAt: 0 }); return; }
    if (seen.text === text) {
      if (now - seen.changedAt < ROLL_MARK_MS) el.classList.add("rolled");
      return;
    }
    rollSeen.set(key, { text, changedAt: now });
    const took = rollText(el, seen.text, text, delay);
    el.style.setProperty("--roll-delay", `${delay + took}ms`);
    el.classList.add("rolled", "roll-new");
    delay += CASCADE_MS;
  });
}

/** Rolls `el` (plain text, already showing `to`) from `from`. Returns how long
 *  it takes, so the next change can wait its turn. */
function rollText(el, from, to, delay) {
  if (reduceMotion()) return fadeIn(el, delay, 120);
  // A different length ("—" to "B12", "estimated" to "landed") has no
  // character to roll into: the new value fades in, the old one already gone.
  if (from.length !== to.length || el.children.length) return fadeIn(el, delay, ROLL_MS);

  const frag = document.createDocumentFragment();
  const plays = [];
  let k = 0;
  for (let i = 0; i < to.length; i++) {
    if (from[i] === to[i]) { frag.append(to[i]); continue; }
    const cell = document.createElement("span");
    cell.className = "roll-cell";
    const incoming = document.createElement("span");
    incoming.textContent = to[i];
    const outgoing = document.createElement("span");
    outgoing.className = "roll-old";
    outgoing.textContent = from[i];
    cell.append(incoming, outgoing);
    frag.append(cell);
    // Later rolls up, earlier rolls down, like a counter.
    const dir = to[i] > from[i] ? 1 : -1;
    const at = delay + ROLL_STAGGER_MS * k++;
    plays.push(
      incoming.animate([{ transform: `translateY(${dir * 100}%)` }, { transform: "none" }],
        { duration: ROLL_MS, delay: at, easing: MOTION_EASE, fill: "backwards" }).finished,
      outgoing.animate([{ transform: "none" }, { transform: `translateY(${-dir * 100}%)` }],
        { duration: ROLL_MS, delay: at, easing: MOTION_EASE, fill: "forwards" }).finished);
  }
  el.textContent = "";
  el.append(frag);
  // Back to plain text once it has played, so the next paint reads it whole.
  Promise.all(plays).then(() => { if (el.isConnected) el.textContent = to; }, () => {});
  return ROLL_STAGGER_MS * (k - 1) + ROLL_MS;
}

/* Stage 3: the small confirmations, each keyed like the rolls and played only
   when a state changes between two paints of a run it has painted before.
   M3  flights refreshed: the fresh line's green dot sends out one ring.
   M6  an edit lands: its hollow dot fills; a YOURS chip comes up to full.
   M5  a row removed: the ghost row settles in, its strike inks in, then UNDO;
       undone, the row fades back. */
const markSeen = new Map();   // key -> state
const paintedRuns = new Set();

function editKey(el) {
  // The phone's dot is on the number itself (v68), which is no button.
  if (el.dataset.mark) return el.dataset.mark;
  try {
    const spec = JSON.parse(el.dataset.edit || el.dataset.editTime || "null");
    return spec ? `${spec.at}|${spec.field || "time"}` : null;
  } catch { return null; }
}

function settleMarks(root, number) {
  const seenRun = paintedRuns.has(number);
  paintedRuns.add(number);
  const quiet = reduceMotion();
  let delay = advancing ? ADVANCE_MS + SEQUENCE_GAP_MS : 0;
  const was = (key, state) => { const before = markSeen.get(key); markSeen.set(key, state); return before; };

  // M3
  const fresh = root.querySelector(".fresh[data-checked]");
  if (fresh) {
    const before = was(`${number}|fresh`, fresh.dataset.checked);
    if (seenRun && before && before !== fresh.dataset.checked && fresh.classList.contains("live") && !quiet) {
      fresh.style.setProperty("--pulse-delay", `${delay}ms`);
      fresh.classList.add("pulse");
      delay += SEQUENCE_GAP_MS; // the ring is ambient: what it announces follows close
    }
  }

  // M6
  root.querySelectorAll(".editable.edited, .telnum.edited, .mine").forEach((el) => {
    const key = el.classList.contains("mine")
      ? `${number}|mine|${el.closest("[data-at]")?.dataset.at}` : `${number}|${editKey(el)}`;
    const state = el.classList.contains("pending") ? "pending" : "sent";
    if (was(key, state) === "pending" && state === "sent" && seenRun) {
      el.style.setProperty("--land-delay", `${delay}ms`);
      el.classList.add("landed");
      if (quiet) el.classList.add("quiet");
      delay += SEQUENCE_GAP_MS;
    }
  });

  // M5
  root.querySelectorAll("[data-at]").forEach((row) => {
    if (!row.matches(".step, .entity")) return;
    const key = `${number}|row|${row.dataset.at}`;
    const state = row.classList.contains("gone") ? "gone" : "here";
    const before = was(key, state);
    if (!seenRun || !before || before === state) return;
    if (state === "gone") {
      const ghost = row.querySelector(".ghost");
      if (!ghost) return;
      if (quiet) { fadeIn(ghost, delay, 120); return; }
      ghost.style.setProperty("--ghost-delay", `${delay}ms`);
      ghost.classList.add("struck-new");
      delay += GHOST_MS + SEQUENCE_GAP_MS;
    } else {
      fadeIn(row, delay, quiet ? 120 : ROLL_MS);
      delay += ROLL_MS + SEQUENCE_GAP_MS;
    }
  });
  return delay;
}

/* M1: the stop advances. RIGHT NOW's step, per run, as of the last paint. A
   change repaints inside a view transition: the ring (the live step's dot)
   travels to its new place, the band's words lift out and then rise in, and
   the rest of the screen crossfades as the old stop folds away (index.html,
   "M1"). No View Transitions, or reduce motion: the band fades in. */
const liveSeen = new Map();
let advancing = false;

/** True when it has taken over the paint. `paint` repaints the run; the call
 *  it makes comes back here with `advancing` set and paints normally. */
function advancePaint(number, liveAt, opening, paint) {
  if (advancing) return false;
  const before = liveSeen.get(number);
  liveSeen.set(number, liveAt);
  if (opening || before === undefined || before === liveAt) return false;
  const run = () => { advancing = true; try { paint(); } finally { advancing = false; } };
  if (reduceMotion() || !document.startViewTransition || document.visibilityState !== "visible") {
    run();
    const band = document.querySelector(".nowband");
    if (band) fadeIn(band, 0, reduceMotion() ? 120 : ROLL_MS);
    return true;
  }
  // Skipped when the page hides mid-way: the paint still runs, only the
  // motion is dropped, and that rejection is not an error.
  document.startViewTransition(run).ready.catch(() => {});
  return true;
}

function fadeIn(el, delay, duration) {
  el.animate([{ opacity: 0 }, { opacity: 1 }],
    { duration, delay, easing: MOTION_EASE, fill: "backwards" });
  return duration;
}

/* Stage 4.
   M7, adapted: a tick in the calls list fills in place and the row dims; the
   list is never re-sorted (the owner: rows stay in time order, a called
   passenger stays where they were). Untick reverses. renderCalls repaints on
   every tap, so the state is keyed by data-call, like the marks above. */
const callSeen = new Map(); // data-call key -> ticked

function settleCalls(root) {
  const quiet = reduceMotion();
  root.querySelectorAll("[data-call]").forEach((row) => {
    const key = row.dataset.call;
    const ticked = row.classList.contains("done");
    const before = callSeen.get(key);
    callSeen.set(key, ticked);
    if (before === undefined || before === ticked) return;
    row.classList.add(ticked ? "tick-new" : "untick-new");
    if (quiet) row.classList.add("quiet");
  });
}

/* M9: a GB run announces itself the first time this phone shows it: the
   violet strip draws across the top and the GB plate stamps in. Once per run
   per device, remembered in localStorage; never on a hidden page, where it
   would be spent unseen. After the launch splash, never under it. */
const LS_GB_SEEN = "fw_gb_seen";
const GB_SEEN_KEEP_MS = 60 * 86400000; // runs are swept after a week
const gbShown = new Set(); // this page's memory; the preview uses only this

function gbIntro(root, number) {
  const strip = root.querySelector(".gbstrip");
  if (!strip || gbShown.has(number) || document.visibilityState !== "visible") return;
  gbShown.add(number);
  if (!PREVIEW) {
    let seen = {};
    try { seen = JSON.parse(localStorage.getItem(LS_GB_SEEN)) || {}; } catch { /* start over */ }
    if (seen[number]) return;
    const now = Date.now();
    for (const k of Object.keys(seen)) if (now - seen[k] > GB_SEEN_KEEP_MS) delete seen[k];
    seen[number] = now;
    try { localStorage.setItem(LS_GB_SEEN, JSON.stringify(seen)); } catch { /* private mode */ }
  }
  const delay = `${splashLeft()}ms`;
  for (const el of [strip, ...root.querySelectorAll(".gbtag")]) {
    el.style.setProperty("--gb-delay", delay);
    el.classList.add("gb-new");
    if (reduceMotion()) el.classList.add("quiet");
  }
}

/* M12: the launch splash, at most once a day (the day turns at 4 AM). The
   check runs in <head> before the first paint (index.html) and puts "splash"
   on <html>; the page renders underneath, and the splash dissolves into it on
   its own, in CSS. Here it only leaves the DOM when it is done. */
function splashLeft() {
  const el = document.documentElement.classList.contains("splash") && document.getElementById("splash");
  const a = el && el.getAnimations()[0];
  if (!a) return 0;
  const end = a.effect.getComputedTiming().endTime;
  return Math.max(0, Math.round(end - (a.currentTime ?? 0)));
}

function splashDone(e) {
  if (e.target.id === "splash") document.documentElement.classList.remove("splash");
}
document.getElementById("splash")?.addEventListener("animationend", splashDone);

/** The preview's scene: the splash again, as a launch would play it. */
function replaySplash() {
  if (reduceMotion()) return false;
  const root = document.documentElement;
  root.classList.remove("splash");
  void root.offsetWidth; // a fresh start for its animations
  root.classList.add("splash");
  return true;
}
