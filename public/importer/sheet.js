/**
 * Dispatch's assignment sheet, from layout text to the assignment record.
 * Ported line for line from the Python importer's parse_text and
 * build_assignment (tools/import_assignment.py: removed 2026-10-04, in git at
 * the tag python-importer-last; its flat-job path, build_jobs, was never
 * ported: that UI is gone). The Python's longer comments carry the reason
 * for each rule; the short ones here name the function they mirror.
 *
 * Anything uncertain is reported in `issues`, never guessed: a confidently
 * wrong pickup time is worse than an obvious gap.
 */
import { lookup as airlineLookup } from "./airlines.js";
import {
  casefold, cpCompare, cpHead, cpLen, lstrip, pyInt, pyRe, repr, splitWs, strip,
} from "./python.js";

const R = String.raw;

// ------------------------------------------------------------------ patterns

const HEADER_RE = pyRe(R`Assignment number\s+(?P<num>\d+)\s+Driver\s+(?P<driver>.+?)\s*$`, "M");
// The AM/PM can wrap onto the next line, so every gap is \s+.
const DATE = R`[A-Za-z]+,\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s+[AP]M`;
const START_RE = pyRe(R`Start date and time\s+(?P<start>` + DATE + R`)`
  + R`\s+End date and time\s+(?P<end>` + DATE + R`)`);
const FOOTER_RE = pyRe(R`(` + DATE + R`)\s+Page \d+ of \d+`, "g");
const NOTES_LABEL_RE = pyRe(R`Driver notes[ \t]{2,}`);
const NOTES_END_RE = pyRe(R`^\s*(Assistant|Passenger|\(Unavailable\))\b|ETA:|ETD:`);
const PARKING_RE = pyRe(R`Parking space[ \t]+(?P<code>\S[^\n]*?)[ \t]*$`, "M");
const VEHICLE_RE = pyRe(R`Vehicle[ \t]{2,}(?P<v>\S[^\n]*?)[ \t]{2,}\S`, "M");
const STOP_RE = pyRe(R`^\s*(?P<label>\S.*?)\s{2,}ETA:\s*(?P<eta>\d{1,2}:\d{2}\s*[AP]M)?\s*`
  + R`ETD:\s*(?P<etd>\d{1,2}:\d{2}\s*[AP]M)?\s*(?P<place>[^|]*?)\s*\|\s*(?P<addr>.*)$`);
const TAGS = ["GBA", "GBD", "MED", "HO", "TD", "A", "D", "S"];
const TAG_SRC = R`(?:^|\s{2,})(` + TAGS.join("|") + R`)(?=\s|$)`;
const TAG_RE = pyRe(TAG_SRC);
const TAG_RE_G = pyRe(TAG_SRC, "g");
const TIME_CITY_RE = pyRe(R`Time/City:\s*(?P<time>\d{1,2}:\d{2}\s*[AP]M)\s*(?P<city>.*?)\s*$`, "M");
const APPT_RE = pyRe(R`Appointment time:\s*(?P<time>\d{1,2}:\d{2}\s*[AP]M)`);
const ARRIVAL_TIME_RE = pyRe(R`Arrival time:\s*(?P<time>\d{1,2}:\d{2}\s*[AP]M)`);
const DURATION_RE = pyRe(R`Duration:\s*(?P<dur>.+?)\s*$`, "M");
const ROUTE_RE = pyRe(R`Route:\s*(?P<route>.+?)\s*$`, "M");
const FLIGHT_RE = pyRe(R`Airline/Flight:\s*(?P<rest>.+?)\s*$`, "M");
const ENTITY_NOTE_RE = pyRe(R`Notes:\s*(?P<note>.+?)\s*$`, "M");
// Trailing "  1" / "  2" is the Bags column bleeding into the Information cell.
const BAGS_TAIL_RE = pyRe(R`\s{2,}(\d{1,2})\s*$`);
const INFO_RES = [FLIGHT_RE, ROUTE_RE, APPT_RE, ARRIVAL_TIME_RE];

const KIND_OF_SRC = ["flight", "route", "appt", "arrival_time"];
// Real, ~1% of rows, and out of scope: reported, never miscounted.
const EXCLUDED_TAGS = { TD: "train", HO: "embassy/consulate" };

const WS_RUN = pyRe(R`\s+`, "g");
const CELL_SPLIT = pyRe(R`\s{2,}`);
const NAME_RE = pyRe(R`^[^\W\d_](?:[^\W\d_]|['\u{2019}\-\. ])*,\s*\S`);
const OR_RE = pyRe(R`\bor\b`);
const ALT_RE = pyRe(R`\b([A-Z]{2})\s?(\d{1,5})\b`, "g");
const PREFIX_RE = pyRe(R`\b(?P<pfx>[A-Za-z]\w)\s?(?P<num>\d{1,5})\s*$`);
const NUMBER_RE = pyRe(R`\b(?P<num>\d{1,5})\s*$`);
const DANGLING_OR = pyRe(R`\bor\s*$`);
// A codeshare alternate that wrapped onto the next line, deep in it (~106).
const CODESHARE_CONT = pyRe(R`^(?!.*Airline/Flight:).{60,}?(?<=\s)([A-Z]{2}\s?\d{1,5})\s*$`, "M");
const INFO_LABELS = ["Airline/Flight:", "Route:", "Appointment time:", "Arrival time:", "Number:"];
const THREE_CAPS = /^[A-Z]{3}$/u; // re.fullmatch(r"[A-Z]{3}")
// "     Drop-off :          A Front": a space before the colon.
const ACTION_LINE = pyRe(R`^\s*(Pickup|Drop-off)\s*:\s*(?P<where>.*?)\s*$`);
const SITE_CODE = pyRe(R`^[A-Z]{2,5}$`);
const PHONE_RE = pyRe(R`(?P<phone>\+?\d[\d\-\(\)\. ]{7,}\d)`);
const ASSISTANT_HEAD = pyRe(R`^\s*Assistant\s{2,}Role\b`);
const ASSISTANT_NAME = pyRe(R`^[A-Z][A-Za-z'\-]+,`);
const PARKING_SITE = pyRe(R`^[A-Z]{3}-`);
const BLANK_RUNS = /\n{2,}/g;

/** re.split(pattern, s) for a pattern without groups. */
const reSplit = (re, s) => s.split(re);

// ------------------------------------------------------------ dates, times

const WEEKDAYS = "wednesday|thursday|saturday|tuesday|monday|friday|sunday";
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december"];
const MONTHS_RE = [...MONTHS].sort((a, b) => b.length - a.length).join("|");
// datetime.strptime(s, "%A, %B %d, %Y %I:%M %p"), as _strptime builds it.
const DT_RE = pyRe(R`^(?P<A>` + WEEKDAYS + R`),\s+(?P<B>` + MONTHS_RE + R`)\s+`
  + R`(?P<d>3[0-1]|[1-2]\d|0[1-9]|[1-9]| [1-9]),\s+(?P<Y>\d\d\d\d)\s+`
  + R`(?P<I>1[0-2]|0[1-9]|[1-9]| [1-9]):(?P<M>[0-5]\d|\d)\s+(?P<p>am|pm)$`, "I");
const TOD_RE = pyRe(R`^(?P<I>1[0-2]|0[1-9]|[1-9]| [1-9]):(?P<M>[0-5]\d|\d)(?P<p>am|pm)$`, "I");

/** strptime's ValueError: the sheet has a date or time this reader can't take. */
export class SheetError extends Error {}

const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function hour12(I, p) {
  let h = pyInt(strip(I));
  const ap = p.toLowerCase();
  if (ap === "am") {
    if (h === 12) h = 0;
  } else if (h !== 12) h += 12;
  return h;
}

/** parse_dt: " ".join(s.split()) through strptime. {y, m, d, H, M} */
function parseDt(s) {
  const norm = splitWs(s).join(" ");
  const g = DT_RE.exec(norm)?.groups;
  if (!g) throw new SheetError(`time data ${repr(norm)} does not match format`);
  const y = pyInt(g.Y), m = MONTHS.indexOf(g.B.toLowerCase()) + 1, d = pyInt(strip(g.d));
  if (y < 1 || d > daysIn(y, m)) throw new SheetError("day is out of range for month");
  return { y, m, d, H: hour12(g.I, g.p), M: pyInt(g.M) };
}

/** parse_tod: strptime(s.replace(" ", ""), "%I:%M%p").time(). {H, M} */
function parseTod(s) {
  const g = TOD_RE.exec(s.replaceAll(" ", ""))?.groups;
  if (!g) throw new SheetError(`time data ${repr(s)} does not match format`);
  return { H: hour12(g.I, g.p), M: pyInt(g.M) };
}

const dateOf = (dt) => ({ y: dt.y, m: dt.m, d: dt.d });
const nextDay = ({ y, m, d }) => {
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const pad = (n, w = 2) => String(n).padStart(w, "0");
const isoDate = ({ y, m, d }) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const fmtDt = (dt) => `${isoDate(dt)} ${pad(dt.H)}:${pad(dt.M)}`;
const sameDate = (a, b) => a.y === b.y && a.m === b.m && a.d === b.d;
const todBefore = (a, b) => a.H < b.H || (a.H === b.H && a.M < b.M);

// ------------------------------------------------------------------- notes

/** parse_notes: the notes cell with its continuation lines, blank lines inside. */
function parseNotes(text) {
  const m = NOTES_LABEL_RE.exec(text);
  if (!m) return null;
  const start = m.index, end = start + m[0].length;
  const lineNo = text.slice(0, start).split("\n").length - 1;
  const lineStart = start > 0 ? text.lastIndexOf("\n", start - 1) + 1 : 0;
  const col = cpLen(text.slice(lineStart, end));
  const allLines = text.split("\n");
  const out = [strip(allLines[lineNo].slice(end - lineStart))];
  let blanks = 0;
  for (const line of allLines.slice(lineNo + 1)) {
    if (!strip(line)) {
      blanks += 1;
      if (blanks >= 3 && out.length) break;
      out.push("");
      continue;
    }
    if (NOTES_END_RE.test(line)) break;
    if (line.length - lstrip(line).length < col - 6) break;
    blanks = 0;
    out.push(strip(line));
  }
  return strip(out.join("\n").replace(BLANK_RUNS, "\n")) || null;
}

// ------------------------------------------------------------------ flights

/** strip_bags: [text without the Bags column, bags or null]. */
function stripBags(s) {
  const m = BAGS_TAIL_RE.exec(s);
  return m ? [strip(s.slice(0, m.index)), pyInt(m[1])] : [strip(s), null];
}

/** parse_flight: "United Airlines UA 1068" -> [number, airline, why]. */
export function parseFlight(rest) {
  [rest] = stripBags(rest);
  rest = strip(rest.replace(WS_RUN, " "));
  if (airlineLookup(rest)[1] === "non-flight-pickup") return [null, rest, "non-flight-pickup"];
  let alts = [];
  const mOr = OR_RE.exec(rest);
  if (mOr) {
    const head = strip(rest.slice(0, mOr.index));
    const tail = strip(rest.slice(mOr.index + mOr[0].length));
    alts = [...tail.matchAll(ALT_RE)].map((a) => [a[1], a[2]]);
    rest = head;
  }
  let m = PREFIX_RE.exec(rest);
  let name, number, why;
  if (m && /\p{L}/u.test(m.groups.pfx)) {
    name = strip(rest.slice(0, m.index));
    number = `${m.groups.pfx.toUpperCase()}${pyInt(m.groups.num)}`;
    why = "prefix-inline";
  } else {
    m = NUMBER_RE.exec(rest);
    if (!m) return [null, rest, "no-flight-number"];
    name = strip(rest.slice(0, m.index));
    let iata;
    [iata, why] = airlineLookup(name);
    if (!iata) return [null, name, why];
    number = `${iata}${pyInt(m.groups.num)}`;
  }
  if (alts.length) {
    const pref = alts.filter(([p]) => number.startsWith(p)).map(([p, n]) => `${p}${pyInt(n)}`);
    const last = alts[alts.length - 1];
    const chosen = pref.length ? pref[0] : `${last[0]}${pyInt(last[1])}`;
    return [chosen, name, why + "+codeshare"];
  }
  return [number, name, why];
}

/** unknown_airline_number: the flight's own number when parseFlight could
 *  not name its airline ("WestJet 1680" -> "1680"), for a code the list
 *  learns later (worker/src/learned.ts). Null when there is none. */
export function unknownAirlineNumber(rest) {
  [rest] = stripBags(rest);
  rest = strip(rest.replace(WS_RUN, " "));
  const mOr = OR_RE.exec(rest);
  if (mOr) rest = strip(rest.slice(0, mOr.index));
  const m = NUMBER_RE.exec(rest);
  return m ? String(pyInt(m.groups.num)) : null;
}

/** flight_text: the Airline/Flight cell, with an alternate that wrapped below. */
function flightText(row, window) {
  const m = FLIGHT_RE.exec(row.raw);
  if (!m) return "";
  const rest = m.groups.rest;
  const [body] = stripBags(rest);
  if (!DANGLING_OR.test(strip(body))) return rest;
  const nl = window.indexOf("\n");
  const tail = nl >= 0 ? window.slice(nl + 1) : "";
  const cont = CODESHARE_CONT.exec(tail);
  return cont ? `${strip(body)} ${cont[1]}` : rest;
}

// --------------------------------------------------------------- the grid

/** row_endpoints: the Origin and Destination cells of a passenger row. */
export function rowEndpoints(raw) {
  const parts = reSplit(CELL_SPLIT, strip(raw)).filter((p) => p);
  const idx = parts.findIndex((p) => INFO_LABELS.some((l) => p.includes(l)));
  if (idx < 0 || idx < 3) return [null, null];
  return [parts[idx - 2], parts[idx - 1]];
}

/** place_codes: the document's own place-name -> site-code map. */
function placeCodes(doc) {
  const out = new Map();
  for (const s of doc.stops) {
    if (s.place && THREE_CAPS.test(s.label || "")) out.set(strip(s.place).toLowerCase(), s.label);
  }
  return out;
}

export function codeForPlace(doc, name) {
  if (!name) return null;
  const key = strip(name).toLowerCase();
  const codes = placeCodes(doc);
  if (codes.has(key)) return codes.get(key);
  const words = splitWs(strip(name));
  if (!words.length) throw new SheetError("list index out of range");
  return THREE_CAPS.test(words[0]) ? words[0] : null;
}

/** actions_in: every action bar, as [line, VERB, where]. */
export function actionsIn(doc) {
  const out = [];
  doc.lines.forEach((line, i) => {
    const m = ACTION_LINE.exec(line);
    if (m) out.push([i, m[1].toUpperCase(), strip(m.groups.where || "")]);
  });
  return out;
}

/** dropoff_points: passenger name -> the drop-off point their row sits under. */
export function dropoffPoints(doc) {
  const acts = actionsIn(doc);
  const out = new Map();
  for (const row of doc.rows) {
    const name = row.name;
    if (!name) continue;
    const prior = acts.filter((a) => a[0] < row.line);
    if (!prior.length) continue;
    const [, verb, where] = prior[prior.length - 1];
    if (verb === "DROP-OFF" && where && !out.has(name)) out.set(name, where);
  }
  return out;
}

/**
 * party_key: same surname, same flight, same drop-off point. The surname
 * whatever its case: dispatch typed one of a couple in capitals (run 378725,
 * 2026-10-04) and they came out as two rows. The label still shows each name
 * as typed (party_label).
 */
export function partyKey(row, dropoffs) {
  const name = row.name || "";
  const surname = name.includes(",") ? strip(name.split(",")[0]) : name;
  const fm = FLIGHT_RE.exec(row.raw);
  const flight = fm ? cpHead(strip(fm.groups.rest), 40) : "";
  const door = dropoffs.get(name) ?? null;
  return JSON.stringify([casefold(surname), flight, door]);
}

/** party_label: "Hauser, Marcus & Vera". */
export function partyLabel(names) {
  const first = names[0];
  const surname = first.includes(",") ? strip(first.split(",")[0]) : first;
  const givens = names.filter((n) => n.includes(","))
    .map((n) => strip(n.slice(n.indexOf(",") + 1))).filter((g) => g);
  if (!givens.length) return surname;
  if (givens.length === 1) return `${surname}, ${givens[0]}`;
  return `${surname}, ${givens.slice(0, -1).join(", ")} & ${givens[givens.length - 1]}`;
}

/** place_code_of: a stop's site code, or null when its label is free text. */
export function placeCodeOf(stop) {
  const label = (stop && stop.label) || "";
  return SITE_CODE.test(label) ? label : null;
}

/** entity_window: a passenger row's lines, up to the next named row. */
function entityWindow(doc, row) {
  const after = doc.rows.filter((r) => r.name).map((r) => r.line).filter((s) => s > row.line);
  const end = after.length ? Math.min(...after) : doc.lines.length;
  return doc.lines.slice(row.line, end).join("\n");
}

function entityPhone(doc, row) {
  const window = entityWindow(doc, row);
  const at = window.indexOf("Phone:");
  if (at === -1) return null;
  const m = PHONE_RE.exec(window.slice(at));
  return m ? splitWs(m.groups.phone).join(" ") : null;
}

const dedupe = (issues) => [...new Set(issues)];

/** parse_assistants: the Assistant / Role / Notes table. */
function parseAssistants(doc) {
  const lines = doc.lines;
  const start = lines.findIndex((l) => ASSISTANT_HEAD.test(l));
  if (start < 0) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (!strip(line)) {
      if (out.length) break;
      continue;
    }
    if (STOP_RE.test(line) || line.includes("ETA:")) break;
    const parts = reSplit(CELL_SPLIT, strip(line)).filter((p) => p);
    if (!parts.length || !ASSISTANT_NAME.test(parts[0])) break;
    out.push({ name: parts[0], role: parts[1] ?? null, note: parts[2] ?? null });
  }
  return out;
}

/** flight_date_for: the date the flight operates, from its airport step. */
function flightDateFor(doc, steps, entity, originCol, destCol) {
  const arriving = ["A", "GBA"].includes(entity.tag || "");
  const wanted = codeForPlace(doc, arriving ? originCol : destCol);
  if (wanted) {
    for (const step of steps) {
      if (step.code === wanted) return arriving ? step.etaDate : step.date;
    }
  }
  return null;
}

/** str.title() for the verbs the sheets print: "DROP-OFF" -> "Drop-Off". */
function title(s) {
  let out = "", prevCased = false;
  for (const ch of s) {
    const cased = ch.toLowerCase() !== ch.toUpperCase();
    out += prevCased ? ch.toLowerCase() : ch.toUpperCase();
    prevCased = cased;
  }
  return out;
}

// -------------------------------------------------------------- the sheet

/**
 * parse_text: the document model, or null when the text has no assignment
 * header. Throws SheetError where Python's strptime would raise.
 */
export function parseText(text, source = "<text>") {
  const hm = HEADER_RE.exec(text);
  const sm = START_RE.exec(text);
  if (!hm || !sm) return null;
  const lines = text.split("\n");
  const footers = [...text.matchAll(FOOTER_RE)].map((f) => f[1]);

  const park = PARKING_RE.exec(text);
  const parkCode = park ? strip(park.groups.code) : null;
  const origin = parkCode && PARKING_SITE.test(parkCode) ? parkCode.split("-")[0] : null;
  const vehicle = VEHICLE_RE.exec(text);

  const doc = {
    assignment: hm.groups.num,
    parking: parkCode,
    origin,
    vehicle: vehicle ? strip(vehicle.groups.v) : null,
    driver: strip(hm.groups.driver),
    start: parseDt(sm.groups.start),
    end: parseDt(sm.groups.end),
    printed: footers.length ? parseDt(footers[footers.length - 1]) : null,
    driverNotes: parseNotes(text),
    source,
  };

  // Stops, with dates found by walking the clock forward: the eta and etd of
  // one stop can fall on different days (LGA 11:00 PM in, 12:00 AM out).
  const stops = [];
  let curDate = dateOf(doc.start);
  let lastTod = null;
  lines.forEach((line, i) => {
    if (!line.includes("ETA:") || !line.includes("|")) return;
    if (line.includes("(Unavailable)")) return; // the driver's own calendar
    const m = STOP_RE.exec(line);
    if (!m) return;
    const label = strip(m.groups.label);
    let etaDate = curDate, etdDate = curDate;
    for (const fld of ["eta", "etd"]) {
      const raw = m.groups[fld];
      if (!raw) continue;
      const tod = parseTod(raw);
      if (lastTod !== null && todBefore(tod, lastTod)) curDate = nextDay(curDate);
      lastTod = tod;
      if (fld === "eta") etaDate = curDate;
      else etdDate = curDate;
    }
    if (!m.groups.eta) etaDate = etdDate;
    if (!m.groups.etd) etdDate = etaDate;
    stops.push({
      line: i, label,
      eta: m.groups.eta ?? null, etd: m.groups.etd ?? null,
      place: strip(m.groups.place) || label,
      addr: strip(m.groups.addr || "") || null,
      date: etdDate, // the itinerary's order; etaDate is for arriving
      etaDate,
    });
  });
  doc.dateOk = !stops.length || sameDate(stops[stops.length - 1].date, dateOf(doc.end));

  // Passenger rows.
  const rows = [];
  lines.forEach((line, i) => {
    let info = null;
    for (let k = 0; k < INFO_RES.length; k++) {
      if (INFO_RES[k].test(line)) {
        info = KIND_OF_SRC[k];
        break;
      }
    }
    if (!info) return;
    // The tag has its own narrow column, but can land a few lines below.
    let tag = null;
    const cands = [line];
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      if (INFO_RES.some((rx) => rx.test(lines[j]))) break;
      cands.push(lines[j]);
    }
    if (i) cands.push(lines[i - 1]);
    for (const cand of cands) {
      const tm = TAG_RE.exec(cpHead(cand, 30));
      if (tm) {
        tag = tm[1];
        break;
      }
    }
    const cells = reSplit(CELL_SPLIT, strip(line));
    let name = strip(cells[0].replace(TAG_RE_G, ""));
    if (!name && cells.length > 1) name = strip(cells[1].replace(TAG_RE_G, ""));
    if (!NAME_RE.test(name)) name = null;
    rows.push({ line: i, tag, name, kindSrc: info, raw: strip(line),
      window: lines.slice(i, i + 4).join("\n") });
  });

  doc.stops = stops;
  doc.rows = rows;
  doc.lines = lines;
  return doc;
}

/**
 * build_assignment: Assignment -> Step -> Action -> Entity. A passenger shows
 * at their pickup AND at their own drop-off; both halves are the work.
 */
export function buildAssignment(doc) {
  const doors = dropoffPoints(doc);
  const acts = actionsIn(doc);
  const total = doc.lines.length;
  const issues = [];
  const steps = [];

  doc.stops.forEach((stop, i) => {
    const nxt = i + 1 < doc.stops.length ? doc.stops[i + 1].line : total;
    const here = acts.filter((a) => stop.line < a[0] && a[0] < nxt);
    const actions = [];
    here.forEach(([lineNo, verb, where], n) => {
      const end = n + 1 < here.length ? here[n + 1][0] : nxt;
      const rows = doc.rows.filter((r) => lineNo < r.line && r.line < end && r.name);
      for (const r of doc.rows) {
        if (lineNo < r.line && r.line < end && !r.name) {
          issues.push(`a passenger row whose name could not be read (line ${r.line + 1}): check the sheet`);
        }
      }
      const groups = new Map();
      for (const row of rows) {
        const key = partyKey(row, doors);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }

      const entities = [];
      for (const members of groups.values()) {
        const names = [];
        for (const m of members) if (!names.includes(m.name)) names.push(m.name);
        // One order for the party at every step it appears in.
        const keyed = names.map((nm, k) => [casefold(nm), k, nm]);
        keyed.sort((a, b) => cpCompare(a[0], b[0]) || a[1] - b[1]);
        names.splice(0, names.length, ...keyed.map((x) => x[2]));
        const first = members[0];
        const tag = first.tag;
        const win = entityWindow(doc, first);
        const entity = {
          name: partyLabel(names),
          pax: names.length,
          tag,
          gb: Boolean(tag && tag.startsWith("GB")),
        };
        [entity.origin, entity.destination] = rowEndpoints(first.raw);
        // Every member's number, in the party's order.
        const byName = new Map();
        for (const m of members) if (!byName.has(m.name)) byName.set(m.name, m);
        const phones = [];
        for (const nm of names) {
          const ph = entityPhone(doc, byName.get(nm));
          if (ph && !phones.includes(ph)) phones.push(ph);
        }
        entity.phone = phones.length ? phones[0] : null;
        if (phones.length > 1) entity.otherPhones = phones.slice(1);
        const note = ENTITY_NOTE_RE.exec(win);
        if (note) entity.note = strip(note.groups.note);

        if (tag && Object.hasOwn(EXCLUDED_TAGS, tag)) {
          entity.unsupported = EXCLUDED_TAGS[tag];
          issues.push(`${tag} row not yet supported: ${entity.name}`);
          entities.push(entity);
          continue;
        }

        // A party's bags are the sum over its members, each counted once.
        let bags = 0, counted = false;
        const seenBags = new Set();
        for (const m of members) {
          if (seenBags.has(m.name)) continue;
          seenBags.add(m.name);
          const [, b] = stripBags(m.raw);
          if (b !== null) {
            bags += b;
            counted = true;
          }
        }
        if (counted) entity.bags = bags;

        if (FLIGHT_RE.test(first.raw)) {
          const [number, airline, why] = parseFlight(flightText(first, win));
          entity.flightNumber = number;
          if (!number && why !== "non-flight-pickup") {
            issues.push(`${entity.name}: could not resolve ${repr(airline)} (${why})`);
          }
          if (why === "unknown-airline") {
            const digits = unknownAirlineNumber(flightText(first, win));
            if (digits) entity.unknownAirline = { name: airline, number: digits };
          }
          const tc = TIME_CITY_RE.exec(win);
          if (tc) entity.scheduledText = strip(`${strip(tc.groups.time)} ${strip(tc.groups.city)}`);
        }
        const am = APPT_RE.exec(win) || ARRIVAL_TIME_RE.exec(win);
        if (am) entity.appointmentTime = strip(am.groups.time);
        const dur = DURATION_RE.exec(win);
        if (dur) entity.duration = strip(dur.groups.dur);
        const rt = ROUTE_RE.exec(win);
        if (rt) entity.route = strip(rt.groups.route);
        entities.push(entity);
      }
      actions.push({ verb: title(verb), where: where || null, entities });
    });

    steps.push({
      code: placeCodeOf(stop),
      place: stop.place || stop.label,
      address: stop.addr || null,
      eta: stop.eta, etd: stop.etd,
      date: isoDate(stop.date),
      etaDate: isoDate(stop.etaDate ?? stop.date),
      actions,
    });
  });

  if (!doc.dateOk) {
    issues.push("last stop date disagrees with the document's stated end date "
      + "-- check the multi-day rollover");
  }

  // Now every step has its date: pin each flight to the step it operates at.
  for (const step of steps) {
    for (const act of step.actions) {
      for (const ent of act.entities) {
        if (!ent.flightNumber) continue;
        ent.flightDate = flightDateFor(doc, steps, ent, ent.origin, ent.destination) || step.etaDate;
      }
    }
  }
  // A flight whose airline has no code yet is pinned the same way, for the
  // day a code the list learns fills it in.
  for (const step of steps) {
    for (const act of step.actions) {
      for (const ent of act.entities) {
        if (!ent.unknownAirline) continue;
        ent.unknownAirline.date = flightDateFor(doc, steps, ent, ent.origin, ent.destination) || step.etaDate;
      }
    }
  }

  const gb = steps.some((s) => s.actions.some((a) => a.entities.some((e) => e.gb)));
  return {
    number: doc.assignment,
    start: fmtDt(doc.start),
    end: fmtDt(doc.end),
    driver: doc.driver ?? null,
    vehicle: doc.vehicle ?? null,
    parking: doc.parking ?? null,
    originCode: doc.origin ?? null,
    driverNotes: doc.driverNotes ?? null,
    assistants: parseAssistants(doc),
    steps,
    gb,
    issues: dedupe(issues),
    printedAt: doc.printed ? fmtDt(doc.printed) : null,
    source: doc.source ?? null,
  };
}
