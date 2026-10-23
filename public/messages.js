/*
 * Messages to passengers (the owner, 2026-09-28/29): drivers reach passengers
 * by WhatsApp, else Messages, never a call. The driver writes one message per
 * trip type in Settings, in their own words, with fields in brackets
 * ([NAME], [FLIGHT], ...); the app fills them from dispatch's sheet and opens
 * the draft in WhatsApp or Messages. The driver sends it: the app never does.
 *
 * Pure except the three localStorage helpers at the end. The passenger's facts
 * come from messageFacts() in assignments.js.
 */

const LS_MESSAGES = "fw_messages"; // {"<kind>": "<template>"}, only the ones changed; per device
const LS_MY_NAME = "fw_my_name";   // what [MY NAME] fills with
const LS_GREET = "fw_greet";       // {"<passenger name>": "brother" | "sister" | "name"}

/** One message per kind of trip, picked by the tag dispatch printed on the row. */
const MESSAGE_KINDS = [
  { kind: "departure", label: "Departures", tags: "D, GBD" },
  { kind: "arrival", label: "Arrivals", tags: "A, GBA" },
  { kind: "medical", label: "Medical", tags: "MED" },
  { kind: "shuttle", label: "Shuttle", tags: "S" },
  { kind: "other", label: "Everything else", tags: "HO, TD, no tag" },
];

function messageKind(tag) {
  switch (tag) {
    case "D": case "GBD": return "departure";
    case "A": case "GBA": return "arrival";
    case "MED": return "medical";
    case "S": return "shuttle";
    default: return "other";
  }
}

// The owner's own message (2026-09-28), one per kind. Signed with [MY NAME]
// so every driver's copy starts as theirs once they type their name.
const MSG_OPEN = "Dear [NAME],\nI have the pleasure of being your driver from [FROM] to [TO]";
const MSG_CLOSE = "Does this work for you?\n\n"
  + "Please let me know if there's anything I can do to make your trip smoother.\n"
  + "See you [DAY]!\n-[MY NAME]";
// [FROM] and [TO] are the places a passenger knows (Warwick, Fishkill, JFK);
// [DOOR] is where the driver waits at the pickup (the owner, 2026-09-30).
const DEFAULT_MESSAGES = {
  departure: `${MSG_OPEN} for flight [FLIGHT].\nI'll meet you outside [DOOR] at [TIME].\n${MSG_CLOSE}`,
  arrival: `${MSG_OPEN}.\nI'll meet you outside baggage claim when flight [FLIGHT] lands at [TIME].\n${MSG_CLOSE}`,
  medical: `${MSG_OPEN} for your [APPOINTMENT] appointment.\nI'll meet you outside [DOOR] at [TIME].\n${MSG_CLOSE}`,
  shuttle: `${MSG_OPEN}.\nI'll meet you outside [DOOR] at [TIME].\n${MSG_CLOSE}`,
  other: `${MSG_OPEN}.\nI'll meet you outside [DOOR] at [TIME].\n${MSG_CLOSE}`,
};

/** The fields a kind offers as buttons in the editor, in this order. */
function messageFields(kind) {
  const extra = kind === "departure" || kind === "arrival" ? ["FLIGHT"]
    : kind === "medical" ? ["APPOINTMENT"] : [];
  return ["NAME", "LAST NAME", "FROM", "TO", "DOOR", ...extra, "TIME", "DAY", "MY NAME"];
}

/** "Castillo, Ana & Luis" -> "Castillo". The sheet prints Last, First. */
function lastNameOf(name) {
  const s = String(name || "").trim();
  const i = s.indexOf(",");
  return (i > 0 ? s.slice(0, i) : s).trim();
}

/** Two or more travelling on one row are a family; one person is Brother or
 *  Sister, which the app cannot know and never guesses from a name. */
function isParty(facts) {
  return (facts.pax || 1) > 1 || /&/.test(facts.name || "");
}

/** What [NAME] says, or null while a single's greeting has not been chosen. */
function greetingFor(facts, greet) {
  const last = lastNameOf(facts.name);
  if (isParty(facts)) return `Family ${last}`;
  if (greet === "brother") return `Brother ${last}`;
  if (greet === "sister") return `Sister ${last}`;
  if (greet === "name") return last;
  if (greet === "either") return `Brother or Sister ${last}`; // the editor's preview, before it is asked
  return null;
}

/** "tomorrow", "today", "on Tuesday", or "on Tue 6 Oct" further out. Both
 *  dates are local YYYY-MM-DD. */
function dayWord(dayIso, todayIso) {
  if (!dayIso || !todayIso) return null;
  const days = Math.round((Date.parse(`${dayIso}T12:00:00Z`) - Date.parse(`${todayIso}T12:00:00Z`)) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  const d = new Date(`${dayIso}T12:00:00Z`);
  if (days > 1 && days < 7) return `on ${d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}`;
  return `on ${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}`;
}

/**
 * The message as pieces: {text} as written, {text, field} filled from the
 * sheet, {text, missing} a bracket left as typed because there is nothing to
 * put there (no flight on the sheet, a field the app doesn't know). It stays
 * in brackets on purpose: the driver sees it in the draft before sending.
 */
function fillPieces(template, facts, opts = {}) {
  const values = {
    "NAME": greetingFor(facts, opts.greet),
    "LAST NAME": lastNameOf(facts.name) || null,
    "FROM": facts.from,
    "TO": facts.to,
    "DOOR": facts.door,
    "FLIGHT": facts.flight,
    "TIME": facts.time,
    "APPOINTMENT": facts.appointment,
    "DAY": dayWord(facts.day, opts.today),
    "MY NAME": (opts.myName || "").trim() || null,
  };
  const out = [];
  const re = /\[\s*([A-Za-z][A-Za-z ]*)\]/g;
  let last = 0, m;
  while ((m = re.exec(template))) {
    if (m.index > last) out.push({ text: template.slice(last, m.index) });
    const key = m[1].trim().toUpperCase().replace(/\s+/g, " ");
    const v = values[key];
    out.push(v ? { text: String(v), field: key } : { text: m[0], missing: true });
    last = re.lastIndex;
  }
  if (last < template.length) out.push({ text: template.slice(last) });
  return out;
}

function fillMessage(template, facts, opts) {
  return fillPieces(template, facts, opts).map((p) => p.text).join("");
}

/**
 * A printed number as WhatsApp wants it: digits with the country code, no +.
 * A US 10-digit number gets its 1; "+" and "00" say the country themselves.
 * Anything else (a local number from abroad, a short one) can't be told, and
 * gets no WhatsApp button rather than a chat with the wrong person.
 */
function waNumber(phone) {
  const raw = String(phone || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (/^\+/.test(raw)) return digits.length >= 8 && digits.length <= 15 ? digits : null;
  if (/^00/.test(digits)) return digits.length >= 10 && digits.length <= 17 ? digits.slice(2) : null;
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `1${digits}`;
  if (digits.length === 11 && digits[0] === "1") return digits;
  return null;
}

function waLink(phone, text) {
  const n = waNumber(phone);
  if (!n) return null;
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

/** sms: with "?&body=" is the one form both iOS and Android read. */
function smsLink(phone, text) {
  const n = waNumber(phone);
  const to = n ? `+${n}` : String(phone || "").replace(/[^\d+]/g, "");
  if (!to) return null;
  return `sms:${to}${text ? `?&body=${encodeURIComponent(text)}` : ""}`;
}

/* ------------------------------------------------------------- storage -- */

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; }
  catch (_) { return {}; }
}

function messageTemplate(kind) {
  const mine = readJson(LS_MESSAGES)[kind];
  return typeof mine === "string" ? mine : DEFAULT_MESSAGES[kind];
}

/** [FROM] used to fill with the pickup's door (v62 moved the door to [DOOR]):
 *  a message the driver wrote with "outside [FROM]" meant the door, so it says
 *  [DOOR] now. Nothing else in their words changes. Once per phone. */
function doorMigrated(all) {
  const out = {};
  for (const [kind, text] of Object.entries(all)) {
    out[kind] = typeof text === "string" ? text.replace(/(outside) \[\s*FROM\s*\]/gi, "$1 [DOOR]") : text;
  }
  return out;
}

function migrateMessages() {
  try {
    if (localStorage.getItem("fw_messages_door")) return;
    const all = readJson(LS_MESSAGES);
    if (Object.keys(all).length) localStorage.setItem(LS_MESSAGES, JSON.stringify(doorMigrated(all)));
    localStorage.setItem("fw_messages_door", "1");
  } catch (_) { /* private mode: nothing kept to migrate */ }
}

/** Saves the driver's wording; their exact default (or null) forgets it. */
function saveMessageTemplate(kind, text) {
  const all = readJson(LS_MESSAGES);
  if (text === null || text === DEFAULT_MESSAGES[kind]) delete all[kind];
  else all[kind] = text;
  try { localStorage.setItem(LS_MESSAGES, JSON.stringify(all)); } catch (_) { /* private mode */ }
}

function myName() {
  try { return localStorage.getItem(LS_MY_NAME) || ""; } catch (_) { return ""; }
}

function greetOf(name) {
  return readJson(LS_GREET)[name] || null;
}

function setGreet(name, choice) {
  const all = readJson(LS_GREET);
  all[name] = choice;
  try { localStorage.setItem(LS_GREET, JSON.stringify(all)); } catch (_) { /* private mode */ }
}
