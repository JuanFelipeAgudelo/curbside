/* ============================================================================
   PHASE 6 — the app's unit is the assignment, not the flight.

   Four levels of data (assignment > step > action > entity) rendered as ONE
   scrolling itinerary. Nesting is shown with a rail and indentation, never a
   tap; depth comes from time, because the app knows what time it is and the
   driver should never have to manage disclosure.

   Two rules govern almost everything here, and both were learned the hard way:

   1. A STOP HAS TWO CLOCKS, set by different passengers. The EARLIEST
      obligation says when the driver must be parked; the LATEST says when the
      car may leave. Collapsing them into one "controlling flight" put the
      driver at LaGuardia 28 minutes after the first passenger was already on
      the ground.

   2. THE APP CONVERTS DISPATCH'S PDF, IT DOES NOT PLAN. Dispatch owns the
      assignment; the world owns the flights. So a flight delay never rewrites
      a step's time — it is reported beneath it, named for the flight that
      caused it. Two numbers with their sources is reporting. One number that
      has replaced dispatch's is deciding.

   It uses app.js's helpers (esc, icon, parseWall, shortTime, shortDate,
   instantTime, openSheet, closeSheet) rather than restating them.
   ========================================================================= */

/* ---------------------------------------------------------------- state -- */

/** /?preview: a made-up run that plays the motion studies (preview.js). Never
 *  loads from the server, never saves, and every edit is blocked. Here, not in
 *  app.js: this file loads first, and the tests load it alone. */
const PREVIEW = typeof location !== "undefined" && new URLSearchParams(location.search).has("preview");

let assignments = [];
// True while app.js's save-the-code step holds the screen: the minute tick,
// a return from the background and a late load must not paint over it.
let holdScreen = false;
let flightStatuses = {};
let flightChecks = null; // the free plan's state, from the worker (checksNote)
// Alerts on this phone (v66; app.js "ALERTS ON THIS PHONE"). The key a phone
// turns them on with comes with the runs; null when the server has none.
let pushKey = null;
// What app.js found (syncPushRow): "on"; "off", never turned on here and it
// could be; "lost", turned on and not working now; null, not looked yet or
// not possible on this phone.
let pushState = null;
let travelTimes = null;
let openAssignmentNumber = null;
// Which screen is up, so a refresh repaints THAT one: coming back from the
// dialer reloads, and it used to drop the driver from the call list.
let screen = "list"; // list | itinerary | calls
let callsDay = null;  // the day the call list shows
let listScroll = 0;   // where the list was, so BACK lands there again

const LS_ASSIGN_CACHE = "fw_assign_cache";
const LS_CALLED = "fw_called"; // {"<assignment>:<name>": "<iso>"}
const LS_TICKS = "fw_ticks";   // {"<assignment>:<note line>": "<iso>"}, per device

// HuB's own figures, measured against real assignment sheets rather than
// inferred from its configuration screen — see docs/spec-curbside.md.
const BUFFER_MIN = 15;        // parked this long before touchdown
const BUFFER_GB_MIN = 30;     // a GB arrival gets double the margin
const LEAD_DOM_MIN = 120;     // at the terminal this long before a departure
const LEAD_INTL_MIN = 180;
const DEPLANE_DOM_MIN = 45;   // landing is not arriving
const DEPLANE_INTL_MIN = 105; // bags AND customs — 45 + 60, not 60
const MOVED_MIN = 5;          // a flight time this far off schedule is "moved"

const AIRPORTS = new Set(["EWR", "JFK", "LGA", "SWF", "HPN", "ALB", "BDL"]);

/* ------------------------------------------------------------- plumbing -- */

function calledLog() {
  try { return JSON.parse(localStorage.getItem(LS_CALLED) || "{}"); }
  catch (_) { return {}; }
}

function statusFor(entity, stepDate) {
  if (!entity.flightNumber) return null;
  const date = entity.flightDate || stepDate;
  return flightStatuses[`${entity.flightNumber}:${date}`] || null;
}

/** Which leg of the flight concerns this row: an arriving passenger is met at
 *  the arrival; a departing one is dropped for the departure. */
function legOf(status, entity) {
  if (!status) return null;
  return isDepartureTag(entity.tag) ? status.departure : status.arrival;
}

function isDepartureTag(tag) {
  return tag === "D" || tag === "GBD" || tag === "TD";
}

/** International = either end outside the US and its territories. Told by the
 *  airport's country; a status stored without one falls back to its time zone,
 *  where only a US zone counts as domestic ("America/..." also covers Canada,
 *  Mexico, the Caribbean and South America, which are international). */
const US_COUNTRIES = new Set(["US", "PR", "VI", "GU", "AS", "MP"]);
const US_ZONES = /^(America\/(New_York|Detroit|Kentucky\/.+|Indiana\/.+|Chicago|Menominee|North_Dakota\/.+|Denver|Boise|Phoenix|Los_Angeles|Anchorage|Juneau|Sitka|Metlakatla|Yakutat|Nome|Adak|Puerto_Rico|St_Thomas)|Pacific\/(Honolulu|Guam|Pago_Pago|Saipan))$/;

function domesticLeg(leg) {
  if (leg.countryCode) return US_COUNTRIES.has(leg.countryCode);
  if (leg.timeZone) return US_ZONES.test(leg.timeZone);
  return null;
}

/** Null when it cannot be told, and callers fail toward the LONGER allowance:
 *  guessing domestic makes the driver leave earlier and wait, guessing
 *  international never strands anyone. Same rule as notify.ts. */
function isIntl(status) {
  if (!status) return null;
  const dep = domesticLeg(status.departure), arr = domesticLeg(status.arrival);
  if (dep === null || arr === null) return null;
  return !(dep && arr);
}

function deplaneMinutesFor(status) {
  return isIntl(status) === false ? DEPLANE_DOM_MIN : DEPLANE_INTL_MIN;
}

function leadMinutesFor(status) {
  return isIntl(status) === false ? LEAD_DOM_MIN : LEAD_INTL_MIN;
}

/** A leg's wall time on the running clock (see wallAt), preferring the live
 *  estimate. Null rather than a guess when the flight has not resolved. */
function legAt(leg) {
  const raw = leg && (leg.estimatedTime || leg.scheduledTime);
  const wall = parseWall(raw);
  return wall ? wall.getTime() / 60000 : null;
}

/** A departure's check-in deadline runs from the EARLIER of scheduled and
 *  estimated. A delayed flight does not move the check-in desk, so a delay
 *  must not tell the driver to come later -- that is the expensive mistake.
 *  Same rule as worker/src/notify.ts, so the row and the push agree.
 *  On the wall clock, and so the fallback: while a status names an instant
 *  (AeroDataBox's always has) clocksFor counts from clockInstant, which takes
 *  the same earlier-of, and this only says there is a time at all. */
function checkInBasis(leg) {
  const s = legAt(leg && { scheduledTime: leg.scheduledTime });
  const e = legAt(leg && leg.estimatedTime ? { estimatedTime: leg.estimatedTime } : null);
  if (s === null || e === null) return s === null ? e : s;
  return Math.min(s, e);
}

/** The same moment as a real instant (ms): AeroDataBox's UTC, else the local
 *  time with its printed offset. Null when neither says. */
function legInstant(leg, field) {
  if (!leg) return null;
  const utc = leg[`${field}Utc`];
  const raw = utc || (leg[field] && String(leg[field]).replace(" ", "T"));
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

/** The instant a clock is counted from: the check-in basis (earlier of
 *  scheduled and estimated) for a departure, the landing for an arrival. */
function clockInstant(leg, departure) {
  const s = legInstant(leg, "scheduledTime"), e = legInstant(leg, "estimatedTime");
  if (!departure) return e ?? s;
  return s === null ? e : e === null ? s : Math.min(s, e);
}

let homeParts = null;
/** A real instant on the running wall clock at home (America/New_York). */
function homeWall(ms) {
  homeParts = homeParts || new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const p = Object.fromEntries(homeParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return wallAt(`${p.year}-${p.month}-${p.day}`, (Number(p.hour) % 24) * 60 + Number(p.minute));
}

/** `at` moved by `minutes` of real time. Across a DST change the wall clock
 *  does not move by the same amount (an hour repeats or is skipped), and the
 *  pushes count in real time: so does the row. Wall arithmetic only when the
 *  status gave no instant. */
function wallPlus(at, instant, minutes) {
  return instant === null ? at + minutes : homeWall(instant + minutes * 60000);
}

function fmtMinutes(total) {
  if (total === null || total === undefined) return null;
  const m = ((total % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m % 60).padStart(2, "0")}${h24 < 12 ? "a" : "p"}`;
}

/** A wait: "6 min", "1h 05m". */
function fmtDuration(mins) {
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/** "2026-08-31 21:30" -> "9:30p", the one time format everywhere. shortTime()
 *  returns the digits only, which is actively wrong on a card whose window
 *  crosses noon or midnight. */
function clockLabel(raw) {
  const p = timeParts(raw);
  return p ? `${p.time}${p.meridiem[0].toLowerCase()}` : "";
}

/** What the driver needs from the vehicle cell is which car to collect, and
 *  that is the branch number. The full string is long, and the document wraps
 *  it across two lines so the tail ("Seats)") is often missing anyway. */
function vehicleLabel(vehicle) {
  if (!vehicle) return null;
  const id = vehicle.match(/\((\d{4,6})\)/);
  const model = vehicle.match(/\b(Sienna|Sprinter|Transit|Odyssey|Pacifica|Metris|Benz|Sedan)\b/i);
  if (id && model) return `${model[1].toUpperCase()} ${id[1]}`;
  if (id) return `VEHICLE ${id[1]}`;
  // No branch number means nothing the driver can go and find. A shift
  // assignment with no vehicle leaves a stray "(1 Seats)" in the cell, and
  // printing that is worse than printing nothing.
  if (/^\(\d+\s*Seats?\)$/i.test(vehicle.trim()) || vehicle.trim().length < 12) return null;
  return vehicle.length > 28 ? vehicle.slice(0, 27).trim() + "…" : vehicle;
}

/** A STEP's eta/etd come from the document as printed -- "11:00 PM" -- not as
 *  a datetime the way an assignment's start/end do. shortTime() parses the
 *  latter and returns null for the former, which is how every step time on the
 *  itinerary rendered as the word "null". */
function stepTime(printed) {
  return fmtMinutes(wallMinutes(printed));
}

function wallMinutes(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})\s*([AP])M$/i);
  if (!m) return null;
  const h = Number(m[1]) % 12;
  return (h + (m[3].toUpperCase() === "P" ? 12 : 0)) * 60 + Number(m[2]);
}

/** One running wall clock: local wall time in minutes with the date folded in,
 *  so 12:10a tomorrow is 30 minutes after 11:40p, not 23 hours before it.
 *  Every comparison of times uses it; fmtMinutes() still prints it (it wraps).
 *  Minutes of the day alone once put "RUNNING ~1466M LATE" on an overnight stop. */
function wallAt(dayIso, minutes) {
  if (minutes === null || minutes === undefined || !dayIso) return null;
  const [y, mo, d] = dayIso.split("-").map(Number);
  return Date.UTC(y, mo - 1, d) / 60000 + minutes;
}

/**
 * A time of day with no date, on a run: the run's day that puts it inside the
 * run's start-end window, else the one nearest it. Only the run's own days are
 * candidates (a run with no end is given the day after its start). One rule
 * for everything the driver or the notes give without a date -- an added
 * stop, a timed note line -- so the two always agree (the owner, 2026-09-26).
 */
function runDayOf(assignment, minutes) {
  const stamp = (s) => {
    const m = String(s || "").match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
    return m ? wallAt(m[1], Number(m[2]) * 60 + Number(m[3])) : null;
  };
  const first = String(assignment.start || "").slice(0, 10);
  const from = stamp(assignment.start);
  if (minutes === null || minutes === undefined || from === null) return first;
  const to = stamp(assignment.end) ?? from + 1440;
  let best = first, bestGap = Infinity;
  for (let d = new Date(`${first}T12:00:00Z`), n = 0; n < 7; n++, d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    const at = wallAt(day, minutes);
    if (at - minutes > to) break;           // past the run's last day
    const gap = at < from ? from - at : at > to ? at - to : 0;
    if (gap < bestGap) { best = day; bestGap = gap; }
  }
  return best;
}

/** Now, on the same clock. The driver's day is local: UTC turns the date over
 *  at 8 PM, just as the overnight runs start. */
function nowAt(now = new Date()) {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(),
                  now.getHours(), now.getMinutes()) / 60000;
}

/** "2026-08-31 21:30", local -- the shape of an assignment's start/end. */
function localStamp(now = new Date()) {
  return new Date(nowAt(now) * 60000).toISOString().slice(0, 16).replace("T", " ");
}

/** A step's eta/etd on the running clock. The sheet dates them (etaDate for
 *  arriving, date for leaving); a time the driver set sits on whichever day
 *  puts it nearest dispatch's, so 12:10a set over 11:50p is 20 minutes later. */
function stepAt(step, field) {
  const m = wallMinutes(step[field]);
  if (m === null) return null;
  let at = wallAt(field === "eta" ? step.etaDate || step.date : step.date, m);
  const sheet = wallMinutes(sheetTime(step, field));
  if (sheet !== null && at !== null) {
    if (m - sheet > 720) at -= 1440;
    else if (sheet - m > 720) at += 1440;
  }
  return at;
}

/** Dispatch's time for a step field, under any correction the driver made.
 *  The driver's is in the field itself -- every clock runs on it -- so every
 *  "dispatch planned" reads dispatch's from here. An added stop's one `time`
 *  counts for both. Same rule as sheetTime in notify.ts. */
function sheetTime(step, field) {
  const e = step._edit && (step._edit[field] || step._edit.time);
  return e ? e.documentValue : (step[field] ?? null);
}

/** "3:40 PM" -> "15:40", for <input type=time>. */
function inputTime(printed) {
  const m = wallMinutes(printed);
  return m === null ? "" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "8:10a – 9:10a" / "AT 8:10a" / "ETA 8:10a" / "ETD 8:10a". */
function timesLabel(eta, etd) {
  return eta
    ? (etd && etd !== eta ? `${stepTime(eta)} &ndash; ${stepTime(etd)}`
       : etd ? `AT ${stepTime(eta)}` : `ETA ${stepTime(eta)}`)
    : (etd ? `ETD ${stepTime(etd)}` : "");
}

/** The stop head's times, beside the rail that already shows the first one
 *  (eta, else etd): only what the rail doesn't say -- when the stop ends, or
 *  what the rail's time is (audit #16, v62.1). */
function headTimes(eta, etd) {
  if (eta && etd && etd !== eta) return `until ${stepTime(etd)}`;
  if (eta && etd) return "ARRIVE &amp; LEAVE";
  return eta ? "ARRIVE" : etd ? "LEAVE" : "";
}

/* ------------------------------------------------------ the two clocks -- */

/**
 * What a step's own arithmetic says, beside what dispatch scheduled.
 *
 * `parkedBy` is the EARLIEST obligation across every row at the stop — a
 * pickup's obligation is its touchdown minus the buffer, a drop-off's is its
 * check-in deadline. `leavingAt` is the LATEST release: an arrival plus its
 * deplane allowance, a departure the moment it is handed over.
 *
 * One sentence covers arrivals, departures and the mixed stops that are both:
 * be there for the earliest obligation, leave after the latest one.
 */
function clocksFor(step) {
  const date = step.etaDate || step.date;
  let parkedBy = null, leavingAt = null;
  let firstName = null, lastName = null, parkedWhy = "", leavingWhy = "";
  const clocks = () => ({ parkedBy, leavingAt, firstName, lastName, parkedWhy, leavingWhy });
  // A flight is worked at the airport. A drop-off at home of someone who
  // landed earlier has no flight clock of its own (as stopsFor in notify.ts).
  if (!AIRPORTS.has(step.code)) return clocks();

  for (const action of step.actions || []) {
    for (const entity of action.entities || []) {
      // Not coming, on the driver's word: they set no clock.
      if (entity._removed) continue;
      const status = statusFor(entity, date);
      const leg = legOf(status, entity);
      const departure = isDepartureTag(entity.tag);
      const at = departure ? checkInBasis(leg) : legAt(leg);
      if (at === null) continue;
      const instant = clockInstant(leg, departure);

      const code = entity.flightNumber;
      if (departure) {
        const lead = leadMinutesFor(status);
        const due = wallPlus(at, instant, -lead);
        if (parkedBy === null || due < parkedBy) {
          parkedBy = due; firstName = code;
          parkedWhy = `${code} check-in, ${lead / 60}h ${isIntl(status) === false ? "domestic" : "international"}`;
        }
      } else {
        const buffer = entity.gb ? BUFFER_GB_MIN : BUFFER_MIN;
        const due = wallPlus(at, instant, -buffer);
        if (parkedBy === null || due < parkedBy) {
          parkedBy = due; firstName = code;
          parkedWhy = `before ${code} lands ${fmtMinutes(at)}`;
        }
        const wait = deplaneMinutesFor(status);
        const free = wallPlus(at, instant, wait);
        if (leavingAt === null || free > leavingAt) {
          leavingAt = free; lastName = code;
          leavingWhy = `${code} ${fmtMinutes(at)} + ${wait}m ${isIntl(status) === false ? "bags" : "customs"}`;
        }
      }
    }
  }
  return clocks();
}

/* ------------------------------------------------------------ rendering -- */

/* ------------------------------------------------------------ messages -- */

/*
 * Passengers are messaged, never called (the owner, 2026-09-28): WhatsApp
 * first, Messages when there's no WhatsApp. The driver's own message for the
 * passenger's kind of trip (messages.js) opens filled in; the driver sends it.
 */

/** A place as a passenger knows it: an airport by its code, anywhere else by
 *  the site dispatch printed (Warwick, Patterson), never the door -- "Main
 *  Lobby" says nothing about which one (the owner, 2026-09-30). */
function placeName(step) {
  if (AIRPORTS.has(step.code)) return step.code;
  return String(step.place || "").trim() || step.code || null;
}

/** Where the driver waits at a stop: the door dispatch printed ("A-res WRK",
 *  "Baggage Claim"), else the place itself. */
function doorName(step, action) {
  return String((action && action.where) || "").trim() || placeName(step);
}

/** When the passenger is collected. An arrival: the landing, live once the
 *  flight is tracked, the printed time before, dispatch's time at the stop
 *  last. Anyone else: dispatch's time at their door, never their flight's. */
function pickupWhen(step, e, plan) {
  const date = step.etaDate || step.date;
  if (isDepartureTag(e.tag)) return stepAt(step, "eta") ?? stepAt(step, "etd");
  // `plan`: the sheet's own time, whatever the flight is doing (saidOf).
  const live = plan ? null : legAt(legOf(statusFor(e, date), e));
  const printed = wallAt(date, wallMinutes(splitScheduled(e.scheduledText).at));
  return live ?? printed ?? stepAt(step, "eta") ?? stepAt(step, "etd");
}

/**
 * What a message needs about one passenger on one run, read from the run as
 * the app holds it (the driver's corrections included): their pickup -- the
 * door and the time -- and where they are going. A row the app can't place
 * (no pickup lists them) still gets its name, tag and flight; the rest stays
 * in brackets in the draft.
 */
function messageFacts(assignment, entity, plan) {
  const name = entity.name;
  const steps = (assignment.steps || []).filter((s) => !s._removed);
  const holds = (action) => (action.entities || []).some((x) => x.name === name && !x._removed);
  let pick = null, drop = null;
  steps.forEach((step, i) => {
    for (const action of step.actions || []) {
      if (!pick && /pickup/i.test(action.verb || "") && holds(action)) pick = { i, step, action };
      else if (pick && !drop && i > pick.i && /drop/i.test(action.verb || "") && holds(action)) drop = { step, action };
    }
  });
  const e = pick ? pick.action.entities.find((x) => x.name === name) : entity;
  const when = pick ? pickupWhen(pick.step, e, plan) : null;
  return {
    name,
    phone: e.phone || null,
    pax: e.pax,
    tag: e.tag,
    kind: messageKind(e.tag),
    from: pick ? placeName(pick.step) : null,
    to: drop ? placeName(drop.step) : null,
    door: pick ? doorName(pick.step, pick.action) : null,
    flight: e.flightNumber || null,
    time: when === null ? null : fmtMinutes(when),
    appointment: e.appointmentTime ? stepTime(e.appointmentTime) || e.appointmentTime : null,
    day: pick ? pick.step.etaDate || pick.step.date : assignment.start.slice(0, 10),
  };
}

/** The draft for this passenger, or "" for an empty chat: on the day of the
 *  run the message ("see you tomorrow") is past, and at the kerb the driver
 *  writes their own (the owner, 2026-09-29). */
function messageText(assignment, facts, now = new Date(), update = false) {
  const today = localStamp(now).slice(0, 10);
  if (today >= assignment.start.slice(0, 10)) return "";
  const text = fillMessage(messageTemplate(facts.kind), facts, { greet: greetOf(facts.name), myName: myName(), today });
  // Messaged before a change: the same message with the new details, said
  // to be one (the owner, 2026-09-30).
  return update ? `Update:\n${text}` : text;
}

const DAY_OF_WORDS = "It's the day of the run, so WHATSAPP and TEXT open an empty chat: your saved message is for the evening before.";

/** The run's own page says it too (v65), once, above the stops: on the day,
 *  until the run starts, when someone on it has a number to message. Under
 *  way, the page is for driving and the call list still says it (the owner,
 *  2026-10-04). */
function dayOfNote(assignment, now = new Date()) {
  const stamp = localStamp(now);
  if (stamp.slice(0, 10) < assignment.start.slice(0, 10) || stamp >= assignment.start) return "";
  const anyPhone = (assignment.steps || []).some((s) => !s._removed && (s.actions || []).some((a) =>
    (a.entities || []).some((e) => !e._removed && e.phone)));
  return anyPhone ? `<p class="daynote">${esc(DAY_OF_WORDS)}</p>` : "";
}

/*
 * Messaged, then it changed (the owner, 2026-09-30). Sheets land around 5 PM,
 * the driver messages everyone that evening, and dispatch re-sends the same
 * evening: the passenger was told the old time. So a tick keeps what the
 * message said, and a passenger whose plan no longer matches it counts as
 * still to message, with what moved, until the driver ticks them again.
 *
 * The plan only: dispatch's sheet with the driver's own corrections. A flight
 * running late is not a change of plan and never flags anyone.
 */
const SAID = [["time", "time"], ["door", "door"], ["from", "from"], ["to", "to"], ["flight", "flight"],
              ["appointment", "appointment"], ["day", "day"], ["phone", "number"]];

/** What a message sent now would tell this passenger, as the tick keeps it. */
function saidOf(assignment, entity) {
  const facts = messageFacts(assignment, entity, true);
  return Object.fromEntries(SAID.map(([field]) => [field, facts[field] ?? null]));
}

/**
 * Whether this passenger was ticked as messaged, and what has changed since:
 * null (not ticked), or { at, changes: [{ field, label, now, was }] }. A tick
 * from before ticks kept what was said (a plain date) is never changed.
 */
function messaged(assignment, entity) {
  const entry = calledLog()[`${assignment.number}:${entity.name}`];
  if (!entry) return null;
  if (typeof entry === "string") return { at: entry, changes: [] };
  const was = entry.said || {};
  const now = entry.said ? saidOf(assignment, entity) : {};
  const changes = SAID.filter(([field]) => {
    // A flight the sheet left unreadable and the driver has since filled in
    // is not news to the passenger whose flight it is.
    if (field === "flight" && !was.flight) return false;
    return (was[field] ?? null) !== (now[field] ?? null);
  }).map(([field, label]) => ({ field, label, now: now[field] ?? null, was: was[field] ?? null }));
  return { at: entry.at, changes };
}

/** People on the run messaged before their plan changed: each once, however
 *  many rows they have (the list card, v65). */
function staleCount(assignment) {
  const names = new Set();
  for (const s of assignment.steps || []) {
    if (s._removed) continue;
    for (const a of s.actions || []) {
      for (const e of a.entities || []) {
        if (e._removed || !e.phone || names.has(e.name)) continue;
        const m = messaged(assignment, e);
        if (m && m.changes.length) names.add(e.name);
      }
    }
  }
  return names.size;
}

/** Ticked, and still true. */
function messageDone(assignment, entity) {
  const m = messaged(assignment, entity);
  return Boolean(m && !m.changes.length);
}

/** "time 7:30a (was 7:00a) · door A Side (was A Front)" */
function changedWords(changes) {
  const say = (c, v) => (v === null ? `no ${c.label}` : c.field === "day" ? shortDate(v) : v);
  return changes.map((c) => `${c.label} ${say(c, c.now)} (was ${c.was === null ? "none" : say(c, c.was)})`).join(" · ");
}

/** A single's Brother or Sister is asked the first time a draft needs it. */
function needsGreeting(assignment, facts, now = new Date()) {
  return !isParty(facts) && !greetOf(facts.name)
    && localStamp(now).slice(0, 10) < assignment.start.slice(0, 10)
    && /\[\s*name\s*\]/i.test(messageTemplate(facts.kind));
}

/** WHATSAPP and TEXT for one number. While the greeting is still to be asked
 *  they are buttons that ask first; after, plain links. `size`: "" the call
 *  list's full-width pair, "small" a party's other number, "c" the run's card,
 *  where the pair sits on the number's own line (v68): there the word alone,
 *  WA and TEXT, named aloud for `who` it reaches. */
function messageButtons(phone, text, ask, size, who) {
  const cls = size ? ` ${size}` : "";
  const compact = size === "c";
  const wa = waNumber(phone);
  const face = (ico, label) => (compact ? label : `${icon(ico, "ico-sm")}${label}`);
  const say = (label) => (compact ? ` aria-label="${esc(`${label} ${who}`)}"` : "");
  const waWord = compact ? "WA" : "WHATSAPP";
  if (ask) {
    const b = (channel, label, ico, name) => `<button class="msgbtn ${channel}${cls}${wa ? "" : " only"}" type="button" data-ask="${channel}"
        data-phone="${esc(phone)}"${say(name)}>${face(ico, label)}</button>`;
    return `${wa ? b("wa", waWord, "message-circle", "WhatsApp") : ""}${b("sms", "TEXT", "message-square", "Text")}`;
  }
  return `${wa ? `<a class="msgbtn wa${cls}" href="${esc(waLink(phone, text))}" target="_blank" rel="noopener"${say("WhatsApp")}>${
      face("message-circle", waWord)}</a>` : ""}<a class="msgbtn sms${cls}${wa ? "" : " only"}" href="${
      esc(smsLink(phone, text))}"${say("Text")}>${face("message-square", "TEXT")}</a>`;
}

/**
 * The passenger's number and the ways to message it, for the call list and
 * the itinerary row alike. The number is shown, not dialled (no calling, the
 * owner). A party's other numbers get their own smaller pair: never merged
 * into the first, which is the one corrections target.
 *
 * `card` (v68, the run's card only): { mark, key }. There the pair is compact
 * and on the number's line, dropping under it where the two do not fit;
 * MESSAGED is under the number; the greeting chip is in the passenger's menu;
 * and the number itself carries the dot of the driver's own correction
 * (`mark`, editMark's classes), which FIX used to carry.
 */
function contactBlock(assignment, entity, wasPhone, card) {
  // A re-sent sheet with another number: the old one struck beside it.
  const was = wasPhone === undefined ? "" : struck(esc(wasPhone || "no number"), "mono");
  if (!entity.phone) {
    // 61 of 411 rows in the sample carry no number, and 29 print the label with
    // nothing after it. The driver still has to reach them, so say so.
    return card
      ? `<span class="tel none"><span class="telnum${card.mark}" data-mark="${esc(card.key)}">NO NUMBER PRINTED</span></span>${was}`
      : `<span class="tel none">NO NUMBER PRINTED</span>${was}`;
  }
  const facts = messageFacts(assignment, entity);
  const sent = messaged(assignment, entity);
  const stale = Boolean(sent && sent.changes.length);
  const text = messageText(assignment, facts, undefined, stale);
  const ask = needsGreeting(assignment, facts);
  const tag = sent ? `<span class="when${stale ? " stale" : ""}">MESSAGED ${esc(instantTime(sent.at) || "")}${
    stale ? " &middot; CHANGED SINCE" : ""}</span>` : "";
  const nowa = waNumber(entity.phone) ? ""
    : `<span class="pendnote">No country code, so no WhatsApp: add it ${
        card ? "" : "on the run, "}under &bull;&bull;&bull; Fix phone.</span>`;
  const others = (Array.isArray(entity.otherPhones) ? entity.otherPhones : []).map((n) => `
      <div class="msgother"><span class="tel">${esc(n)}</span>
        <span class="msgbtns">${messageButtons(n, text, ask, "small")}</span></div>`).join("");
  const greet = greetOf(entity.name);
  const chip = !card && !isParty(facts) && greet
    ? `<button class="greet-chip" type="button" data-ask="" aria-label="Greeting for ${esc(entity.name)}">${
        GREET_WORDS[greet] || ""}</button>` : "";
  const head = card
    ? `<div class="telline">
        <div class="telwho">
          <div class="tel"><span class="telnum${card.mark}" data-mark="${esc(card.key)}">${esc(entity.phone)}</span>${was}</div>
          ${tag}
        </div>
        <div class="msgbtns c">${messageButtons(entity.phone, text, ask, "c", entity.name)}</div>
      </div>`
    : `<div class="tel${stale ? " changed" : ""}">${esc(entity.phone)}${was}${chip}${tag}</div>
      <div class="msgbtns">${messageButtons(entity.phone, text, ask, "")}</div>`;
  return `<div class="msgbox" data-msg="${esc(`${assignment.number}:${entity.name}`)}">
      ${head}
      ${nowa}
      <div class="greet-ask" hidden>
        <span class="greet-q">Dear &hellip; ${esc(lastNameOf(entity.name))}?</span>
        <div class="seg" role="group" aria-label="Greeting for ${esc(entity.name)}">
          ${greetButtons(null)}
        </div>
        <p class="seg-help">Asked once for each person, then remembered on this phone.</p>
      </div>
      ${others}
    </div>`;
}

const GREET_WORDS = { brother: "BROTHER", sister: "SISTER", name: "NAME ONLY" };

/** The three answers to "Dear ... ?": on the card the first time a draft
 *  needs one, and in the passenger's menu, where `chosen` is the one kept. */
function greetButtons(chosen) {
  return Object.entries(GREET_WORDS).map(([key, word]) => `<button type="button" data-greet="${key}"${
    chosen === null ? "" : ` aria-pressed="${chosen === key}"`}>${word}</button>`).join("\n          ");
}

/** Wires every contact block under `root`. Tapping WHATSAPP or TEXT before
 *  the greeting is known opens the question; the answer is kept and the draft
 *  opens at once. The greeting chip opens it to change the answer only. */
function wireMessages(root) {
  root.querySelectorAll(".msgbox").forEach((box) => {
    const ask = box.querySelector(".greet-ask");
    box.querySelectorAll("[data-ask]").forEach((btn) => btn.addEventListener("click", () => {
      const same = !ask.hidden && ask.dataset.channel === btn.dataset.ask && ask.dataset.phone === (btn.dataset.phone || "");
      ask.hidden = same;
      ask.dataset.channel = btn.dataset.ask;
      ask.dataset.phone = btn.dataset.phone || "";
    }));
    ask.querySelectorAll("[data-greet]").forEach((btn) => btn.addEventListener("click", () => {
      const [number, ...rest] = box.dataset.msg.split(":");
      const name = rest.join(":");
      setGreet(name, btn.dataset.greet);
      const { channel, phone } = ask.dataset;
      const a = assignments.find((x) => x.number === number);
      const entity = a && entityNamed(a, name);
      if (channel && phone && a && entity) {
        const sent = messaged(a, entity);
        const text = messageText(a, messageFacts(a, entity), undefined, Boolean(sent && sent.changes.length));
        if (channel === "wa") window.open(waLink(phone, text), "_blank", "noopener");
        else window.location.href = smsLink(phone, text);
      }
      renderCurrent();
    }));
  });
}

function entityNamed(assignment, name) {
  for (const step of assignment.steps || []) {
    for (const action of step.actions || []) {
      const e = (action.entities || []).find((x) => x.name === name && !x._removed);
      if (e) return e;
    }
  }
  return null;
}

/** `roll` names the value for motion.js, so a change between paints rolls.
 *  `was`: dispatch's old value, struck under it (a re-sent sheet). */
function slot(label, value, cls, roll, was) {
  const r = roll ? ` data-roll="${esc(roll)}"` : "";
  const shown = value === null || value === undefined || value === ""
    ? `<b class="pending"${r}>&mdash;</b>`
    : `<b class="${cls || ""}"${r}>${esc(String(value))}</b>`;
  const old = was === undefined ? "" : struck(esc(was === null || was === "" ? "—" : String(was)));
  return `<span><span class="k">${label}</span>${shown}${old}</span>`;
}

/** TERM / GATE / BELT / BAGS, on the row they belong to. Always drawn, so the
 *  row never changes shape; an em-dash means not published yet. */
function instrumentLine(entity, status, rollKey, wasBags) {
  const leg = legOf(status, entity);
  const departing = isDepartureTag(entity.tag);
  // The airport's three roll when they change; BAGS is dispatch's and doesn't.
  const slots = [
    slot("TERM", leg && leg.terminal, "", `${rollKey}|term`),
    slot("GATE", leg && leg.gate, "", `${rollKey}|gate`),
  ];
  // A departure has no carousel — baggageBelt is null for departures by
  // definition, so showing the slot would promise a value that never comes.
  if (!departing) slots.push(slot("BELT", leg && leg.baggageBelt, "", `${rollKey}|belt`));
  slots.push(slot("BAGS", entity.bags, "", undefined, wasBags));
  return `<div class="instr">${slots.join("")}</div>`;
}

/** `wasSched`: the flight's printed time and city on dispatch's older copy. */
function statusLine(entity, status, rollKey, wasSched) {
  const bits = [];
  if (status && status.airline) bits.push(esc(status.airline));

  const printed = splitScheduled(entity.scheduledText);
  const departing = isDepartureTag(entity.tag);
  const place = printed.place || (departing ? entity.destination : entity.origin);
  if (place) bits.push(esc(departing ? `to ${place}` : `from ${place}`));

  const leg = legOf(status, entity);
  const at = legAt(leg);
  if (status && at !== null) {
    // Live. Blue only when the time moved 5 min or more from schedule, with
    // the schedule beside it; a flight on time is plain ink. Red is kept for
    // problems, and a landing is not one.
    const sched = legAt(leg.scheduledTime ? { scheduledTime: leg.scheduledTime } : null);
    const moved = sched !== null && Math.abs(at - sched) >= MOVED_MIN;
    bits.push(`<b class="${moved ? "moved" : "ontime"}" data-roll="${esc(rollKey)}|status">${esc(status.status.toLowerCase())} ${esc(fmtMinutes(at))}</b>${
      moved ? ` sched ${esc(fmtMinutes(sched))}` : ""}`);
  } else if (printed.at) {
    // Not tracking yet. The printed time is still what the driver has, and
    // saying so is more use than an empty row.
    bits.push(`${esc(fmtMinutes(wallMinutes(printed.at)) || printed.at)} <span class="muted">as printed</span>`);
  }
  if (wasSched !== undefined) {
    // Dispatch reprinted the flight: its old time (and city, when that moved).
    const old = splitScheduled(wasSched);
    const words = old.at
      ? `${fmtMinutes(wallMinutes(old.at)) || old.at}${old.place && old.place !== printed.place ? ` ${old.place}` : ""}`
      : wasSched || "no time";
    bits.push(struck(esc(words)));
  }
  return bits.length ? `<div class="estat">${bits.join(" &middot; ")}</div>` : "";
}

/** The document prints one cell: "11:15 PM Houston, Texas (IAH)". Rendered
 *  whole behind the word "from" it reads backwards, so split it: the city is
 *  the place, the time is the schedule. */
function splitScheduled(text) {
  const m = String(text || "").match(/^(\d{1,2}:\d{2}\s*[AP]M)\s*(.*)$/i);
  return m ? { at: m[1], place: m[2].trim() } : { at: null, place: text || "" };
}

/**
 * A row the driver said is not happening: struck and dim, with its own undo for
 * as long as the run exists. Never a toast, and never gone -- dispatch's copy is
 * still underneath, and a no-show at 2 AM is sometimes just late.
 */
function ghost(mark, what, verb) {
  return `<div class="ghost">
      <span class="gwhat">${esc(what)}</span>
      <span class="gverb">${verb}${mark.pending ? " &middot; waiting for signal" : ""}</span>
      <button class="mini-btn" type="button" data-use="${esc(mark.patchId)}">UNDO</button>
    </div>`;
}

/** A row the driver added: labelled as theirs, and never blended with
 *  dispatch's. When a later sheet has it too, that is said -- and the driver,
 *  not the app, clears their copy. */
function addedMark(mark, agreedText) {
  if (!mark) return { chip: "", row: "" };
  return {
    chip: `<span class="mine${mark.pending ? " pending" : ""}" title="Added by you, not on dispatch's sheet">YOURS</span>`,
    row: mark.agreed
      ? `<div class="contest agreed"><span>${agreedText}</span>
           <button class="mini-btn" type="button" data-use="${esc(mark.patchId)}">CLEAR MINE</button></div>`
      : "",
  };
}

const FLIGHT_TAGS = ["A", "D", "GBA", "GBD"];

/** What openEdit is given for a passenger's flight or phone. The card's own
 *  button and the menu's row are made from this, so they open one correction.
 *  A flight filled from an airline the list learned has no sheet value: the
 *  sheet itself left it blank. */
function entitySpec(entity, field) {
  const e = entity._edit && entity._edit[field];
  const learned = field === "flightNumber" && entity._learned && !e;
  return {
    at: entity._at, field,
    label: `${field === "phone" ? "Phone" : "Flight"} for ${entity.name}`,
    current: entity[field] ?? null,
    documentValue: (e ? e.documentValue : learned ? null : entity[field]) ?? null,
  };
}

function renderEntity(entity, step, assignment, clocks) {
  const at = entity._at;
  if (entity._removed) {
    // Their own row, taken back, is removed; dispatch's passenger is not coming.
    return `<div class="entity gone" data-at="${esc(at)}">${
      ghost(entity._removed, entity.name, entity._add ? "REMOVED" : "NOT COMING")}</div>`;
  }
  const mine = addedMark(entity._add, "The sheet lists them now too");
  // What a re-sent sheet changed about them. A value the driver set is theirs
  // and is never struck (the panel says where it stands).
  const sm = sheetMarks(assignment);
  const em = (sm && sm.entity[at]) || null;
  const facts = (em && em.facts) || {};
  const mineOn = (field) => Boolean(entity._edit && entity._edit[field]);
  const differs = (a, b) => String(a ?? "").trim().toLowerCase() !== String(b ?? "").trim().toLowerCase();
  const sheetChip = em && em.added ? NEW_CHIP
    : em && em.moved ? `<span class="schip">${em.moved.from ? "MOVED HERE" : "NEW HERE"}</span>` : "";
  const movedFrom = em && em.moved && em.moved.from ? `<div class="estat">was at ${esc(em.moved.from)}</div>` : "";
  const f = facts.flight;
  const flightWas = f && !mineOn("flightNumber") && differs(f.flightNumber, entity.flightNumber)
    ? struck(esc(f.flightNumber || "no flight"), "mono") : "";
  const schedWas = f && differs(f.scheduledText, entity.scheduledText) ? f.scheduledText ?? null : undefined;
  const phoneWas = facts.phone && !mineOn("phone") && differs(facts.phone.phone, entity.phone)
    ? facts.phone.phone ?? null : undefined;
  const bagsWas = facts.bags ? facts.bags.bags ?? null : undefined;
  const tagWas = facts.tag && differs(facts.tag.tag, entity.tag) ? struck(esc(facts.tag.tag || "no tag"), "mono") : "";
  const noteWas = facts.note && !mineOn("note")
    ? `<div class="estat">Note: ${struck(esc(facts.note.note || "none"))}</div>` : "";
  // BAGS has its slot on a flight row; anywhere else, a line like the rest.
  const otherWas = ["pax", "appointment", "trip", ...(entity.flightNumber ? [] : ["bags"])].filter((k) => facts[k])
    .map((k) => `<div class="estat">was ${struck(esc(factWords(k, facts[k]) || "not given"))}</div>`).join("");
  const date = step.etaDate || step.date;
  const status = statusFor(entity, date);
  const controlling = clocks.lastName && entity.flightNumber === clocks.lastName;
  const earliest = clocks.firstName && entity.flightNumber === clocks.firstName;

  // Named for the clock it sets, so the clock and the passenger point at each
  // other. Only said when the two clocks come from different flights.
  let role = "";
  if (earliest && clocks.firstName !== clocks.lastName) {
    role = `<div class="role">Sets Parked by</div>`;
  } else if (controlling && clocks.firstName !== clocks.lastName) {
    role = `<div class="role">Sets Leaving</div>`;
  }

  const tag = entity.tag
    ? `<span class="etag${entity.gb ? " gb" : ""}">${esc(entity.tag)}</span>` : "";
  // A flight row with no number is the headline gap: the importer would not
  // guess an airline. The blank is a dashed button where the number goes.
  const isFlightRow = FLIGHT_TAGS.includes(entity.tag);
  const fMark = editMark(entity, "flightNumber");
  // Filled from an airline the list learned: the sheet itself left it blank.
  const learned = entity._learned && !fMark.cls;
  const flight = entity.flightNumber || isFlightRow
    ? `<button class="editable eflight${entity.flightNumber ? "" : " empty"}${fMark.cls}${learned ? " edited" : ""}" type="button"
         data-edit="${esc(JSON.stringify(entitySpec(entity, "flightNumber")))}">${
         entity.flightNumber ? esc(entity.flightNumber) : "ADD FLIGHT"}</button>${
         learned ? `<span class="lword">LEARNED</span>` : ""}` : "";

  // The number's correction, not coming and the greeting are in the row's own
  // menu (v68): one button at the end of the name line, never on the number.
  const pMark = editMark(entity, "phone");
  const more = `<button class="more" type="button" data-more="${esc(at)}" aria-label="More for ${esc(entity.name)}">${
    icon("ellipsis")}</button>`;

  const unsupported = entity.unsupported
    ? `<div class="pendnote">${esc(entity.unsupported)} &mdash; not tracked</div>` : "";
  const note = entity.note ? `<div class="estat">Note: ${esc(entity.note)}</div>` : "";
  const appt = entity.appointmentTime
    ? `<div class="estat">${esc(entity.appointmentTime)}${entity.duration ? " &middot; " + esc(entity.duration) : ""}</div>` : "";

  return `
    <div class="entity${entity._add ? " added" : ""}" data-at="${esc(at)}">
      <div class="erow"><span class="ename">${esc(entity.name)}</span>${mine.chip}${sheetChip}${tag}${tagWas}${flight}${flightWas}${more}</div>
      ${movedFrom}${fMark.row}
      ${statusLine(entity, status, `${assignment.number}|${at}`, schedWas)}
      ${entity.flightNumber ? instrumentLine(entity, status, `${assignment.number}|${at}`, bagsWas) : ""}
      ${appt}${unsupported}${role}${note}${noteWas}${otherWas}
      ${contactBlock(assignment, entity, phoneWas, { mark: pMark.cls, key: `${at}|phone` })}
      ${pMark.row}${mine.row}
    </div>`;
}

/** "2026-06-04 17:17" -> "Thu 4 Jun, 5:17 PM" */
function stampLabel(raw) {
  const day = shortDate(String(raw).slice(0, 10));
  const at = clockLabel(raw);
  return [day, at].filter(Boolean).join(", ");
}

/** The line under a clock: dispatch's number, and the driver's beside it when
 *  they set their own. */
function planned(step, field) {
  const theirs = sheetTime(step, field);
  const mine = step[field];
  if (!theirs && !mine) return "";
  if (mine && mine !== theirs) {
    return `<br>you set ${esc(stepTime(mine))}${theirs ? `, ${step._add ? "phoned in" : "dispatch"} ${esc(stepTime(theirs))}` : ""}`;
  }
  return `<br>dispatch planned ${esc(stepTime(theirs))}`;
}

/** Finished: past its leave time, or, while a flight holds the driver there,
 *  past the flight clock's LEAVING (the owner, 2026-09-25). Dispatch's 12:00a
 *  with UA1503 down at 11:41p keeps LGA the stop until 12:26a -- where the
 *  driver is, not a new plan; dispatch's time is still what is printed. A
 *  step with no leave time lasts its day. */
function stepDone(step, clocks, now) {
  const etd = stepAt(step, "etd");
  if (etd === null) return wallAt(step.date, 1440) <= now;
  return Math.max(etd, clocks.leavingAt ?? etd) < now;
}

/** When a run is really over, as a "2026-08-31 21:30" stamp: its printed end,
 *  or later if a stop is still worked after it -- a late flight's Leaving at
 *  (stepDone's own test). The printed end alone stopped the refetch, let the
 *  screen sleep and moved the run to EARLIER while the driver still waited. */
function effectiveEnd(assignment) {
  let end = assignment.end;
  for (const step of assignment.steps || []) {
    if (step._removed) continue;
    const etd = stepAt(step, "etd");
    if (etd === null) continue;
    const leaves = Math.max(etd, clocksFor(step).leavingAt ?? etd);
    const stamp = new Date(leaves * 60000).toISOString().slice(0, 16).replace("T", " ");
    if (!end || stamp > end) end = stamp;
  }
  return end;
}

/* ------------------------------------------------------ the notes timeline -- */

/*
 * Phase 11. A driver-notes line that STARTS with a time ("7:45a Load Mail…",
 * "7:55am depart from RCA…") is ticked off under the stop it falls in: the
 * first stop whose leave time is at or after it -- the stop that is RIGHT NOW
 * at that time -- or the last stop. Placed by its own printed time, worded as
 * printed, never read for a place (converter-not-planner). Everything else is
 * prose, and the whole notes block still stands as written.
 */

// "7:45a", "7:55am", "7:45 AM", a bare "6:15" (a shuttle sheet, 374819), a
// 24-hour "14:30", and a starred "7:45*" -- dispatch's mark for a time that
// hangs on something else ("or 5 min after Morning Worship concludes").
const NOTE_TIME = /^((\d{1,2}):(\d{2})(?:\s?([ap])m?)?)(\*)?\s+(\S.*)$/i;

/** The run's start and end on the running clock (a run with no end: a day). */
function runWindow(assignment) {
  const stamp = (s) => {
    const m = String(s || "").match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
    return m ? wallAt(m[1], Number(m[2]) * 60 + Number(m[3])) : null;
  };
  const from = stamp(assignment.start);
  return { from, to: stamp(assignment.end) ?? (from === null ? null : from + 1440) };
}

/** A notes line that starts with a time the timeline reads (the match), or null. */
function timedLine(line) {
  const m = String(line).trim().match(NOTE_TIME);
  return m && Number(m[2]) <= 23 && Number(m[3]) <= 59 ? m : null;
}

/** The notes as rows, the way the server serves them (patch.ts `address`):
 *  dispatch's lines `n0`, `n1`... -- `printed` is dispatch's words, `line`
 *  what shows (the driver's once they corrected it) -- then the legs the
 *  driver added ("+ref"). A copy from before has none: built here the same
 *  way, so `n3` names the same line on the phone and on the server. */
function ensureLines(assignment) {
  if (!assignment.lines) {
    assignment.lines = String(assignment.driverNotes || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      .map((text, i) => ({ printed: text, line: text, _at: `n${i}` }));
  }
  return assignment.lines;
}

/** The timed lines -- the legs -- in dispatch's order, the driver's added ones
 *  placed among them by time: { at, time, text, key, row } and, when the driver
 *  corrected one, dispatch's `printedTime` and `printedText`. */
function noteLines(assignment) {
  const lines = [];
  const mine = [];
  const seen = {};
  const day = String(assignment.start || "").slice(0, 10);
  const { from, to } = runWindow(assignment);
  let prev = null;
  // A time with its a/p, or past 12, says which it is. A bare one takes the
  // one inside the run (6:15 on a 6:00a-10:00a run is 6:15a), the one that
  // keeps the printed order first; outside the run either way, the one that
  // keeps the order (the owner's corpus: "12:50 ... 4:45 ... 5:00" after a
  // run printed to end at 12:00p is the afternoon), else the nearer. Only
  // dispatch's lines have an order to keep.
  const readAt = (m, ordered) => {
    const h = Number(m[2]), mm = Number(m[3]);
    const choices = m[4] ? [(h % 12) * 60 + mm + (/p/i.test(m[4]) ? 720 : 0)]
      : h > 12 || h === 0 ? [h * 60 + mm]
      : [(h % 12) * 60 + mm, (h % 12) * 60 + mm + 720];
    // The line carries no date: it takes the run's day that puts it inside the
    // run (12:10a on a 9:30p run is the next day; so is 7:45a on a run that
    // starts at 7:30p and ends the next morning).
    const dated = choices.map((min) => wallAt(runDayOf(assignment, min), min)).sort((x, y) => x - y);
    const gap = (t) => from === null ? 0 : t < from ? from - t : t > to ? t - to : 0;
    const inOrder = (t) => !ordered || prev === null || t >= prev;
    return dated.find((t) => gap(t) === 0 && inOrder(t))
      ?? dated.find((t) => gap(t) === 0)
      ?? (ordered && prev !== null ? dated.find(inOrder) : undefined)
      ?? dated.reduce((best, t) => (gap(t) < gap(best) ? t : best));
  };
  // Worded as printed; a bare time is shown with the a/p it was read as.
  const shown = (m, at) => `${m[4] || Number(m[2]) > 12 ? m[1] : fmtMinutes(at)}${m[5] || ""}`;
  for (const row of ensureLines(assignment)) {
    const m = timedLine(row.line);
    if (!m || !day) continue;
    const at = readAt(m, !row._add);
    const entry = { at, time: shown(m, at), text: m[6], key: "", row };
    if (row._add) {
      entry.key = `${assignment.number}:${row._at}`;
      mine.push(entry);
      continue;
    }
    // Dispatch's reading orders the next bare time, whatever the driver set.
    const edit = row._edit && row._edit.line;
    const pm = edit ? timedLine(row.printed) : null;
    prev = pm ? readAt(pm, true) : at;
    if (pm) Object.assign(entry, { printedTime: shown(pm, prev), printedText: pm[6] });
    // Keyed by dispatch's words, so a reprint that moves the line -- or the
    // driver's own correction -- keeps its tick; the same words twice on one
    // run are told apart by their order.
    const words = row.printed;
    seen[words] = (seen[words] || 0) + 1;
    entry.key = `${assignment.number}:${words}${seen[words] > 1 ? `#${seen[words]}` : ""}`;
    lines.push(entry);
  }
  for (const l of mine) {
    const i = lines.findIndex((x) => x.at > l.at);
    lines.splice(i < 0 ? lines.length : i, 0, l);
  }
  return lines;
}

/** step index -> its lines, in the order printed. Removed stops take none. */
function placeNoteLines(assignment) {
  const steps = (assignment.steps || []).map((s, i) => [s, i]).filter(([s]) => !s._removed);
  const placed = {};
  if (!steps.length) return placed;
  for (const line of noteLines(assignment)) {
    const hit = steps.find(([s]) => {
      const leave = stepAt(s, "etd") ?? stepAt(s, "eta");
      return leave !== null && leave >= line.at;
    }) || steps[steps.length - 1];
    (placed[hit[1]] = placed[hit[1]] || []).push(line);
  }
  return placed;
}

/*
 * Windows (the owner, 2026-09-29; 374819). A printed stop with no address and
 * nobody to carry is a window of the day -- a shuttle, Dispatch, Office
 * Projects, Floater -- not a place to drive to: 24 of 503 stops in the owner's
 * corpus, none with a passenger. It shows as a dashed band with dispatch's own
 * label, and its timed notes lines are its legs: the rail items, each ticked
 * by the driver. Real places stay stops, whatever they carry.
 */
function isWindow(step) {
  if (!step || step.address || step._add || AIRPORTS.has(step.code)) return false;
  return !(step.actions || []).some((a) => (a.entities || []).length);
}

/** The legs RIGHT NOW reads from: the live window's, then those of the windows
 *  printed straight after it (CLD's last leg hands over to ABS's first). None
 *  when the live window has no legs of its own. */
function legsAhead(assignment, placed, liveIndex) {
  const steps = assignment.steps || [];
  const live = (i) => (placed[i] || []).filter((l) => !l.row._removed);
  if (!live(liveIndex).length) return [];
  const legs = [];
  for (let i = liveIndex; i < steps.length; i++) {
    if (steps[i]._removed) continue;
    if (!isWindow(steps[i])) break;
    for (const l of live(i)) legs.push({ ...l, step: steps[i] });
  }
  return legs;
}

/** Which leg is RIGHT NOW (the owner, 2026-09-29): a leg holds from its time
 *  until the next leg's time or its tick, whichever comes first; outside
 *  every leg, the next one not ticked. -1: none left. The app never ticks. */
function nowLeg(legs, now, ticks) {
  const i = legs.findIndex((l, k) => !ticks[l.key] && l.at <= now
    && (k + 1 === legs.length || now < legs[k + 1].at));
  return i >= 0 ? i : legs.findIndex((l) => !ticks[l.key] && l.at > now);
}

/** A leg's words as a button that opens it (TIME + WHAT), with the driver's
 *  marks: the dot on a correction and dispatch's words beside it, YOURS on
 *  one they added, and a later sheet's disagreement to settle. A re-sent
 *  sheet's marks ride on `l.sheet` (legMarks): NEW, the old words struck. */
function legWords(l, label) {
  const mark = editMark(l.row, "line", "");
  const mine = addedMark(l.row._add, "The sheet has this leg now too");
  const spec = esc(JSON.stringify({ at: l.row._at, label }));
  const contested = l.row._edit && l.row._edit.line && l.row._edit.line.contested;
  const s = l.sheet || {};
  // Dispatch's own line moved under the driver's: what it printed before, struck.
  const was = s.wasTime ? `${struck(esc(s.wasTime))} ` : s.wasText ? `${struck(esc(s.wasText))} ` : "";
  const beside = !l.printedTime || contested ? "" // the contest row says both
    : l.printedText === l.text ? `you set ${esc(l.time)} · dispatch printed ${was}${esc(l.printedTime)}`
    : `yours · dispatch printed ${was}${esc(l.printedTime)} ${esc(l.printedText)}`;
  const reworded = s.wasText && !l.printedTime ? `<span class="lbeside">${struck(esc(s.wasText))}</span>` : "";
  return `<button class="editable ltext${mark.cls}" type="button" data-leg="${spec}">${esc(l.text)}</button>${mine.chip}${
    s.added ? NEW_CHIP : ""}${reworded}${beside ? `<span class="lbeside">${beside}</span>` : ""}${mark.row}${mine.row}`;
}

function tickButton(l, ticked) {
  return `<button class="tickbox" type="button" aria-pressed="${ticked ? "true" : "false"}"
            aria-label="Tick off ${esc(l.time)} ${esc(l.text)}">&#10003;</button>`;
}

/** The step's legs with a re-sent sheet's marks on them, and the ones it
 *  dropped slotted in by time as `{ gone }` entries (drawn as ghosts only). */
function legMarks(assignment, lines, gone) {
  const sm = sheetMarks(assignment);
  const out = (lines || []).map((l) => {
    const lm = sm && sm.line[l.row._at];
    if (!lm) return l;
    const was = lm.retimed || lm.reworded;
    const shown = was ? legShown(assignment, was) : null;
    return { ...l, sheet: {
      added: Boolean(lm.added),
      wasTime: lm.retimed && shown ? shown.time : null,
      wasText: lm.reworded ? (shown ? shown.text : lm.reworded) : null,
    } };
  });
  for (const g of gone || []) {
    const i = out.findIndex((x) => x.at > g.at);
    out.splice(i < 0 ? out.length : i, 0, { gone: g, at: g.at });
  }
  return out;
}

function renderLegs(lines, nowKey, label) {
  const ticks = readLS(LS_TICKS, {});
  return `<div class="legs">${(lines || []).map((l) => {
    if (l.gone) {
      return `<div class="leg dropped"><div class="rail"><span class="rtime">${esc(l.gone.time)}</span></div>
        <div class="legbody">${sheetGhost(l.gone.text, "NOT ON THE NEW SHEET")}</div></div>`;
    }
    const wasTime = l.sheet && l.sheet.wasTime && !l.printedTime ? `<span class="rwas">${esc(l.sheet.wasTime)}</span>` : "";
    const rail = `<div class="rail"><span class="dot"></span><span class="rtime">${esc(l.time)}</span>${wasTime}</div>`;
    if (l.row._removed) {
      return `<div class="leg gone" data-at="${esc(l.row._at)}">${rail}
        <div class="legbody">${ghost(l.row._removed, l.text, "NOT HAPPENING")}</div></div>`;
    }
    return `
    <div class="leg${ticks[l.key] ? " done" : ""}${l.key === nowKey ? " now" : ""}" data-tick="${esc(l.key)}" data-at="${esc(l.row._at)}">
      ${rail}
      <div class="legbody">
        <span class="lwords">${legWords(l, label)}</span>
        ${tickButton(l, ticks[l.key])}
      </div>
    </div>`;
  }).join("")}</div>`;
}

function renderNoteLines(lines, label) {
  if (!lines || !lines.length) return "";
  const ticks = readLS(LS_TICKS, {});
  return `<div class="notelines">${lines.map((l) => l.gone
    ? `<div class="nline dropped"><span class="ntime">${esc(l.gone.time)}</span>${
        sheetGhost(l.gone.text, "NOT ON THE NEW SHEET")}</div>`
    : l.row._removed
    ? `<div class="nline gone" data-at="${esc(l.row._at)}"><span class="ntime">${esc(l.time)}</span>${
        ghost(l.row._removed, l.text, "NOT HAPPENING")}</div>`
    : `
    <div class="nline${ticks[l.key] ? " done" : ""}" data-tick="${esc(l.key)}" data-at="${esc(l.row._at)}">
      ${tickButton(l, ticks[l.key])}
      <span class="ntime">${esc(l.time)}${l.sheet && l.sheet.wasTime && !l.printedTime
        ? struck(esc(l.sheet.wasTime), "nwas") : ""}</span><span class="ntext">${legWords(l, label)}</span>
    </div>`).join("")}</div>`;
}

/** What openEdit is given for a stop's times: the head's button and the
 *  stop's menu open the same correction. Only the times the sheet printed are
 *  fields; an added stop has one time, what dispatch phoned in. */
function timeSpecOf(step) {
  const sheetEta = sheetTime(step, "eta"), sheetEtd = sheetTime(step, "etd");
  const sheetLabel = step._add ? stepTime(sheetEta) : timesLabel(sheetEta, sheetEtd);
  return {
    at: step._at,
    label: `Time at ${step.code || step.place}`,
    documentValue: String(sheetLabel || "").replace("&ndash;", "–"),
    fields: step._add
      ? [{ field: "time", label: "TIME", current: step.eta, documentValue: sheetEta }]
      : [["eta", "ARRIVE", sheetEta], ["etd", "LEAVE", sheetEtd]]
          .filter(([, , doc]) => doc)
          .map(([field, label, doc]) => ({ field, label, current: step[field], documentValue: doc })),
  };
}

/** The same for a door. */
function doorSpec(step, action) {
  const e = action._edit && action._edit.where;
  return {
    at: action._at, field: "where",
    label: `Door for ${action.verb} at ${step.code || step.place}`,
    current: action.where ?? null,
    documentValue: (e ? e.documentValue : action.where) ?? null,
  };
}

/** `goneLegs`: the legs a re-sent sheet dropped that fall at this stop
 *  (placeGoneLegs), drawn among its own as ghosts. */
function renderStep(step, index, assignment, now, lines, isLive, nowKey, goneLegs) {
  const railTime = stepTime(step.eta) || stepTime(step.etd);
  const rail = `<div class="rail"><span class="dot"></span>${railTime ? `<span class="rtime">${esc(railTime)}</span>` : ""}</div>`;
  const label = `${step.code || ""} ${step.place}`.trim();
  if (step._removed) {
    return `<div class="step gone">${rail}<div class="stepbody">${ghost(step._removed, label, "NOT HAPPENING")}</div></div>`;
  }
  const mine = addedMark(step._add, "The sheet has this stop now too");
  const clocks = clocksFor(step);
  // What a re-sent sheet changed here (sheetMarks): struck under or beside
  // the new value, never over a value the driver set themselves.
  const sm = sheetMarks(assignment);
  const mk = (sm && sm.step[step._at]) || {};
  const legs = legMarks(assignment, lines, goneLegs);
  // What you collect, at the place and time you collect it -- and where the
  // car is, when its space says (carLot).
  const vehicle = index === 0 ? vehicleLabel(assignment.vehicle) : null;
  const lot = index === 0 ? carLot(assignment) : null;
  const collect = (vehicle || (index === 0 && assignment.parking))
    ? `<div class="collect">${icon("car", "ico-sm")}<span>${vehicle ? `<b>${esc(vehicle)}</b>` : ""}${
        assignment.parking ? `${vehicle ? " &middot; " : ""}${esc(assignment.parking)}` : ""}${
        lot ? ` &middot; collect at <b>${esc(lot.code)}</b>` : ""}</span></div>`
    : "";
  const carWas = index === 0 && sm ? [
    sm.run.vehicle ? vehicleLabel(sm.run.vehicle.was) || sm.run.vehicle.was || "no vehicle" : null,
    sm.run.parking ? sm.run.parking.was || "no parking" : null,
  ].filter(Boolean) : [];
  const collectWas = carWas.length ? `<div class="cwas">${struck(esc(carWas.join(" · ")))}</div>` : "";
  const placeWas = mk.place
    ? `<div class="swasline">${struck(esc([
        "place" in mk.place.was ? mk.place.was.place : step.place,
        "address" in mk.place.was ? mk.place.was.address : step.address,
      ].filter(Boolean).join(" · ") || "no address"))}</div>` : "";
  const etd = stepAt(step, "etd");
  const eta = stepAt(step, "eta");
  const past = stepDone(step, clocks, now);
  const current = !past && ((eta !== null && eta <= now) || index === 0);
  const state = past ? "done" : current ? "current" : "";

  // The driver's times where they set their own, dispatch's beside them --
  // not struck: strike-through means dispatch moved it.
  const times = headTimes(step.eta, step.etd);
  const sheetEta = sheetTime(step, "eta"), sheetEtd = sheetTime(step, "etd");
  const timeMarks = (step._add ? [["time", "Time"]] : [["eta", "Arrive"], ["etd", "Leave"]])
    .map(([f, what]) => editMark(step, f, what));
  const timeCls = (timeMarks.find((m) => m.cls.includes("contested"))
    || timeMarks.find((m) => m.cls.includes("pending"))
    || timeMarks.find((m) => m.cls) || { cls: "" }).cls;
  // An added stop has one time, what dispatch phoned in.
  const sheetLabel = step._add ? stepTime(sheetEta) : timesLabel(sheetEta, sheetEtd);
  // Dispatch moved them on a re-sent sheet: the old ones struck under the new
  // -- or, where the driver set their own, inside "dispatch planned".
  const moved = mk.times;
  const movedDay = moved && (moved.was.etaDate || moved.was.date) !== (moved.now.etaDate || moved.now.date)
    ? `${esc(shortDate(moved.was.etaDate || moved.was.date))} ` : "";
  const wasTimes = moved ? struck(`${movedDay}${timesLabel(moved.was.eta, moved.was.etd) || "no time"}`) : "";
  const sheetTimes = (sheetEta !== step.eta || sheetEtd !== step.etd)
    ? `<div class="stdisp">${step._add ? "phoned in" : "dispatch planned"} ${wasTimes ? `${wasTimes} ` : ""}${sheetLabel}</div>`
    : wasTimes ? `<div class="stdisp">${wasTimes}</div>` : "";
  const timeSpec = esc(JSON.stringify(timeSpecOf(step)));
  // A stop already left is closed, and its head is the tap that opens it: the
  // times in it are words until then, the button once it is open (the audit,
  // 2026-10-04: a 34px button inside a head that takes the same tap).
  const timesBtn = times
    ? `${past ? `<span class="stimes stplain">${times}</span>` : ""}<button class="editable stimes${
        timeCls}" type="button" data-edit-time="${timeSpec}">${times}</button>` : "";

  if (isWindow(step)) {
    return `
    <div class="step window ${state}${isLive ? " live" : ""}" data-at="${esc(step._at)}"${past ? ' data-collapsible="1"' : ""}
         style="view-transition-name: st-${String(step._at).replace(/[^A-Za-z0-9-]/g, "-")}">
      <div class="sthead wband">
        <span class="scode">${esc(step.code || "—")}</span>${mk.added ? NEW_CHIP : ""}
        ${step.place !== step.code ? `<span class="splace">${esc(step.place)}</span>` : ""}
        ${timesBtn}
      </div>
      ${placeWas}${sheetTimes}${timeMarks.map((m) => m.row).join("")}${collect}${collectWas}
      ${renderLegs(legs, nowKey, step.place || step.code)}
      <div class="stepfoot">
        <button class="addrow" type="button" data-add-leg="${esc(step.place || step.code || "")}">+ ADD A LEG</button>
        <button class="addrow quiet" type="button" data-remove="${esc(step._at)}"
                data-label="${esc(label)}">NOT HAPPENING</button>
      </div>
    </div>`;
  }

  // Two clocks, each shown BESIDE dispatch's own number for the same thing and
  // labelled with where it came from. Strip the second number away and the
  // figure stops being a report and becomes an instruction.
  // At the current stop the clock the driver is working to names itself (the
  // same one RIGHT NOW gives); one that has passed goes grey and is ticked.
  let clockBlock = "";
  if (clocks.parkedBy !== null || clocks.leavingAt !== null) {
    const rows = [];
    const parkedPassed = clocks.parkedBy !== null && now >= clocks.parkedBy;
    const leavingPassed = clocks.leavingAt !== null && now >= clocks.leavingAt;
    const clockState = (passed, active) => passed ? " passed" : active ? " active" : "";
    if (clocks.parkedBy !== null) {
      const active = current && (!parkedPassed || clocks.leavingAt === null);
      rows.push(`<div class="clock${clockState(parkedPassed, active)}">
        <span class="lbl">PARKED AT ${esc(step.code)}${parkedPassed ? " &#10003;" : ""}</span>
        <span class="val" data-roll="${esc(assignment.number)}|${esc(step._at)}|parked">${esc(fmtMinutes(clocks.parkedBy))}</span>
        <span class="why">${esc(clocks.parkedWhy)}${planned(step, "eta")}</span>
      </div>`);
    }
    if (clocks.leavingAt !== null) {
      const active = current && (parkedPassed || clocks.parkedBy === null);
      rows.push(`<div class="clock${clockState(leavingPassed, active)}">
        <span class="lbl">LEAVING ${esc(step.code)}${leavingPassed ? " &#10003;" : ""}</span>
        <span class="val" data-roll="${esc(assignment.number)}|${esc(step._at)}|leaving">${esc(fmtMinutes(clocks.leavingAt))}</span>
        <span class="why">${esc(clocks.leavingWhy)}${planned(step, "etd")}</span>
      </div>`);
    }
    clockBlock = `<div class="clocks">${rows.join("")}</div>`;
  }

  // A delay never rewrites dispatch's time. It is reported underneath, named.
  let consequence = "";
  if (clocks.leavingAt !== null && etd !== null && clocks.leavingAt - etd > 10) {
    consequence = `<div class="changed">&#9650; Leaving ~${clocks.leavingAt - etd}m after dispatch's ${esc(fmtMinutes(etd))}</div>`;
  }

  // An airport is known by its name. Its address wrapped the head and put the
  // stop's times on a line of their own (the owner, 2026-10-04); it shows only
  // where a re-sent sheet changed it, beside the old one struck.
  const address = step.address && (!AIRPORTS.has(step.code) || (mk.place && "address" in mk.place.was))
    ? step.address : "";

  const actions = (step.actions || []).map((action, ai) => {
    const wMark = editMark(action, "where");
    const aAt = action._at;
    // A door or a verb a re-sent sheet changed: the old one struck beside it.
    const door = sm && sm.action[aAt] && sm.action[aAt].door;
    const low = (v) => String(v || "").trim().toLowerCase();
    const verbWas = door && door.was && door.now && low(door.was.verb) !== low(door.now.verb)
      ? struck(esc(String(door.was.verb || "").toUpperCase())) : "";
    const whereWas = door && door.was && door.now && !(action._edit && action._edit.where)
      && low(door.was.where) !== low(door.now.where) ? struck(esc(door.was.where || "door not given")) : "";
    return `
    <div class="action" data-at="${esc(aAt)}">
      <div class="ahead">
        <span class="averb">${esc(String(action.verb || "").toUpperCase())}</span>${verbWas}
        <button class="editable awhere${action.where ? "" : " none"}${wMark.cls}" type="button"
                data-edit="${esc(JSON.stringify(doorSpec(step, action)))}">${
          action.where ? esc(action.where) : "door not given"}</button>${whereWas}${door && !door.was ? NEW_CHIP : ""}
      </div>
      ${wMark.row}
      ${(action.entities || []).map((e) => renderEntity(e, step, assignment, clocks)).join("")}
      ${droppedPeople(sm, aAt)}
    </div>`;
  }).join("");

  return `
    <div class="step ${state}${isLive ? " live" : ""}${step._add ? " added" : ""}" data-at="${esc(step._at)}"${past ? ' data-collapsible="1"' : ""}
         style="view-transition-name: st-${String(step._at).replace(/[^A-Za-z0-9-]/g, "-")}">
      ${rail}
      <div class="stepbody">
        <div class="sthead">
          <span class="scode">${esc(step.code || "—")}</span>${mine.chip}${mk.added ? NEW_CHIP : ""}
          ${step.place !== step.code ? `<span class="splace">${esc(step.place)}${address ? " · " + esc(address) : ""}</span>` : ""}
          ${timesBtn}
        </div>
        ${placeWas}${sheetTimes}${timeMarks.map((m) => m.row).join("")}
        ${mine.row}${collect}${collectWas}${consequence}${clockBlock}${actions}${droppedPeople(sm, step._at)}${
          renderNoteLines(legs, step.code || step.place)}
        <div class="stepfoot">
          <button class="stopmenu" type="button" data-stop-menu="${esc(step._at)}">CHANGE THIS STOP${icon("ellipsis")}</button>
        </div>
      </div>
    </div>`;
}

/* -------------------------------------------- one menu a row (v68) -- */

/*
 * A passenger's card and a stop each have ONE menu (the owner, 2026-10-04):
 * the three dots at the end of the name line, and CHANGE THIS STOP at the
 * stop's foot. They took FIX, NOT COMING, the greeting chip, + ADD PASSENGER
 * and STOP NOT HAPPENING off the page, which had a control for every one of
 * them on every row, every day.
 *
 * A menu is a second way in, never the only one for a value on screen: the
 * flight, the door and the times are still fixed by tapping them, and their
 * rows say so. Nothing here is a new kind of change. A row opens the same
 * correction (entitySpec, timeSpecOf, doorSpec), the same add, or queues the
 * same "not happening", with its never-expiring UNDO on the page.
 *
 * The rows are plain data so they can be read without a screen:
 * { key, title, sub } and one of `edit` (openEdit's spec), `add` (openAdd's),
 * `remove` ({ at, label }) or `greet` (answered in the row). `apart`: set
 * off from the rest, last. Not red: red is a problem, and this is a choice.
 */

/** The driver's own value says so. */
function yoursWord(host, field) {
  return host._edit && host._edit[field] ? " · yours" : "";
}

function paxMenuRows(assignment, entity) {
  const rows = [{
    key: "phone",
    title: entity.phone ? "Fix phone" : "Add phone",
    sub: entity.phone ? `${entity.phone}${yoursWord(entity, "phone")}`
      : `No number${yoursWord(entity, "phone") || " printed"}`,
    edit: entitySpec(entity, "phone"),
  }];
  // Where the card has a flight to tap, and only there.
  if (entity.flightNumber || FLIGHT_TAGS.includes(entity.tag)) {
    rows.push({
      key: "flight",
      title: entity.flightNumber ? "Fix flight" : "Add flight",
      sub: entity.flightNumber
        ? `${entity.flightNumber}${yoursWord(entity, "flightNumber")} · you can also tap the flight on the card`
        : "The sheet left it blank · you can also tap ADD FLIGHT",
      edit: entitySpec(entity, "flightNumber"),
    });
  }
  // A single with a number to message: Brother, Sister or the name alone.
  // A family is "Family Castillo", and nobody is asked.
  if (entity.phone && !isParty(entity)) {
    const greet = greetOf(entity.name);
    rows.push({ key: "greeting", title: "Greeting", name: entity.name, greet, sub: greetSub(entity.name, greet) });
  }
  rows.push(entity._add
    ? { key: "remove", apart: true, title: "Remove",
        sub: "You added this row. It stays on the card, struck, with its UNDO.",
        remove: { at: entity._at, label: entity.name } }
    : { key: "remove", apart: true, title: "Not coming",
        sub: "Leaves every stop they are on. UNDO stays on the card.",
        remove: { at: entity._at, label: entity.name } });
  return rows;
}

/** "Dear Sister Okafor · how your message opens" */
function greetSub(name, greet) {
  return `${greet ? `Dear ${greetingFor({ name, pax: 1 }, greet)}` : "Not asked yet"} · how your message opens`;
}

/** "7:10a – 10:30a", "arrive 8:10a", "leave 9:30p": the stop's times in a row's words. */
function menuTimes(step) {
  const eta = stepTime(step.eta), etd = stepTime(step.etd);
  if (eta && etd) return eta === etd ? eta : `${eta} – ${etd}`;
  return eta ? `arrive ${eta}` : etd ? `leave ${etd}` : "";
}

function stopMenuRows(assignment, step) {
  const where = step.code || step.place;
  const actions = step.actions || [];
  const verbOf = (action) => String(action.verb || "stop").toLowerCase();
  // Once for each pickup and drop-off: the passenger joins that one.
  const rows = actions.map((action) => ({
    key: `add:${action._at}`,
    title: "Add a passenger",
    sub: `To the ${verbOf(action)}${action.where ? ` at ${action.where}` : ""}`,
    add: { at: action._at, verb: action.verb, code: step.code || null, label: `${action.verb} at ${where}` },
  }));
  // As the head's own button: only where the stop shows a time.
  if (headTimes(step.eta, step.etd)) {
    rows.push({ key: "time", title: "Fix the time", sub: `${menuTimes(step)} · you can also tap the times`,
                edit: timeSpecOf(step) });
  }
  for (const action of actions) {
    const which = actions.length > 1 ? `${action.verb} · ` : "";
    rows.push({
      key: `door:${action._at}`,
      title: action.where ? "Fix the door" : "Add the door",
      sub: `${which}${action.where ? `${action.where}${yoursWord(action, "where")}` : "The sheet gave none"} · you can also tap the door`,
      edit: doorSpec(step, action),
    });
  }
  rows.push({ key: "remove", apart: true, title: "Stop not happening",
              sub: "Stays on the run, struck, with its UNDO.",
              remove: { at: step._at, label: `${step.code || ""} ${step.place}`.trim() } });
  return rows;
}

/** The rows as the sheet draws them: the Settings menu's own cards. A row
 *  that opens a correction has the chevron; one that acts at once has none. */
function menuRowsHtml(rows) {
  const draw = (r, i) => {
    const text = `<span class="menu-text"><span class="menu-title">${esc(r.title)}</span><span class="menu-sub">${esc(r.sub)}</span></span>`;
    if (r.key === "greeting") {
      return `<div class="menu-row menu-static menu-stack">${text}
        <div class="seg" role="group" aria-label="Greeting for ${esc(r.name)}">
          ${greetButtons(r.greet || "")}
        </div></div>`;
    }
    return `<button class="menu-row" type="button" data-row="${i}">${text}${
      r.remove ? "" : icon("chevron-right", "chev")}</button>`;
  };
  const card = (apart) => {
    const drawn = rows.map((r, i) => (Boolean(r.apart) === apart ? draw(r, i) : "")).join("");
    return drawn ? `<div class="menu${apart ? " menu-apart" : ""}">
        ${drawn}</div>` : "";
  };
  return `${card(false)}${card(true)}`;
}

/**
 * The menu for one row, or null when the row is not there to change. It
 * keeps the copy it was read from (`aim`, as openEdit does): if dispatch
 * re-sends the run while the menu is open, a row tapped after that still says
 * which copy its address points into, and the server refuses it rather than
 * aim it at whatever sits there now.
 */
function rowMenuOf(number, at, isStop) {
  const assignment = assignments.find((a) => a.number === number);
  if (!assignment) return null;
  let host = null;
  for (const step of assignment.steps || []) {
    if (isStop) { if (step._at === at) host = step; continue; }
    for (const action of step.actions || []) {
      for (const entity of action.entities || []) if (entity._at === at) host = entity;
    }
  }
  if (!host || host._removed) return null;
  return {
    number, isStop,
    title: isStop ? `${host.code || ""} ${host.place}`.trim() : host.name,
    rows: isStop ? stopMenuRows(assignment, host) : paxMenuRows(assignment, host),
    aim: (rowAt) => basisFor(assignment, rowAt),
  };
}

let rowMenu = null; // the menu on screen

function openRowMenu(number, at, isStop) {
  const menu = rowMenuOf(number, at, isStop);
  if (!menu) return;
  rowMenu = menu;
  document.getElementById("row-menu-title").textContent = menu.title;
  document.getElementById("row-menu-note").textContent = isStop
    ? "Yours is marked as yours and dispatch's stays beside it. Dispatch's stops keep their order."
    : "Yours is marked with a dot and dispatch's value stays beside it. Nothing here is sent to dispatch.";
  drawRowMenu();
  openSheet("row-menu");
}

function drawRowMenu() {
  const body = document.getElementById("row-menu-rows");
  body.innerHTML = menuRowsHtml(rowMenu.rows);
  body.querySelectorAll("[data-row]").forEach((el) =>
    el.addEventListener("click", () => pickMenuRow(rowMenu, Number(el.dataset.row))));
  body.querySelectorAll("[data-greet]").forEach((el) => el.addEventListener("click", () => {
    const row = rowMenu.rows.find((r) => r.key === "greeting");
    setGreet(row.name, el.dataset.greet);
    // The row says the new answer; the drafts behind the menu are rewritten.
    row.greet = el.dataset.greet;
    row.sub = greetSub(row.name, row.greet);
    drawRowMenu();
    renderCurrent();
  }));
}

/** One row tapped: the menu closes and the row's own sheet or change follows,
 *  so CANCEL or SAVE there lands back on the run. */
function pickMenuRow(menu, i) {
  const row = menu && menu.rows[i];
  if (!row) return;
  closeSheet("row-menu");
  if (row.edit) openEdit(menu.number, { ...row.edit, aim: menu.aim(row.edit.at) });
  else if (row.add) openAdd(menu.number, { mode: "entity", ...row.add, aim: menu.aim(row.add.at) });
  else if (row.remove) removeRow(menu.number, row.remove.at, row.remove.label, menu.aim(row.remove.at));
}

/* ---------------------------------------------- places, route in Maps -- */

/*
 * Route in Maps (the owner, 2026-09-29). One button per run opens Apple Maps
 * or Google Maps -- asked once, remembered on this phone -- with every stop
 * still ahead filled in, in dispatch's order, never optimised; the phone's own
 * location is the start. A window adds nothing itself: its legs' codes do, in
 * the order printed. A stop is told to Maps as the list's own place for its
 * code, else as the sheet prints it (place and address), an airport by its
 * full name and, when every flight there agrees, its live terminal. A code
 * with no address holds the button until the driver adds it: places belong to
 * the list (every phone on it), added by the drivers, synced like edits.
 */

const LS_MAPS = "fw_maps"; // "apple" | "google", this phone's answer
const AIRPORT_NAMES = {
  EWR: "Newark Liberty International Airport", JFK: "John F. Kennedy International Airport",
  LGA: "LaGuardia Airport", SWF: "New York Stewart International Airport",
  HPN: "Westchester County Airport", ALB: "Albany International Airport", BDL: "Bradley International Airport",
};
// Capitals in a notes line that are words, not places ("Load Mail for ALL Sites").
const NOT_CODES = new Set(["ALL", "AND", "THE", "FOR", "NOT", "ANY", "ETA", "ETD", "TBD", "TBA",
  "VIP", "USA", "GBA", "GBD", "MED", "PDF", "ASAP"]);
// Google Maps URLs take 9 waypoints and the destination in its app (3 in a
// phone's browser: nothing here can know which opens). Apple states no limit.
const GOOGLE_STOPS = 10;

function mapsApp() {
  try { const v = localStorage.getItem(LS_MAPS); return v === "apple" || v === "google" ? v : null; }
  catch (_) { return null; }
}

function setMapsApp(app) {
  try { localStorage.setItem(LS_MAPS, app); } catch (_) { /* private mode: asked again next time */ }
}

/*
 * Places and airlines every driver gets (the owner, 2026-10-01): the keeper's
 * own list is everyone's default (worker/src/shared.ts), sent with each load.
 * A list's own entry for the same code or name wins. On the keeper's phone
 * `suggestions` holds what other drivers added, to add for everyone or dismiss.
 */
let sharedCatalog = { places: [], airlines: [] };
let keeper = false;
let suggestions = [];

/** The list's own places (Settings -> Places), by code. */
function ownPlaces() {
  return (typeof settings !== "undefined" && settings && settings.places) || [];
}

/** Every place this list knows without a sheet: its own, then every
 *  driver's (marked `shared`) where it has none of its own. */
function listPlaces() {
  const own = ownPlaces();
  const mine = new Set(own.map((p) => p.code));
  const rest = (sharedCatalog.places || []).filter((p) => !mine.has(p.code)).map((p) => ({ ...p, shared: true }));
  return rest.length ? [...own, ...rest].sort((a, b) => a.code.localeCompare(b.code)) : own;
}

/** The places the sheets give: every printed stop with an address that is not
 *  an airport, in the newest print's words for its code. */
function sheetPlaces() {
  const out = new Map();
  const runs = [...assignments].sort((a, b) => String(b.printedAt || "").localeCompare(String(a.printedAt || "")));
  for (const a of runs) {
    for (const s of a.steps || []) {
      if (!s.code || !s.address || s._add || AIRPORTS.has(s.code) || out.has(s.code)) continue;
      out.set(s.code, { code: s.code, name: s.place && s.place !== s.code ? s.place : "", address: s.address });
    }
  }
  return [...out.values()].sort((x, y) => x.code.localeCompare(y.code));
}

function placeLine(p) {
  return [p.name, p.address].filter(Boolean).join(", ");
}

/** The place codes a leg names, in the order printed: three capitals that are
 *  not a word, or any code the list already knows. */
function legCodes(text, known) {
  return (String(text).match(/\b[A-Z0-9]{2,8}\b/g) || []).filter((c) =>
    known.has(c) || AIRPORTS.has(c) || (/^[A-Z]{3}$/.test(c) && !NOT_CODES.has(c)));
}

/*
 * The car's lot (the owner, 2026-09-30): a parking space's prefix says where
 * the car waits, which is where the run starts. Only what the owner has said
 * is here -- FKL-NBD is NCA, not Fishkill as the space's first letters read --
 * and a prefix nobody has named is not guessed. Read when shown, never written
 * into the run; the list's own place for the code wins over these words.
 */
const CAR_LOTS = [
  { prefix: "FKL-NBD", code: "NCA", name: "Newburgh Center A", address: "1292 NY-300, Newburgh, NY 12550" },
];

function carLot(assignment) {
  const space = String(assignment.parking || "").toUpperCase().replace(/\s+/g, "");
  const lot = CAR_LOTS.find((l) => space.startsWith(l.prefix));
  if (!lot) return null;
  const mine = listPlaces().find((p) => p.code === lot.code);
  return mine ? { ...lot, name: mine.name || lot.name, address: mine.address } : lot;
}

/** An airport stop's terminal, when every flight there has the same one live. */
function stopTerminal(step) {
  const seen = new Set();
  for (const action of step.actions || []) {
    for (const e of action.entities || []) {
      if (e._removed) continue;
      const leg = legOf(statusFor(e, step.etaDate || step.date), e);
      if (leg && leg.terminal) seen.add(String(leg.terminal).replace(/^terminal\s*/i, ""));
    }
  }
  return seen.size === 1 ? [...seen][0] : null;
}

/** Dispatch's route: { stops: [{ key, code, label, text }], missing: [code],
 *  started }. Every stop before the run starts, the car's lot first; once it
 *  has, the one RIGHT NOW and after, and a window's legs from the one RIGHT
 *  NOW reads, ticked ones left out. `key` names a stop for the driver's own
 *  order (mapsRoute): a step by its `_at`, a leg's place by the leg. */
function routeStops(assignment, now) {
  const steps = assignment.steps || [];
  const { from } = runWindow(assignment);
  const started = from !== null && now >= from;
  const first = started ? steps.findIndex((s) => !s._removed && !stepDone(s, clocksFor(s), now)) : 0;
  const stops = [], missing = [];
  if (first < 0) return { stops, missing, started };
  const yours = new Map(listPlaces().map((p) => [p.code, p]));
  const sheets = new Map(sheetPlaces().map((p) => [p.code, p]));
  const known = new Set([...yours.keys(), ...sheets.keys()]);
  const placed = placeNoteLines(assignment);
  const ticks = readLS(LS_TICKS, {});
  // Legs RIGHT NOW has moved past are behind the driver, ticked or not.
  const behind = new Set();
  if (started && isWindow(steps[first])) {
    const legs = legsAhead(assignment, placed, first);
    const i = nowLeg(legs, now, ticks);
    legs.slice(0, i < 0 ? legs.length : i).forEach((l) => behind.add(l.key));
  }
  const add = (key, code, label, text) => {
    if (!text && !missing.includes(code)) missing.push(code);
    const last = stops[stops.length - 1];
    if (last && last.code === code) return;
    stops.push({ key, code, label, text });
  };
  // Where the car waits comes first, until the run is under way.
  const lot = started ? null : carLot(assignment);
  if (lot) add(`lot:${lot.code}`, lot.code, "the car", placeLine(lot));
  for (let i = first; i < steps.length; i++) {
    const s = steps[i];
    if (s._removed) continue;
    if (isWindow(s)) {
      for (const l of placed[i] || []) {
        if (ticks[l.key] || behind.has(l.key) || l.row._removed) continue;
        for (const code of legCodes(l.text, known)) {
          if (steps.some((w) => w.code === code && isWindow(w))) continue; // a window is not a place
          const p = yours.get(code) || sheets.get(code);
          add(`l:${l.key}:${code}`, code, "", p ? placeLine(p) : AIRPORT_NAMES[code] || null);
        }
      }
      continue;
    }
    const code = s.code || s.place;
    if (AIRPORTS.has(s.code)) {
      const t = stopTerminal(s);
      add(`s:${s._at}`, code, t ? `Terminal ${t}` : "", `${AIRPORT_NAMES[s.code]}${t ? ` Terminal ${t}` : ""}`);
      continue;
    }
    const p = yours.get(s.code);
    const name = p ? p.name : s.place !== s.code ? s.place : "";
    add(`s:${s._at}`, code, name, p ? placeLine(p) : s.address ? [s.place, s.address].filter(Boolean).join(", ") : null);
  }
  return { stops, missing, started };
}

/*
 * The driver's route (the owner, 2026-09-30): before Maps opens, the stops
 * can be put in another order, left out, added to, and started from somewhere
 * other than where the phone is. Kept on this phone for that run until it
 * ends; only what Maps is given changes -- the run keeps dispatch's order, and
 * DISPATCH'S ORDER puts it back. A stop the sheet adds later goes in after the
 * stop it follows on the sheet.
 */
const LS_ROUTES = "fw_routes";           // {"<number>": {order, out, added, start}}
const LS_MAPS_DIRECT = "fw_maps_direct"; // "1": ROUTE IN MAPS skips the stops and opens Maps

function mapsDirect() {
  try { return localStorage.getItem(LS_MAPS_DIRECT) === "1" && !!mapsApp(); } catch (_) { return false; }
}

function setMapsDirect(on) {
  try { if (on) localStorage.setItem(LS_MAPS_DIRECT, "1"); else localStorage.removeItem(LS_MAPS_DIRECT); }
  catch (_) { /* private mode: the stops show each time */ }
}

function routeEdits(number) {
  return readLS(LS_ROUTES, {})[number] || null;
}

/** null puts dispatch's order back. Runs this phone no longer holds take
 *  their routes with them. */
function saveRouteEdits(number, edits) {
  const all = readLS(LS_ROUTES, {});
  for (const n of Object.keys(all)) if (!assignments.some((a) => a.number === n)) delete all[n];
  if (edits) all[number] = edits; else delete all[number];
  writeLS(LS_ROUTES, all);
}

/** The route Maps gets: dispatch's (routeStops) with this phone's edits on
 *  top. { stops, out (left out), order (every key, the left-out ones where
 *  they stood), start (null: where you are), missing, started, edited }. */
function mapsRoute(assignment, now) {
  const base = routeStops(assignment, now);
  const edits = routeEdits(assignment.number);
  if (!edits) return { ...base, out: [], order: base.stops.map((s) => s.key), start: null, edited: false };
  const byKey = new Map(base.stops.map((s) => [s.key, s]));
  for (const s of edits.added || []) byKey.set(s.key, { ...s, yours: true });
  const order = (edits.order || []).filter((k) => byKey.has(k));
  const keys = base.stops.map((s) => s.key);
  keys.forEach((k, i) => {
    if (order.includes(k)) return;
    let j = i - 1;
    while (j >= 0 && !order.includes(keys[j])) j--;
    order.splice(j < 0 ? 0 : order.indexOf(keys[j]) + 1, 0, k);
  });
  for (const k of byKey.keys()) if (!order.includes(k)) order.push(k);
  const out = new Set(edits.out || []);
  const stops = order.filter((k) => !out.has(k)).map((k) => byKey.get(k));
  return {
    stops,
    out: order.filter((k) => out.has(k)).map((k) => byKey.get(k)),
    order,
    start: edits.start || null,
    missing: base.missing.filter((code) => stops.some((s) => s.code === code && !s.text)),
    started: base.started,
    edited: true,
  };
}

/** One change to the driver's route: { move: [key, +1|-1] } | { out: key } |
 *  { back: key } | { add: {code, label, text} } | { start: place|null } |
 *  { reset: true }. Back to dispatch's route exactly: nothing is kept. */
function editRoute(assignment, change, now) {
  const number = assignment.number;
  if (change.reset) return saveRouteEdits(number, null);
  const r = mapsRoute(assignment, now);
  const edits = routeEdits(number) || {};
  const order = [...r.order];
  const out = new Set(r.out.map((s) => s.key));
  let added = (edits.added || []).filter((s) => order.includes(s.key));
  let start = r.start;
  if (change.move) {
    // Among the stops Maps gets; a left-out one keeps its place.
    const [key, by] = change.move;
    const shown = order.filter((k) => !out.has(k));
    const i = shown.indexOf(key), j = i + by;
    if (i < 0 || j < 0 || j >= shown.length) return;
    const a = order.indexOf(shown[i]), b = order.indexOf(shown[j]);
    [order[a], order[b]] = [order[b], order[a]];
  }
  if (change.out) {
    // A stop of the driver's own goes; one of dispatch's is only left out.
    if (added.some((s) => s.key === change.out)) {
      added = added.filter((s) => s.key !== change.out);
      order.splice(order.indexOf(change.out), 1);
    } else out.add(change.out);
  }
  if (change.back) out.delete(change.back);
  if (change.add) {
    const key = `p:${change.add.code}:${Date.now().toString(36)}`;
    added.push({ key, code: change.add.code, label: change.add.label || "", text: change.add.text });
    order.push(key);
  }
  if ("start" in change) start = change.start;
  const base = routeStops(assignment, now).stops.map((s) => s.key);
  const same = !added.length && !out.size && !start
    && order.length === base.length && base.every((k, i) => order[i] === k);
  saveRouteEdits(number, same ? null : { order, out: [...out], added, start });
}

/** The Maps link: the first GOOGLE_STOPS stops for Google (the next ones: a
 *  later tap gets the rest), all of them for Apple (iOS 18.4's directions URL).
 *  `start`: a place to start from instead of where the phone is. The same
 *  place twice in a row is told once. */
function routeUrl(app, stops, start) {
  const enc = encodeURIComponent;
  const texts = stops.map((s) => s.text).filter((t, i, all) => i === 0 || t !== all[i - 1]);
  if (app === "google") {
    const some = texts.slice(0, GOOGLE_STOPS);
    const dest = some.pop();
    return `https://www.google.com/maps/dir/?api=1${start ? `&origin=${enc(start.text)}` : ""}&destination=${enc(dest)}${
      some.length ? `&waypoints=${some.map(enc).join("%7C")}` : ""}&travelmode=driving`;
  }
  const dest = texts.pop();
  return `https://maps.apple.com/directions?${start ? `source=${enc(start.text)}&` : ""}destination=${enc(dest)}${
    texts.map((t) => `&waypoint=${enc(t)}`).join("")}&mode=driving`;
}

function routeBar(assignment, now) {
  const { stops, missing, started, start, edited } = mapsRoute(assignment, now);
  if (!stops.length) return "";
  const path = stops.map((s) => `<b>${esc(s.code)}</b>${s.label ? ` ${esc(s.label)}` : ""}`).join(" &rarr; ");
  const from = start ? `From <b>${esc(start.code)}</b>` : "From where you are";
  const order = edited ? ", in your order" : ", in dispatch&rsquo;s order";
  const mapIco = `<svg class="ico" aria-hidden="true"><use href="#i-map" /></svg>`;
  const btn = (tail) => `<button class="routebtn" type="button" data-route="${esc(assignment.number)}">${mapIco
    }<span>ROUTE IN MAPS</span><span class="spacer"></span>${tail}</button>`;
  if (missing.length) {
    const names = missing.map((c) => `<b>${esc(c)}</b>`).join(", ");
    return `<div class="routebar missing">
      ${btn(`<span class="rnext">${esc(missing[0])} NEEDS AN ADDRESS</span>`)}
      <p class="rpath">${path}. ${names} ${missing.length === 1 ? "has" : "have"} no address yet: add ${
        missing.length === 1 ? "it" : "them"} once, for every run on this list, or leave ${
        missing.length === 1 ? "it" : "them"} out.</p>
    </div>`;
  }
  const n = stops.length;
  const cut = mapsApp() === "google" && n > GOOGLE_STOPS ? ` Google Maps gets the next ${GOOGLE_STOPS}.` : "";
  return `<div class="routebar">
    ${btn(`<span class="rcount">${n} STOP${n === 1 ? "" : "S"}${started ? " LEFT" : ""}${edited ? " &middot; YOURS" : ""}</span>${
      mapsDirect() ? `<svg class="ico ico-sm" aria-hidden="true"><use href="#i-external-link" /></svg>`
        : `<svg class="ico ico-sm" aria-hidden="true"><use href="#i-chevron-right" /></svg>`}`)}
    <p class="rpath">${from} &rarr; ${path}${order}.${cut}</p>
  </div>`;
}

/** `next`: only the next stop -- one place, which every Maps takes. */
function openRoute(number, app, next) {
  const a = assignments.find((x) => x.number === number);
  if (!a) return;
  const { stops, missing, start } = mapsRoute(a, nowAt());
  if (!stops.length || missing.length) return;
  const url = routeUrl(app, next ? stops.slice(0, 1) : stops, start);
  // A new window, as WhatsApp does: the installed app hands it to Maps.
  if (!window.open(url, "_blank")) location.href = url;
}

/** One place, added, changed or removed: on this phone at once, to the list
 *  through the outbox (offline-safe, by code, so two phones never clash). */
function savePlace(place, remove) {
  const code = place.code;
  const op = remove ? { kind: "place", code, remove: true }
    : { kind: "place", code, name: place.name || "", address: place.address };
  applyPlaceOp(op);
  enqueue(op);
  flush();
}

function applyPlaceOp(op) {
  const places = ownPlaces().filter((p) => p.code !== op.code);
  if (!op.remove) places.push({ code: op.code, name: op.name || "", address: op.address });
  places.sort((a, b) => a.code.localeCompare(b.code));
  settings = Object.assign({}, settings, { places });
}

/** Sent, and the list GET brought back already says so. */
function placeShown(op) {
  const p = ownPlaces().find((x) => x.code === op.code);
  return op.remove ? !p : !!p && p.address === op.address && p.name === (op.name || "");
}

/* ----------------------------------------------- airlines the list learned -- */

/*
 * An airline the importer has no code for (the owner, 2026-09-30) comes in as
 * a row with no flight and a line under the run saying so. FIX on the line
 * opens that flight; the driver's number fixes the row and -- ticked unless
 * they untick it -- teaches the list the airline's code, so later sheets
 * naming it get their flights filled in, marked LEARNED. The server fills
 * them in and tracks them (worker/src/learned.ts); this phone does the same
 * so it shows at once, offline too. A driver's own number always wins.
 */
const COULD_NOT_RESOLVE = /^(.+): could not resolve (['"])(.*)\2 \(([a-z-]+)\)$/;
const FLIGHT_GAPS = new Set(["unknown-airline", "no-flight-number", "no-airline-name"]);

function ownAirlines() {
  return (typeof settings !== "undefined" && settings && settings.airlines) || [];
}

/** The list's own airlines, then every driver's (marked `shared`) for the
 *  names it has not learned itself: as the server merges them. */
function listAirlines() {
  const own = ownAirlines();
  const mine = new Set(own.map((a) => airlineKey(a.name)));
  return [...own, ...(sharedCatalog.airlines || []).filter((a) => !mine.has(airlineKey(a.name)))
    .map((a) => ({ ...a, shared: true }))];
}

/** As the importer's table compares names: lower case, one space. */
function airlineKey(name) {
  return String(name || "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/** The airline a row's flight could not be named by: {name, number} (number
 *  null for a run read before numbers were kept), or null. */
function unknownAirlineOf(assignment, entity) {
  if (entity.unknownAirline) return entity.unknownAirline;
  for (const line of assignment.issues || []) {
    const m = COULD_NOT_RESOLVE.exec(line);
    if (m && m[4] === "unknown-airline" && m[1] === entity.name) return { name: m[3], number: null };
  }
  return null;
}

/** This phone's copy filled as the server fills it (applyLearned), and what
 *  an airline since forgotten or changed filled, taken back. */
function learnFlights(assignment) {
  const known = new Map(listAirlines().map((a) => [airlineKey(a.name), a]));
  for (const step of assignment.steps || []) {
    for (const action of step.actions || []) {
      for (const e of action.entities || []) {
        const u = e.unknownAirline;
        if (!u) continue;
        if (e._edit && "flightNumber" in e._edit) { delete e._learned; continue; } // the driver's
        const hit = known.get(airlineKey(u.name));
        if (e._learned) {
          if (hit && hit.code === e._learned.code) continue;
          e.flightNumber = null;
          delete e._learned;
        }
        if (!hit || !u.number || e.flightNumber) continue;
        e.flightNumber = `${hit.code}${u.number}`;
        if (u.date) e.flightDate = u.date;
        e._learned = { name: hit.name, code: hit.code };
      }
    }
  }
}

/** A code for a name, learned or forgotten: on this phone at once, to the
 *  list through the outbox (by name, so two phones never clash). */
function saveAirline(name, code, remove) {
  const op = remove ? { kind: "airline", name, remove: true } : { kind: "airline", name, code };
  applyAirlineOp(op);
  enqueue(op);
  flush();
}

function applyAirlineOp(op) {
  const airlines = ownAirlines().filter((a) => airlineKey(a.name) !== airlineKey(op.name));
  if (!op.remove) airlines.push({ name: op.name, code: op.code });
  airlines.sort((a, b) => airlineKey(a.name).localeCompare(airlineKey(b.name)));
  settings = Object.assign({}, settings, { airlines });
}

function airlineShown(op) {
  const a = ownAirlines().find((x) => airlineKey(x.name) === airlineKey(op.name));
  return op.remove ? !a : !!a && a.code === op.code;
}

/* ---- the keeper's review of what other drivers added ---- */

/** What is still to answer: not what the keeper's own list already says. */
function openSuggestions(kind) {
  return suggestions.filter((g) => g.kind === kind && (kind === "place"
    ? !ownPlaces().some((p) => p.code === g.code && p.address === g.address)
    : !ownAirlines().some((a) => airlineKey(a.name) === airlineKey(g.name) && a.code === g.code)));
}

/** ADD FOR EVERYONE: the keeper's own save, which is what shares it. */
function takeSuggestion(id) {
  const g = suggestions.find((x) => x.id === id);
  if (!g) return;
  if (g.kind === "place") savePlace({ code: g.code, name: g.name, address: g.address });
  else saveAirline(g.name, g.code);
}

/** DISMISS: on this phone at once, to the server through the outbox. */
function dismissSuggestion(id) {
  const op = { kind: "dismiss", id };
  applyDismissOp(op);
  enqueue(op);
  flush();
}

function applyDismissOp(op) {
  suggestions = suggestions.filter((g) => g.id !== op.id);
}

function dismissShown(op) {
  return !suggestions.some((g) => g.id === op.id);
}

/** A typed flight number's airline code: "WS1680" -> "WS", else null. */
function flightCode(value) {
  const m = /^([A-Z0-9]{2})(\d{1,5})$/.exec(String(value || "").replace(/\s+/g, "").toUpperCase());
  return m && /[A-Z]/.test(m[1]) ? m[1] : null;
}

/** The run's "could not read" lines, each flight one tied to its passenger:
 *  { text, entity?, why?, airline? } -- open while the row has no flight. */
function issueRows(assignment) {
  const rows = [];
  for (const text of assignment.issues || []) {
    const m = COULD_NOT_RESOLVE.exec(text);
    let entity = null;
    if (m && FLIGHT_GAPS.has(m[4])) {
      for (const step of assignment.steps || []) {
        for (const action of step.actions || []) {
          for (const e of action.entities || []) {
            if (!entity && !e._removed && e.name === m[1]) entity = e;
          }
        }
      }
    }
    rows.push(entity ? { text, entity, why: m[4], airline: m[3] } : { text });
  }
  return rows;
}

function openIssueCount(assignment) {
  return issueRows(assignment).filter((r) => !r.entity || !r.entity.flightNumber).length;
}

/* ------------------------------------------------ what dispatch changed -- */

/*
 * A re-sent sheet (spec "What changed", 2026-09-30). The server compares
 * dispatch's own copies -- never the driver's corrections -- from the one the
 * list last OK'd, and sends one entry per change, addressed by the rows' own
 * `_at` (worker/src/changes.ts). Drawn here in place -- the old value struck
 * under or beside the new, NEW, a dashed ghost where the new sheet dropped
 * something (no UNDO: it is dispatch's) -- and, until someone on the list says
 * OK, as WHAT DISPATCH CHANGED and UPDATED on the card. Strike-through means
 * dispatch moved it; nothing here is the app's own.
 */

const sheetIndexes = new WeakMap();

/** The run's changes by where they show, or null when there are none. */
function sheetMarks(a) {
  const sc = a && a.sheetChanges;
  if (!sc || !sc.count || !Array.isArray(sc.items)) return null;
  const known = sheetIndexes.get(sc);
  if (known) return known;
  const idx = { step: {}, action: {}, entity: {}, line: {}, stopsAfter: {}, peopleIn: {}, legsGone: [], notes: null, run: {} };
  const at = (map, key) => (map[key] = map[key] || {});
  const list = (map, key) => (map[key] = map[key] || []);
  for (const c of sc.items) {
    switch (c.kind) {
      case "vehicle": case "parking": idx.run[c.kind] = c; break;
      case "times": at(idx.step, c.at).times = c; break;
      case "place":
        if ("place" in c.was || "address" in c.was) at(idx.step, c.at).place = c;
        for (const d of c.doors || []) if (d.at) at(idx.action, d.at).door = d;
        break;
      case "stopAdded": at(idx.step, c.at).added = true; break;
      case "stopDropped": list(idx.stopsAfter, c.after ?? "").push(c); break;
      case "personAdded": for (const r of c.rows) at(idx.entity, r).added = true; break;
      case "personDropped":
      case "personMoved":
        // A ghost where they were: in the door that took the old one's place,
        // else at the stop; nowhere when the stop is gone too (its own ghost).
        for (const g of c.gone || []) {
          const host = g.action || g.step;
          if (host) list(idx.peopleIn, host).push({ name: c.name, moved: c.kind === "personMoved", to: g.to });
        }
        for (const h of c.here || []) at(idx.entity, h.at).moved = h;
        break;
      case "fact": for (const r of c.rows) (at(idx.entity, r.at).facts = at(idx.entity, r.at).facts || {})[c.fact] = r.was; break;
      case "legAdded": at(idx.line, c.at).added = true; break;
      case "legRetimed": at(idx.line, c.at).retimed = c.was; break;
      case "legReworded": at(idx.line, c.at).reworded = c.was; break;
      case "legDropped": idx.legsGone.push(c.line); break;
      case "notes": idx.notes = c; break;
    }
  }
  sheetIndexes.set(sc, idx);
  return idx;
}

/** UPDATED and the panel: changes nobody on the list has OK'd yet. */
function sheetUnseen(a) {
  const sc = a && a.sheetChanges;
  return Boolean(sc && sc.count && !sc.seen);
}

/** The old value, struck: dispatch moved it. */
function struck(html, cls = "") {
  return `<s class="swas${cls ? ` ${cls}` : ""}">${html}</s>`;
}

const NEW_CHIP = `<span class="schip">NEW</span>`;

/** A row the new sheet no longer has: dashed and struck, and no UNDO. */
function sheetGhost(what, verb, extra = "") {
  return `<div class="sghost"><span class="gwhat">${esc(what)}</span>${extra}<span class="gverb">${esc(verb)}</span></div>`;
}

/** A timed notes line read the way the timeline reads it: { at, time, text }. */
function legShown(assignment, text) {
  const l = noteLines({ ...assignment, lines: [{ printed: text, line: text, _at: "was" }] })[0];
  return l ? { at: l.at, time: l.time, text: l.text } : null;
}

/** step index -> the legs the new sheet dropped, placed as placeNoteLines
 *  places a line: the stop that is RIGHT NOW at its time. */
function placeGoneLegs(assignment) {
  const sm = sheetMarks(assignment);
  const placed = {};
  if (!sm || !sm.legsGone.length) return placed;
  const steps = (assignment.steps || []).map((s, i) => [s, i]).filter(([s]) => !s._removed);
  if (!steps.length) return placed;
  for (const text of sm.legsGone) {
    const l = legShown(assignment, text);
    if (!l) continue;
    const hit = steps.find(([s]) => {
      const leave = stepAt(s, "etd") ?? stepAt(s, "eta");
      return leave !== null && leave >= l.at;
    }) || steps[steps.length - 1];
    (placed[hit[1]] = placed[hit[1]] || []).push(l);
  }
  return placed;
}

/** A stop the new sheet dropped, in the rail where it was. */
function droppedStop(c) {
  const time = stepTime(c.eta) || stepTime(c.etd);
  return `<div class="step dropped">
      <div class="rail">${time ? `<span class="rtime">${esc(time)}</span>` : ""}</div>
      <div class="stepbody">${sheetGhost(c.code, "NOT ON THE NEW SHEET",
        c.place && c.place !== c.code ? `<span class="gplace">${esc(c.place)}</span>` : "")}</div>
    </div>`;
}

/** People the new sheet took out of this door or stop. */
function droppedPeople(sm, host) {
  return ((sm && sm.peopleIn[host]) || []).map((p) => `<div class="entity dropped">${sheetGhost(p.name,
    !p.moved ? "NOT ON THE NEW SHEET" : p.to ? `MOVED TO ${p.to}` : "NO LONGER HERE")}</div>`).join("");
}

/** One of a person's facts in words, for the panel. `other`: the same fact on
 *  the other copy, so a flight's city is said only when it moved. */
function factWords(fact, f, other) {
  const has = (v) => v !== null && v !== undefined && v !== "";
  switch (fact) {
    case "flight": {
      const at = splitScheduled(f.scheduledText);
      const city = at.place && (!other || at.place !== splitScheduled(other.scheduledText).place) ? ` ${at.place}` : "";
      const when = at.at ? `${fmtMinutes(wallMinutes(at.at)) || at.at}${city}` : f.scheduledText || "";
      return [f.flightNumber || "no flight", when].filter(Boolean).join(" ");
    }
    case "phone": return f.phone || "no number";
    case "bags": return has(f.bags) ? `${f.bags} bag${Number(f.bags) === 1 ? "" : "s"}` : "bags not given";
    case "pax": return has(f.pax) ? `${f.pax} passenger${Number(f.pax) === 1 ? "" : "s"}` : "";
    case "tag": return f.tag || "no tag";
    case "note": return f.note ? `“${f.note}”` : "no note";
    case "appointment": return [f.appointmentTime, f.duration].filter(Boolean).join(" · ") || "no time";
    case "trip": return [f.origin, f.destination].filter(Boolean).join(" → ") || f.route || "";
    default: return "";
  }
}

const FACT_FIELD = { flight: "flightNumber", phone: "phone" };

/** Where the driver's own value stands against dispatch's change: said under
 *  the panel's row, since the value on the stop is theirs (no strike there). */
function yoursLine(edit, words) {
  if (!edit) return "";
  if (edit.agreed) return "What you had set.";
  return `You set ${words}: yours stands until you choose.`;
}

/** A person's moves, in words: "was at EWR, now at JFK". */
function moveWords(c) {
  const bits = [];
  const here = [...(c.here || [])];
  for (const g of c.gone || []) {
    if (g.to) {
      bits.push(`was at ${g.code}, now at ${g.to}`);
      const k = here.findIndex((h) => h.from === g.code);
      if (k >= 0) here.splice(k, 1);
    } else bits.push(`no longer at ${g.code}`);
  }
  for (const h of here) bits.push(`now also at ${h.code}`);
  return bits.join("; ");
}

/** One row of WHAT DISPATCH CHANGED: where, then what (new, the old struck). */
function sheetRow(a, c) {
  const e = (v) => esc(String(v ?? ""));
  const stepOf = (at) => (a.steps || []).find((s) => s._at === at);
  const hostOf = (at) => hostAt(a, { at });
  let where = "", what = "", sub = "", label = false;
  switch (c.kind) {
    case "vehicle":
      label = true; where = "VEHICLE";
      what = `<b class="mono">${e(vehicleLabel(c.now) || c.now || "none")}</b>${struck(e(vehicleLabel(c.was) || c.was || "none"), "mono")}`;
      break;
    case "parking":
      label = true; where = "PARKING";
      what = `<b class="mono">${e(c.now || "none")}</b>${struck(e(c.was || "none"), "mono")}`;
      break;
    case "runTimes":
      label = true; where = "THE RUN";
      what = `<b class="mono">${e(clockLabel(c.now.start))} &ndash; ${e(clockLabel(c.now.end))}</b>${
        struck(`${e(clockLabel(c.was.start))} &ndash; ${e(clockLabel(c.was.end))}`, "mono")}`;
      break;
    case "times": {
      where = c.code;
      const day = (t) => (t.etaDate || t.date) !== (c.now.etaDate || c.now.date) ? `${e(shortDate(t.etaDate || t.date))} ` : "";
      what = `<b class="mono">${timesLabel(c.now.eta, c.now.etd) || "no time"}</b>${
        struck(`${day(c.was)}${timesLabel(c.was.eta, c.was.etd) || "no time"}`, "mono")}`;
      const s = stepOf(c.at);
      const mine = s && s._edit ? ["eta", "etd", "time"].filter((f) => s._edit[f])
        .map((f) => `${f === "etd" ? "leave" : f === "eta" ? "arrive" : "the time"} ${stepTime(s._edit[f].value)}`) : [];
      if (s && s._removed) sub = "You marked it not happening.";
      else if (mine.length) sub = `You set ${mine.join(", ")}: yours stands until you choose.`;
      break;
    }
    case "place": {
      where = c.code;
      const bits = [];
      if ("place" in c.was || "address" in c.was) {
        const now = [c.now.place, c.now.address].filter(Boolean).join(" · ");
        const was = ["place" in c.was ? c.was.place : c.now.place, "address" in c.was ? c.was.address : c.now.address]
          .filter(Boolean).join(" · ");
        bits.push(`<span>${e(now)}</span>${struck(e(was || "no address"))}`);
      }
      const subs = [];
      for (const d of c.doors || []) {
        const verb = (x) => e(String(x.verb || "").toLowerCase());
        if (!d.was) bits.push(`<span>${verb(d.now)} <b>${e(d.now.where || "door not given")}</b></span>${NEW_CHIP}`);
        else if (!d.now) bits.push(`${struck(`${verb(d.was)} ${e(d.was.where || "door not given")}`)}<span class="sc-gone">not on the new sheet</span>`);
        else {
          bits.push(`<span>${verb(d.now)} <b>${e(d.now.where || "door not given")}</b></span>${
            struck(`${d.was.verb !== d.now.verb ? `${verb(d.was)} ` : ""}${e(d.was.where || "door not given")}`)}`);
          const h = hostOf(d.at);
          const edit = h && h._edit && h._edit.where;
          if (edit) subs.push(yoursLine(edit, h.where || "no door"));
        }
      }
      what = bits.join("");
      sub = subs.join(" ");
      break;
    }
    case "stopAdded":
      where = c.code;
      what = `<span>${e(c.place)}</span>${NEW_CHIP}`;
      break;
    case "stopDropped": {
      where = c.code;
      const t = stepTime(c.eta) || stepTime(c.etd);
      what = `${struck(`${e(c.place)}${t ? ` <span class="mono">${e(t)}</span>` : ""}`)}<span class="sc-gone">not on the new sheet</span>`;
      break;
    }
    case "personAdded":
      where = c.codes.join(", ");
      what = `<span>${e(c.name)}</span>${NEW_CHIP}`;
      break;
    case "personDropped":
      where = c.codes.join(", ");
      what = `${struck(e(c.name))}<span class="sc-gone">not on the new sheet</span>`;
      if ((a.changes || []).some((x) => x.kind === "remove" && x.label === c.name)) sub = "You had marked them not coming.";
      break;
    case "personMoved":
      where = c.codes.join(", ");
      what = `<span>${e(c.name)}</span><span class="schip">MOVED</span><span class="sc-note">${e(moveWords(c))}</span>`;
      break;
    case "fact": {
      where = c.codes.join(", ");
      what = `<span>${e(c.name)} &middot; <b>${e(factWords(c.fact, c.now, c.was))}</b></span>${
        struck(e(factWords(c.fact, c.was, c.now)))}`;
      const field = FACT_FIELD[c.fact];
      for (const r of c.rows) {
        const h = field && hostOf(r.at);
        const edit = h && h._edit && h._edit[field];
        if (edit && !edit.propagated) { sub = yoursLine(edit, h[field] || "nothing"); break; }
      }
      break;
    }
    case "legAdded":
    case "legRetimed":
    case "legReworded":
    case "legDropped": {
      label = true; where = "LEG";
      const now = legShown(a, c.line) || { time: "", text: c.line };
      const was = c.was ? legShown(a, c.was) || { time: "", text: c.was } : null;
      const t = (x) => `<span class="mono">${e(x.time)}</span>`;
      if (c.kind === "legAdded") what = `<span>${t(now)} ${e(now.text)}</span>${NEW_CHIP}`;
      else if (c.kind === "legRetimed") what = `<span><b class="mono">${e(now.time)}</b></span>${struck(e(was.time), "mono")}<span>${e(now.text)}</span>`;
      else if (c.kind === "legReworded") what = `<span>${t(now)} ${e(now.text)}</span>${struck(e(was.text))}`;
      else what = `${struck(`${t(now)} ${e(now.text)}`)}<span class="sc-gone">not on the new sheet</span>`;
      const row = c.at && ensureLines(a).find((l) => l._at === c.at);
      const edit = row && row._edit && row._edit.line;
      if (edit) sub = yoursLine(edit, row.line);
      break;
    }
    case "notes": {
      label = true; where = "NOTES";
      const n = c.added.length, g = c.dropped.length;
      what = `<span>${[n ? `${n} new line${n === 1 ? "" : "s"}` : "", g ? `${g} gone` : ""].filter(Boolean).join(", ")}: in DRIVER NOTES below</span>`;
      break;
    }
    default:
      return "";
  }
  return `<div class="sc-row"><span class="sc-where${label ? " lbl" : ""}">${e(where)}</span>
      <span class="sc-what">${what}${sub ? `<span class="sc-sub">${e(sub)}</span>` : ""}</span></div>`;
}

/** WHAT DISPATCH CHANGED, under RIGHT NOW and the route, until OK. */
function sheetPanel(a) {
  if (!sheetUnseen(a)) return "";
  const sc = a.sheetChanges;
  const at = (p) => `<span class="mono">${esc(printedLabel(p))}</span>`;
  const n = sc.count;
  return `<section class="sheetchg" aria-label="What dispatch changed">
      <div class="sc-head"><span class="k">WHAT DISPATCH CHANGED</span><span class="spacer"></span>
        <button class="mini-btn" type="button" id="sheet-ok">OK</button></div>
      <p class="sc-lede">The copy printed ${a.printedAt ? at(a.printedAt) : "last"}, against ${
        sc.since ? `the one printed ${at(sc.since)}` : "the one you had"}. ${n} change${n === 1 ? "" : "s"}, each marked below.</p>
      ${sc.items.map((c) => sheetRow(a, c)).join("")}
    </section>`;
}

/** OK: for every phone on the list, through the outbox like any edit, and on
 *  this one at once. The marks on the stops stay. */
function okSheet(number) {
  const a = assignments.find((x) => x.number === number);
  if (!a || !sheetUnseen(a)) return;
  const op = { kind: "seen", number, printedAt: a.printedAt };
  applySeenOp(op);
  enqueue(op);
  renderCurrent();
  flush();
}

function applySeenOp(op) {
  const a = assignments.find((x) => x.number === op.number);
  if (a && a.sheetChanges && a.printedAt === op.printedAt) a.sheetChanges.seen = true;
}

/** Sent, and GET already says so -- or a newer copy made it moot. */
function seenShown(op) {
  const a = assignments.find((x) => x.number === op.number);
  return !a || !a.sheetChanges || a.printedAt !== op.printedAt || Boolean(a.sheetChanges.seen);
}

/* ------------------------------------------------------- the list screen -- */

/** "CLD Shuttle, After Breakfast Shuttle → MGW → NCA": a window goes by its
 *  printed label (a code alone reads as a place), windows in a row by commas. */
function routeOf(assignment) {
  let route = "";
  let last = null, lastWindow = false;
  for (const step of assignment.steps || []) {
    if (step._removed) continue;
    const win = isWindow(step);
    const c = win ? step.place || step.code : step.code || step.place;
    if (!c || c === last) continue;
    route += route ? (win && lastWindow ? ", " : " → ") + c : c;
    last = c;
    lastWindow = win;
  }
  return route;
}

function paxCount(assignment) {
  let n = 0;
  const seen = new Set();
  for (const step of assignment.steps || []) {
    if (step._removed) continue;
    for (const action of step.actions || []) {
      for (const e of action.entities || []) {
        if (e._removed || seen.has(e.name)) continue;
        seen.add(e.name);
        // Always a number: the card prints the total as it is, and a count
        // that arrived as text would be joined on, markup and all.
        const pax = Number(e.pax);
        n += pax > 0 ? pax : 1;
      }
    }
  }
  return n;
}

/** The run's arriving flight furthest off its schedule, by MOVED_MIN or more:
 *  { flight, minutes } (+ late, - early), or null. Only arrivals: a late
 *  departure never moves the check-in desk (checkInBasis), so it changes
 *  nothing the driver does. The list card says it (v65). */
function movedFlight(assignment) {
  let best = null;
  for (const step of assignment.steps || []) {
    if (step._removed) continue;
    for (const action of step.actions || []) {
      for (const e of action.entities || []) {
        if (e._removed || !e.flightNumber || isDepartureTag(e.tag)) continue;
        const leg = legOf(statusFor(e, step.etaDate || step.date), e);
        const at = legAt(leg);
        const sched = legAt(leg && leg.scheduledTime ? { scheduledTime: leg.scheduledTime } : null);
        if (at === null || sched === null) continue;
        const minutes = Math.round(at - sched);
        if (Math.abs(minutes) < MOVED_MIN) continue;
        if (!best || Math.abs(minutes) > Math.abs(best.minutes)) best = { flight: e.flightNumber, minutes };
      }
    }
  }
  return best;
}

/** "UA1503 1H 05M LATE", "B6123 12M EARLY". */
function movedWords(m) {
  const n = Math.abs(m.minutes);
  const span = n >= 60 ? `${Math.floor(n / 60)}H${n % 60 ? ` ${String(n % 60).padStart(2, "0")}M` : ""}` : `${n}M`;
  return `${m.flight} ${span} ${m.minutes > 0 ? "LATE" : "EARLY"}`;
}

function renderAssignmentCard(assignment, nowIso) {
  const startWall = parseWall(assignment.start);
  const endWall = parseWall(assignment.end);
  const inProgress = isInProgress(assignment, nowIso);
  const chips = [];
  if (inProgress) chips.push(`<span class="achip here">IN PROGRESS</span>`);
  // Dispatch re-sent it and nobody on the list has OK'd what changed: the
  // run's old start and end struck beside the new ones, when they moved.
  const updated = sheetUnseen(assignment);
  const runWas = updated ? assignment.sheetChanges.run || {} : {};
  if (updated) chips.push(`<span class="achip upd">UPDATED</span>`);
  if (assignment._queued) chips.push(`<span class="achip unsent">NOT SENT</span>`);
  if (assignment.gb) chips.push(`<span class="achip gb">GB</span>`);
  const toCheck = openIssueCount(assignment);
  if (toCheck) {
    chips.push(`<span class="achip alert">${toCheck} TO CHECK</span>`);
  }
  // What only this app knows, on the first screen: a flight that moved, and
  // passengers told a plan that has changed since (messaged()). Not once the
  // run is over: by then it is history, not news.
  const live = effectiveEnd(assignment) >= nowIso;
  const moved = live ? movedFlight(assignment) : null;
  if (moved) chips.push(`<span class="achip moved">${esc(movedWords(moved))}</span>`);
  const stale = live ? staleCount(assignment) : 0;
  if (stale) chips.push(`<span class="achip alert">${stale} TO MESSAGE AGAIN</span>`);
  const windows = (assignment.steps || []).filter((s) => !s._removed && isWindow(s));
  const shuttles = windows.filter((s) => /shuttle/i.test(s.place || "")).length;
  if (shuttles) chips.push(`<span class="achip">${shuttles} SHUTTLE${shuttles === 1 ? "" : "S"}</span>`);
  const legs = windows.length ? noteLines(assignment).filter((l) => !l.row._removed).length : 0;

  const pax = paxCount(assignment);
  // The number first: import lines and dispatch both name a run by it.
  const meta = [
    `#${esc(assignment.number)}`,
    legs ? `${legs} leg${legs === 1 ? "" : "s"} in the notes` : null,
    pax ? `${pax} passenger${pax === 1 ? "" : "s"}` : null,
    assignment.vehicle ? esc(vehicleLabel(assignment.vehicle)) : null,
  ].filter(Boolean).join(" &middot; ");

  return `
    <button class="acard${inProgress ? " now" : ""}${assignment.gb ? " gb" : ""}"
            type="button" data-assignment="${esc(assignment.number)}">
      <span class="arow">
        <span class="atime">${esc(clockLabel(assignment.start))}</span>${runWas.start ? struck(esc(clockLabel(runWas.start)), "awas") : ""}
        <span class="adash">&ndash;</span>
        <span class="atime">${esc(clockLabel(assignment.end))}</span>${runWas.end ? struck(esc(clockLabel(runWas.end)), "awas") : ""}
        <span class="aspace"></span>${chips.join("")}
      </span>
      <span class="aroute">${esc(routeOf(assignment))}</span>
      <span class="ameta">${meta}</span>
    </button>`;
}

/** Hours a finished run stays on the home screen (spec "Archive and retention"). */
const ARCHIVE_AFTER_H = 10;
let archiveOpen = false;

function renderAssignments() {
  if (holdScreen) return;
  const returning = screen !== "list";
  screen = "list";
  openAssignmentNumber = null;
  callsDay = null;
  settleHistory();
  syncWakeLock();
  const nowIso = localStamp();
  const today = nowIso.slice(0, 10);

  if (!assignments.length && !hiddenRuns.length) {
    const block = importBlock() + alertsBar();
    const hint = importHint();
    main.innerHTML = `
      ${block ? `<div class="screen-pad">${block}</div>` : ""}
      <div class="empty-state">
        ${icon("car")}
        <h2>No assignments yet</h2>
        <p>Import dispatch's PDF and the run shows up here, sorted by when it starts. The next sheet usually lands around 5:00p.</p>
        <button class="submit" type="button" id="empty-import">${icon("file-plus")}IMPORT A SHEET</button>
        ${hint ? `<p class="empty-hint">${esc(hint)}</p>` : ""}
      </div>`;
    document.getElementById("empty-import").addEventListener("click", pickSheets);
    wireImportBlock();
    wireAlertsBar();
    return;
  }

  // Upcoming first, because that is the work. A run that ended stays on the
  // home screen for ARCHIVE_AFTER_H -- a 3 AM finish is still there when you
  // wake up -- then moves behind ARCHIVE, still readable, until the list's
  // retention deletes it (worker/src/retention.ts).
  // A run removed from this phone keeps its place here, as a ghost with its
  // UNDO, and nowhere else (hiddenCard).
  const archiveBefore = localStamp(new Date(Date.now() - ARCHIVE_AFTER_H * 3600000));
  const gone = new Set(hiddenRuns);
  const all = [...assignments, ...hiddenRuns].sort((x, y) => String(x.start).localeCompare(String(y.start)));
  const card = (a) => (gone.has(a) ? hiddenCard(a) : renderAssignmentCard(a, nowIso));
  const ends = new Map(all.map((a) => [a, effectiveEnd(a)]));
  const upcoming = all.filter((a) => ends.get(a) >= nowIso);
  const past = all.filter((a) => ends.get(a) < nowIso && ends.get(a) >= archiveBefore).reverse();
  const archived = all.filter((a) => ends.get(a) < archiveBefore).reverse();

  let html = "";
  let lastDay = null;
  for (const a of upcoming) {
    const day = a.start.slice(0, 10);
    if (day !== lastDay) {
      lastDay = day;
      const label = day === today ? "TODAY" : shortDate(day).toUpperCase();
      html += `<div class="daygroup">${esc(label)}</div>`;
    }
    html += card(a);
  }
  if (past.length) {
    html += `<div class="daygroup">EARLIER &middot; ${past.length}</div>`;
    html += past.map(card).join("");
  }
  if (!upcoming.length && !past.length) {
    html += `<p class="ameta" style="margin:4px 0 0">Nothing coming up. The next sheet lands around 5:00p.</p>`;
  }
  if (archived.length) {
    const keep = settings.retentionDays;
    html += `<button class="archivebar" type="button" id="toggle-archive" aria-expanded="${archiveOpen}">
               <span>ARCHIVE &middot; ${archived.length}</span><span class="spacer"></span>
               <span>${keep ? `KEPT ${keep} DAYS` : ""} ${archiveOpen ? "&#9652;" : "&#9662;"}</span>
             </button>`;
    if (archiveOpen) {
      let aDay = null;
      for (const a of archived) {
        const day = a.start.slice(0, 10);
        if (day !== aDay) {
          aDay = day;
          html += `<div class="daygroup">${esc(shortDate(day).toUpperCase())}</div>`;
        }
        html += card(a);
      }
    }
  }

  const day = nextAssignmentDay();
  // Someone messaged before their plan changed is left again (messaged()).
  const pending = day
    ? callsFor(day).filter((r) => r.phone
        && !messageDone(assignments.find((a) => a.number === r.assignment), r)).length
    : 0;
  const callsBtn = day
    ? `<button class="callsbar" type="button" id="open-calls">
         ${icon("message-square", "ico-sm")}<span>MESSAGES FOR ${esc(shortDate(day).toUpperCase())}</span>
         <span class="spacer"></span>
         <span class="${pending ? "left" : "ok"}">${pending ? `${pending} LEFT` : "ALL DONE"}</span>
       </button>`
    : "";

  main.innerHTML = `${offlineStrip()}<div class="screen-pad">${importBlock()}${alertsBar()}${callsBtn}${checksBar(upcoming)}${html}</div>`;
  wireImportBlock();
  wireAlertsBar();
  const kb = document.getElementById("checks-bar");
  if (kb) kb.addEventListener("click", () => openChecks());
  const cb = document.getElementById("open-calls");
  if (cb) cb.addEventListener("click", () => renderCalls());
  const ab = document.getElementById("toggle-archive");
  if (ab) ab.addEventListener("click", () => { archiveOpen = !archiveOpen; renderAssignments(); });
  main.querySelectorAll("[data-assignment]").forEach((el) => {
    el.addEventListener("click", () => renderItinerary(el.dataset.assignment));
  });
  main.querySelectorAll("[data-unhide]").forEach((el) => {
    el.addEventListener("click", () => { unhideRun(el.dataset.unhide); renderAssignments(); });
  });
  if (returning) setPageScroll(listScroll);
}

/* --------------------------------------------------- the itinerary screen -- */

/** RIGHT NOW's second line: the NEXT clock the driver is working to. Once
 *  parked-by has passed the driver is there, and what matters is when the car
 *  leaves -- ours, marked "~" and given its reason; dispatch's own time is
 *  still in the step's clock block. */
function nowWhy(step, clocks, now) {
  if (clocks.parkedBy !== null && (clocks.leavingAt === null || now < clocks.parkedBy)) {
    return `Parked by ${fmtMinutes(clocks.parkedBy)} · ${clocks.parkedWhy}`;
  }
  if (clocks.leavingAt !== null) return `Leaving ~${fmtMinutes(clocks.leavingAt)} · ${clocks.leavingWhy}`;
  const sheetEta = sheetTime(step, "eta");
  if (step.eta && step.eta !== sheetEta) return `You set ${stepTime(step.eta)} · dispatch ${stepTime(sheetEta)}`;
  return step.eta ? `Dispatch has you there at ${stepTime(step.eta)}` : "";
}

/** When the server last heard about any of this run's flights (ISO), or null
 *  when none has been checked yet -- the rows then say "as printed". */
function flightsCheckedAt(assignment) {
  let newest = null;
  for (const step of assignment.steps || []) {
    if (step._removed) continue;
    for (const action of step.actions || []) {
      for (const entity of action.entities || []) {
        if (entity._removed) continue;
        const status = statusFor(entity, step.etaDate || step.date);
        if (status && status.fetchedAt && (!newest || status.fetchedAt > newest)) newest = status.fetchedAt;
      }
    }
  }
  return newest;
}

/** live under 5 min (a green dot), plain after. Never red for its age: on
 *  the free plan a flight is checked about 3h and 45m before landing and just
 *  after (worker checks.ts), so "checked 2h ago" is the plan, not a problem. */
function freshState(iso, now = Date.now()) {
  return (now - Date.parse(iso)) / 60000 < 5 ? "live" : "";
}

const LS_PUSH_ASKED = "fw_push_asked"; // the "alerts are off" bar was answered once

/**
 * Above the list when this phone gets no alerts from Curbside (v66). Stopped
 * after having been on (the phone blocks them now, or its sign-up was lost)
 * is a problem and stays until fixed: a driver counting on a buzz that will
 * not come is the failure this app is for. Never turned on is an offer, made
 * until it is tapped once; after that it is the driver's choice, in Settings.
 */
function alertsBar() {
  if (pushState !== "lost" && pushState !== "off") return "";
  const lost = pushState === "lost";
  let asked = false;
  try { asked = !!localStorage.getItem(LS_PUSH_ASKED); } catch (_) { /* private mode */ }
  if (!lost && asked) return "";
  return `<button class="callsbar" type="button" id="alerts-bar">
      ${icon("bell", "ico-sm")}<span>${lost ? "ALERTS STOPPED ON THIS PHONE" : "ALERTS ARE OFF ON THIS PHONE"}</span>
      <span class="spacer"></span>
      <span class="${lost ? "bad" : "left"}">TURN ON</span>
    </button>`;
}

/** Its tap: straight to the page that turns them on (app.js openAlerts). */
function wireAlertsBar() {
  const bar = document.getElementById("alerts-bar");
  if (bar) bar.addEventListener("click", () => openAlerts());
}

function hasFlight(assignment) {
  return (assignment.steps || []).some(
    (s) => (s.actions || []).some((a) => (a.entities || []).some((e) => e.flightNumber)));
}

/**
 * Paused flight checks are said on the list too (v65), once, above the runs
 * they touch: a delay found by nobody is the one thing that must show. A bar
 * like the list's others (v67), red where it says how long; its tap opens the
 * page that says how many lookups are left and why (app.js openChecks).
 */
function checksBar(runs) {
  if (!flightChecks || flightChecks.state !== "paused" || !runs.some(hasFlight)) return "";
  const until = flightChecks.until ? `UNTIL ${esc(shortDate(flightChecks.until.slice(0, 10)).toUpperCase())}` : "WHY";
  return `<button class="callsbar" type="button" id="checks-bar">
      ${icon("triangle-alert", "ico-sm")}<span>FLIGHT CHECKS PAUSED</span>
      <span class="spacer"></span>
      <span class="bad">${until}</span>
    </button>`;
}

/** Said only when the free plan's month is running out (worker checks.ts):
 *  "low" keeps the check before landing; "paused" makes none. */
function checksNote(assignment) {
  if (!flightChecks || flightChecks.state === "ok" || !hasFlight(assignment)) return "";
  if (flightChecks.state === "low") {
    return `<p class="checksnote">Flight checks running low: only the one before landing</p>`;
  }
  const until = flightChecks.until ? ` until ${esc(shortDate(flightChecks.until.slice(0, 10)))}` : "";
  return `<p class="checksnote paused">Flight checks paused${until}: this month's free lookups are used up. Times are the last check's, or as printed.</p>`;
}

/** Nothing on screen says how old a gate or an estimate is, and the cron only
 *  asks about flights that are due. So say it. */
function checkedLabel(iso, now = Date.now()) {
  const mins = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
  if (mins < 1) return "Flights checked just now";
  if (mins < 60) return `Flights checked ${mins}m ago`;
  if (mins < 48 * 60) return `Flights checked ${Math.floor(mins / 60)}h ago`;
  return `Flights checked ${Math.floor(mins / 1440)}d ago`;
}

/** DRIVER NOTES. Once its timed lines are on the timeline, the block keeps the
 *  rest -- the prose -- and SHOW ALL gives back every line as printed. */
let notesOpen = null; // the run whose notes show in full

/** Notes lines as a paragraph; a re-sent sheet's new prose lines marked NEW
 *  and the ones it dropped struck at the end (its legs are on the timeline). */
function notesHtml(lines, marks) {
  const key = (l) => String(l).trim().replace(/\s+/g, " ").toLowerCase();
  const fresh = marks.added.map(key);
  const parts = lines.map((line) => {
    const k = fresh.indexOf(key(line));
    if (k < 0) return esc(line);
    fresh.splice(k, 1);
    return `${esc(line)} ${NEW_CHIP}`;
  });
  for (const l of marks.dropped) parts.push(`${struck(esc(l))} <span class="sc-gone">not on the new sheet</span>`);
  return parts.join("\n");
}

function notesBlock(assignment) {
  const raw = String(assignment.driverNotes || "");
  const sm = sheetMarks(assignment);
  const marks = sm && sm.notes;
  if (!raw.trim() && !marks) return "";
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const prose = lines.filter((l) => !timedLine(l));
  const text = (ls, whole) => (marks ? notesHtml(ls, marks) : esc(whole ?? ls.join("\n")));
  if (prose.length === lines.length || !noteLines(assignment).length) {
    return `<div class="notes"><span class="k">DRIVER NOTES</span><p>${text(lines, raw)}</p></div>`;
  }
  const open = notesOpen === assignment.number;
  const shown = open ? `<p>${text(lines, raw)}</p>`
    : prose.length || marks ? `<p>${text(prose)}</p>`
    : `<p class="ameta">Every line is a leg on the timeline above.</p>`;
  return `<div class="notes"><span class="k">DRIVER NOTES${open ? ", AS PRINTED" : ""}</span>${shown}
    <button class="text-btn notes-all" type="button" data-notes-all aria-expanded="${open}">${
      open ? "SHOW LESS" : `SHOW ALL ${lines.length} LINES`}</button></div>`;
}

function renderItinerary(number, clock = new Date()) {
  const assignment = assignments.find((a) => a.number === number);
  if (!assignment) return renderAssignments();
  // A refresh repaints in place; only opening a run starts at its top.
  const opening = screen !== "itinerary" || openAssignmentNumber !== number;
  if (screen === "list") { listScroll = pageScroll(); pushLayer({ screen: "itinerary" }); }
  // The past step the driver opened stays open through a repaint: the minute
  // tick must not close it under their thumb.
  const openStep = opening ? null : main.querySelector(".step.open");
  const keepOpen = openStep && openStep.dataset.at;
  screen = "itinerary";
  openAssignmentNumber = number;

  const now = nowAt(clock);

  // RIGHT NOW: the first step that has not finished. One authoritative answer,
  // and when the run is a GB one the band carries the stamp rather than being
  // displaced by it.
  const live = (assignment.steps || []).find((s) => {
    if (s._removed) return false;
    return !stepDone(s, clocksFor(s), now);
  });
  const placed = placeNoteLines(assignment);
  let band = "";
  let nowKey = null;
  if (live) {
    const clocks = clocksFor(live);
    const verb = (live.actions || [])[0];
    let headline = verb
      ? `${verb.verb} at ${live.place}${verb.where ? " — " + verb.where : ""}`
      : `Head to ${live.place}`;
    let why = nowWhy(live, clocks, now);
    let label = "", when = "";
    // A window is never "Head to": the leg it is on, as printed, or its own
    // label and hours when it has none left.
    if (isWindow(live)) {
      const legs = legsAhead(assignment, placed, assignment.steps.indexOf(live));
      const i = nowLeg(legs, now, readLS(LS_TICKS, {}));
      if (i >= 0) {
        const leg = legs[i];
        nowKey = leg.key;
        label = String(leg.step.place || leg.step.code || "").toUpperCase();
        headline = leg.text;
        const soon = leg.at > now ? `in ${fmtDuration(leg.at - now)}` : "now";
        when = `<div class="nowtime"><span class="t">${esc(leg.time)}</span><span class="in">${
          esc(leg.printedTime ? `${soon} · you set it; dispatch ${leg.printedTime}` : soon)}</span></div>`;
        const ticks = readLS(LS_TICKS, {});
        const then = legs.slice(i + 1).find((l) => !ticks[l.key]);
        const after = then ? null : (assignment.steps || []).slice(assignment.steps.indexOf(leg.step) + 1)
          .find((s) => !s._removed && !isWindow(s));
        why = then ? `Then ${then.time} ${then.text}`
          : after ? `Then ${after.code || after.place}${stepTime(after.eta) ? ` at ${stepTime(after.eta)}` : ""}` : "";
      } else {
        const eta = stepAt(live, "eta"), etd = stepAt(live, "etd");
        headline = live.place || live.code;
        why = eta !== null && now < eta
          ? `From ${fmtMinutes(eta)}${etd !== null ? ` to ${fmtMinutes(etd)}` : ""}`
          : etd !== null ? `Until ${fmtMinutes(etd)}` : "";
      }
    }
    const checked = flightsCheckedAt(assignment);
    band = `
      <div class="nowband">
        <div class="nowhead">
          <span class="k">RIGHT NOW</span>
          ${assignment.gb ? `<span class="gbtag">GB &middot; GOVERNING BODY</span>` : ""}
          ${label ? `<span class="k wk">${esc(label)}</span>` : ""}
        </div>
        ${when}
        <span class="v">${esc(headline)}</span>
        ${why ? `<span class="why">${esc(why)}</span>` : ""}
      </div>
      ${checked ? `<p class="fresh ${freshState(checked)}" data-checked="${esc(checked)}">${esc(checkedLabel(checked))}</p>` : ""}`;
  }

  const notes = notesBlock(assignment);

  // Import gaps are surfaced, never swallowed: "I could not read this part" is
  // a feature, and it is where the app earns trust for everything that DID
  // import.
  // A flight the sheet left unreadable is one tap from its fix (FIX opens it,
  // and can teach the list the airline); once fixed it says so, and whose.
  const iRows = issueRows(assignment);
  const nOpen = iRows.filter((r) => !r.entity || !r.entity.flightNumber).length;
  const issueLine = (r) => {
    if (!r.entity) return `<li>${esc(r.text)}</li>`;
    const e = r.entity;
    if (e.flightNumber) {
      return `<li class="ifixed">${icon("check", "ico-sm")}<span>${esc(e.name)}: <b>${esc(e.flightNumber)}</b> ${
        e._learned ? `&middot; learned ${esc(e._learned.name)} = ${esc(e._learned.code)}` : "&middot; yours"}</span></li>`;
    }
    const u = unknownAirlineOf(assignment, e);
    const words = r.why === "unknown-airline"
      ? `${esc(e.name)}: the sheet says <b>${esc(r.airline)}${u && u.number ? ` ${esc(u.number)}` : ""}</b>, an airline I have no code for.`
      : r.why === "no-flight-number" ? `${esc(e.name)}: <b>${esc(r.airline)}</b>, with no flight number.`
      : `${esc(e.name)}: no airline on the sheet.`;
    const doc = e._edit && e._edit.flightNumber ? e._edit.flightNumber.documentValue : e.flightNumber;
    return `<li class="ifix"><span>${words}</span><button class="mini-btn" type="button"
      data-edit="${editAttr(e._at, "flightNumber", `Flight for ${e.name}`, e.flightNumber, doc)}">FIX</button></li>`;
  };
  const issues = iRows.length
    ? `<div class="issues${nOpen ? "" : " ok"}"><span class="k">${nOpen
        ? `${nOpen} THING${nOpen === 1 ? "" : "S"} I COULD NOT READ` : "EVERYTHING I COULD NOT READ IS FIXED"}</span>
         <ul>${iRows.map(issueLine).join("")}</ul></div>` : "";

  // M1: RIGHT NOW moved on to another stop since the last paint of this run.
  // Painted inside a view transition instead, so the ring travels and the
  // band's words hand over (motion.js); this call ends here.
  // The transition paints a frame later: not over a screen the driver left.
  // A leg handing over to the next is a move too.
  if (advancePaint(number, live ? `${live._at}|${nowKey || ""}` : null, opening, () => {
    if (screen === "itinerary" && openAssignmentNumber === number) renderItinerary(number);
  })) return;

  // A stop a re-sent sheet dropped stays in the rail where it was: after the
  // stop before it (sheetMarks), as a ghost that is nobody's to undo.
  const sm = sheetMarks(assignment);
  const goneLegs = placeGoneLegs(assignment);
  const dropped = (after) => ((sm && sm.stopsAfter[after]) || []).map(droppedStop).join("");
  const steps = dropped("") + (assignment.steps || [])
    .map((s, i) => renderStep(s, i, assignment, now, placed[i], s === live, nowKey, goneLegs[i])
      + (s._add ? "" : dropped(s._at))).join("");

  // Provenance, at the foot: which copy of this run the app is holding. The
  // driver never chooses which assignment an import updates -- the number is
  // the identity and the newest PRINTED copy wins -- but "am I looking at the
  // latest sheet?" is a fair question and this answers it.
  // Corrections that no longer point at anything: dispatch reprinted the sheet
  // and the thing corrected is not recognisable. Kept and shown, never applied
  // to a near miss -- the driver re-places or discards them.
  // Queued edits the server refused land here too: made offline against a
  // copy dispatch has since replaced. Same problem, same answer.
  const lost = assignment.orphanedEdits || [];
  const refused = lostEdits().filter((l) => l.number === assignment.number);
  const nLost = lost.length + refused.length;
  const orphans = nLost
    ? `<div class="issues"><span class="k">${nLost} CHANGE${nLost === 1 ? "" : "S"} I COULD NOT PLACE</span>
         <ul>${lost.map((p) => `<li>${describePatch(p)}
           <button class="mini-btn" type="button" data-discard="${esc(p.id)}">DISCARD</button></li>`).join("")}${
           refused.map((l) => `<li>${esc(l.label)}${"value" in l ? ` &rarr; <b>${esc(l.value ?? "blank")}</b>` : ""}
           <span class="ameta">${esc(l.reason)}</span>
           <button class="mini-btn" type="button" data-discard-lost="${esc(l.ref)}">DISCARD</button></li>`).join("")}</ul>
         <p class="ameta" style="margin:0">The sheet changed around these. Tap the value again to re-enter it.</p>
       </div>` : "";
  // Removals a later sheet agrees with: the row is gone from dispatch's copy
  // too, so there is nothing left to draw a ghost on. Said, and left for the
  // driver to clear -- the app does not drop their patch for them.
  const gone = (assignment.changes || []).filter((c) => c.gone);
  const agreedGone = gone.length
    ? `<div class="issues ok"><span class="k">THE SHEET AGREES</span>
         <ul>${gone.map((c) => `<li>Dispatch dropped <b>${esc(c.label || "a row")}</b> too
           <button class="mini-btn" type="button" data-use="${esc(c.patchId)}">CLEAR MINE</button></li>`).join("")}</ul></div>` : "";
  // In place and never expiring. No toast: five seconds to react at 2 AM is a
  // promise the app cannot keep.
  const nEdits = (assignment.edits || []).length + (assignment.changes || []).length + lost.length;
  const nWaiting = pendingFor(assignment.number).length;
  const waiting = nWaiting ? ` &middot; ${nWaiting} waiting for signal` : "";
  const undo = nEdits
    ? `<div class="undo-row"><span>${nEdits} change${nEdits === 1 ? "" : "s"} of yours on this run${waiting}</span>
         <button class="mini-btn" type="button" id="undo-edit">UNDO LAST EDIT</button></div>` : "";

  const printed = assignment.printedAt
    ? `dispatch printed this copy ${esc(stampLabel(assignment.printedAt))}`
    : "this copy carries no print date";

  main.innerHTML = `
    ${assignment.gb ? `<div class="gbstrip"></div>` : ""}
    <div class="ihead">
      <button class="back" type="button" id="itin-back">${icon("chevron-left", "ico-sm")}ASSIGNMENTS</button>
      ${assignment.gb && !band ? `<span class="gbtag">GB &middot; GOVERNING BODY</span>` : ""}
      <span class="veh num">#${esc(assignment.number)}</span>
    </div>
    ${offlineStrip()}${importStrip(assignment)}
    <div class="screen-pad">
      ${band}${checksNote(assignment)}${routeBar(assignment, now)}${sheetPanel(assignment)}${dayOfNote(assignment, clock)}
      <div class="timeline">${steps}</div>
      <button class="addrow addstop" type="button" id="add-stop">+ ADD A STOP DISPATCH PHONED IN</button>
      ${notes}${issues}
      ${orphans}${agreedGone}
      ${undo}
      <p class="provenance">Assignment <b>${esc(assignment.number)}</b> &middot; ${printed}</p>
      ${PREVIEW ? "" : `<div class="hiderun">
        <button class="text-btn" type="button" id="hide-run">REMOVE FROM THIS PHONE</button>
        <p>Only this phone: the run stays on the list, and its flight alerts still come. UNDO waits on the list of runs.</p>
      </div>`}
    </div>`;

  document.getElementById("itin-back").addEventListener("click", renderAssignments);
  const hide = document.getElementById("hide-run");
  // No question asked: the list opens on its ghost, UNDO beside it.
  if (hide) hide.addEventListener("click", () => { hideRun(number); renderAssignments(); });
  const sheetOk = document.getElementById("sheet-ok");
  if (sheetOk) sheetOk.addEventListener("click", () => okSheet(number));
  wireEdits(assignment);
  wireMessages(main);

  // Only ONE past step open at a time, and the current step never collapses.
  // Without that guard a scroll back through a long run leaves four steps open
  // and the driver loses the anchor.
  main.querySelectorAll('[data-collapsible] .sthead').forEach((head) => {
    head.addEventListener("click", () => {
      const step = head.closest(".step");
      const wasOpen = step.classList.contains("open");
      main.querySelectorAll(".step.open").forEach((s) => s.classList.remove("open"));
      if (!wasOpen) step.classList.add("open");
    });
  });
  if (keepOpen) {
    const again = main.querySelector(`.step[data-collapsible][data-at="${CSS.escape(keepOpen)}"]`);
    if (again) again.classList.add("open");
  }

  // Ticked, not cleared, and never by the app: a line whose time has passed
  // stays open until the driver says it is done. A leg's tick can move RIGHT
  // NOW on, so a leg repaints the screen.
  main.querySelectorAll("[data-tick]").forEach((row) => {
    const btn = row.querySelector(".tickbox");
    row.addEventListener("click", (ev) => {
      // The words open the leg; a contest's buttons settle it.
      if (ev.target.closest("[data-leg], .mini-btn")) return;
      const ticks = readLS(LS_TICKS, {});
      const on = !ticks[row.dataset.tick];
      if (on) ticks[row.dataset.tick] = new Date().toISOString();
      else delete ticks[row.dataset.tick];
      writeLS(LS_TICKS, ticks);
      row.classList.toggle("done", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      if (row.classList.contains("leg")) renderItinerary(number);
    });
  });
  // The route: the stops Maps will get, to change or open (app.js), unless
  // this phone said to go straight to Maps -- and a stop with no address
  // always shows them, to add it or leave it out.
  const route = main.querySelector("[data-route]");
  if (route) {
    route.addEventListener("click", () => {
      if (PREVIEW) return;
      if (mapsDirect() && !mapsRoute(assignment, nowAt()).missing.length) openRoute(number, mapsApp());
      else openRouteSheet(number);
    });
  }
  const allNotes = main.querySelector("[data-notes-all]");
  if (allNotes) {
    allNotes.addEventListener("click", () => {
      notesOpen = notesOpen === number ? null : number;
      renderItinerary(number);
    });
  }

  if (opening) setPageScroll(0);
  gbIntro(main, number);
  // The cause before its consequence: a removal, then the clock it moved.
  rollChanged(main, settleMarks(main, number));
  syncWakeLock();
}

/* ------------------------------------------------------------ editing -- */

/*
 * Phase 7. A driver corrects what the importer could not read, and the
 * correction survives the next PDF. The server holds the log and applies it on
 * read, so everything here is thin: it names WHICH value by array index (the
 * server turns that into a durable target from its own copy), and it reads each
 * applied edit straight off the object it changed -- `entity._edit.phone`.
 *
 * No edit mode. A value is a button; a blank is a dashed button where the value
 * would be.
 */

const LS_DEVICE = "fw_device";
let editing = null; // { number, at, field, label }

/** A short per-device label, so driver and helper on one list code can tell
 *  whose correction is whose. */
function deviceLabel() {
  try {
    let d = localStorage.getItem(LS_DEVICE);
    if (!d) {
      d = "device-" + Math.random().toString(16).slice(2, 6);
      localStorage.setItem(LS_DEVICE, d);
    }
    return d;
  } catch (_) { return null; }
}

function editAttr(at, field, label, current, documentValue) {
  return esc(JSON.stringify({ at, field, label, current: current ?? null,
                              documentValue: documentValue ?? null }));
}

/** The mark an edited field carries, and the choice a contested one offers. */
function editMark(host, field, what) {
  const pre = what ? `${what}: ` : "";
  const e = host && host._edit && host._edit[field];
  if (!e) return { cls: "", row: "" };
  // Made on this phone, not yet on the server: a hollow dot until it lands.
  if (e.pending) return { cls: " edited pending", row: "" };
  // Another appearance of the same passenger: coloured, but asked only once.
  if (e.propagated) return { cls: e.contested ? " contested" : " edited", row: "" };
  if (e.contested) {
    // A time reads as every time on screen does: 7:30a, not the sheet's "7:30 AM".
    const shown = (v) => (v === null || v === undefined ? "nothing"
      : ["eta", "etd", "time"].includes(field) ? stepTime(v) || v : v);
    return {
      cls: " contested",
      row: `<div class="contest">
        <span>${pre}Sheet now says <b>${esc(shown(e.documentValue))}</b>, you set <b>${esc(shown(e.value))}</b></span>
        <span class="contest-acts">
          <button class="mini-btn" type="button" data-keep="${esc(e.patchId)}"
                  data-keep-field="${esc(field)}">KEEP MINE</button>
          <button class="mini-btn" type="button" data-use="${esc(e.patchId)}">USE THE SHEET</button>
        </span>
      </div>`,
    };
  }
  if (e.agreed) {
    return {
      cls: " edited",
      row: `<div class="contest agreed">
        <span>${pre}The sheet now says the same</span>
        <button class="mini-btn" type="button" data-use="${esc(e.patchId)}">CLEAR MY EDIT</button>
      </div>`,
    };
  }
  return { cls: " edited", row: "" };
}

/** An unplaced patch, in words. */
function describePatch(p) {
  const kind = p.kind || "field";
  if (kind === "remove") return `Not happening: <b>${esc(p.label || "a row")}</b>`;
  if (kind === "addEntity") return `Added passenger <b>${esc(p.entity && p.entity.name)}</b>`;
  if (kind === "addStep") return `Added stop <b>${esc(p.step && (p.step.code || p.step.place))}</b>`;
  if (kind === "addLeg") return `Added leg <b>${esc(p.leg && p.leg.line)}</b>`;
  if (p.field === "line") return `Leg &rarr; <b>${esc(p.value)}</b>`;
  return `${esc(p.field)} &rarr; <b>${esc(p.value ?? "blank")}</b>`;
}

function lastPatchId(assignment) {
  const ids = [
    ...(assignment.edits || []).map((e) => e.patchId),
    ...(assignment.changes || []).map((c) => c.patchId),
    ...(assignment.orphanedEdits || []).map((p) => p.id),
  ].sort();
  return ids.length ? ids[ids.length - 1] : null;
}

function openEdit(number, spec) {
  // The copy the row was read from, fixed now: if a reprint lands while the
  // sheet is open, the save must still say which copy `at` points into, so
  // the server refuses it (409) instead of aiming it at whatever row is there.
  // A row's menu was read earlier still, and hands over its own (`spec.aim`).
  const shown = assignments.find((a) => a.number === number);
  editing = { number, ...spec, aim: spec.aim || (shown ? basisFor(shown, spec.at) : {}) };
  document.getElementById("edit-title").textContent = spec.label;
  const times = document.getElementById("edit-times");
  document.getElementById("edit-text").hidden = Boolean(spec.fields);
  times.hidden = !spec.fields;
  document.getElementById("edit-error").textContent = "";
  document.getElementById("edit-learn-row").hidden = true;
  if (spec.fields) {
    // A step's times. Only the ones the sheet printed: the first stop's
    // missing ETA is not the driver's to invent.
    times.innerHTML = spec.fields.map((f) => `
      <div class="field">
        <label for="edit-${f.field}">${esc(f.label)}</label>
        <input class="input mono-input" type="time" id="edit-${f.field}" value="${esc(inputTime(f.current))}" />
      </div>`).join("");
    document.getElementById("edit-doc").textContent = spec.documentValue
      ? `${spec.at.startsWith("+") ? "Phoned in" : "The sheet says"}: ${spec.documentValue}. It stays shown beside yours.`
      : "";
    openSheet("edit-sheet");
    times.querySelector("input").focus();
    return;
  }
  const input = document.getElementById("edit-input");
  input.value = spec.current ?? "";
  input.className = spec.field === "flightNumber" ? "input mono-input" : "input";
  input.inputMode = spec.field === "phone" ? "tel" : "text";
  input.placeholder = spec.field === "flightNumber" ? "UA995"
    : spec.field === "phone" ? "+1 555 010 0000" : "A Front";
  document.getElementById("edit-doc").textContent = spec.documentValue
    ? `The sheet says: ${spec.documentValue}`
    : "The sheet left this blank.";
  // A flight whose airline had no code: what the sheet printed, and -- once
  // the number is typed -- the offer to remember the airline's code.
  editing.airline = null;
  const host = spec.field === "flightNumber" && shown ? hostAt(shown, { at: spec.at }) : null;
  const u = host && unknownAirlineOf(shown, host);
  if (u) {
    const printed = `${u.name}${u.number ? ` ${u.number}` : ""}`;
    if (host._learned) {
      document.getElementById("edit-doc").textContent = `The sheet says ${printed}; this list learned ${
        host._learned.name} is ${host._learned.code}. A number you type here is yours, for this passenger.`;
    } else {
      document.getElementById("edit-doc").textContent = `The sheet says ${printed}, an airline I have no code for.`;
      editing.airline = u.name;
    }
  }
  document.getElementById("edit-learn").checked = true;
  syncLearnRow();
  openSheet("edit-sheet");
  input.focus();
  input.select();
}

/** "Remember WestJet is WS": shown while the typed number has a code to learn. */
function syncLearnRow() {
  const row = document.getElementById("edit-learn-row");
  const code = editing && editing.airline && flightCode(document.getElementById("edit-input").value);
  row.hidden = !code;
  if (code) {
    document.getElementById("edit-learn-label").textContent =
      `Remember ${editing.airline} is ${code}: later sheets that name ${editing.airline} get their flights filled in, on every phone on this list.`;
  }
}

/* -------------------------------------------------------------- outbox -- */

/*
 * Phase 8. Every edit goes to a queue on the phone FIRST and to the server
 * when there is signal. The driver correcting a phone number in an LGA garage
 * is the normal case, not the edge, so there is one path, not an online path
 * with an offline fallback: tap, it shows, it sends when it can.
 *
 * Three rules keep the queue honest:
 *
 * - A queued edit shows at once, marked as not yet sent, and survives closing
 *   the app. It never waits behind a spinner and is never silently dropped.
 * - It is replay-safe. Each op carries a ref; a POST whose answer was lost to a
 *   dropped bar is recognised on the second try instead of written twice.
 * - It carries the copy it was made against (`basis`, that copy's importedAt).
 *   If dispatch re-sent the run while the phone was dark, the server refuses it
 *   rather than aim old indices at a new sheet, and it comes back to the driver
 *   as a correction the app could not place.
 */

const LS_OUTBOX = "fw_outbox"; // ops not yet accepted by the server, in order
const LS_LOST = "fw_lost";     // queued edits the server refused
const LS_SENT = "fw_sent";     // accepted, but not yet in what GET returns
const LS_UNDONE = "fw_undone"; // refs the driver undid that the server may still hold
const SENT_TTL_MS = 5 * 60 * 1000;
const SEND_TIMEOUT_MS = 10000; // one bar can hold a request open for minutes

function readLS(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch (_) { return fallback; }
}

function writeLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode */ }
}

function outbox() { return readLS(LS_OUTBOX, []); }
function lostEdits() { return readLS(LS_LOST, []).filter((l) => l.listCode === listCode); }

/** The driver's edits to a run still waiting for signal (not a sheet or an OK waiting to send). */
function pendingFor(number) {
  return outbox().filter((op) => op.listCode === listCode && op.number === number
    && op.kind !== "import" && op.kind !== "seen");
}

/** Sortable after every server id ("2026..."), and in the order they were made. */
function newRef() {
  return Date.now().toString(36).padStart(9, "0") + "-" + Math.random().toString(16).slice(2, 8);
}

function enqueue(op) {
  // The motion preview's run is made up: nothing about it may reach the list.
  if (PREVIEW) return newRef();
  const q = outbox();
  const ref = newRef();
  q.push({ ref, madeAt: new Date().toISOString(), listCode, ...op });
  writeLS(LS_OUTBOX, q);
  return ref;
}

function unqueue(ref) {
  writeLS(LS_OUTBOX, outbox().filter((op) => op.ref !== ref));
}

function* hostsOf(assignment) {
  yield* ensureLines(assignment);
  for (const step of assignment.steps || []) {
    yield step;
    for (const action of step.actions || []) {
      yield action;
      for (const entity of action.entities || []) yield entity;
    }
  }
}

/**
 * Give every row an address if the copy came without one. The server sends
 * `_at` (the row's place in DISPATCH's copy, or "+ref" for a row the driver
 * added); a copy cached before that has no added rows, so its own indices are
 * the same thing.
 */
function ensureAddresses(assignment) {
  ensureLines(assignment);
  (assignment.steps || []).forEach((step, s) => {
    if (!step._at) step._at = `${s}`;
    (step.actions || []).forEach((action, a) => {
      if (!action._at) action._at = `${step._at}.${a}`;
      (action.entities || []).forEach((entity, e) => {
        if (!entity._at) entity._at = `${action._at}.${e}`;
      });
    });
  });
}

/** The row an op names. By address, never by position in the array on
 *  screen: added stops are placed by time, so positions are not dispatch's. */
function hostAt(assignment, b) {
  const at = b.at ?? [b.stepIdx, b.actionIdx, b.entityIdx]
    .filter((x) => x !== undefined && x !== null).join(".");
  for (const h of hostsOf(assignment)) if (h._at === at) return h;
  return null;
}

function stepSortKey(step) {
  const t = wallMinutes(step.eta) ?? wallMinutes(step.etd) ?? 0;
  return `${step.etaDate || step.date} ${String(t).padStart(4, "0")}`;
}

/** Show a queued edit the way the server will apply it. A preview only: the
 *  server's applyPatches stays the one real implementation, and replaces this
 *  as soon as the server's copy shows the edit. */
function overlayPost(assignment, op, patchId) {
  const b = op.body;
  // Made against another copy: the server will refuse it, so do not pretend.
  // (Ops on rows the driver added carry no basis: no sheet can move those.)
  if (b.basis && b.basis !== assignment.importedAt) return;
  const kind = b.kind || "field";
  const change = { patchId: patchId || `q:${op.ref}`, kind, label: b.label ?? null,
                   agreed: false, at: op.madeAt, by: b.by, pending: !patchId };
  const note = () => { assignment.changes = [...(assignment.changes || []), change]; };

  if (kind === "addStep") {
    const a = b.step;
    const action = { verb: a.verb, where: a.where ?? null, entities: [], _at: `+${op.ref}.0` };
    const step = { code: a.code || null, place: a.place, date: a.date, etaDate: a.date,
                   eta: a.time, etd: a.time, actions: [action], _add: change, _at: `+${op.ref}` };
    const steps = assignment.steps || (assignment.steps = []);
    const i = steps.findIndex((s) => stepSortKey(s) > stepSortKey(step));
    steps.splice(i < 0 ? steps.length : i, 0, step);
    note();
    return;
  }
  if (kind === "addLeg") {
    ensureLines(assignment).push({ printed: null, line: b.leg.line, _add: { ...change, label: b.leg.line }, _at: `+${op.ref}` });
    note();
    return;
  }
  const host = hostAt(assignment, b);
  if (!host) return;
  if (kind === "remove") {
    host._removed = change;
    // Their other rows too, as the server does it: exact name only.
    if ("name" in host) {
      const who = (host.name || "").trim().toLowerCase();
      for (const h of hostsOf(assignment)) {
        if (h !== host && "name" in h && !h._removed && (h.name || "").trim().toLowerCase() === who) {
          h._removed = { ...change, propagated: true };
        }
      }
    }
    note();
    return;
  }
  if (kind === "addEntity") {
    if (!host.entities) return;
    const e = b.entity;
    host.entities.push({ name: e.name, pax: 1, flightNumber: e.flightNumber ?? null,
                         phone: e.phone ?? null, note: e.note ?? null, tag: e.tag ?? null,
                         _add: { ...change, label: e.name }, _at: `+${op.ref}` });
    note();
    return;
  }
  const shown = host[b.field === "time" ? "eta" : b.field] ?? null;
  const prior = host._edit && host._edit[b.field];
  const edit = {
    patchId: patchId || `q:${op.ref}`, field: b.field, value: b.value, was: b.was,
    documentValue: prior ? prior.documentValue : shown,
    contested: false, agreed: false, at: op.madeAt, by: b.by, pending: !patchId,
  };
  const mark = (h, e) => {
    if (b.field === "time") { h.eta = b.value; h.etd = b.value; } else h[b.field] = b.value;
    h._edit = { ...(h._edit || {}), [b.field]: e };
  };
  // The same person's other appearances holding the same value -- as the
  // server does it, exact name only. Found before the host changes.
  const others = [];
  if ("name" in host) {
    const who = (host.name || "").trim().toLowerCase();
    for (const h of hostsOf(assignment)) {
      if (h === host || !("name" in h) || (h.name || "").trim().toLowerCase() !== who) continue;
      if ((h[b.field] ?? null) === shown) others.push(h);
    }
  }
  mark(host, edit);
  others.forEach((h) => mark(h, { ...edit, propagated: true }));
  assignment.edits = [...(assignment.edits || []), edit];
}

/** A queued removal of a patch: the field goes back to what the sheet says, a
 *  ghost comes back to life, an added row goes. */
function overlayDelete(assignment, id) {
  const mine = (h) => h._add && h._add.patchId === id;
  assignment.lines = ensureLines(assignment).filter((l) => !mine(l));
  assignment.steps = (assignment.steps || []).filter((s) => !mine(s));
  for (const step of assignment.steps) {
    for (const action of step.actions || []) {
      action.entities = (action.entities || []).filter((e) => !mine(e));
    }
  }
  for (const h of hostsOf(assignment)) {
    if (h._removed && h._removed.patchId === id) delete h._removed;
    for (const [field, e] of Object.entries(h._edit || {})) {
      if (e.patchId !== id) continue;
      if (field === "time") { h.eta = e.documentValue; h.etd = e.documentValue; } else h[field] = e.documentValue;
      delete h._edit[field];
    }
  }
  assignment.edits = (assignment.edits || []).filter((e) => e.patchId !== id);
  assignment.changes = (assignment.changes || []).filter((c) => c.patchId !== id);
  assignment.orphanedEdits = (assignment.orphanedEdits || []).filter((p) => p.id !== id);
}

/** Whether the server's copy shows a patch: by its id, or -- for an edit the
 *  phone sent -- by its ref. A replay that KV's list lag let through is stored
 *  twice, and the server shows the FIRST copy, whose id the phone never got. */
function serverHas(assignment, id, ref) {
  const is = (patchId, r) => patchId === id || Boolean(ref && r === ref);
  return (assignment.edits || []).some((e) => is(e.patchId, e.ref))
      || (assignment.changes || []).some((c) => is(c.patchId, c.ref))
      || (assignment.orphanedEdits || []).some((p) => is(p.id, p.ref));
}

/*
 * KV lists are eventually consistent: a patch the server has accepted can be
 * missing from GET for 20 seconds or more (measured). Without this ledger the
 * driver's correction vanishes the moment it sends and reappears later, which
 * reads as "it didn't save". So an accepted op keeps being drawn until the
 * server's own copy shows it -- then the server's version takes over.
 */
function sentLedger() { return readLS(LS_SENT, []); }

function pruneSent() {
  const now = Date.now();
  const live = sentLedger().filter((op) => now - Date.parse(op.sentAt) <= SENT_TTL_MS);
  // Runs the server has taken that GET does not show yet: their edits wait with them.
  const arriving = new Set(live.filter((op) => op.kind === "import"
    && !assignments.some((a) => a.number === op.number)).map((op) => op.number));
  writeLS(LS_SENT, live.filter((op) => {
    if (op.kind === "place") return op.listCode === listCode ? !placeShown(op) : true;
    if (op.kind === "airline") return op.listCode === listCode ? !airlineShown(op) : true;
    if (op.kind === "seen") return op.listCode === listCode ? !seenShown(op) : true;
    if (op.kind === "dismiss") return op.listCode === listCode ? !dismissShown(op) : true;
    const a = assignments.find((x) => x.number === op.number);
    // A sheet: kept until GET shows that run at that print or newer.
    if (op.kind === "import") return !a || newerPrint(op.printedAt, a.printedAt);
    if (!a) return arriving.has(op.number);
    return op.kind === "post" ? !serverHas(a, op.patchId, op.ref) : serverHas(a, op.id);
  }));
}

/*
 * An undo can race its own edit. The driver undoes an edit whose POST already
 * left the phone -- in flight, or timed out after the server had saved it --
 * and the queue forgets it; the server does not. Or one copy of a replayed edit
 * is deleted while the other is still hidden by KV's list lag. So an undone
 * edit's ref is remembered, and when the server's copy shows a patch with that
 * ref, its removal is queued like any other.
 */
function undoneRefs() { return readLS(LS_UNDONE, []); }

function rememberUndone(number, ref) {
  if (!ref) return;
  const kept = undoneRefs().filter((u) => u.ref !== ref).slice(-49);
  writeLS(LS_UNDONE, [...kept, { ref, listCode, number, at: new Date().toISOString() }]);
}

/** The server's id for the patch a ref wrote, if its copy shows one. */
function patchIdByRef(assignment, ref) {
  const hit = (assignment.edits || []).find((e) => e.ref === ref)
    || (assignment.changes || []).find((c) => c.ref === ref);
  if (hit) return hit.patchId;
  const orphan = (assignment.orphanedEdits || []).find((p) => p.ref === ref);
  return orphan ? orphan.id : null;
}

/** After a load from the server: queue the removal of anything undone that
 *  came back. Forgotten once old enough that the server would show it by now. */
function reapUndone() {
  const now = Date.now();
  const deleting = (id) => outbox().some((op) => op.kind === "delete" && op.id === id)
    || sentLedger().some((op) => op.kind === "delete" && op.id === id);
  writeLS(LS_UNDONE, undoneRefs().filter((u) => {
    if (u.listCode !== listCode) return now - Date.parse(u.at) <= SENT_TTL_MS * 12;
    const a = assignments.find((x) => x.number === u.number);
    const id = a && patchIdByRef(a, u.ref);
    if (id) {
      if (!deleting(id)) enqueue({ kind: "delete", number: u.number, id });
      return true;
    }
    return now - Date.parse(u.at) <= SENT_TTL_MS;
  }));
}

function overlayOutbox() {
  // Sheets first: an edit made on a run that is on this phone only needs the run.
  overlayImports();
  // Places and OKs: sent ones GET does not show yet, then the queued, in order.
  for (const op of [...sentLedger(), ...outbox()]) {
    if (op.listCode !== listCode) continue;
    if (op.kind === "place") applyPlaceOp(op);
    else if (op.kind === "airline") applyAirlineOp(op);
    else if (op.kind === "seen") applySeenOp(op);
    else if (op.kind === "dismiss") applyDismissOp(op);
  }
  for (const op of sentLedger()) {
    if (op.listCode !== listCode) continue;
    const a = assignments.find((x) => x.number === op.number);
    if (!a) continue;
    if (op.kind === "post" && !serverHas(a, op.patchId, op.ref)) overlayPost(a, op, op.patchId);
    else if (op.kind === "delete") overlayDelete(a, op.id);
  }
  for (const op of outbox()) {
    if (op.listCode !== listCode) continue;
    const a = assignments.find((x) => x.number === op.number);
    if (!a) continue;
    if (op.kind === "post") overlayPost(a, op);
    else if (op.kind === "delete") overlayDelete(a, op.id);
  }
  for (const a of assignments) { placeAdded(a); learnFlights(a); }
  // Last: everything above finds a run by its number, hidden or not.
  partHidden();
}

/*
 * Removed from this phone (the owner, 2026-09-30: "drivers need to be able to
 * delete assignments"). Only here: the run stays on the list for every other
 * phone, nothing is sent, and the flight alerts for it keep coming, since
 * they go to the list. A hidden run is taken out of `assignments`, so no
 * screen, count or clock sees it; the list draws a ghost in its place with an
 * UNDO that lasts until the list's clean-up deletes the run. Importing its
 * sheet again on this phone brings it back (queueImport).
 */
const LS_HIDDEN = "fw_hidden"; // {"<list>:<number>": {at, printedAt}}, per device
let hiddenRuns = [];           // this list's hidden runs, as loaded

function hiddenLog() { return readLS(LS_HIDDEN, {}); }
function hiddenEntry(number) { return hiddenLog()[`${listCode}:${number}`] || null; }

/** Splits what was loaded into the runs shown and the runs hidden here. Safe
 *  to run again: a run un-hidden since goes back among the shown. */
function partHidden() {
  const log = hiddenLog();
  const hidden = (a) => Boolean(log[`${listCode}:${a.number}`]);
  const all = [...assignments, ...hiddenRuns.filter((h) => !assignments.some((a) => a.number === h.number))];
  hiddenRuns = all.filter(hidden);
  if (!hiddenRuns.length && all.length === assignments.length) return;
  assignments = all.filter((a) => !hidden(a))
    .sort((x, y) => String(x.start).localeCompare(String(y.start)));
}

function hideRun(number) {
  const run = assignments.find((a) => a.number === number);
  if (!run || PREVIEW) return;
  writeLS(LS_HIDDEN, { ...hiddenLog(),
    [`${listCode}:${number}`]: { at: new Date().toISOString(), printedAt: run.printedAt ?? null } });
  partHidden();
}

function unhideRun(number) {
  const log = hiddenLog();
  delete log[`${listCode}:${number}`];
  writeLS(LS_HIDDEN, log);
  partHidden();
}

/** After a load from the server: a hidden run the list no longer has was
 *  cleaned up, and its entry goes with it. Not a fresh one: a run just
 *  imported can be missing from GET for a while (KV's list lag). Another
 *  list's entries wait for that list, past any retention. */
const HIDDEN_SETTLE_MS = 3600000;
const HIDDEN_KEEP_MS = 45 * 86400000;
function pruneHidden(now = Date.now()) {
  const log = hiddenLog();
  let changed = false;
  for (const [key, entry] of Object.entries(log)) {
    const age = now - Date.parse(entry.at);
    const mine = key.startsWith(`${listCode}:`);
    const here = mine && hiddenRuns.some((a) => key === `${listCode}:${a.number}`);
    if (mine ? !here && !(age <= HIDDEN_SETTLE_MS) : !(age <= HIDDEN_KEEP_MS)) {
      delete log[key];
      changed = true;
    }
  }
  if (changed) writeLS(LS_HIDDEN, log);
}

/** The ghost of a run removed from this phone, where its card was. */
function hiddenCard(a) {
  const entry = hiddenEntry(a.number) || {};
  const newer = newerPrint(a.printedAt, entry.printedAt) || Boolean(a._newer);
  return `
    <div class="acard hid" data-hidden="${esc(a.number)}">
      <span class="arow">
        <s class="atime">${esc(clockLabel(a.start))}</s>
        <span class="adash">&ndash;</span>
        <s class="atime">${esc(clockLabel(a.end))}</s>
        <span class="aspace"></span>
        <button class="mini-btn" type="button" data-unhide="${esc(a.number)}"
                aria-label="Undo: show run ${esc(a.number)} on this phone again">UNDO</button>
      </span>
      <s class="aroute">${esc(routeOf(a))}</s>
      <span class="ameta">#${esc(a.number)} &middot; Removed from this phone${newer ? " &middot; dispatch sent a newer copy since" : ""}</span>
    </div>`;
}

/** The server's rule for which of two copies of a run stands (isNewerCopy in
 *  assignment.ts), on their printed stamps: a copy with no print date never
 *  displaces one that has one. */
function newerPrint(incoming, existing) {
  if (!incoming) return false;
  if (!existing) return true;
  return incoming > existing;
}

function addRun(run) {
  ensureAddresses(run);
  assignments.push(run);
  assignments.sort((x, y) => String(x.start).localeCompare(String(y.start)));
}

/*
 * Sheets the driver imported that the saved copy does not show yet.
 *
 * - A NEW run waiting for signal is drawn at once from what the phone read,
 *   marked NOT SENT. Its `importedAt` names the queued sheet ("q:<ref>"), so
 *   edits made on it carry that as their basis and are re-aimed at the
 *   server's copy once the sheet lands (settleImport).
 * - A newer copy of a run already here is NOT drawn over it. The server is
 *   what re-applies the driver's corrections to a new copy; drawing the new
 *   sheet first would hide them. The run says a newer copy is waiting.
 * - Sent, but not yet in what GET returns (KV's list lag): a new run is drawn
 *   from the server's own answer; an update waits for GET as above.
 */
function overlayImports() {
  const mine = (op) => op.kind === "import" && op.listCode === listCode;
  for (const op of sentLedger().filter(mine)) {
    const here = assignments.find((a) => a.number === op.number);
    if (!here) { if (op.assignment) addRun(JSON.parse(JSON.stringify(op.assignment))); }
    else if (newerPrint(op.printedAt, here.printedAt)) here._newer = { printedAt: op.printedAt, sent: true };
  }
  for (const op of outbox().filter(mine)) {
    const here = assignments.find((a) => a.number === op.number);
    const run = () => ({ ...JSON.parse(JSON.stringify(op.assignment)), importedAt: `q:${op.ref}`, _queued: op.ref });
    if (!here) addRun(run());
    else if (here._queued) {
      // Two sheets of one run, both waiting: the newer print is the one shown.
      if (newerPrint(op.printedAt, here.printedAt)) {
        assignments.splice(assignments.indexOf(here), 1);
        addRun(run());
      }
    } else if (newerPrint(op.printedAt, here.printedAt)
               && !(here._newer && !newerPrint(op.printedAt, here._newer.printedAt))) {
      here._newer = { printedAt: op.printedAt, sent: false };
    }
  }
}

/** As placeAdded in patch.ts: the driver's stops by their (possibly
 *  corrected) time, dispatch's in dispatch's order whatever their times say. */
function placeAdded(assignment) {
  const all = assignment.steps || [];
  if (!all.some((s) => s._add)) return;
  const steps = all.filter((s) => !s._add);
  for (const step of all.filter((s) => s._add)) {
    const i = steps.findIndex((s) => stepSortKey(s) > stepSortKey(step));
    steps.splice(i < 0 ? steps.length : i, 0, step);
  }
  assignment.steps = steps;
}

/** Re-draw from the saved copy plus the queue -- no network. Every edit action
 *  ends here, so the result is on screen before anything is sent. */
function refreshLocal() {
  const cached = readLS(LS_ASSIGN_CACHE, null);
  if (cached) applyAssignments(cached, true);
  overlayOutbox();
  renderCurrent();
}

async function sendOp(op) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
  // A sheet goes where the laptop's importer sends it: the whole run, as read.
  const route = op.kind === "import" ? "/api/assignments"
    : op.kind === "place" ? "/api/places"
    : op.kind === "airline" ? "/api/airlines"
    : op.kind === "seen" ? "/api/assignments/seen"
    : op.kind === "dismiss" ? "/api/suggestions" : "/api/assignments/patches";
  const body = op.kind === "import" ? op.assignment
    : op.kind === "place" ? { listCode: op.listCode, code: op.code, name: op.name, address: op.address, remove: op.remove }
    : op.kind === "airline" ? { listCode: op.listCode, name: op.name, code: op.code, remove: op.remove }
    : op.kind === "seen" ? { listCode: op.listCode, number: op.number, printedAt: op.printedAt }
    : op.kind === "dismiss" ? { listCode: op.listCode, id: op.id }
    : op.kind === "post" ? { listCode: op.listCode, number: op.number, ref: op.ref, ...op.body }
    : { listCode: op.listCode, number: op.number, id: op.id };
  try {
    return await fetch(`${API_BASE}${route}`, {
      method: op.kind === "delete" ? "DELETE" : "POST",
      headers: listHeaders(op.listCode, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function lose(op, reason) {
  const lost = readLS(LS_LOST, []);
  lost.push({ ref: op.ref, listCode: op.listCode, number: op.number,
              label: op.label || op.body.field, reason,
              ...(op.body.field ? { value: op.body.value } : {}) });
  writeLS(LS_LOST, lost);
}

let flushing = null;

/** Send the queue, oldest first, one at a time: order is meaning here (an
 *  undo after an edit is not the same as an edit after an undo). Stops at the
 *  first op that cannot be sent and leaves it and everything after it queued. */
function flush() {
  if (PREVIEW) return Promise.resolve();
  if (!flushing) flushing = drain().finally(() => { flushing = null; });
  return flushing;
}

/**
 * The next op to send: the oldest, except that a sheet waiting to replace a
 * run lets the edits made on that run go first. Those were made on the copy
 * the phone showed -- the copy the server still holds -- so they land on it,
 * and the new sheet then carries them over like any correction. Sent after
 * it, they would be refused as made on another copy. Edits made on a sheet
 * that is itself waiting (basis "q:<ref>") still wait for it.
 */
function nextOp() {
  const q = outbox();
  const head = q[0];
  if (!head || head.kind !== "import") return head;
  return q.find((o) => o.kind !== "import" && o.listCode === head.listCode && o.number === head.number
                       && !String((o.body && o.body.basis) || "").startsWith("q:")) || head;
}

async function drain() {
  let sent = 0;
  for (;;) {
    const op = nextOp();
    if (!op) break;
    // Once it has left the phone the server may hold it, answer or no answer.
    if (!op.tried) writeLS(LS_OUTBOX, outbox().map((o) => (o.ref === op.ref ? { ...o, tried: true } : o)));
    let res;
    try { res = await sendOp(op); } catch (_) { break; }   // no signal
    // Try again later: the server's trouble, or its rate limit -- not a refusal.
    if (res.status >= 500 || res.status === 429) break;
    const data = await res.json().catch(() => ({}));
    // Undone while it was in flight: the server has it now, so take it back.
    const undone = !outbox().some((o) => o.ref === op.ref);
    unqueue(op.ref);
    sent++;
    if (op.kind === "import") {
      settleImport(op, res.status, data);
      continue;
    }
    if (op.kind === "place" || op.kind === "airline") {
      // Held on screen until GET shows it (KV can answer from a copy a minute
      // old). A refusal cannot come from this app's own form; it is dropped.
      if (res.ok) writeLS(LS_SENT, [...sentLedger(), { ...op, sentAt: new Date().toISOString() }]);
      else console.warn(`${op.kind === "place" ? "Place" : "Airline"} refused:`, data.error || res.status);
      continue;
    }
    if (op.kind === "seen" || op.kind === "dismiss") {
      // Held on screen until GET says so. Refused (409): a newer copy came in
      // meanwhile, and its changes are the ones to read -- nothing to keep.
      if (res.ok) writeLS(LS_SENT, [...sentLedger(), { ...op, sentAt: new Date().toISOString() }]);
      continue;
    }
    if (res.ok) {
      if (undone && op.kind === "post" && data.patch) {
        enqueue({ kind: "delete", number: op.number, id: data.patch.id });
      } else {
        const done = { ...op, sentAt: new Date().toISOString() };
        if (op.kind === "post") done.patchId = data.patch && data.patch.id;
        if (op.kind === "delete" || done.patchId) writeLS(LS_SENT, [...sentLedger(), done]);
      }
    } else if (op.kind === "post" && !undone) {
      // Refused, not unreachable: it goes back to the driver -- never retried
      // into a loop, never dropped. (A removal of something already gone is
      // simply done.)
      lose(op, res.status === 409
        ? "The sheet changed before this could send."
        : `Not saved: ${data.error || `HTTP ${res.status}`}.`);
    }
  }
  if (sent) await loadAssignments();
  return sent;
}

window.addEventListener("online", () => { if (listCode) loadAssignments(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && listCode) loadAssignments();
});
// `online` is not reliable on phones -- it fires for wifi without internet and
// often not at all when one bar comes back -- so a waiting queue is also tried
// on a timer.
setInterval(() => { if (listCode && outbox().length) flush(); }, 30000);

/* -------------------------------------------------------------- imports -- */

/*
 * Dispatch's PDF, read on this device (import.js reads the file, public/
 * importer/ converts it) and sent through the outbox like any other write. A
 * sheet read with no signal is not lost: a new run shows at once, marked NOT
 * SENT, and sends when a bar comes back.
 *
 * What the last import did is said on the list, one line per file, until the
 * driver taps OK -- no toasts. The server's answer decides the words; ahead of
 * it the phone says only what it already knows.
 */
let importLines = [];   // { ref?, file, number?, state, printedAt?, update?, held?, theirs?, error?, run? }
let importStamp = null; // the device time the lines are from

/** A new pick, drop or share: the last one's lines go. */
function startImport() {
  importLines = [];
  importStamp = deviceTime(new Date());
}

/** A file that imported nothing: readSheet's reason, or the reader's own. */
function noteProblem(file, reason) {
  importLines.push({ file, state: reason });
}

/** What a line says about its run, kept so it reads before the list shows it. */
function runSummary(a) {
  return { start: a.start, end: a.end, pax: paxCount(a) };
}

/**
 * A sheet read on the device, to the queue -- unless the phone already knows
 * the server's answer: this print or a newer one is here, or is waiting to
 * send. The server's own rule (newerPrint), on the phone's copy.
 */
function queueImport(assignment, file) {
  const number = assignment.number;
  const printedAt = assignment.printedAt ?? null;
  const line = { file, number, printedAt, run: runSummary(assignment) };
  // Importing a run removed from this phone is asking for it back.
  if (hiddenEntry(number)) unhideRun(number);
  const waiting = outbox().filter((op) => op.kind === "import" && op.listCode === listCode
                                          && op.number === number);
  if (waiting.some((op) => (op.printedAt ?? null) === printedAt)) {
    importLines.push({ ...line, state: "already" });
    return null;
  }
  const here = assignments.find((a) => a.number === number && !a._queued);
  if (here && !newerPrint(printedAt, here.printedAt)) {
    const theirs = here.printedAt ?? null;
    importLines.push({ ...line, state: theirs === printedAt ? "same" : "older", theirs });
    return null;
  }
  const newer = waiting.find((op) => newerPrint(op.printedAt, printedAt));
  if (newer) {
    importLines.push({ ...line, state: "older", theirs: newer.printedAt });
    return null;
  }
  const ref = enqueue({ kind: "import", number, file, printedAt, assignment, update: Boolean(here) });
  importLines.push({ ...line, ref, state: "sending", update: Boolean(here),
                     held: here ? here.printedAt ?? null : null });
  return ref;
}

/** After reading: the list, from the top, where the lines are; then send. */
function showImports() {
  refreshLocal();
  if (screen !== "list") renderAssignments();
  setPageScroll(0);
  announceImports();
  if (importLines.some((l) => l.state === "sending")) {
    flush().catch(console.error).then(settleSending);
  }
}

/** Lines still sending once the queue has run: their sheet did not go. */
function settleSending() {
  const queued = new Set(outbox().map((op) => op.ref));
  let changed = false;
  for (const l of importLines) {
    if (l.state === "sending" && queued.has(l.ref)) { l.state = "waiting"; changed = true; }
  }
  if (!changed) return;
  announceImports();
  if (screen === "list") renderAssignments();
}

/** The server's answer to a sheet, as the line's state. The server says
 *  "a newer copy is already stored" for an equal print too, so which of the
 *  two it was is told here, from the print dates. */
function importOutcome(op, status, data) {
  if (status === 404) return "gone"; // the list code
  if (status < 200 || status >= 300) return "refused";
  // A newer print with nothing a driver could see changed: 13 of 62 real re-sends.
  if (data.applied) return data.same ? "reprinted" : data.replaced ? "updated" : "new";
  const theirs = data.assignment ? data.assignment.printedAt ?? null : null;
  return newerPrint(theirs, op.printedAt ?? null) ? "older" : "same";
}

/** A sheet the server answered (drain). */
function settleImport(op, status, data) {
  let state = importOutcome(op, status, data);
  const stored = data && data.assignment;
  // The server holds exactly this print.
  const same = state === "same" && stored && stored.printedAt && stored.printedAt === op.printedAt;
  // An earlier try left the phone and its answer was lost to a bar: the copy
  // the server holds is this phone's own, so a run that was not here is new.
  if (same && op.tried && !op.update) state = "new";
  const taken = state === "new" || state === "updated" || state === "reprinted";
  if (taken || same) {
    writeLS(LS_SENT, [...sentLedger(), {
      kind: "import", ref: op.ref, listCode: op.listCode, number: op.number,
      printedAt: op.printedAt ?? null, sentAt: new Date().toISOString(),
      // A run not on the phone is drawn from this until GET shows it; an
      // update never is (only the server re-applies the corrections).
      assignment: state === "updated" || state === "reprinted" ? null : stored,
    }]);
  }
  // Edits made on the sheet while it waited were aimed at what the phone
  // read. The server's copy IS that sheet when it took this one, or is the
  // same print when it already held it: aim them there. Otherwise they stay
  // aimed at a copy the server does not have and come back to the driver
  // (409), never re-aimed at a different sheet.
  if (stored && stored.importedAt && (taken || same)) {
    writeLS(LS_OUTBOX, outbox().map((o) => (o.body && o.body.basis === `q:${op.ref}`
      ? { ...o, body: { ...o.body, basis: stored.importedAt } } : o)));
  }
  // How many changes the server counted (since the list's last OK), and from
  // which print: the line says what the run's panel will show.
  const outcome = { state, theirs: stored ? stored.printedAt ?? null : null,
                    error: (data && data.error) || null,
                    changes: data && typeof data.changes === "number" ? data.changes : null,
                    since: (data && data.since) || null };
  const line = importLines.find((l) => l.ref === op.ref);
  if (line) Object.assign(line, outcome);
  else if (op.listCode === listCode) {
    // Sent from an earlier session's queue: said now, on its own line.
    if (!importLines.length) importStamp = deviceTime(new Date());
    importLines.push({ ref: op.ref, file: op.file, number: op.number, printedAt: op.printedAt ?? null,
                       update: Boolean(op.update), run: runSummary(op.assignment), ...outcome });
  }
  announceImports();
}

/** When dispatch printed a copy: the time alone when that was today. */
function printedLabel(raw) {
  return String(raw).slice(0, 10) === localStamp().slice(0, 10) ? clockLabel(raw) : stampLabel(raw);
}

const IMPORT_PROBLEMS = {
  "not-a-sheet": ["Not an assignment sheet", "nothing imported"],
  "too-big": ["Not an assignment sheet", "too big to be one; nothing imported"],
  picture: ["A picture, not text", "a scan or a photo. Import the PDF from dispatch's email."],
  "not-pdf": ["Not a PDF", "Curbside reads dispatch's PDF only"],
  unsupported: ["A locked or unusual PDF", "not one of dispatch's sheets. Nothing imported."],
  unreadable: ["A date or time can't be read", "nothing imported"],
  bug: ["Couldn't read this sheet", "nothing imported"],
};

/** A line's words: { cls, number, title (text), detail (html), opens }. */
function importView(l) {
  const run = l.run || {};
  const day = run.start ? esc(shortDate(String(run.start).slice(0, 10))) : "";
  const shown = assignments.some((a) => a.number === l.number);
  const printed = (p) => esc(printedLabel(p));
  const v = { cls: "bad", number: l.number || null, title: "", detail: "", opens: false };
  const ok = (cls, title, detail) => ({ ...v, cls, title, detail, opens: shown });
  switch (l.state) {
    case "new": {
      const n = Number(run.pax) || 0;
      const pax = n ? ` &middot; ${n} passenger${n === 1 ? "" : "s"}` : "";
      return ok("done", "New run",
        `${day} &middot; ${esc(clockLabel(run.start))}&ndash;${esc(clockLabel(run.end))}${pax}`);
    }
    case "reprinted":
      // "at 7:45p" when that was today; a day takes no "at" ("Sat 3 Oct, 7:45p").
      return ok("done", "Reprinted", l.printedAt
        ? `Printed again ${String(l.printedAt).slice(0, 10) === localStamp().slice(0, 10) ? "at " : ""}${
          printed(l.printedAt)} &middot; nothing changed` : "Printed again &middot; nothing changed");
    case "updated": {
      const a = assignments.find((x) => x.number === l.number);
      const placed = a ? (a.edits || []).length + (a.changes || []).length : 0;
      const lost = a ? (a.orphanedEdits || []).length : 0;
      let detail = l.printedAt ? `Dispatch's newer copy, printed ${printed(l.printedAt)}` : "Dispatch's newer copy";
      // Dispatch's own changes (the run's WHAT DISPATCH CHANGED), then the driver's.
      if (l.changes > 0) detail += ` &middot; <b>${l.changes} change${l.changes === 1 ? "" : "s"}</b>`;
      else if (l.changes === 0) {
        detail += l.since ? ` &middot; the same as the one printed ${printed(l.since)}` : " &middot; nothing left to mark";
      }
      if (placed) detail += ` &middot; your ${placed === 1 ? "change" : `${placed} changes`} carried over`;
      if (lost) {
        detail += ` &middot; <span class="needs">${lost} of your changes need${lost === 1 ? "s" : ""} placing</span>`;
      }
      return ok("done", "Updated", detail);
    }
    case "same":
      return ok("same", "Already here", "The same sheet you have &mdash; nothing changed");
    case "older":
      return ok("same", "Older copy, not used", l.theirs
        ? `You have dispatch's newer one, printed ${printed(l.theirs)}` : "You have a newer copy of this run");
    case "sending":
    case "waiting": {
      const what = l.update
        ? (l.printedAt ? `Newer copy, printed ${printed(l.printedAt)}` : "Newer copy")
        : `New run &middot; ${day}`;
      if (l.state === "sending") {
        return ok("wait", "Sending…", l.update ? what
          : `${what} &middot; ${esc(clockLabel(run.start))}&ndash;${esc(clockLabel(run.end))}`);
      }
      return ok("wait", "Waiting for signal", l.update
        ? `${what}${l.held ? ` &middot; until it sends you see the one printed ${printed(l.held)}` : ""}`
        : `${what}, ${esc(clockLabel(run.start))} &middot; on this phone until a bar comes back`);
    }
    case "already":
      return ok("wait", "Already waiting", "This sheet is already on this phone, waiting for signal");
    case "refused":
      return { ...v, title: "Not saved", detail: `The server refused it: ${esc(l.error || "no reason given")}` };
    case "gone":
      return { ...v, title: "Not saved", detail: "This list code isn't on the server any more" };
    case "no-reader":
      return { ...v, number: null, title: "This phone can't read sheets",
               detail: "Its browser is too old for the sheet reader (it needs iOS 16.4 or later)" };
    case "no-load":
      return { ...v, number: null, title: "Couldn't load the sheet reader", detail: "Check your signal and try again" };
    case "nothing-shared":
      return { ...v, number: null, title: "No PDF arrived",
               detail: "Share the PDF attachment itself, not the email or a link" };
    default: {
      const [title, rest] = IMPORT_PROBLEMS[l.state] || IMPORT_PROBLEMS.bug;
      return { ...v, number: null, title, detail: `${esc(l.file || "This file")} &middot; ${esc(rest)}` };
    }
  }
}

function importLineHtml(l) {
  const v = importView(l);
  const glyph = v.cls === "done" ? icon("check") : v.cls === "bad" ? "!" : "";
  const top = v.number
    ? `<span class="itop"><b class="inum">${esc(v.number)}</b><span class="iwhat">${esc(v.title)}</span></span>`
    : `<span class="iwhat">${esc(v.title)}</span>`;
  const inner = `<span class="iglyph" aria-hidden="true">${glyph}</span>
    <span class="ibody">${top}<span class="idetail">${v.detail}</span></span>`;
  return v.opens
    ? `<button class="iline ${v.cls}" type="button" data-open-run="${esc(v.number)}">${inner}${icon("chevron-right")}</button>`
    : `<div class="iline ${v.cls}">${inner}</div>`;
}

/** The lines, on top of the list, until OK. */
function importBlock() {
  if (!importLines.length) return "";
  return `<section class="imports" aria-label="What the import did">
      <div class="imports-head"><span class="eyebrow">IMPORT</span><span class="spacer"></span>
        <span class="when">${esc(importStamp || "")}</span>
        <button class="mini-btn" type="button" id="imports-ok">OK</button></div>
      ${importLines.map(importLineHtml).join("")}
    </section>`;
}

function wireImportBlock() {
  const ok = document.getElementById("imports-ok");
  if (ok) ok.addEventListener("click", () => { importLines = []; announceImports(); renderAssignments(); });
  main.querySelectorAll("[data-open-run]").forEach((el) =>
    el.addEventListener("click", () => renderItinerary(el.dataset.openRun)));
}

/** The same words for a screen reader: the block is redrawn every minute, so
 *  it is not itself a live region. */
function announceImports() {
  const el = document.getElementById("import-status");
  if (!el) return;
  el.textContent = importLines.map((l) => {
    const v = importView(l);
    return [v.number, v.title].filter(Boolean).join(" ");
  }).join(". ");
}

/** Over a run's itinerary: a sheet on this phone only, or a newer copy of it
 *  that has not reached this screen yet. */
function importStrip(a) {
  const at = (p) => `<span class="mono">${esc(printedLabel(p))}</span>`;
  const was = a.printedAt ? `the copy printed ${at(a.printedAt)}` : "the copy you had";
  let words;
  if (a._queued) {
    words = "On this phone only. It sends when a bar comes back; until then your other devices don't have it.";
  } else if (a._newer && a._newer.sent) {
    words = `Dispatch's newer copy, printed ${at(a._newer.printedAt)}, is saved. It shows here in a moment;
      until then this is ${was}.`;
  } else if (a._newer) {
    const n = (a.edits || []).length + (a.changes || []).length;
    const yours = n ? `, with your ${n === 1 ? "change" : `${n} changes`}` : "";
    words = `Dispatch's newer copy, printed ${at(a._newer.printedAt)}, is waiting for signal. Until it sends
      you're seeing ${was}${yours}.`;
  } else return "";
  return `<div class="warn-strip">${icon("clock")}<span>${words}</span></div>`;
}

/*
 * A new run the server has taken can be missing from GET for 20 seconds or
 * more (KV's list lag), and an updated one briefly shows its old copy. The
 * ledger draws the new run meanwhile; this asks again until GET catches up.
 */
let catchUpTimer = null;
function catchUpImports() {
  if (catchUpTimer || offline) return;
  if (!sentLedger().some((op) => op.kind === "import" && op.listCode === listCode)) return;
  catchUpTimer = setTimeout(() => {
    catchUpTimer = null;
    if (listCode) loadAssignments().catch(console.error);
  }, 20000);
}

/* ------------------------------------------------------ live while open -- */

/*
 * A screen left open on the dash must not freeze. Each minute the open screen
 * is repainted from what the app already holds, so RIGHT NOW, done/current and
 * the clocks move with the time, at no cost. The runs themselves are loaded
 * again only when the list's stamp says something changed (below): a load
 * costs the server 2 KV lists of the 1,000 a day, the stamp one read.
 */
let lastTick = null;

/*
 * Staying in sync (the owner, 2026-09-30): a change made elsewhere -- another
 * phone's import or correction, a flight check -- shows within a minute or
 * two. The server gives the list a new stamp on every such write; each minute
 * the phone asks for the stamp alone (one KV read, no list) and loads the
 * runs only when it is not the one its copy came with. This replaced a full
 * load every ten minutes while a run was live.
 */
let listStamp = null;   // the list's stamp when the copy on screen left the server
let syncSettle = false; // one more load is owed (see checkStamp)
let syncing = false;

async function checkStamp() {
  if (PREVIEW || syncing || !listCode) return;
  syncing = true;
  const code = listCode;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/stamp`, { headers: listHeaders(code), signal: ctl.signal });
    if (!res.ok || code !== listCode) return;
    const stamp = (await res.json()).stamp ?? null;
    if (stamp !== listStamp) {
      // KV's listings can trail a write by 20 seconds or more, so the load
      // this starts may not hold the change yet: the next minute loads once
      // more, whatever the stamp says then.
      syncSettle = true;
      await loadAssignments();
    } else if (syncSettle || offline) {
      // Also the way back from "No signal": the server just answered.
      syncSettle = false;
      await loadAssignments();
    }
  } catch (_) {
    // No signal, or a slow bar: the next minute asks again. Nothing to say.
  } finally {
    clearTimeout(timer);
    syncing = false;
  }
}

function liveTick(now = new Date()) {
  const minute = Math.floor(now.getTime() / 60000);
  if (minute === lastTick) return;
  lastTick = minute;
  if (!listCode || document.visibilityState !== "visible") return;
  // Nothing repaints under a thumb that is typing, a load included.
  const focus = document.activeElement;
  if (focus && main.contains(focus) && /^(INPUT|TEXTAREA|SELECT)$/.test(focus.tagName)) return;
  checkStamp(); // it repaints when a load lands
  renderCurrent();
}
setInterval(liveTick, 5000);

/* ---------------------------------------------------------- edit actions -- */

function saveEdit(e) {
  e.preventDefault();
  if (!editing) return;
  const assignment = assignments.find((a) => a.number === editing.number);
  if (!assignment) return;
  if (editing.fields) return saveTimes();
  let value = document.getElementById("edit-input").value.trim();
  if (editing.field === "flightNumber") value = value.replace(/\s+/g, "").toUpperCase();
  enqueue({
    kind: "post",
    number: editing.number,
    label: editing.label,
    body: {
      at: editing.at,
      field: editing.field,
      value: value || null,
      was: editing.documentValue,
      by: deviceLabel(),
      ...editing.aim,
    },
  });
  // Taught by the fix, unless the driver unticked it.
  const code = editing.airline && flightCode(value);
  if (code && document.getElementById("edit-learn").checked) saveAirline(editing.airline, code);
  closeSheet("edit-sheet");
  refreshLocal();
  flush();
}

/** A step's times: one patch per time the driver actually changed, so each
 *  has its own undo and its own keep mine / use the sheet. A blank input
 *  leaves the time as it was -- a time is corrected, never cleared. */
function saveTimes() {
  const changed = editing.fields
    .map((f) => ({ ...f, value: printedTime(document.getElementById(`edit-${f.field}`).value) }))
    .filter((f) => f.value && f.value !== f.current);
  for (const f of changed) {
    enqueue({
      kind: "post",
      number: editing.number,
      label: `${editing.label} (${f.label.toLowerCase()})`,
      body: {
        at: editing.at, field: f.field, value: f.value, was: f.documentValue,
        by: deviceLabel(), ...editing.aim,
      },
    });
  }
  closeSheet("edit-sheet");
  if (!changed.length) return;
  refreshLocal();
  flush();
}

/** Remove one patch: drop it from the queue if it never left the phone,
 *  otherwise queue its removal. */
function removePatch(number, id) {
  if (id.startsWith("q:")) {
    const ref = id.slice(2);
    const op = outbox().find((o) => o.ref === ref);
    // Sent at least once: the server may have saved it (see reapUndone).
    if (op && op.tried) rememberUndone(number, ref);
    unqueue(ref);
    return;
  }
  // Its ref, so a second copy still hidden by the list lag goes too.
  const assignment = assignments.find((a) => a.number === number);
  const sent = sentLedger().find((op) => op.patchId === id);
  const known = assignment && [...(assignment.edits || []), ...(assignment.changes || [])]
    .find((e) => e.patchId === id);
  const ref = (sent && sent.ref) || (known && known.ref) || null;
  rememberUndone(number, ref);
  // Sent but not yet visible: stop drawing it, or it would outlive its removal.
  writeLS(LS_SENT, sentLedger().filter((op) =>
    op.patchId !== id && !(ref && op.kind === "post" && op.ref === ref)));
  enqueue({ kind: "delete", number, id });
}

function undoLastEdit(number) {
  const assignment = assignments.find((a) => a.number === number);
  const id = assignment && lastPatchId(assignment);
  if (!id) return;
  removePatch(number, id);
  refreshLocal();
  flush();
}

function dropPatch(number, id) {
  removePatch(number, id);
  refreshLocal();
  flush();
}

function discardLost(ref) {
  writeLS(LS_LOST, readLS(LS_LOST, []).filter((l) => l.ref !== ref));
  renderCurrent();
}

/** KEEP MINE: the correction stands, re-based on what the sheet now says, so
 *  it stops being contested. Expressed as ordinary patches -- drop the old one,
 *  write a fresh one -- so it inherits ordering, undo and sharing. */
function keepMine(number, patchId, field, host) {
  const e = host._edit[field];
  const assignment = assignments.find((a) => a.number === number);
  removePatch(number, patchId);
  enqueue({
    kind: "post", number, label: field,
    body: { at: host._at, field, value: e.value, was: e.documentValue, by: deviceLabel(),
            ...basisFor(assignment, host._at) },
  });
  refreshLocal();
  flush();
}

/** Only an edit aimed by position in dispatch's copy can be overtaken by a new
 *  sheet, so only that one carries the copy it was made on. */
function basisFor(assignment, at) {
  return String(at || "").startsWith("+") ? {} : { basis: assignment.importedAt };
}

/** "Not happening": a no-show, or cancelled by phone. A ghost with its own
 *  undo, dispatch's row kept underneath. No confirm: the undo is the safety,
 *  and it does not expire. `aim`: the copy a row's menu was read from. */
function removeRow(number, at, label, aim) {
  const assignment = assignments.find((a) => a.number === number);
  if (!assignment) return;
  enqueue({
    kind: "post", number, label: `Not happening: ${label}`,
    body: { kind: "remove", at, label, by: deviceLabel(), ...(aim || basisFor(assignment, at)) },
  });
  refreshLocal();
  flush();
}

let adding = null; // { number, mode: "entity" | "step", at?, verb?, code? }

/** The departure/arrival tag an added passenger's flight most likely has. A
 *  proposal the driver sees and can change, not a decision: at an airport you
 *  collect arrivals and deliver departures; at a door it is the other way. */
function proposedTag(code, verb) {
  const pickup = /pick/i.test(verb || "");
  return AIRPORTS.has(code) ? (pickup ? "A" : "D") : (pickup ? "D" : "A");
}

function openAdd(number, spec) {
  const assignment = assignments.find((a) => a.number === number);
  if (!assignment) return;
  adding = { number, ...spec, aim: spec.aim || basisFor(assignment, spec.at) }; // as in openEdit
  const isStep = spec.mode === "step";
  document.getElementById("row-title").textContent = isStep ? "Add a stop" : `Add a passenger · ${spec.label}`;
  document.getElementById("row-entity").hidden = isStep;
  document.getElementById("row-step").hidden = !isStep;
  document.getElementById("row-error").textContent = "";
  const form = document.getElementById("row-form");
  form.reset();
  if (isStep) {
    const date = document.getElementById("r-date");
    date.value = String(assignment.start).slice(0, 10);
    // The date follows the time into the run's window until the driver picks
    // one: 1:30 AM on a run that starts at 9 PM is the next morning.
    if (!date.dataset.wired) {
      date.dataset.wired = "1";
      date.addEventListener("input", () => { if (adding) adding.dateTouched = true; });
      document.getElementById("r-time").addEventListener("input", (ev) => {
        const run = adding && assignments.find((a) => a.number === adding.number);
        if (run && !adding.dateTouched) date.value = addedStopDay(run, printedTime(ev.target.value));
      });
    }
  } else {
    document.getElementById("r-dir").value = proposedTag(spec.code, spec.verb);
  }
  openSheet("row-sheet");
  document.getElementById(isStep ? "r-place" : "r-name").focus();
}

/** "15:40" -> "3:40 PM", the sheet's own format, so every renderer and the
 *  worker read a driver's stop exactly as they read dispatch's. */
function printedTime(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

/** The day an added stop's time falls on (see runDayOf). `time` is printed
 *  ("1:30 AM"). Without this, 1:30 AM typed on a run that starts at 9 PM took
 *  the start date, sorted ahead of the whole run and read as done. */
function addedStopDay(assignment, time) {
  return runDayOf(assignment, wallMinutes(time));
}

function saveAdd(e) {
  e.preventDefault();
  if (!adding) return;
  const assignment = assignments.find((a) => a.number === adding.number);
  if (!assignment) return;
  const val = (id) => document.getElementById(id).value.trim();
  const error = document.getElementById("row-error");
  let op;
  if (adding.mode === "step") {
    const place = val("r-place");
    const time = printedTime(val("r-time"));
    if (!place || !time || !val("r-date")) { error.textContent = "A stop needs a place, a date and a time."; return; }
    const code = /^[A-Za-z]{3}$/.test(place) ? place.toUpperCase() : null;
    // A date the driver picked stands; the pre-filled one follows the time.
    const date = adding.dateTouched ? val("r-date") : addedStopDay(assignment, time);
    op = { kind: "post", number: adding.number, label: `Add stop ${code || place}`,
           body: { kind: "addStep", by: deviceLabel(),
                   step: { place: code || place, code, date, time,
                           verb: val("r-verb"), where: val("r-where") || null } } };
  } else {
    const name = val("r-name");
    if (!name) { error.textContent = "A passenger needs a name."; return; }
    const flight = val("r-flight").replace(/\s+/g, "").toUpperCase() || null;
    op = { kind: "post", number: adding.number, label: `Add ${name}`,
           body: { kind: "addEntity", at: adding.at, by: deviceLabel(),
                   entity: { name, flightNumber: flight, phone: val("r-phone") || null,
                             note: val("r-note") || null, tag: flight ? val("r-dir") : null },
                   ...adding.aim } };
  }
  enqueue(op);
  closeSheet("row-sheet");
  adding = null;
  refreshLocal();
  flush();
}

/*
 * Legs (the owner, 2026-09-29): the driver corrects a leg's time and words,
 * adds one dispatch phoned in, or says one is not happening -- all through the
 * patch log, like any row. Dispatch's words stay beside the driver's; the tick
 * stays, keyed by dispatch's words. One correction per leg: a second replaces
 * the first, so USE DISPATCH'S is one tap back to the sheet.
 */
let legEditing = null; // { number, at | null (a new one), label, aim }

function hhmm(at) {
  const m = ((at % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function openLeg(number, at, label) {
  const assignment = assignments.find((a) => a.number === number);
  if (!assignment) return;
  const row = at ? ensureLines(assignment).find((r) => r._at === at) : null;
  const entry = row ? noteLines(assignment).find((l) => l.row === row) : null;
  if (at && !entry) return;
  legEditing = { number, at, label, aim: at ? basisFor(assignment, at) : {} };
  const edit = row && row._edit && row._edit.line;
  document.getElementById("leg-title").textContent = !row ? "Add a leg"
    : row._add ? `Your leg at ${entry.time}` : `Leg at ${entry.printedTime || entry.time}`;
  document.getElementById("leg-time").value = entry ? hhmm(entry.at) : "";
  document.getElementById("leg-what").value = entry ? entry.text : "";
  document.getElementById("leg-doc").textContent = row && !row._add ? `Dispatch printed: ${row.printed}` : "";
  document.getElementById("leg-error").textContent = "";
  document.getElementById("leg-dispatch").hidden = !(edit && !row._add);
  const off = document.getElementById("leg-off");
  off.hidden = !row;
  off.textContent = row && row._add ? "REMOVE" : "NOT HAPPENING";
  document.getElementById("leg-save").textContent = row ? "SAVE" : "ADD LEG";
  document.getElementById("leg-note").textContent = !row
    ? `Goes under ${label || "the run"} by its time, marked YOURS, with its own tick. Dispatch's legs never move.`
    : row._add ? "Yours: dispatch never printed it. Every phone on this list sees it."
    : "Yours is marked with a dot, dispatch's stays beside it, and the leg keeps its tick. A new sheet that changes this line shows both.";
  openSheet("leg-sheet");
  document.getElementById("leg-time").focus();
}

function legRowOf() {
  const assignment = legEditing && assignments.find((a) => a.number === legEditing.number);
  return assignment && legEditing.at ? ensureLines(assignment).find((r) => r._at === legEditing.at) : null;
}

function saveLeg(e) {
  e.preventDefault();
  if (!legEditing) return;
  const { number, at } = legEditing;
  const t = document.getElementById("leg-time").value;
  const what = document.getElementById("leg-what").value.trim().replace(/\s*\n\s*/g, " ");
  const error = document.getElementById("leg-error");
  if (!/^\d{2}:\d{2}$/.test(t)) return void (error.textContent = "When? A leg needs its time.");
  if (!what) return void (error.textContent = "What happens? A leg needs its words.");
  const [h, mi] = t.split(":").map(Number);
  const time = fmtMinutes(h * 60 + mi);
  const value = `${time} ${what}`;
  const by = deviceLabel();
  if (!at) {
    enqueue({ kind: "post", number, label: `Leg ${time}`,
              body: { kind: "addLeg", leg: { line: value }, label: value, by } });
  } else {
    const row = legRowOf();
    if (!row) return closeSheet("leg-sheet");
    const edit = row._edit && row._edit.line;
    if (value === row.line) return closeSheet("leg-sheet");
    // One correction per leg: the new one replaces the old. Typed back to
    // the leg's own first words (dispatch's, or as the driver added it), it
    // is no correction at all.
    const base = edit ? edit.documentValue : row.line;
    if (edit) removePatch(number, edit.patchId);
    if (value !== base) {
      enqueue({ kind: "post", number, label: `Leg ${time}`,
                body: { at, field: "line", value, was: base, by, ...legEditing.aim } });
    }
  }
  closeSheet("leg-sheet");
  refreshLocal();
  flush();
}

function legBack() {
  const row = legRowOf();
  const edit = row && row._edit && row._edit.line;
  if (edit) dropPatch(legEditing.number, edit.patchId);
  closeSheet("leg-sheet");
}

/** NOT HAPPENING for dispatch's leg (a ghost with UNDO); REMOVE for the
 *  driver's own, with its correction, so nothing is left to orphan. */
function legOff() {
  const row = legRowOf();
  if (!row) return closeSheet("leg-sheet");
  const { number, at } = legEditing;
  closeSheet("leg-sheet");
  if (row._add) {
    const edit = row._edit && row._edit.line;
    if (edit) removePatch(number, edit.patchId);
    dropPatch(number, row._add.patchId);
    return;
  }
  removeRow(number, at, row.line);
}

function wireEdits(assignment) {
  const number = assignment.number;
  main.querySelectorAll("[data-leg]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const spec = JSON.parse(el.dataset.leg);
      openLeg(number, spec.at, spec.label);
    });
  });
  main.querySelectorAll("[data-add-leg]").forEach((el) =>
    el.addEventListener("click", () => openLeg(number, null, el.dataset.addLeg)));
  main.querySelectorAll("[data-edit]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openEdit(number, JSON.parse(el.dataset.edit));
    });
  });
  main.querySelectorAll("[data-edit-time]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation(); // a past step's head also folds it
      openEdit(number, JSON.parse(el.dataset.editTime));
    });
  });
  main.querySelectorAll("[data-use]").forEach((el) =>
    el.addEventListener("click", () => dropPatch(number, el.dataset.use)));
  main.querySelectorAll("[data-discard]").forEach((el) =>
    el.addEventListener("click", () => dropPatch(number, el.dataset.discard)));
  main.querySelectorAll("[data-discard-lost]").forEach((el) =>
    el.addEventListener("click", () => discardLost(el.dataset.discardLost)));
  main.querySelectorAll("[data-keep]").forEach((el) => {
    el.addEventListener("click", () => {
      const host = hostAt(assignment, { at: el.closest("[data-at]").dataset.at });
      if (host) keepMine(number, el.dataset.keep, el.dataset.keepField, host);
    });
  });
  main.querySelectorAll("[data-remove]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeRow(number, el.dataset.remove, el.dataset.label);
    });
  });
  main.querySelectorAll("[data-more]").forEach((el) =>
    el.addEventListener("click", () => openRowMenu(number, el.dataset.more, false)));
  main.querySelectorAll("[data-stop-menu]").forEach((el) =>
    el.addEventListener("click", () => openRowMenu(number, el.dataset.stopMenu, true)));
  const addStop = document.getElementById("add-stop");
  if (addStop) addStop.addEventListener("click", () => openAdd(number, { mode: "step" }));
  const undo = document.getElementById("undo-edit");
  if (undo) undo.addEventListener("click", () => undoLastEdit(number));
}

/* ------------------------------------------------------------- the calls -- */

/**
 * Every passenger on the next day that has assignments, with their number.
 *
 * Assignments arrive at 5 PM for the following day, and every passenger has to
 * be reached that evening -- then again from the kerb until they are in the
 * car. That is daily, repeated work that had no screen at all, and the number
 * it needs was the field an earlier draft of the design threw away.
 *
 * Nothing here is maintained: the list IS tomorrow's assignments, read through
 * the same party grouping as the itinerary, so a couple is one message because
 * it is one conversation.
 */
function callsFor(dayIso) {
  const out = [];
  for (const a of assignments) {
    if (a.start.slice(0, 10) !== dayIso) continue;
    const seen = new Set();
    for (const step of a.steps || []) {
      if (step._removed) continue;
      for (const action of step.actions || []) {
        // The message answers one question: when am I collecting you, and where.
        // So it is the PICKUP that matters -- for an arrival that is the
        // airport after they land, for a departure it is their own door. An
        // earlier version used whichever step came first and paired a
        // departure's flight time with the pickup's place, which told a
        // passenger being collected at 10 AM that the time was 2:09 PM.
        if (!/pickup/i.test(action.verb || "")) continue;
        for (const e of action.entities || []) {
          if (e._removed || seen.has(e.name)) continue;   // printed once per step they appear in
          seen.add(e.name);
          // The same time the message says: the landing for an arrival
          // (live once tracked), dispatch's time at the door for anyone else.
          const when = pickupWhen(step, e);
          out.push({
            assignment: a.number,
            at: e._at,
            gb: !!e.gb,
            name: e.name,
            pax: e.pax,
            tag: e.tag,
            phone: e.phone || null,
            otherPhones: e.otherPhones || [],
            place: step.code || step.place,
            when: when === null || when === undefined ? "" : fmtMinutes(when),
            sortAt: when ?? 0,
          });
        }
      }
    }
  }
  out.sort((x, y) => x.sortAt - y.sortAt);
  return out;
}

/** The next day that has any assignment. In normal operation that is tomorrow,
 *  because the sheet landed at 5 PM -- but naming it "tomorrow" would be a
 *  guess on any other day, so it is derived rather than assumed. */
function nextAssignmentDay(now = new Date()) {
  // The first day with a run that has not started: at 5 PM, after a morning
  // run, that is tomorrow; before an evening run today, it is still today
  // (the owner, 2026-09-26). By the day alone, today's finished run held the
  // list and tomorrow's could not be reached (review #4).
  // Only a day with someone to call: tonight's dispatch shift (no passengers)
  // made the bar read ALL DONE while tomorrow's calls were still to make.
  const stamp = localStamp(now);
  const days = assignments.filter((a) => a.start > stamp).map((a) => a.start.slice(0, 10));
  return [...new Set(days)].sort().find((d) => callsFor(d).length) ?? null;
}

/** Every day with someone to call, in order: what the call list's arrows
 *  step through. A day of runs with no passengers is not a stop worth making. */
function callDays() {
  return [...new Set(assignments.map((a) => a.start.slice(0, 10)))].sort()
    .filter((d) => callsFor(d).length);
}

/** The tick keeps what the message said (saidOf), so a later change of plan
 *  can be told from it. */
function markCalled(assignmentNumber, name, on) {
  const log = calledLog();
  const key = `${assignmentNumber}:${name}`;
  const run = assignments.find((a) => a.number === assignmentNumber);
  if (on) log[key] = run ? { at: new Date().toISOString(), said: saidOf(run, { name }) } : new Date().toISOString();
  else delete log[key];
  try { localStorage.setItem(LS_CALLED, JSON.stringify(log)); } catch (_) { /* private mode */ }
}

function renderCalls(dayIso) {
  const day = dayIso || nextAssignmentDay();
  const opening = screen !== "calls" || callsDay !== day;
  if (screen === "list") { listScroll = pageScroll(); pushLayer({ screen: "calls" }); }
  screen = "calls";
  openAssignmentNumber = null;
  callsDay = day;
  const days = callDays();
  // With no upcoming run, the arrow steps back to the last day there was one.
  const prev = day ? days.filter((d) => d < day).pop() : days[days.length - 1];
  const next = day ? days.find((d) => d > day) : undefined;
  const rows = day ? callsFor(day) : [];
  const runOf = (r) => assignments.find((x) => x.number === r.assignment);
  const withNumbers = rows.filter((r) => r.phone);
  const done = withNumbers.filter((r) => messageDone(runOf(r), r)).length;
  const left = withNumbers.length - done;

  const body = rows.length ? rows.map((r) => {
    const key = `${r.assignment}:${r.name}`;
    const run = runOf(r);
    const sent = messaged(run, r);
    // Messaged, then their plan changed: to message again, and what moved.
    const stale = Boolean(sent && sent.changes.length);
    const when = sent && !stale;
    const missing = !r.phone;
    // Someone a re-sent sheet added (or moved to this pickup), until ticked.
    const sm = sheetMarks(run);
    const mark = sm && sm.entity[r.at];
    const fresh = !sent && mark && (mark.added || mark.moved);
    return `
      <div class="crow${when ? " done" : ""}${stale ? " stale" : ""}${missing ? " flagged" : ""}" data-call="${esc(key)}">
        <button class="tickbox" type="button" aria-pressed="${when ? "true" : "false"}"
                aria-label="Mark ${esc(r.name)} as messaged${stale ? " again" : ""}">&#10003;</button>
        <span class="cwho">
          <span class="nmline">
            <span class="nm">${esc(r.name)}</span>
            ${r.tag ? `<span class="etag${r.gb ? " gb" : ""}">${esc(r.tag)}</span>` : ""}
            ${fresh ? NEW_CHIP : ""}
            <span class="cw">${esc(r.when || "")} ${esc(r.place || "")}</span>
          </span>
          ${contactBlock(run, r)}
          ${stale ? `<span class="stalenote">Changed since your message: ${esc(changedWords(sent.changes))}. Message again, then tick.</span>` : ""}
          ${missing ? `<span class="pendnote">ask dispatch</span>` : ""}
        </span>
      </div>`;
  }).join("") : `<p class="ameta" style="margin:0">No one to message. The next sheet lands around 5:00p.</p>`;

  main.innerHTML = `
    <div class="ihead">
      <button class="back" type="button" id="calls-back">${icon("chevron-left", "ico-sm")}ASSIGNMENTS</button>
      <span class="veh">MESSAGES</span>
    </div>
    <div class="screen-pad">
      <div class="callhead">
        <button class="daystep" type="button" id="calls-prev" aria-label="Earlier day"${prev ? "" : " disabled"}>${icon("chevron-left", "ico-sm")}</button>
        <span>${day ? esc(shortDate(day).toUpperCase()) : "NO UPCOMING RUNS"}</span>
        <button class="daystep" type="button" id="calls-next" aria-label="Later day"${next ? "" : " disabled"}>${icon("chevron-right", "ico-sm")}</button>
        <span class="spacer"></span>
        ${withNumbers.length ? `<span class="left">${left} LEFT</span>` : ""}
      </div>
      ${day && withNumbers.length && day <= localStamp().slice(0, 10)
        ? `<p class="daynote">${esc(DAY_OF_WORDS)}</p>` : ""}
      ${body}
      ${withNumbers.length ? `
        <div class="leaveline">
          <span class="lbl">BEFORE</span>
          <span class="val">9:00p</span>
          <span class="sub">${done} of ${withNumbers.length} done</span>
        </div>` : ""}
    </div>`;

  document.getElementById("calls-back").addEventListener("click", renderAssignments);
  if (prev) document.getElementById("calls-prev").addEventListener("click", () => renderCalls(prev));
  if (next) document.getElementById("calls-next").addEventListener("click", () => renderCalls(next));
  wireMessages(main);
  main.querySelectorAll("[data-call] .tickbox").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("[data-call]");
      const [number, ...rest] = row.dataset.call.split(":");
      // Ticked by the driver, never by the app: it can't see a message sent
      // (the owner, 2026-09-29). A messaged passenger stays on the list,
      // dimmed, because at 6 AM at the kerb you want that same number again.
      markCalled(number, rest.join(":"), !row.classList.contains("done"));
      renderCalls(day);
    });
  });
  if (opening) setPageScroll(0);
  settleCalls(main);
  syncWakeLock();
}

/** A run is in progress from its start to its end, local time -- the same
 *  test as the list's IN PROGRESS chip. The end is effectiveEnd's. */
function isInProgress(assignment, nowIso = localStamp()) {
  return assignment.start <= nowIso && nowIso <= effectiveEnd(assignment);
}

/*
 * The screen stays on while a run in progress is on screen: in the mount,
 * the phone going dark between stops is a glance lost. Held only while the
 * itinerary of a run in progress is visible; the browser drops the lock when
 * the app is hidden, so it is asked for again when it comes back. The minute
 * tick repaints, which lets it go once the run ends.
 */
let wakeLock = null; // a WakeLockSentinel, "pending", or null

function syncWakeLock() {
  const open = screen === "itinerary" && assignments.find((a) => a.number === openAssignmentNumber);
  const want = !!open && isInProgress(open) && document.visibilityState === "visible";
  if (want && !wakeLock && typeof navigator !== "undefined" && navigator.wakeLock) {
    wakeLock = "pending";
    navigator.wakeLock.request("screen").then((lock) => {
      wakeLock = lock;
      lock.addEventListener("release", () => { if (wakeLock === lock) wakeLock = null; });
      syncWakeLock(); // the driver may have left the run while it was granted
    }).catch(() => { wakeLock = null; }); // low battery, or not allowed: the screen just sleeps
  } else if (!want && wakeLock && wakeLock !== "pending") {
    const lock = wakeLock;
    wakeLock = null;
    lock.release().catch(() => { /* already released */ });
  }
}
document.addEventListener("visibilitychange", syncWakeLock);

/** Once per launch: with a run in progress, the app opens on it rather than
 *  the list -- the question at launch is "where am I going". Back still
 *  leads to the list, because the itinerary is opened from it. */
let openedToNow = false;

/** Re-render whichever assignment view is open. Anything that changes a
 *  display preference calls this rather than reaching for a specific screen. */
function renderCurrent() {
  if (holdScreen) return;
  document.getElementById("offline-flag").hidden = !offline;
  document.getElementById("import-btn").hidden = !listCode;
  // The server answered with an error: the phone has signal, so "offline"
  // would send the driver hunting for bars that are already there.
  document.getElementById("offline-word").textContent = serverTrouble ? "SERVER" : "OFFLINE";
  document.getElementById("offline-ico").setAttribute("href",
    serverTrouble ? "#i-triangle-alert" : "#i-wifi-off");
  if (!openedToNow && assignments.length) {
    openedToNow = true;
    const run = screen === "list" && assignments.find((a) => isInProgress(a));
    if (run) return renderItinerary(run.number);
  }
  if (screen === "itinerary" && openAssignmentNumber) renderItinerary(openAssignmentNumber);
  else if (screen === "calls") renderCalls(callsDay);
  else renderAssignments();
}

/** Stale and readable beats absent -- but only if it says it is stale, and
 *  from when. Flight times are the part that goes out of date; dispatch's plan
 *  and the driver's own edits do not. */
function offlineStrip() {
  if (!offline) return "";
  const d = cachedAt ? new Date(cachedAt) : null;
  const at = d ? fmtMinutes(d.getHours() * 60 + d.getMinutes()) : null;
  const from = `Showing the copy from <span class="mono">${esc(at || "earlier")}</span>.`;
  return `<div class="warn-strip">${icon("triangle-alert")}
    <span>${serverTrouble
      ? `Server problem, not your signal. ${from}
    Flights may have moved since; your edits send when the server is back.`
      : `No signal. ${from}
    Flights may have moved since; your edits send when a bar comes back.`}</span></div>`;
}

/* -------------------------------------------------------------- loading -- */

let cachedAt = null; // when the copy on screen left the server
let serverTrouble = false; // offline because the server answered with an error

function applyAssignments(data, fromCache) {
  assignments = data.assignments || [];
  assignments.forEach(ensureAddresses);
  flightStatuses = data.statuses || {};
  flightChecks = data.flightChecks || null;
  pushKey = data.pushKey || null;
  travelTimes = data.travelTimes || null;
  if (data.settings) settings = Object.assign({}, settings, data.settings);
  // The list's own push topic. A list made before topics were their own
  // secret is given one on its first load after the change.
  if (data.ntfyTopic && data.ntfyTopic !== ntfyTopic) {
    ntfyTopic = data.ntfyTopic;
    try { localStorage.setItem(LS_NTFY_TOPIC, ntfyTopic); } catch (_) { /* private mode */ }
  }
  listStamp = data.stamp ?? null;
  hiddenRuns = [];
  sharedCatalog = { places: (data.shared && data.shared.places) || [], airlines: (data.shared && data.shared.airlines) || [] };
  keeper = data.keeper === true;
  suggestions = keeper && Array.isArray(data.suggestions) ? data.suggestions.slice() : [];
  if (!fromCache) data._cachedAt = new Date().toISOString();
  cachedAt = data._cachedAt || null;
  if (!fromCache) writeLS(LS_ASSIGN_CACHE, data);
}

/** Another list's runs must never show under this one, not even from the
 *  saved copy. Queued edits stay: each carries its own list code. */
function forgetAssignments() {
  assignments = [];
  hiddenRuns = [];
  listStamp = null;
  syncSettle = false;
  sharedCatalog = { places: [], airlines: [] };
  keeper = false;
  suggestions = [];
  flightStatuses = {};
  flightChecks = null;
  importLines = []; // the other list's
  openAssignmentNumber = null;
  screen = "list";
  callsDay = null;
  listScroll = 0;
  archiveOpen = false;
  try { localStorage.removeItem(LS_ASSIGN_CACHE); } catch (_) { /* nothing to forget */ }
}

/** `fresh` is an answer already in hand (a list switch fetches one to prove
 *  the code), so it is not asked for twice. */
async function loadAssignments(fresh) {
  if (PREVIEW) return; // preview.js holds the screen; nothing is fetched or saved
  // Paint the saved copy first. With one bar the request below can take the
  // whole timeout, and the next stop must not wait on it.
  if (!fresh && !assignments.length) {
    const cached = readLS(LS_ASSIGN_CACHE, null);
    if (cached) {
      applyAssignments(cached, true);
      overlayOutbox();
      renderCurrent();
    }
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
  // The list this load is for. An answer can take the whole timeout, and the
  // driver may have entered another list's code by then: it is that list's
  // screen now, and this answer, or this failure, says nothing about it.
  const code = listCode;
  try {
    let data = fresh;
    if (!data) {
      const res = await fetch(`${API_BASE}/api/assignments`,
                              { headers: listHeaders(code), signal: ctl.signal });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      data = await res.json();
    }
    if (code !== listCode) return;
    offline = false;
    serverTrouble = false;
    applyAssignments(data);
    pruneSent();
    reapUndone();
  } catch (err) {
    if (code !== listCode) return;
    // Terminals eat signal. Stale and readable beats absent and honest-looking.
    console.error(err);
    const cached = readLS(LS_ASSIGN_CACHE, null);
    if (!cached) throw err;
    offline = true;
    serverTrouble = !!err.status;
    applyAssignments(cached, true);
  } finally {
    clearTimeout(timer);
  }
  overlayOutbox();
  if (!offline) pruneHidden();
  renderCurrent();
  if (!offline && outbox().length) flush();
  catchUpImports();
  // This phone's alerts: still on, and the list still has it (app.js).
  if (typeof syncPush === "function") syncPush();
}
