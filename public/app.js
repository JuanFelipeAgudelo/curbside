// Curbside — shell: list code, settings, theme, sheets, first run.
// Static PWA, no build step: plain DOM against the Worker API. Everything the
// driver actually looks at lives in assignments.js; getting dispatch's PDF in,
// in import.js.

const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://127.0.0.1:8787"
  : "https://flightwatch-worker.juanfe02agu.workers.dev";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}

/* ================= STATE ================= */

// Per-list, from the server.
const LS_LIST_CODE = "fw_list_code";
const LS_NTFY_TOPIC = "fw_ntfy_topic";
const LS_CODE_UNSAVED = "fw_code_unsaved"; // a new list's code, not yet SAVED (renderSaveCode)
// Per-device. The theme deliberately never round-trips to KV: two devices on
// one list code can want different ones.
const LS_THEME = "fw_theme";

let listCode = localStorage.getItem(LS_LIST_CODE);
let ntfyTopic = localStorage.getItem(LS_NTFY_TOPIC);
let themeMode = localStorage.getItem(LS_THEME) || "auto"; // auto | night | day

// The list's settings, from the server. Only retention is read on this side;
// the fallback holds until the first load says otherwise.
let settings = { retentionDays: 7 };
let offline = false;

const main = document.getElementById("main");

/* ================= UTIL ================= */

function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The list code travels in a header, never the URL: a URL is kept in
 *  browser history and in every proxy's logs, and the code is the list's key. */
function listHeaders(code, extra = {}) {
  return { ...extra, "X-List-Code": code };
}

/** The page scrolls on <body> (html and body are 100% tall), so window.scrollY
 *  stays 0 however far down the driver is. Read and set whichever one moved. */
function pageScroll() {
  return document.body.scrollTop || document.documentElement.scrollTop;
}

function setPageScroll(y) {
  document.body.scrollTop = y;
  document.documentElement.scrollTop = y;
}

function icon(name, cls) {
  return `<svg class="ico ${cls || ""}" aria-hidden="true"><use href="#i-${name}" /></svg>`;
}

/* ================= TIME =================
   AeroDataBox local times are already wall-clock at their own airport, so they are
   parsed into a UTC Date purely as a carrier and never timezone-converted. */

function parseWall(raw) {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
}

function timeParts(raw) {
  const wall = parseWall(raw);
  if (!wall) return null;
  const s = wall.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC",
  });
  const [time, meridiem] = s.split(" ");
  return { time, meridiem };
}

function shortTime(raw) {
  const p = timeParts(raw);
  return p ? p.time : null;
}

function shortDate(isoDate) {
  const [y, mo, d] = String(isoDate).split("-").map(Number);
  if (!y) return "";
  return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  });
}

// For real UTC instants (a call's tick), as opposed to the airport wall-clock
// strings everything else here handles. This one DOES convert to the reader's
// timezone — "called 7:02p" is only useful against their own clock.
function instantTime(iso) {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return deviceTime(at);
}

/** The device's own clock in the one format: "11:30p". */
function deviceTime(at) {
  const h24 = at.getHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(at.getMinutes()).padStart(2, "0")}${h24 < 12 ? "a" : "p"}`;
}

/* ================= API ================= */

/** The server turned the last new list away for its limits (a 429), as
 *  opposed to never answering: the welcome screen says which. */
let registerRefused = false;

async function ensureList() {
  if (listCode) return true;
  registerRefused = false;
  try {
    const res = await fetch(`${API_BASE}/api/register`, { method: "POST" });
    registerRefused = res.status === 429;
    if (!res.ok) throw new Error(`register failed: ${res.status}`);
    const data = await res.json();
    if (!data.listCode) throw new Error("register response missing listCode");
    listCode = data.listCode;
    ntfyTopic = data.ntfyTopic;
    localStorage.setItem(LS_LIST_CODE, listCode);
    localStorage.setItem(LS_NTFY_TOPIC, ntfyTopic);
    return true;
  } catch (err) {
    console.error("Failed to register a list:", err);
    return false;
  }
}

/** How long runs are kept (the one setting saved this way). Shown at once;
 *  when the list did not take it, put back and said where it was chosen: a
 *  number that showed and then quietly went back at the next load is how a
 *  driver who asked for 30 days loses a run after 7. */
async function saveSettings(patch) {
  const before = settings;
  const show = (next) => {
    settings = next;
    renderCurrent(); // the archive says how long finished runs are kept
    syncSettingsSheet();
  };
  show(Object.assign({}, settings, patch));
  let failed = null;
  try {
    const res = await fetch(`${API_BASE}/api/settings`, {
      method: "PUT",
      headers: listHeaders(listCode, { "Content-Type": "application/json" }),
      body: JSON.stringify(Object.assign({ listCode }, patch)),
    });
    if (!res.ok) failed = "the server said no";
  } catch (err) {
    console.error("Couldn't save settings:", err);
    failed = "no signal";
  }
  if (failed) {
    const back = {};
    for (const key of Object.keys(patch)) back[key] = before[key];
    show(Object.assign({}, settings, back));
    document.getElementById("keep-value").textContent =
      `Not saved: ${failed}. Still ${settings.retentionDays || 7} days; try again in a minute.`;
    return;
  }
  // The saved copy too: a redraw from it (every edit makes one) must not put
  // the old number back until the next load.
  const cached = readLS(LS_ASSIGN_CACHE, null);
  if (cached) writeLS(LS_ASSIGN_CACHE, Object.assign(cached, { settings: Object.assign({}, cached.settings, patch) }));
}

/* ================= PREFERENCES (per device) ================= */

/** Auto: the phone's own light or dark mode, dark 11p-5a the late theme. The
 *  rule lives in index.html's <head> (curbsideTheme), which sets the theme
 *  before the first paint: one copy. The clock tick re-reads it, so a phone
 *  switching modes switches the app within a second. */
function resolveTheme() {
  return curbsideTheme(themeMode, new Date());
}

const THEME_COLOR = { day: "#EFECE4", night: "#0E1B30", late: "#070B14" };

let resolvedTheme = null;

function setThemeMode(mode) {
  themeMode = mode;
  localStorage.setItem(LS_THEME, mode);
  ["auto", "night", "day"].forEach((m) => {
    document.getElementById(`theme-${m}`).setAttribute("aria-pressed", String(m === mode));
  });
  applyResolvedTheme();
}

// Called once a second from the clock tick, so it only touches the DOM when the
// resolved theme actually flips — three times a day, not 86,400 times.
function applyResolvedTheme() {
  const resolved = resolveTheme();
  if (resolved === resolvedTheme) return;
  resolvedTheme = resolved;

  if (resolved === "night") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", resolved);
  document.querySelector('meta[name="theme-color"]').setAttribute("content", THEME_COLOR[resolved]);
}

/* ================= SHEETS ================= */

// Which element opened each sheet, so focus can go back where it came from.
const sheetOpener = new Map();

function openSheet(id) {
  const sheet = document.getElementById(id);
  if (!sheet.hidden) return;
  sheetOpener.set(id, document.activeElement);
  sheet.hidden = false;
  pushLayer({ sheet: id });
  // Move focus into the sheet, otherwise it stays on the now-hidden trigger and
  // tabbing walks the home screen behind the overlay.
  const first = sheet.querySelector("button, input, textarea, [tabindex]");
  if (first) first.focus();
}

function closeSheet(id) {
  const sheet = document.getElementById(id);
  if (sheet.hidden) return;
  sheet.hidden = true;
  const opener = sheetOpener.get(id);
  sheetOpener.delete(id);
  if (opener && document.contains(opener) && opener.focus) opener.focus();
  settleHistory();
  pokeTopEdge();
  // Drafts on screen were filled with the old message or name.
  if (id === "settings-sheet" && listCode) renderCurrent();
  // Back on the Settings menu from one of its pages: its rows say what is set now.
  else if (!document.getElementById("settings-sheet").hidden) syncSettingsSheet();
}

/**
 * iOS 26 leaves its Liquid Glass edge blur over the page after a sheet that
 * scrolled (Settings) closes: WebKit only re-samples the top edge when a fixed
 * box there changes, and hiding the sheet isn't one. A full pull to refresh
 * cleared it on the phone, so do what the pull does, unseen: bring the strip
 * to the edge for a moment as a blank band of page colour (.poke).
 */
function pokeTopEdge() {
  const strip = document.getElementById("pull-refresh");
  if (strip.matches(".dragging, .refreshing")) return;
  strip.classList.remove("settling");
  strip.classList.add("poke");
  strip.style.transform = "translateY(0px)";
  setTimeout(() => {
    if (strip.matches(".dragging, .refreshing")) return strip.classList.remove("poke");
    strip.style.transform = "translateY(-56px)";
    strip.classList.remove("poke");
  }, 150);
}

function topmostOpenSheet() {
  const open = Array.from(document.querySelectorAll(".sheet")).filter((s) => !s.hidden);
  return open.length ? open[open.length - 1] : null;
}

/* ================= BACK =================
   The phone's back button (or swipe) walks the app's own layers: a sheet
   closes, the itinerary or the call list goes back to the list. Each layer
   pushes one entry when it opens, and whatever closes a layer inside the app
   pops that entry, so the stack never holds a layer that is off screen and one
   press is always one step. Only entries marked `cs` are ever popped by the
   app, so it can never send the driver out of it. */
let backPending = false;
let queuedLayer = null; // opened while a back was still in flight

function pushLayer(layer) {
  const entry = Object.assign({ cs: 1 }, layer);
  // history.back() lands later; a push before it would be the entry it pops.
  if (backPending) { queuedLayer = entry; return; }
  try { history.pushState(entry, ""); } catch (_) { /* no history */ }
}

/** Pop the top entry when the layer it stands for is no longer showing. */
function settleHistory() {
  const st = history.state;
  if (backPending || !st || !st.cs) return;
  if (st.sheet ? !topmostOpenSheet() : screen === "list") {
    backPending = true;
    history.back();
  }
}

window.addEventListener("popstate", () => {
  backPending = false;
  if (queuedLayer) {
    const entry = queuedLayer;
    queuedLayer = null;
    try { history.pushState(entry, ""); } catch (_) { /* no history */ }
    settleHistory();
    return;
  }
  const st = history.state || {};
  const sheet = topmostOpenSheet();
  if (sheet && sheet.id !== st.sheet) closeSheet(sheet.id);
  else if (!st.sheet && !st.screen && screen !== "list") renderAssignments();
  else settleHistory();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const sheet = topmostOpenSheet();
  if (sheet) { e.preventDefault(); closeSheet(sheet.id); }
});

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.innerHTML;
    btn.textContent = "COPIED";
    setTimeout(() => { btn.innerHTML = original; }, 1200);
  } catch (err) {
    console.error("Clipboard write failed:", err);
  }
}

function syncSettingsSheet() {
  document.getElementById("set-code").textContent = listCode || "—";
  document.getElementById("set-topic").textContent = ntfyTopic || "—";
  // ntfy's page for the topic offers Subscribe, and the ntfy app opens it.
  const sub = document.getElementById("sub-topic");
  if (ntfyTopic) sub.href = `https://ntfy.sh/${encodeURIComponent(ntfyTopic)}`;
  else sub.removeAttribute("href");
  document.querySelectorAll("[data-keep]").forEach((b) => {
    b.setAttribute("aria-pressed", String(Number(b.dataset.keep) === settings.retentionDays));
  });
  document.getElementById("keep-value").textContent =
    `Kept ${settings.retentionDays || 7} days after they end, then deleted`;
  syncMessageRows();
  syncRouteRows();
  syncChecksLeft();
  syncPushRow();
}

/** Settings > List code and alerts: the free plan's lookups left (worker
 *  checks.ts checksView), red once checks are cut back. */
function syncChecksLeft() {
  const el = document.getElementById("checks-left");
  const c = flightChecks;
  if (!c || typeof c.left !== "number") { el.textContent = "—"; el.classList.remove("low"); return; }
  const at = c.renews ? new Date(c.renews) : null;
  const day = at && !isNaN(at) ? shortDate(`${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`) : "";
  el.textContent = `${c.left}${day ? ` · renew ${day}` : ""}`;
  el.classList.toggle("low", c.state !== "ok");
}

/** What the Messages row says is set: whose name signs them, how many are
 *  the driver's own words. */
function syncMessagesValue() {
  const name = myName();
  const own = MESSAGE_KINDS.filter((k) => messageTemplate(k.kind) !== DEFAULT_MESSAGES[k.kind]).length;
  document.getElementById("messages-value").textContent =
    `${name ? `Signed ${name}` : "No name yet"} · ${own ? `${own} of ${MESSAGE_KINDS.length} in your words` : "the starting messages"}`;
}

/* ================= WIRING ================= */

document.getElementById("settings-btn").addEventListener("click", () => {
  syncSettingsSheet();
  openSheet("settings-sheet");
});
document.getElementById("settings-close").addEventListener("click", () => closeSheet("settings-sheet"));

// Settings is a menu: each of these rows opens its own page over it.
[["messages", null], ["keep", null], ["list", () => { showSwitch(false); testAlertSay(""); syncPush(); }]].forEach(([name, before]) => {
  document.getElementById(`${name}-open`).addEventListener("click", () => {
    if (before) before();
    openSheet(`${name}-sheet`);
  });
  document.getElementById(`${name}-close`).addEventListener("click", () => closeSheet(`${name}-sheet`));
});

["auto", "night", "day"].forEach((m) => {
  document.getElementById(`theme-${m}`).addEventListener("click", () => setThemeMode(m));
});

document.querySelectorAll("[data-keep]").forEach((b) => {
  b.addEventListener("click", () => saveSettings({ retentionDays: Number(b.dataset.keep) }));
});

/* ================= MESSAGES =================
   The driver's own message per kind of trip (messages.js), edited here and
   filled for real passengers in the preview, so what they write is what the
   passenger reads. Kept on this device. */
const myNameInput = document.getElementById("my-name");
const messageTextArea = document.getElementById("message-text");
let messageEditing = null; // { kind, samples, at }

function syncMessageRows() {
  myNameInput.value = myName();
  renderMessageRows();
  syncMessagesValue();
}

function renderMessageRows() {
  document.getElementById("msg-rows").innerHTML = MESSAGE_KINDS.map((k) => `
    <div class="set-row msg-row">
      <span class="msg-kind">
        <span>${esc(k.label)}<span class="msg-tags">${esc(k.tags)}</span></span>
        <span class="msg-first">${esc(messageTemplate(k.kind).replace(/\s*\n\s*/g, " ")) || "Empty: an empty chat"}</span>
      </span>
      <button class="mini-btn" type="button" data-edit-msg="${k.kind}" aria-label="Edit the ${esc(k.label)} message">EDIT</button>
    </div>`).join("");
  document.querySelectorAll("[data-edit-msg]").forEach((b) =>
    b.addEventListener("click", () => openMessageEditor(b.dataset.editMsg)));
}

/** A made-up passenger for a kind with nobody of that kind on the list. */
function sampleFacts(kind) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const day = localStamp(d).slice(0, 10);
  const base = { name: "Sample, Pat", pax: 1, kind, day, time: "5:30a", flight: null, appointment: null };
  if (kind === "arrival") return { ...base, tag: "A", from: "JFK", to: "Warwick", door: "Baggage Claim", flight: "B6 1123", time: "9:05a" };
  if (kind === "departure") return { ...base, tag: "D", from: "Warwick", to: "JFK", door: "A-res WRK", flight: "DL 404" };
  if (kind === "medical") return { ...base, tag: "MED", from: "Wallkill", to: "the clinic", door: "F Res", appointment: "10:30a", time: "9:15a" };
  return { ...base, tag: kind === "shuttle" ? "S" : null, from: "Warwick", to: "Newburgh Center B", door: "A-res WRK" };
}

/** The list's passengers of this kind, upcoming runs first, for the preview. */
function messageSamples(kind) {
  const now = localStamp();
  const runs = [...assignments].sort((a, b) =>
    (a.start < now) - (b.start < now) || (a.start < now ? b.start.localeCompare(a.start) : a.start.localeCompare(b.start)));
  const out = [];
  for (const a of runs) {
    for (const step of a.steps || []) {
      if (step._removed) continue;
      for (const action of step.actions || []) {
        if (!/pickup/i.test(action.verb || "")) continue;
        for (const e of action.entities || []) {
          if (e._removed || messageKind(e.tag) !== kind || out.some((o) => o.a === a && o.facts.name === e.name)) continue;
          out.push({ a, facts: messageFacts(a, e) });
        }
      }
    }
  }
  return out.length ? out : [{ a: null, facts: sampleFacts(kind) }];
}

function renderMessagePreview() {
  const { samples, at } = messageEditing;
  const { a, facts } = samples[at];
  const pieces = fillPieces(messageTextArea.value, facts, {
    greet: greetOf(facts.name) || "either", myName: myName(), today: localStamp().slice(0, 10),
  });
  document.getElementById("message-preview").innerHTML = pieces.map((p) =>
    p.missing ? `<b class="miss">${esc(p.text)}</b>` : p.field ? `<b>${esc(p.text)}</b>` : esc(p.text)).join("")
    || `<span class="muted">Empty: WhatsApp and Messages open an empty chat.</span>`;
  document.getElementById("message-who").textContent = a
    ? `${facts.name} · ${facts.tag || "no tag"} · ${a.number} · ${samples.length > 1 ? `${at + 1} of ${samples.length}` : "the only one"}`
    : "A made-up passenger: nobody of this kind is on your list yet.";
  document.getElementById("message-prev").disabled = samples.length < 2;
  document.getElementById("message-next").disabled = samples.length < 2;
}

function openMessageEditor(kind) {
  const k = MESSAGE_KINDS.find((x) => x.kind === kind);
  messageEditing = { kind, samples: messageSamples(kind), at: 0 };
  document.getElementById("message-title").textContent = k.label;
  document.getElementById("message-help").innerHTML =
    `Used for every passenger tagged <b>${esc(k.tags)}</b> on dispatch&rsquo;s sheet. A field with nothing to fill stays in brackets, so you see it before you send.`;
  messageTextArea.value = messageTemplate(kind);
  document.getElementById("message-fields").innerHTML = messageFields(kind).map((f) =>
    `<button class="mini-btn" type="button" data-field="${esc(f)}"><svg class="ico ico-sm"><use href="#i-plus" /></svg>${esc(f)}</button>`).join("");
  document.querySelectorAll("#message-fields [data-field]").forEach((b) => b.addEventListener("click", () => {
    const t = messageTextArea;
    t.setRangeText(`[${b.dataset.field}]`, t.selectionStart, t.selectionEnd, "end");
    t.focus();
    messageChanged();
  }));
  renderMessagePreview();
  openSheet("message-sheet");
}

function messageChanged() {
  saveMessageTemplate(messageEditing.kind, messageTextArea.value);
  renderMessagePreview();
  renderMessageRows();
}

messageTextArea.addEventListener("input", messageChanged);
myNameInput.addEventListener("input", () => {
  try { localStorage.setItem(LS_MY_NAME, myNameInput.value.trim()); } catch { /* private mode */ }
});
document.getElementById("message-prev").addEventListener("click", () => {
  const e = messageEditing;
  e.at = (e.at + e.samples.length - 1) % e.samples.length;
  renderMessagePreview();
});
document.getElementById("message-next").addEventListener("click", () => {
  const e = messageEditing;
  e.at = (e.at + 1) % e.samples.length;
  renderMessagePreview();
});
document.getElementById("message-reset").addEventListener("click", () => {
  saveMessageTemplate(messageEditing.kind, null);
  messageTextArea.value = messageTemplate(messageEditing.kind);
  renderMessagePreview();
  renderMessageRows();
});
document.getElementById("message-close").addEventListener("click", () => closeSheet("message-sheet"));

/* ================= ROUTES AND PLACES =================
   ROUTE IN MAPS shows the stops Maps will get -- to put in another order,
   leave out, add to or start elsewhere (assignments.js: mapsRoute, editRoute)
   -- and opens Apple or Google Maps from there, the pick remembered on this
   phone (fw_maps). "Straight to Maps" skips the stops; Settings -> Maps turns
   it off. Places are the list's own, one code at a time (savePlace). */
let routeFor = null;     // the run the route sheet opens, or null from Settings
let routePick = null;    // null, or "add" / "start" while choosing a place
let routeScope = "all";  // "all" | "next": every stop, or only the next one
let placeEditing = null; // the code of the place being changed, or null: a new one

function syncRouteRows() {
  const app = mapsApp();
  document.getElementById("maps-value").textContent = app
    ? `${app === "apple" ? "Apple Maps" : "Google Maps"}, ${mapsDirect() ? "straight to Maps" : "stops shown first"} · this phone`
    : "Asked the first time you open a route";
  // Yours, every driver's (the keeper's list, where you have none of your
  // own), and the sheets': three sources, one count each.
  const all = listPlaces();
  const n = all.filter((p) => !p.shared).length, e = all.length - n;
  const m = sheetPlaces().filter((p) => !all.some((y) => y.code === p.code)).length;
  document.getElementById("places-value").textContent = [
    `${n} yours`, e ? `${e} for every driver` : null, `${m} from dispatch’s sheets`].filter(Boolean).join(" · ");
  const air = listAirlines();
  document.getElementById("airlines-value").textContent = air.length
    ? air.map((a) => `${a.name} = ${a.code}`).join(", ")
    : "None learned yet";
  // The keeper's: what other drivers added, waiting for a yes or a no.
  for (const kind of ["place", "airline"]) {
    const badge = document.getElementById(`${kind}s-badge`);
    const waiting = openSuggestions(kind).length;
    badge.hidden = !waiting;
    badge.textContent = `${waiting} NEW`;
  }
}

/** Who gets what this list sets: the keeper's is every driver's. */
function whoWords() {
  return keeper ? "What you set here is every driver’s default." : "Shared by every phone on this list.";
}

/** What other drivers added, on the keeper's phone: one row each, with the
 *  keeper's own entry for it (if any) said, never replaced unasked. */
function suggestedRows(kind) {
  const rows = openSuggestions(kind);
  if (!rows.length) return "";
  const mine = (g) => (kind === "place" ? ownPlaces().find((p) => p.code === g.code)
    : ownAirlines().find((a) => airlineKey(a.name) === airlineKey(g.name)));
  return `<span class="eyebrow set-eyebrow">ADDED BY OTHER DRIVERS</span>${rows.map((g) => {
    const have = mine(g);
    const yours = !have ? "" : kind === "place"
      ? `<span class="pa">Yours says: ${esc(placeLine(have))}</span>` : `<span class="pa">Yours says: ${esc(have.code)}</span>`;
    return `<div class="place-row suggested"><span class="pc">${esc(g.code)}</span>
      <span class="pt"><span class="pn">${esc(g.name || g.code)}</span>${
        g.address ? `<span class="pa">${esc(g.address)}</span>` : ""}${yours}</span>
      <span class="sugg-acts">
        <button class="mini-btn go" type="button" data-take="${esc(g.id)}">${have ? "USE THIS FOR EVERYONE" : "ADD FOR EVERYONE"}</button>
        <button class="mini-btn" type="button" data-dismiss="${esc(g.id)}">DISMISS</button>
      </span></div>`;
  }).join("")}`;
}

/** ADD FOR EVERYONE / DISMISS, in either sheet. */
function answerSuggestion(ev, redraw) {
  const take = ev.target.closest("[data-take]"), drop = ev.target.closest("[data-dismiss]");
  if (!take && !drop) return;
  if (take) takeSuggestion(take.dataset.take);
  else dismissSuggestion(drop.dataset.dismiss);
  refreshLocal();
  redraw();
  syncRouteRows();
}

function renderAirlines() {
  document.getElementById("airlines-who").textContent = whoWords();
  document.getElementById("airlines-suggested").innerHTML = suggestedRows("airline");
  const all = listAirlines();
  const row = (a) => `<div class="place-row"><span class="pc">${esc(a.code)}</span>
        <span class="pt"><span class="pn">${esc(a.name)}</span>${
          a.shared ? `<span class="ptag">FOR EVERY DRIVER</span>` : ""}</span>${a.shared ? ""
        : `<button class="mini-btn" type="button" data-forget="${esc(a.name)}" aria-label="Forget ${esc(a.name)}">FORGET</button>`}</div>`;
  document.getElementById("airlines-list").innerHTML = all.length
    ? all.map(row).join("")
    : `<p class="places-empty">None yet. When a sheet names an airline I have no code for, FIX its flight and I can remember the code.</p>`;
}

document.getElementById("airlines-open").addEventListener("click", () => {
  renderAirlines();
  openSheet("airlines-sheet");
});
document.getElementById("airlines-close").addEventListener("click", () => closeSheet("airlines-sheet"));
document.getElementById("airlines-suggested").addEventListener("click", (ev) => answerSuggestion(ev, renderAirlines));
document.getElementById("airlines-list").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-forget]");
  if (!b) return;
  saveAirline(b.dataset.forget, null, true);
  refreshLocal();
  renderAirlines();
  syncRouteRows();
});

function openRouteSheet(number) {
  routeFor = number || null;
  routePick = null;
  routeScope = "all";
  renderRouteSheet();
  openSheet("route-sheet");
}

const routeIcon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}" /></svg>`;

/** Where the route can start or go: the car's lot, the list's places, the
 *  sheets', the airports. */
function routePlaces(a) {
  const groups = [];
  const lot = carLot(a);
  if (lot) groups.push(["THE CAR", [{ code: lot.code, label: lot.name, text: placeLine(lot) }]]);
  // The lot is named once, as the car's: not again under the places.
  const notLot = (p) => !lot || p.code !== lot.code;
  const yours = listPlaces();
  const mine = yours.filter(notLot);
  if (mine.length) groups.push(["YOUR PLACES", mine.map((p) => ({ code: p.code, label: p.name, text: placeLine(p) }))]);
  const sheets = sheetPlaces().filter((p) => notLot(p) && !yours.some((y) => y.code === p.code));
  if (sheets.length) groups.push(["FROM DISPATCH’S SHEETS", sheets.map((p) => ({ code: p.code, label: p.name, text: placeLine(p) }))]);
  groups.push(["AIRPORTS", Object.entries(AIRPORT_NAMES).map(([code, text]) => ({ code, label: "", text }))]);
  return groups;
}

function renderRouteSheet() {
  const a = routeFor && assignments.find((x) => x.number === routeFor);
  const app = mapsApp();
  const list = document.getElementById("route-list");
  const openBox = document.getElementById("route-open");
  document.querySelectorAll("[data-maps]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.maps === app)));
  document.getElementById("route-direct").checked = mapsDirect();
  document.getElementById("route-title").textContent = a ? `Route in Maps · #${a.number}` : "Maps";
  if (!a) {
    // From Settings: which Maps, and whether the stops show first.
    list.innerHTML = "";
    openBox.hidden = false;
    document.getElementById("route-scope").hidden = true;
    document.getElementById("route-in").textContent = "ROUTES OPEN IN";
    document.getElementById("route-direct-label").textContent = "Go straight to Maps: don’t show the stops first";
    document.getElementById("route-help").textContent = "On this phone. With the stops first, you can put them in another "
      + "order, leave some out, add one or start somewhere else before Maps opens.";
    document.querySelectorAll("[data-maps]").forEach((b) => { b.disabled = false; });
    return;
  }
  if (routePick) {
    openBox.hidden = true;
    const e = (s) => esc(s || "");
    list.innerHTML = `<div class="rhead"><button class="mini-btn" type="button" data-rpick-back>${routeIcon("chevron-left")}BACK</button>
        <span class="eyebrow">${routePick === "add" ? "ADD A STOP" : "START FROM"}</span></div>
      ${routePick === "start" ? `<button class="rpick" type="button" data-rpick-here><span class="pc">&#9679;</span><span class="pt">Where you are now</span></button>` : ""}
      ${routePlaces(a).map(([title, places]) => `<span class="eyebrow set-eyebrow">${e(title)}</span>
        ${places.map((p) => `<button class="rpick" type="button" data-rpick="${e(JSON.stringify(p))}"><span class="pc">${e(p.code)}</span>
          <span class="pt">${e(p.text)}</span></button>`).join("")}`).join("")}
      <button class="addrow" type="button" data-rpick-new>+ A PLACE THAT ISN&rsquo;T HERE</button>`;
    return;
  }
  openBox.hidden = false;
  document.getElementById("route-in").textContent = "OPEN IN";
  document.getElementById("route-direct-label").textContent = "Don’t show the stops again: go straight to Maps";
  const r = mapsRoute(a, nowAt());
  const byKey = new Map([...r.stops, ...r.out].map((s) => [s.key, s]));
  const outKeys = new Set(r.out.map((s) => s.key));
  let n = 0;
  const last = r.stops.length;
  const rows = r.order.map((k) => {
    const s = byKey.get(k);
    const name = `<b>${esc(s.code)}</b>${s.label ? ` ${esc(s.label)}` : ""}`;
    if (outKeys.has(k)) {
      return `<div class="rrow out"><span class="n">&ndash;</span><span class="t"><s>${name}</s><span class="rsub">Left out</span></span>
        <span class="racts"><button class="mini-btn" type="button" data-rback="${esc(k)}">ADD BACK</button></span></div>`;
    }
    n++;
    return `<div class="rrow"><span class="n">${n}</span><span class="t">${name}${s.yours ? `<span class="yours">YOURS</span>` : ""}
        <span class="rsub">${s.text ? esc(s.text) : `<span class="miss">No address yet</span>`}</span></span>
      <span class="racts">${s.text ? "" : `<button class="mini-btn" type="button" data-rplace="${esc(s.code)}">ADD</button>`}
        <button class="up" type="button" data-rmove="${esc(k)}" data-by="-1" aria-label="Move ${esc(s.code)} up"${n === 1 ? " disabled" : ""}>${routeIcon("chevron-right")}</button>
        <button class="down" type="button" data-rmove="${esc(k)}" data-by="1" aria-label="Move ${esc(s.code)} down"${n === last ? " disabled" : ""}>${routeIcon("chevron-right")}</button>
        <button type="button" data-rout="${esc(k)}" aria-label="Leave ${esc(s.code)} out">${routeIcon("x")}</button></span></div>`;
  }).join("");
  const start = r.start
    ? `<b>${esc(r.start.code)}</b>${r.start.label ? ` ${esc(r.start.label)}` : ""}<span class="rsub">${esc(r.start.text)}</span>`
    : "Where you are now";
  list.innerHTML = `<span class="eyebrow">START</span>
    <div class="rrow here"><span class="n">&#9679;</span><span class="t">${start}</span>
      <span class="racts"><button class="mini-btn" type="button" data-rstart>CHANGE</button></span></div>
    <div class="rhead"><span class="eyebrow">${r.edited ? "STOPS, IN YOUR ORDER" : "STOPS, IN DISPATCH’S ORDER"}</span>
      <span class="spacer"></span>${r.edited ? `<button class="mini-btn" type="button" data-rreset>DISPATCH’S ORDER</button>` : ""}</div>
    <div class="rlist">${rows || `<p class="places-empty">Every stop is left out.</p>`}</div>
    <button class="addrow" type="button" data-radd>+ ADD A STOP</button>
    <p class="seg-help">Only what Maps gets changes: the run keeps dispatch&rsquo;s order. Kept on this phone until the run
      ends.${r.started ? " The stops behind you are left out." : ""}</p>`;
  const scope = document.getElementById("route-scope");
  scope.hidden = r.stops.length < 2;
  if (scope.hidden) routeScope = "all";
  scope.querySelectorAll("[data-scope]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scope === routeScope)));
  const blocked = !r.stops.length || r.missing.length > 0;
  document.querySelectorAll("[data-maps]").forEach((b) => { b.disabled = blocked; });
  document.getElementById("route-help").textContent = r.missing.length
    ? `${r.missing.join(", ")} ${r.missing.length === 1 ? "has" : "have"} no address yet: ADD it, or leave it out.`
    : mapsApp() === "google" && routeScope === "all" && r.stops.length > GOOGLE_STOPS
      ? `Google Maps gets the first ${GOOGLE_STOPS}; tap again later for the rest.` : "";
}

document.getElementById("route-list").addEventListener("click", (ev) => {
  const a = routeFor && assignments.find((x) => x.number === routeFor);
  const b = ev.target.closest("button");
  if (!a || !b) return;
  const now = nowAt();
  const d = b.dataset;
  if (d.rmove) editRoute(a, { move: [d.rmove, Number(d.by)] }, now);
  else if (d.rout) editRoute(a, { out: d.rout }, now);
  else if (d.rback) editRoute(a, { back: d.rback }, now);
  else if ("rreset" in d) editRoute(a, { reset: true }, now);
  else if ("radd" in d) routePick = "add";
  else if ("rstart" in d) routePick = "start";
  else if ("rpickBack" in d) routePick = null;
  else if ("rpickHere" in d) { editRoute(a, { start: null }, now); routePick = null; }
  else if (d.rpick) {
    const p = JSON.parse(d.rpick);
    editRoute(a, routePick === "start" ? { start: p } : { add: p }, now);
    routePick = null;
  } else if ("rpickNew" in d) return void openPlaceEditor(null);
  else if (d.rplace) return void openPlaceEditor(d.rplace);
  else return;
  renderRouteSheet();
  if (screen === "itinerary") renderCurrent();
});

document.getElementById("route-scope").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-scope]");
  if (!b) return;
  routeScope = b.dataset.scope;
  renderRouteSheet();
});

document.getElementById("route-direct").addEventListener("change", (ev) => {
  setMapsDirect(ev.target.checked);
  syncRouteRows();
  if (listCode) renderCurrent();
});

document.querySelectorAll("[data-maps]").forEach((b) => b.addEventListener("click", () => {
  setMapsApp(b.dataset.maps);
  setMapsDirect(document.getElementById("route-direct").checked);
  const number = routeFor;
  // Opened inside the tap, or the phone blocks the new window.
  if (number) openRoute(number, b.dataset.maps, routeScope === "next");
  closeSheet("route-sheet");
  syncRouteRows();
  if (listCode) renderCurrent();
}));
document.getElementById("route-cancel").addEventListener("click", () => closeSheet("route-sheet"));
document.getElementById("maps-change").addEventListener("click", () => openRouteSheet(null));

function renderPlaces() {
  const row = (p, tail) => `<div class="place-row"><span class="pc">${esc(p.code)}</span>
    <span class="pt">${p.name ? `<span class="pn">${esc(p.name)}</span>` : ""}<span class="pa">${esc(p.address)}</span></span>${tail}</div>`;
  // A sheet's own words can be short of what Maps needs (no town): EDIT makes
  // the driver's version, used instead, and the sheet's leaves this list.
  const edit = (p) => `<button class="mini-btn" type="button" data-place-edit="${esc(p.code)}" aria-label="Edit ${esc(p.code)}">EDIT</button>`;
  document.getElementById("places-who").textContent = whoWords();
  document.getElementById("places-suggested").innerHTML = suggestedRows("place");
  const all = listPlaces();
  const yours = all.filter((p) => !p.shared), every = all.filter((p) => p.shared);
  document.getElementById("places-yours").innerHTML = yours.length
    ? yours.map((p) => row(p, edit(p))).join("")
    : `<p class="places-empty">None yet. Add a code the notes use that no sheet gives an address for.</p>`;
  // Every driver's: already known, nothing to set. EDIT makes this list's own.
  document.getElementById("places-shared").innerHTML = every.length
    ? `<span class="eyebrow set-eyebrow">FOR EVERY DRIVER</span>${every.map((p) => row(p, edit(p))).join("")}` : "";
  const sheets = sheetPlaces().filter((p) => !all.some((y) => y.code === p.code));
  // The keeper's sheet places reach other drivers only once they are his own
  // (shared.ts): SHARE makes one his, as printed, in one tap (v65). EDIT
  // first when the sheet's words are short of what Maps needs.
  const shareable = keeper ? sheets.filter((p) => SHAREABLE_CODE.test(p.code)) : [];
  const share = (p) => (shareable.includes(p)
    ? `<button class="mini-btn" type="button" data-place-share="${esc(p.code)}" aria-label="Share ${esc(p.code)} with every driver">SHARE</button>` : "");
  document.getElementById("places-sheets").innerHTML = sheets.length
    ? `${shareable.length > 1 ? `<button class="addrow addplace" type="button" id="place-share-all">SHARE ALL ${shareable.length} WITH EVERY DRIVER</button>` : ""}${
      sheets.map((p) => row(p, share(p) + edit(p))).join("")}`
    : `<p class="places-empty">None yet: they come with the sheets you import.</p>`;
  document.querySelectorAll("[data-place-edit]").forEach((b) =>
    b.addEventListener("click", () => openPlaceEditor(b.dataset.placeEdit)));
  document.querySelectorAll("[data-place-share]").forEach((b) => b.addEventListener("click", () => {
    const p = shareable.find((x) => x.code === b.dataset.placeShare);
    if (p) { savePlace(p); placeSaved(); }
  }));
  const shareAll = document.getElementById("place-share-all");
  if (shareAll) shareAll.addEventListener("click", () => { shareable.forEach((p) => savePlace(p)); placeSaved(); });
}

/** A code POST /api/places takes (worker limits.ts checkPlace). */
const SHAREABLE_CODE = /^[A-Z0-9]{2,8}$/;

document.getElementById("places-open").addEventListener("click", () => {
  renderPlaces();
  openSheet("places-sheet");
});
document.getElementById("places-close").addEventListener("click", () => closeSheet("places-sheet"));
document.getElementById("places-suggested").addEventListener("click", (ev) => answerSuggestion(ev, renderPlaces));
document.getElementById("place-add").addEventListener("click", () => openPlaceEditor(null));

/** code: a place of the list's to change, or a code to add (from the route:
 *  "ADD SGA FIRST"), or null for a blank one. */
function openPlaceEditor(code) {
  const mine = code ? ownPlaces().find((p) => p.code === code) : null;
  const every = code ? listPlaces().find((p) => p.code === code && p.shared) : null;
  const sheet = code ? sheetPlaces().find((p) => p.code === code) : null;
  placeEditing = mine ? code : null;
  const from = mine || every || sheet || { code: code || "", name: "", address: "" };
  document.getElementById("place-title").textContent = mine ? `Place ${code}` : "Add a place";
  const codeInput = document.getElementById("place-code");
  codeInput.value = code || "";
  codeInput.readOnly = !!mine;
  document.getElementById("place-name").value = from.name || "";
  document.getElementById("place-address").value = from.address || "";
  document.getElementById("place-doc").textContent = every && !mine
    ? `Every driver has ${code} as ${placeLine(every)}. Saving makes your own, used on this list instead.`
    : sheet ? `Dispatch's sheets print ${code} as ${placeLine(sheet)}. Yours is used instead.`
    : `${whoWords()} The route in Maps uses it wherever a leg or a stop names this code.`;
  document.getElementById("place-error").textContent = "";
  document.getElementById("place-remove").hidden = !mine;
  openSheet("place-sheet");
  if (code && !mine) document.getElementById("place-name").focus();
}

function placeSaved() {
  closeSheet("place-sheet");
  if (!document.getElementById("places-sheet").hidden) renderPlaces();
  if (!document.getElementById("route-sheet").hidden) renderRouteSheet();
  syncRouteRows();
  if (listCode) renderCurrent();
}

document.getElementById("place-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = document.getElementById("place-code").value.trim().toUpperCase();
  const name = document.getElementById("place-name").value.trim();
  const address = document.getElementById("place-address").value.trim().replace(/\s*\n\s*/g, ", ");
  const error = document.getElementById("place-error");
  if (!/^[A-Z0-9]{2,8}$/.test(code)) return void (error.textContent = "A code is 2 to 8 letters or digits, as the notes print it.");
  if (!address) return void (error.textContent = "Where is it? Maps needs an address.");
  savePlace({ code, name, address });
  placeSaved();
});
document.getElementById("place-remove").addEventListener("click", () => {
  if (placeEditing) savePlace({ code: placeEditing }, true);
  placeSaved();
});
document.getElementById("place-cancel").addEventListener("click", () => closeSheet("place-sheet"));

/* ================= FEEDBACK =================
   A tester's note to the owner, straight to the worker (POST /api/feedback),
   not through the outbox: it changes no run, and a note that can't go now
   stays in the box (and in fw_feedback_draft) until it can. */
const LS_FEEDBACK_DRAFT = "fw_feedback_draft";
const feedbackText = document.getElementById("feedback-text");
const feedbackError = document.getElementById("feedback-error");
let feedbackVersion = null;

function feedbackCount() {
  document.getElementById("feedback-count").textContent = `${feedbackText.value.length} / 2000`;
}

async function openFeedback() {
  document.getElementById("feedback-form").hidden = false;
  document.getElementById("feedback-sent").hidden = true;
  document.getElementById("feedback-close").textContent = "CANCEL";
  feedbackError.textContent = "";
  try { feedbackText.value = localStorage.getItem(LS_FEEDBACK_DRAFT) || ""; } catch { /* nicety */ }
  feedbackCount();
  openSheet("feedback-sheet");
  feedbackText.focus();
  feedbackVersion = await showVersion();
  document.getElementById("feedback-version").textContent = feedbackVersion ? `App version ${feedbackVersion}` : "";
}

async function sendFeedback(e) {
  e.preventDefault();
  const text = feedbackText.value.trim();
  if (!text) { feedbackError.textContent = "Write something first."; return; }
  if (!listCode) { feedbackError.textContent = "Start a list or enter your code first."; return; }
  const send = document.getElementById("feedback-send");
  send.disabled = true;
  feedbackError.textContent = "";
  try {
    const res = await fetch(`${API_BASE}/api/feedback`, {
      method: "POST",
      headers: listHeaders(listCode, { "Content-Type": "application/json" }),
      body: JSON.stringify({ text, version: feedbackVersion }),
    });
    if (!res.ok) {
      const why = (await res.json().catch(() => ({}))).error;
      feedbackError.textContent = res.status === 429 && why
        ? `Not sent: ${why}. Your note is kept here.`
        : "Not sent: the server said no. Your note is kept here; try again later.";
      return;
    }
    feedbackText.value = "";
    try { localStorage.removeItem(LS_FEEDBACK_DRAFT); } catch { /* nicety */ }
    document.getElementById("feedback-form").hidden = true;
    document.getElementById("feedback-sent").hidden = false;
    document.getElementById("feedback-close").textContent = "CLOSE";
    document.getElementById("feedback-done").focus();
  } catch (err) {
    console.error("Couldn't send feedback:", err);
    feedbackError.textContent = "Not sent: no signal. Your note is kept here; send it when you're back online.";
  } finally {
    send.disabled = false;
  }
}

feedbackText.addEventListener("input", () => {
  feedbackCount();
  try { localStorage.setItem(LS_FEEDBACK_DRAFT, feedbackText.value); } catch { /* nicety */ }
});
document.getElementById("open-feedback").addEventListener("click", openFeedback);
document.getElementById("feedback-close").addEventListener("click", () => closeSheet("feedback-sheet"));
document.getElementById("feedback-done").addEventListener("click", () => closeSheet("feedback-sheet"));
document.getElementById("feedback-form").addEventListener("submit", sendFeedback);

document.getElementById("copy-code").addEventListener("click", (e) => copyText(listCode, e.currentTarget));
document.getElementById("copy-topic").addEventListener("click", (e) => copyText(ntfyTopic, e.currentTarget));

/* ---- a copy of the list (v65): the driver's own backup, made from what this
 * phone last loaded, so it costs the server nothing and works offline. Never
 * the list code or the alert topic: a file gets shared, and those are keys. */
function listCopy(now = new Date()) {
  const data = readLS(LS_ASSIGN_CACHE, null);
  if (!data || !Array.isArray(data.assignments)) return null;
  return {
    curbside: "list copy",
    savedAt: now.toISOString(),
    assignments: data.assignments,
    settings: data.settings || {},
    thisPhone: { messages: readLS(LS_MESSAGES, {}), myName: myName(), greetings: readLS(LS_GREET, {}) },
  };
}

/** The phone's share sheet when it can take a file (iPhone: Save to Files),
 *  else a download. */
async function exportList() {
  const sub = document.getElementById("export-value");
  const copy = listCopy();
  if (!copy) { sub.textContent = "Nothing loaded on this phone yet"; return; }
  const name = `curbside-${localStamp().slice(0, 10)}.json`;
  const text = JSON.stringify(copy, null, 2);
  const said = `Saved ${copy.assignments.length} run${copy.assignments.length === 1 ? "" : "s"} · keep your code apart from it`;
  try {
    const file = new File([text], name, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "Curbside list copy" });
      sub.textContent = said;
      return;
    }
  } catch (err) {
    if (err && err.name === "AbortError") return; // the driver closed the sheet
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  sub.textContent = said;
}
document.getElementById("export-list").addEventListener("click", exportList);

/* ================= ALERTS ON THIS PHONE (v66) =================
   Curbside alerts the phone itself: Web Push, no other app. The phone signs
   up with its browser's push service under the server's key (pushKey, which
   comes with the runs), and hands that subscription to its list; the Worker
   then sends each notice to it (worker/src/webpush.ts) and sw.js shows it.
   A phone's own choice, kept on the phone and never synced: another phone on
   the list turns its own on. The ntfy topic stays, as the other way. */
const LS_PUSH_ON = "fw_push_on"; // "1": the driver turned alerts on, on this phone

let pushEndpoint = null;  // this phone's live subscription while alerts are on
let pushConfirmed = null; // "<code>|<endpoint>": what the list took, this launch
let pushLooked = false;   // syncPush has run once: the state is known
let pushSyncing = null;   // a look under way
let pushAgain = false;    // and one more owed after it

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function onIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // an iPad says it is a Mac
}

function onHomeScreen() {
  return navigator.standalone === true
    || !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
}

function pushWanted() {
  try { return localStorage.getItem(LS_PUSH_ON) === "1"; } catch (_) { return false; }
}

/** What is true of this phone now, for pushView. */
function pushFacts() {
  const supported = pushSupported();
  const permission = supported ? Notification.permission : "default";
  const wanted = pushWanted();
  return {
    supported, ios: onIOS(), standalone: onHomeScreen(), key: pushKey, permission, wanted,
    on: wanted && !!pushEndpoint && permission === "granted",
    looked: pushLooked,
  };
}

/**
 * Settings > List code and alerts, "Alerts on this phone": the word, the line
 * under it, the button (null: none to offer) and what the list screen's bar
 * shows (assignments.js alertsBar). An iPhone only lets a Home Screen app
 * have alerts (iOS 16.4), so in Safari it says how to get there.
 */
function pushView(s) {
  if (!s.supported) {
    if (s.ios && !s.standalone) {
      return { word: "NOT YET", tone: "", button: null, bar: null,
        say: "On an iPhone, alerts need Curbside on the Home Screen: in Safari tap Share, then Add to Home Screen. Open Curbside from there and turn them on." };
    }
    return { word: "NO", tone: "", button: null, bar: null,
      say: s.ios ? "This iPhone needs iOS 16.4 or later to show Curbside's alerts. The ntfy app, below, still can."
        : "This browser can't show Curbside's alerts. The ntfy app, below, still can." };
  }
  if (!s.key) {
    return { word: "NOT YET", tone: "", button: null, bar: null,
      say: "Alerts from Curbside itself aren't ready on the server. The ntfy app, below, still works." };
  }
  if (s.permission === "denied") {
    return { word: "BLOCKED", tone: "bad", button: null, bar: s.wanted ? "lost" : null,
      say: "This phone is blocking Curbside's notifications. Allow them in the phone's Settings (Notifications, then Curbside) and come back." };
  }
  if (s.on) {
    return { word: "ON", tone: "on", button: "TURN OFF", bar: "on",
      say: "When a flight moves, this phone buzzes with what to do and your new times." };
  }
  // Turned on, and not looked at yet this launch: nothing to say either way.
  if (s.wanted && !s.looked) return { word: "…", tone: "", button: null, bar: null, say: "" };
  if (s.wanted) {
    return { word: "STOPPED", tone: "bad", button: "TURN ON", bar: "lost",
      say: "Alerts were on and have stopped on this phone. Tap TURN ON to start them again." };
  }
  return { word: "OFF", tone: "", button: "TURN ON", bar: "off",
    say: "Curbside can alert this phone itself when a flight moves. No other app needed." };
}

/** The row in Settings and the bar on the list, from what is true now.
 *  `note` is what just happened, said in place of the standing line. */
function syncPushRow(note) {
  const view = pushView(pushFacts());
  const word = document.getElementById("push-state");
  word.textContent = view.word;
  word.className = `set-value push-state ${view.tone}`;
  const btn = document.getElementById("push-toggle");
  btn.hidden = !view.button;
  if (view.button) btn.textContent = view.button;
  document.getElementById("push-say").textContent = note || view.say;
  document.getElementById("list-value").textContent = view.bar === "on" ? "Alerts on · your code, another list"
    : view.bar ? "Alerts off on this phone · your code" : "Your code, flight alerts, another list";
  // Before the first look nothing is known: no bar, rather than a wrong one.
  const bar = pushLooked ? view.bar : null;
  if (bar === pushState) return;
  pushState = bar;
  if (listCode && !holdScreen && screen === "list") renderCurrent();
}

/** The server's key as the browser wants it. */
function pushKeyBytes(key) {
  return Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

/** Was this subscription made under the server's key as it is now? A browser
 *  that does not say is taken on trust: SEND A TEST finds a stale one. */
function underServerKey(sub, key) {
  const used = sub.options && sub.options.applicationServerKey;
  if (!used) return true;
  const have = new Uint8Array(used), want = pushKeyBytes(key);
  return have.length === want.length && have.every((b, i) => b === want[i]);
}

/** The service worker, once it is in charge: signing up needs one. Gives up
 *  rather than wait for ever on a phone where it never installs. */
function pushRegistration() {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, no) => setTimeout(() => no(new Error("no service worker")), 8000)),
  ]);
}

/** This phone's subscription under the server's key, made when there is none
 *  (or only one from an older key). Needs no tap once the phone said yes. */
async function pushSubscription(reg) {
  let sub = await reg.pushManager.getSubscription();
  if (sub && !underServerKey(sub, pushKey)) { await sub.unsubscribe(); sub = null; }
  return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(pushKey) });
}

/** A request that gives up: a list switch or a launch must not hang on it. */
function pushFetch(method, code, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  return fetch(`${API_BASE}/api/push`, {
    method, headers: listHeaders(code, { "Content-Type": "application/json" }), body: JSON.stringify(body), signal: ctl.signal,
  }).finally(() => clearTimeout(timer));
}

/** Hands the subscription to the list. Throws when the server did not take it. */
async function sendSubscription(sub, code) {
  const res = await pushFetch("POST", code, { subscription: sub.toJSON() });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  pushConfirmed = `${code}|${sub.endpoint}`;
}

/** The phone's own question. Older Safari answers through a callback. */
function askNotifications() {
  return new Promise((resolve) => {
    let answer;
    try { answer = Notification.requestPermission(resolve); } catch (_) { return resolve(Notification.permission); }
    if (answer && answer.then) answer.then(resolve, () => resolve(Notification.permission));
  });
}

/**
 * After every load with signal: are this phone's alerts still what the driver
 * set? While they are on, a subscription the browser let go (or made under an
 * older server key) is made again, and the list is told once a launch, which
 * costs it two reads when it already knew and puts back a phone it had lost.
 */
function syncPush() {
  // Asked again while one look is under way (a list switch during a slow
  // send): one more look follows it, for the list as it is by then.
  if (pushSyncing) { pushAgain = true; return pushSyncing; }
  pushSyncing = (async () => {
    try {
      if (!pushSupported() || PREVIEW) return;
      const reg = await navigator.serviceWorker.getRegistration();
      let sub = reg ? await reg.pushManager.getSubscription() : null;
      // Signing up needs a service worker in charge; a first launch has none
      // yet, and no alerts to keep either.
      const live = pushWanted() && reg && reg.active && listCode && pushKey && Notification.permission === "granted";
      if (live && (!sub || !underServerKey(sub, pushKey))) sub = await pushSubscription(reg);
      pushEndpoint = pushWanted() && sub ? sub.endpoint : null;
      const code = listCode;
      if (live && pushConfirmed !== `${code}|${sub.endpoint}`) await sendSubscription(sub, code);
    } catch (err) {
      console.error("Alerts on this phone:", err);
    } finally {
      pushLooked = true;
      pushSyncing = null;
      syncPushRow();
      if (pushAgain) { pushAgain = false; syncPush(); }
    }
  })();
  return pushSyncing;
}

async function turnAlertsOn() {
  if (!listCode) { syncPushRow("Start a list or enter your code first."); return; }
  // Asked from the tap itself, before anything else is awaited: an iPhone
  // shows its question only then.
  const permission = await askNotifications();
  if (permission !== "granted") { syncPushRow(); return; }
  const btn = document.getElementById("push-toggle");
  btn.disabled = true;
  syncPushRow("Turning on…");
  let told = false; // the phone signed up; the list is being told
  try {
    const sub = await pushSubscription(await pushRegistration());
    told = true;
    await sendSubscription(sub, listCode);
    try { localStorage.setItem(LS_PUSH_ON, "1"); localStorage.setItem(LS_PUSH_ASKED, "1"); } catch (_) { /* private mode */ }
    pushEndpoint = sub.endpoint;
    pushLooked = true;
    syncPushRow("On. Tap SEND A TEST to see one arrive.");
  } catch (err) {
    console.error("Couldn't turn alerts on:", err);
    // On only once the list has the phone: a row saying ON with no alert
    // behind it would be worse than one more tap.
    syncPushRow(err && err.status ? "Not turned on: the server said no. Try again in a minute."
      : told || navigator.onLine === false ? "Not turned on: no signal. Try again when you're online."
        : "Not turned on: this phone couldn't sign up for alerts. Try again in a minute.");
  } finally {
    btn.disabled = false;
  }
}

/**
 * This phone leaves a list's alerts: the list forgets it, and the
 * subscription itself is ended, so nothing sent to the old one can arrive
 * even if the list never heard (no signal). The driver's choice, fw_push_on,
 * is the caller's to change: a list switch keeps it.
 */
async function leavePush(code) {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      if (code) await pushFetch("DELETE", code, { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch (err) {
    console.error("Couldn't end this phone's alerts:", err);
  }
  pushEndpoint = null;
  pushConfirmed = null;
}

async function turnAlertsOff() {
  const btn = document.getElementById("push-toggle");
  btn.disabled = true;
  try { localStorage.removeItem(LS_PUSH_ON); localStorage.setItem(LS_PUSH_ASKED, "1"); } catch (_) { /* private mode */ }
  await leavePush(listCode);
  btn.disabled = false;
  syncPushRow("Off. Curbside sends this phone no alerts now.");
}

/** A test this phone should have taken and did not: its sign-up is stale (the
 *  list lost it, or the push service ended it). A new one, handed over. */
async function renewPush() {
  try {
    const reg = await pushRegistration();
    const old = await reg.pushManager.getSubscription();
    if (old) await old.unsubscribe();
    const sub = await pushSubscription(reg);
    pushEndpoint = sub.endpoint;
    await sendSubscription(sub, listCode);
    return true;
  } catch (err) {
    console.error("Couldn't renew this phone's alerts:", err);
    return false;
  } finally {
    syncPushRow();
  }
}

document.getElementById("push-toggle").addEventListener("click", () => {
  testAlertSay(""); // an earlier test's answer is about how things were
  if (pushFacts().on) turnAlertsOff();
  else turnAlertsOn();
});

// Back from the phone's own Settings, where notifications were just allowed
// (or blocked): the page says so without being closed and opened.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !document.getElementById("list-sheet").hidden) syncPush();
});

/** The list's "alerts are off" bar (assignments.js alertsBar): straight to
 *  the page that turns them on. Tapped once, the offer is not made again. */
function openAlerts() {
  try { localStorage.setItem(LS_PUSH_ASKED, "1"); } catch (_) { /* private mode */ }
  showSwitch(false);
  testAlertSay("");
  syncSettingsSheet();
  openSheet("list-sheet");
  // Under the page: the offer is gone when it closes. "Stopped" stays.
  if (screen === "list") renderCurrent();
}

/** The list's paused-checks bar (assignments.js checksBar): the same page,
 *  for its Flight checks left line and what running out means. */
function openChecks() {
  showSwitch(false);
  testAlertSay("");
  syncSettingsSheet();
  openSheet("list-sheet");
}

/* ---- a test alert: proves alerts reach this phone before a real delay has
 * to. Never queued: a test sent later, offline, would prove nothing. */
function testAlertSay(text) {
  const say = document.getElementById("test-alert-say");
  say.textContent = text;
  say.hidden = !text;
}

/**
 * The line under SEND A TEST, from the server's answer (worker index.ts,
 * /api/alerts/test: `here` this phone took it, `app` phones that did, `ntfy`
 * ntfy.sh did) and whether this phone has alerts on. `renewed` is set when
 * this phone should have taken it and did not: true, its sign-up was made
 * again; false, that failed too. `can`: the row above offers TURN ON. When
 * it does not (blocked, Safari off the Home Screen, an old browser) that row
 * says what to do, and these words never name a button that is not there.
 */
function testAlertWords(status, d, on, renewed, can = true) {
  const others = d.app === 1 ? "another phone" : `${d.app} other phones`;
  const above = "The line above says what this phone needs for its own alerts";
  if (status === 200) {
    if (d.here) return "Sent to this phone. It should buzz within a few seconds. Nothing? Check that the phone lets Curbside send notifications.";
    if (on) {
      return renewed ? "This phone's alerts had lapsed, and are renewed now. Tap SEND A TEST again."
        : "This phone didn't take the test. Turn alerts off and on again, above.";
    }
    if (d.app) return `Sent to ${others} on this list, not to this one. ${can ? "For this phone, TURN ON above." : `${above}.`}`;
    return `Sent to the ntfy app only. ${can ? "For alerts on this phone without it, TURN ON above." : `${above}.`}`;
  }
  if (status === 429) return `Not sent: ${d.error || "too many tests; try again later"}.`;
  // ntfy's free limit is the usual reason, and the app's own alerts the way round it.
  if (!on && !d.phones) {
    if (d.quota) {
      return `Not sent: no phone on this list has alerts on, and ntfy.sh's daily limit for Curbside's server is used up. ${
        can ? "TURN ON above" : above}: those alerts don't go through ntfy.`;
    }
    return `Not sent: no phone on this list has alerts on, and ntfy.sh didn't take it. ${can ? "TURN ON above, or try" : "Try"} again in a minute.`;
  }
  return d.error ? `Not sent: ${d.error}. Try again in a minute.` : "Not sent: the server said no. Try again in a minute.";
}

async function sendTestAlert() {
  if (!listCode) { testAlertSay("Start a list or enter your code first."); return; }
  const btn = document.getElementById("test-alert");
  btn.disabled = true;
  testAlertSay("Sending…");
  try {
    const facts = pushFacts();
    const on = facts.on, can = pushView(facts).button === "TURN ON";
    const res = await fetch(`${API_BASE}/api/alerts/test`, {
      method: "POST",
      headers: listHeaders(listCode, { "Content-Type": "application/json" }),
      body: JSON.stringify(on ? { endpoint: pushEndpoint } : {}),
    });
    const data = await res.json().catch(() => ({}));
    const renewed = res.status === 200 && on && !data.here ? await renewPush() : undefined;
    testAlertSay(testAlertWords(res.status, data || {}, on, renewed, can));
  } catch (err) {
    console.error("Couldn't send a test alert:", err);
    testAlertSay("Not sent: no signal. Try again when you're online.");
  } finally {
    btn.disabled = false;
  }
}
document.getElementById("test-alert").addEventListener("click", sendTestAlert);

/** Point the app at an existing list code. Returns false if the server doesn't
 *  recognise it, and throws only if the server is unreachable. The answer that
 *  proves the code is also the list's first load, so it is fetched once. */
async function adoptCode(trimmed) {
  const res = await fetch(`${API_BASE}/api/assignments`, { headers: listHeaders(trimmed) });
  if (!res.ok) return false;
  const data = await res.json();
  // This phone's alerts go with it: the list it leaves forgets the phone, and
  // the load below signs it up to the new one.
  if (pushWanted() && listCode && listCode !== trimmed) await leavePush(listCode);
  listCode = trimmed;
  localStorage.setItem(LS_LIST_CODE, listCode);
  localStorage.removeItem(LS_CODE_UNSAVED); // a code typed in is a code already kept
  holdScreen = false;
  // The other list's topic is not this one's; the load below says which is.
  ntfyTopic = null;
  localStorage.removeItem(LS_NTFY_TOPIC);
  forgetAssignments();
  closeSheet("list-sheet");
  closeSheet("settings-sheet");
  await loadAssignments(data);
  syncSettingsSheet();
  takeShared(false); // a sheet shared before there was a list
  return true;
}

/** Another list's code, in a field under SWITCH (it was a browser pop-up). */
function showSwitch(open) {
  const form = document.getElementById("switch-form");
  form.hidden = !open;
  document.getElementById("switch-code").setAttribute("aria-expanded", String(open));
  document.getElementById("switch-error").textContent = "";
  const input = document.getElementById("switch-input");
  input.value = "";
  if (open) input.focus();
}

document.getElementById("switch-code").addEventListener("click", () =>
  showSwitch(document.getElementById("switch-form").hidden));
document.getElementById("switch-cancel").addEventListener("click", () => showSwitch(false));
document.getElementById("switch-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const error = document.getElementById("switch-error");
  const go = document.getElementById("switch-go");
  const trimmed = document.getElementById("switch-input").value.trim();
  if (!trimmed) return void (error.textContent = "Type the other list's code.");
  if (trimmed === listCode) return void (error.textContent = "That's the list this phone is on.");
  error.textContent = "";
  go.disabled = true;
  try {
    if (await adoptCode(trimmed)) showSwitch(false);
    else error.textContent = "That code isn't recognised — check it and try again.";
  } catch (err) {
    console.error(err);
    error.textContent = "Couldn't reach the server. Try again.";
  } finally {
    go.disabled = false;
  }
});

document.getElementById("edit-cancel").addEventListener("click", () => closeSheet("edit-sheet"));
document.getElementById("edit-form").addEventListener("submit", saveEdit);
document.getElementById("edit-input").addEventListener("input", syncLearnRow);
document.getElementById("row-cancel").addEventListener("click", () => closeSheet("row-sheet"));
document.getElementById("row-form").addEventListener("submit", saveAdd);
document.getElementById("row-menu-close").addEventListener("click", () => closeSheet("row-menu"));
document.getElementById("leg-cancel").addEventListener("click", () => closeSheet("leg-sheet"));
document.getElementById("leg-form").addEventListener("submit", saveLeg);
document.getElementById("leg-dispatch").addEventListener("click", legBack);
document.getElementById("leg-off").addEventListener("click", legOff);

/* ================= CHROME ================= */

function tickClock() {
  document.getElementById("clock").textContent = deviceTime(new Date());
  if (themeMode === "auto") applyResolvedTheme();
}

/* ================= APP UPDATES =================
   sw.js skips waiting and claims the page, so a new version takes over the
   moment it installs, but the page keeps running the files it booted with
   until it reloads. The shell is network-first, so a launch with signal is
   already new even when the browser's own check installs a worker at the same
   time; that one is not an update for this page. What is: a worker found by
   our own check while the page runs (back from the background, or open all
   day on the wake lock). That shows UPDATE in the chrome and never reloads by
   itself mid-run. A pull is the driver's yes, now. */
const UPDATE_CHECK_MS = 30 * 60000;
const SS_UPDATED = "curbside-just-updated";
let controlled = !!navigator.serviceWorker?.controller;
let foundUpdate = false;     // our check found a newer worker
let reloadOnTakeover = false;
let lastUpdateCheck = Date.now();

/** Ask the server for a newer sw.js. True when one is coming or already here. */
async function findUpdate() {
  lastUpdateCheck = Date.now();
  if (!document.getElementById("update-btn").hidden) return true;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) return false;
    await reg.update();
    if (reg.installing || reg.waiting) foundUpdate = true;
  } catch { /* no signal: nothing found */ }
  return foundUpdate;
}

function reloadIntoUpdate() {
  try { sessionStorage.setItem(SS_UPDATED, "1"); } catch { /* the line is a nicety */ }
  location.reload();
}

navigator.serviceWorker?.addEventListener("controllerchange", () => {
  showVersion();
  if (reloadOnTakeover) return reloadIntoUpdate();
  if (!controlled) { controlled = true; return; } // first install: this page is it
  if (foundUpdate) document.getElementById("update-btn").hidden = false;
});

document.getElementById("update-btn").addEventListener("click", reloadIntoUpdate);

function maybeFindUpdate() {
  if (document.visibilityState === "visible" && Date.now() - lastUpdateCheck >= UPDATE_CHECK_MS) findUpdate();
}
document.addEventListener("visibilitychange", maybeFindUpdate);
setInterval(maybeFindUpdate, 60000);

/* ================= PULL TO REFRESH =================
   Installed iOS PWAs run standalone with no browser chrome, so there's no native
   gesture to fall back on. A pull reloads the runs and installs an update if
   there is one, then says in one line what happened. */
const pullStrip = document.getElementById("pull-refresh");
const pullLabel = pullStrip.querySelector(".pull-label");
const PULL_SAY_MS = 1800;

/** The strip comes down with one line and goes back up. `done` runs after. */
function pullSay(text, done, ms = PULL_SAY_MS) {
  pullStrip.classList.remove("dragging", "poke");
  pullStrip.classList.add("settling", "refreshing", "said");
  pullStrip.style.transform = "translateY(0px)";
  pullLabel.textContent = text;
  setTimeout(() => {
    pullStrip.style.transform = "translateY(-56px)";
    pullStrip.classList.remove("ready", "refreshing", "said");
    if (done) done();
  }, ms);
}

/* Versions (the owner, 2026-09-29). Every release gets a new number, or the
   phones keep the old code (sw.js's name is what tells them). A whole number
   (v61) is a release a driver would notice -- a new feature, a screen or a
   rule that behaves differently -- and a point (v60.1) is a fix or polish.
   Crossing into a new whole number says, once, what it brought. */
const LS_SEEN_VERSION = "fw_seen_version"; // the version this phone last ran

/** "v60.1" -> 60; null for anything else. */
function versionMajor(v) {
  const m = /^v(\d+)(?:\.\d+)?$/.exec(v || "");
  return m ? Number(m[1]) : null;
}

/** What a whole-number release brought, in a few words for the update line
 *  (at most 28 characters: it is one line of the strip). Every new whole
 *  number adds its words here; client.test.ts holds sw.js's to that. */
function releaseNews(major) {
  return {
    60: "Shuttles and route in Maps",
    61: "What dispatch changed",
    62: "Your route, learned airlines",
    63: "Live sync, re-message flags",
    64: "New Settings, shared places",
    65: "Test alerts, late flights",
    66: "Alerts without the ntfy app",
    67: "Run numbers, tidier stops",
    68: "Calmer cards, a menu each",
  }[major] || null;
}

/** The line after an update: after one the driver pulled in, as before, and
 *  also when this phone has crossed into a new whole number since it last
 *  ran -- then with what's new. A phone updated before it kept a version came
 *  from an older whole number; a first install says nothing. */
function updateLine(v, seen, justUpdated) {
  if (!v) return justUpdated ? "APP UPDATED" : null;
  const major = versionMajor(v);
  const before = seen ? versionMajor(seen) : justUpdated && major !== null ? major - 1 : null;
  const news = major !== null && before !== null && major > before ? releaseNews(major) : null;
  if (!justUpdated && !news) return null;
  return `UPDATED TO ${v.toUpperCase()}${news ? ` · ${news.toUpperCase()}` : ""}`;
}

(function setupPullToRefresh() {
  const indicator = pullStrip;
  const label = pullLabel;
  const THRESHOLD = 70;
  const MAX_PULL = 110;

  let startY = null;
  let pulling = false;
  let refreshing = false;

  document.addEventListener("touchstart", (e) => {
    // Not under a sheet: a swipe down in Settings or an editor scrolls the
    // sheet, and a refresh behind it could reload the page (an update) with
    // whatever was being typed.
    if (refreshing || pageScroll() > 0 || topmostOpenSheet()) return;
    startY = e.touches[0].clientY;
    pulling = true;
    indicator.classList.remove("settling");
    indicator.classList.add("dragging");
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!pulling || startY === null || refreshing) return;
    const delta = e.touches[0].clientY - startY;
    if (delta <= 0) return;
    const pull = Math.min(delta * 0.5, MAX_PULL);
    indicator.style.transform = `translateY(${pull - 56}px)`;
    indicator.classList.toggle("ready", pull >= THRESHOLD);
    label.textContent = pull >= THRESHOLD ? "RELEASE TO REFRESH" : "PULL TO REFRESH";
  }, { passive: true });

  document.addEventListener("touchend", () => {
    if (!pulling || refreshing) return;
    pulling = false;
    indicator.classList.remove("dragging");
    indicator.classList.add("settling");

    if (indicator.classList.contains("ready")) {
      refreshing = true;
      indicator.classList.add("refreshing");
      indicator.style.transform = "translateY(0px)";
      label.textContent = "REFRESHING";
      // A load that throws had no saved copy to fall back on: offline all the same.
      const loaded = loadAssignments().then(() => null, (err) => { console.error(err); return err; });
      Promise.all([loaded, findUpdate()]).then(([failure, update]) => {
        if (update) {
          label.textContent = "UPDATING";
          // Already in charge (UPDATE was showing): now. Otherwise when it
          // takes over, or regardless after a wait: the shell is network-first.
          if (!document.getElementById("update-btn").hidden) return reloadIntoUpdate();
          reloadOnTakeover = true;
          setTimeout(reloadIntoUpdate, 8000);
          return;
        }
        pullSay(!failure && !offline ? "UP TO DATE"
          : failure ? (failure.status ? "SERVER PROBLEM" : "NO SIGNAL")
          : serverTrouble ? "SERVER PROBLEM · SAVED COPY" : "NO SIGNAL · SAVED COPY",
          () => { refreshing = false; });
      });
    } else {
      indicator.style.transform = "translateY(-56px)";
    }
    startY = null;
  });
})();

/* ================= INIT ================= */

/**
 * First run, with no code stored. Registering one silently is what filled the
 * namespace with orphan lists: a new browser, a private window or cleared site
 * data all look exactly like a new user, so the app quietly minted a fresh
 * empty list while the real one stayed on the server, unreachable. The code is
 * the only way back and there is no recovery, so creating a list is now a
 * deliberate act with the recovery path sitting right next to it.
 */
function renderWelcome() {
  main.innerHTML = `
    <div class="welcome">
      <span class="eyebrow">FIRST RUN</span>
      <h2>Do you already have a list code?</h2>
      <p class="welcome-note">Your code is the only way back to your assignments. If you have one
      from another device, enter it here &mdash; starting a new list will not find it.</p>
      <div class="field">
        <label for="w-code">LIST CODE</label>
        <input class="input" id="w-code" placeholder="a1b2c3d4" autocomplete="off"
               autocapitalize="off" spellcheck="false" />
      </div>
      <p class="field-error" id="w-error"></p>
      <button class="submit" id="w-use" type="button">USE THIS CODE</button>
      <button class="mini-btn welcome-new" id="w-new" type="button">START A NEW LIST</button>
      <p class="welcome-guide">New to Curbside? <a href="/guide/">Read the guide</a></p>
    </div>`;

  const errorEl = document.getElementById("w-error");
  const input = document.getElementById("w-code");

  document.getElementById("w-use").addEventListener("click", async () => {
    const trimmed = input.value.trim();
    if (!trimmed) { errorEl.textContent = "Enter a code, or start a new list."; return; }
    errorEl.textContent = "";
    try {
      if (await adoptCode(trimmed)) return;
      errorEl.textContent = "That code isn't recognised — check it and try again.";
    } catch (err) {
      console.error(err);
      errorEl.textContent = "Couldn't reach the server. Try again.";
    }
  });

  document.getElementById("w-new").addEventListener("click", async () => {
    errorEl.textContent = "";
    if (!(await ensureList())) {
      errorEl.textContent = registerRefused
        ? "No new lists can be started right now: too many were today. Try again later."
        : "Couldn't set up a list. Check your connection and try again.";
      return;
    }
    try { localStorage.setItem(LS_CODE_UNSAVED, "1"); } catch { /* the screen still shows once */ }
    renderSaveCode();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("w-use").click();
  });
}

/**
 * A new list's code, once, before anything else: the code is the list's only
 * key and there is no recovery, so it goes somewhere off this phone now, not
 * after the first lost reinstall. Held until SAVED, across relaunches
 * (fw_code_unsaved); a list entered by its code never sees it.
 */
function renderSaveCode() {
  holdScreen = true;
  const canShare = typeof navigator.share === "function";
  main.innerHTML = `
    <div class="welcome save-code">
      <span class="eyebrow">YOUR NEW LIST</span>
      <h2>This code is your list. Save it now.</h2>
      <div class="code-card mono" id="sc-code">${esc(listCode)}</div>
      <p class="welcome-note">It's the only way back to your assignments on a new phone, or after
      this one's data is cleared. There is no recovery. Send it to yourself: a note, or a text.</p>
      <div class="save-actions">
        ${canShare ? `<button class="submit" id="sc-share" type="button">SHARE</button>` : ""}
        <button class="${canShare ? "mini-btn" : "submit"}" id="sc-copy" type="button">COPY</button>
      </div>
      <p class="field-error" id="sc-error"></p>
      <button class="submit quiet" id="sc-saved" type="button">SAVED</button>
      <p class="welcome-note">Settings shows the code again any time.</p>
    </div>`;

  const saved = document.getElementById("sc-saved");
  const errorEl = document.getElementById("sc-error");
  const kept = () => { saved.classList.remove("quiet"); errorEl.textContent = ""; };

  if (canShare) {
    document.getElementById("sc-share").addEventListener("click", async () => {
      try {
        await navigator.share({ text: `My Curbside list code: ${listCode}\nOpen ${location.origin}/ and tap USE THIS CODE.` });
        kept();
      } catch (err) {
        if (err && err.name !== "AbortError") errorEl.textContent = "Couldn't open Share. Copy it instead.";
      }
    });
  }
  document.getElementById("sc-copy").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(listCode);
      btn.textContent = "COPIED";
      setTimeout(() => { btn.textContent = "COPY"; }, 1200);
      kept();
    } catch (err) {
      console.error("Clipboard write failed:", err);
      errorEl.textContent = "Couldn't copy. Write the code down instead.";
    }
  });
  saved.addEventListener("click", async () => {
    try { localStorage.removeItem(LS_CODE_UNSAVED); } catch { /* nicety */ }
    holdScreen = false;
    forgetAssignments();
    await loadAssignments();
    syncSettingsSheet();
    takeShared(false); // a sheet shared before there was a list
  });
}

/** Settings' App version: the cache name of the service worker in charge
 *  ("curbside-v60.1"), the one name every release changes. Asked at load and
 *  again when a new worker takes over: the page can arrive from the network
 *  before its worker has installed, and a rollback counts down. */
function showVersion() {
  return new Promise((resolve) => {
    const worker = navigator.serviceWorker?.controller;
    if (!worker) return resolve(null); // not installed yet, or plain http: leave the dash
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }) => {
      const m = /^curbside-(v\d+(?:\.\d+)?)$/.exec(data);
      if (m) document.getElementById("set-version").textContent = m[1];
      resolve(m ? m[1] : null);
    };
    worker.postMessage("version", [channel.port2]);
    setTimeout(() => resolve(null), 2000); // a worker too old to answer
  });
}

navigator.serviceWorker?.addEventListener("controllerchange", showVersion);

(async function init() {
  let justUpdated = false;
  try { justUpdated = !!sessionStorage.getItem(SS_UPDATED); sessionStorage.removeItem(SS_UPDATED); } catch { /* nicety */ }
  showVersion().then((v) => {
    let seen = null;
    try { seen = localStorage.getItem(LS_SEEN_VERSION); if (v) localStorage.setItem(LS_SEEN_VERSION, v); } catch { /* private mode */ }
    const line = updateLine(v, seen, justUpdated);
    // With what's new, long enough to read.
    if (line) pullSay(line, null, line.includes("·") ? 3600 : PULL_SAY_MS);
  });
  setThemeMode(themeMode);
  migrateMessages();
  tickClock();
  // Opened by Share -> Curbside (sw.js answers the share with /?shared=1).
  // The address goes back to "/" at once: a reload must not say it again.
  const shared = new URLSearchParams(location.search).has("shared");
  if (shared) history.replaceState(null, "", "/");

  if (PREVIEW) {
    const s = document.createElement("script");
    s.src = "/preview.js";
    document.body.append(s);
    return;
  }
  if (!listCode) {
    renderWelcome();
    return;
  }
  let unsaved = false;
  try { unsaved = !!localStorage.getItem(LS_CODE_UNSAVED); } catch { /* nicety */ }
  if (unsaved) {
    renderSaveCode();
    return;
  }
  try {
    await loadAssignments();
  } catch (err) {
    console.error(err);
  }
  takeShared(shared);
})();

setInterval(tickClock, 1000);
