/**
 * What the worker will accept, before anything is written.
 *
 * A list code is free to register, so every write path is reachable by anyone.
 * Without caps, one POST can store megabytes and register thousands of made-up
 * flights, and cron then spends an AeroDataBox unit on each (security review
 * B2, 2026-09-25). The limits are generous: measured across the 15 real
 * fixtures, the largest run is 5.2 KB with 5 steps, 3 actions to a step, 7
 * passengers to an action, 13 passengers in all, notes of 486 characters and
 * no other string over 98.
 *
 * The shapes (flight number, date) also keep KV keys well-formed: they are
 * interpolated into `flight:<number>:<date>...` keys, and a date such as
 * "2026-10-01:trackers" would otherwise name another flight's tracker index
 * (review B3).
 */

import { isFlightNumber, isIsoDate } from "./assignment";
import { wallNow } from "./retention";

export { FLIGHT_NUMBER, ISO_DATE, isFlightNumber, isFlightRef, isIsoDate } from "./assignment";

export const MAX_ASSIGNMENT_BYTES = 256 * 1024;
export const MAX_PATCH_BYTES = 8 * 1024;
/** Every other route: a list code and a handful of fields. */
export const MAX_BODY_BYTES = 32 * 1024;

export const MAX_STEPS = 60;
export const MAX_ACTIONS_PER_STEP = 20;
export const MAX_ENTITIES_PER_ACTION = 60;
export const MAX_ENTITIES = 300;
/** Distinct flights (number and day) on one run as sent. Each is tracked: KV
 *  keys and the month's lookups, which every list shares. The most a real
 *  sheet has carried is 3 (252 sheets, 2026-10-04). Corrections are held to
 *  the same since v69: a change that would make a run name one more flight
 *  past this is refused (index.ts, the patch POST). */
export const MAX_FLIGHTS = 12;
export const MAX_ARRAY = 100;
export const MAX_STRING = 500;
export const MAX_NOTES = 10_000;
/** Settings > SEND A TEST ALERT, per list per hour (index.ts testAlertAllowed). */
export const TEST_ALERT_LIMIT = 5;

/*
 * What one list can cost the rest (security review, 2026-10-04). KV's free
 * plan is one pool a day for every list on the account, and anyone who has
 * the app's address can register a list.
 */
/** Runs one list holds. GET /api/assignments reads every one (a KV read
 *  each, of the day's 100,000), so a list of thousands would spend the day's
 *  reads in a few loads. The busiest real day has 5 runs; kept for the
 *  longest retention (30 days) that is 150. */
export const MAX_RUNS = 300;
/** Corrections one run holds: each is a key every load of the list is
 *  handed. No real run comes near it. */
export const MAX_PATCHES = 300;
/** New lists a day, from everywhere: each is a write of the day's 1,000. */
export const REGISTER_PER_DAY = 20;

/** An assignment's start and end, New York wall clock: "2026-08-31 21:30". */
export const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
/** Dispatch's assignment number goes into KV keys; digits in every real one. */
export const ASSIGNMENT_NUMBER = /^[A-Za-z0-9-]{1,20}$/;
/** The phone's own id for an edit (base-36 time, a dash, hex). */
export const REF = /^[A-Za-z0-9._-]{1,64}$/;
/** A stored change's id (assignment.ts newPatchId): a stamp, a dash, hex. */
export const PATCH_ID = /^[A-Za-z0-9-]{1,64}$/;

/** A run's number and a change's id are parts of KV keys
 *  (`patch:<list>:<number>:<id>`) on the routes that only name them, too:
 *  never a colon, never past what a key may be, never anything but text. */
export function checkRunKey(body: Json, withId = false): void {
  if (typeof body.number !== "string" || !ASSIGNMENT_NUMBER.test(body.number)) {
    throw new Refusal("number must be the assignment number, like 369736", 400);
  }
  if (withId && (typeof body.id !== "string" || !PATCH_ID.test(body.id))) {
    throw new Refusal("id must be a change's id", 400);
  }
}

/**
 * A list code: text, of a key's shape. Register makes eight hex characters;
 * anything of this shape is looked up, and nothing else ever is. The code is
 * interpolated into KV keys (`list:<code>`, `assign:<code>:<number>`), so a
 * colon would reach into another key's name, a 600-character one is a key KV
 * refuses (a 500), and a JSON number that spells a real list's code was taken
 * as that list while comparing unequal to it everywhere a string was expected
 * (security review, 2026-10-04).
 */
export const LIST_CODE = /^[A-Za-z0-9_-]{4,64}$/;

export function isListCode(v: unknown): v is string {
  return typeof v === "string" && LIST_CODE.test(v);
}

/** A request refused for what it carries: 400 malformed, 413 too big. */
export class Refusal extends Error {
  status: 400 | 413;
  constructor(message: string, status: 400 | 413) {
    super(message);
    this.status = status;
  }
}

/** The body as JSON, refused whole if it is too big, not JSON, or not an
 *  object -- never a 500 from `request.json()`. */
export async function readBody<T>(request: Request, maxBytes = MAX_BODY_BYTES): Promise<T> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new Refusal(`request body too large (max ${Math.round(maxBytes / 1024)} KB)`, 413);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Refusal("malformed JSON", 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Refusal("expected a JSON object", 400);
  }
  return parsed as T;
}

type Json = Record<string, unknown>;

function nullOr(v: unknown, ok: (v: unknown) => boolean): boolean {
  return v === null || v === undefined || ok(v);
}

/** Every string and array in the run, within bounds. */
function checkSizes(v: unknown, path: string, depth: number): void {
  if (depth > 8) throw new Refusal(`${path} is nested too deeply`, 400);
  if (typeof v === "string") {
    const max = path === "driverNotes" ? MAX_NOTES : MAX_STRING;
    if (v.length > max) throw new Refusal(`${path} is too long (max ${max} characters)`, 413);
  } else if (Array.isArray(v)) {
    if (v.length > MAX_ARRAY) throw new Refusal(`${path} has too many items (max ${MAX_ARRAY})`, 413);
    v.forEach((x, i) => checkSizes(x, `${path}[${i}]`, depth + 1));
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) checkSizes(x, path ? `${path}.${k}` : k, depth + 1);
  }
}

/*
 * What each of a run's own fields is. The phones print some of them as they
 * are: a passenger count is added up and shown with no escaping, so a run
 * holding markup for `pax` ran as script on every phone on the list (security
 * review, 2026-10-04). The app's importer only ever sends these types, with
 * null or nothing where the sheet printed nothing; anything else is not the
 * app. A field not named here is nobody's, and is stored unread.
 */
type Kind = "text" | "count" | "flag" | "texts";

const KIND: Record<Kind, [(v: unknown) => boolean, string]> = {
  text: [(v) => typeof v === "string", "text"],
  count: [(v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 999, "a number from 0 to 999"],
  flag: [(v) => typeof v === "boolean", "true or false"],
  texts: [(v) => Array.isArray(v) && v.every((x) => typeof x === "string"), "a list of text"],
};

const RUN_FIELDS: Record<string, Kind> = {
  driver: "text", vehicle: "text", parking: "text", originCode: "text", driverNotes: "text", source: "text",
  gb: "flag", issues: "texts",
};
const ASSISTANT_FIELDS: Record<string, Kind> = { name: "text", role: "text", note: "text" };
const STEP_FIELDS: Record<string, Kind> = { code: "text", place: "text", address: "text", eta: "text", etd: "text" };
const ACTION_FIELDS: Record<string, Kind> = { verb: "text", where: "text" };
const ENTITY_FIELDS: Record<string, Kind> = {
  tag: "text", origin: "text", destination: "text", flightNumber: "text", scheduledText: "text", flightDate: "text",
  appointmentTime: "text", duration: "text", route: "text", phone: "text", note: "text", unsupported: "text",
  pax: "count", bags: "count", gb: "flag", otherPhones: "texts",
};

function checkKinds(host: Json, fields: Record<string, Kind>, where: string): void {
  for (const [field, kind] of Object.entries(fields)) {
    const v = host[field];
    if (v === null || v === undefined) continue;
    const [ok, words] = KIND[kind];
    if (!ok(v)) throw new Refusal(`${where}${field} must be ${words}`, 400);
  }
}

/** A print this far past now is no print of dispatch's: a clock a little
 *  ahead, or a zone read wrong, is well inside it. */
const PRINT_AHEAD_MS = 24 * 3600 * 1000;

/** The newest PRINTED copy of a run wins (assignment.ts isNewerCopy), by its
 *  footer. A footer from the future would outrank every real re-send after
 *  it, so the sheet dispatch sends next would be turned away as the older. */
function checkPrinted(printedAt: unknown, nowMs: number): void {
  if (printedAt === null || printedAt === undefined) return;
  if (typeof printedAt !== "string" || !STAMP.test(printedAt)) {
    throw new Refusal("printedAt must look like 2026-09-25 21:30", 400);
  }
  const [day, time] = printedAt.split(" ");
  const printed = Date.parse(`${day}T${time}:00Z`), now = Date.parse(`${wallNow(nowMs).replace(" ", "T")}:00Z`);
  if (Number.isNaN(printed) || printed > now + PRINT_AHEAD_MS) {
    throw new Refusal("this copy says it was printed in the future", 400);
  }
}

/**
 * Throws a Refusal if an imported run is out of bounds or malformed. Counts
 * before shapes, so a huge body is refused without walking all of it twice.
 */
export function checkAssignment(body: Json, nowMs: number = Date.now()): void {
  const steps = body.steps ?? [];
  if (!Array.isArray(steps)) throw new Refusal("steps must be a list", 400);
  if (steps.length > MAX_STEPS) throw new Refusal(`too many steps (max ${MAX_STEPS})`, 413);
  let entities = 0;
  const flights = new Set<string>();
  steps.forEach((step: Json, s: number) => {
    if (!step || typeof step !== "object") throw new Refusal(`steps[${s}] is not a stop`, 400);
    const actions = step.actions ?? [];
    if (!Array.isArray(actions)) throw new Refusal(`steps[${s}].actions must be a list`, 400);
    if (actions.length > MAX_ACTIONS_PER_STEP) {
      throw new Refusal(`too many actions at one stop (max ${MAX_ACTIONS_PER_STEP})`, 413);
    }
    for (const field of ["date", "etaDate"]) {
      if (!nullOr(step[field], isIsoDate)) throw new Refusal(`steps[${s}].${field} must look like 2026-09-25`, 400);
    }
    checkKinds(step, STEP_FIELDS, `steps[${s}].`);
    actions.forEach((action: Json, a: number) => {
      if (!action || typeof action !== "object") throw new Refusal(`steps[${s}].actions[${a}] is not an action`, 400);
      checkKinds(action, ACTION_FIELDS, `steps[${s}].actions[${a}].`);
      const list = action.entities ?? [];
      if (!Array.isArray(list)) throw new Refusal(`steps[${s}].actions[${a}].entities must be a list`, 400);
      if (list.length > MAX_ENTITIES_PER_ACTION) {
        throw new Refusal(`too many passengers in one action (max ${MAX_ENTITIES_PER_ACTION})`, 413);
      }
      entities += list.length;
      list.forEach((e: Json, i: number) => {
        const where = `steps[${s}].actions[${a}].entities[${i}]`;
        if (!e || typeof e !== "object") throw new Refusal(`${where} is not a passenger`, 400);
        // A row is named by its passenger everywhere: never without one.
        if (typeof e.name !== "string") throw new Refusal(`${where}.name must be text`, 400);
        checkKinds(e, ENTITY_FIELDS, `${where}.`);
        const u = e.unknownAirline as Json | null | undefined;
        if (u !== null && u !== undefined && (typeof u !== "object" || typeof u.name !== "string"
          || typeof u.number !== "string" || !nullOr(u.date, (d) => typeof d === "string"))) {
          throw new Refusal(`${where}.unknownAirline must be an airline's name and number`, 400);
        }
        // A flight number or date of the wrong shape is NOT refused: one
        // misread row must never cost the driver the whole sheet. It is stored
        // and shown, and flightsOf() never tracks it, so it names no KV key.
        if (e.flightNumber) flights.add(`${e.flightNumber}:${e.flightDate ?? step.etaDate ?? step.date}`);
      });
    });
  });
  if (entities > MAX_ENTITIES) throw new Refusal(`too many passengers (max ${MAX_ENTITIES})`, 413);
  if (flights.size > MAX_FLIGHTS) throw new Refusal(`too many flights (max ${MAX_FLIGHTS})`, 413);
  if (typeof body.number !== "string" || !ASSIGNMENT_NUMBER.test(body.number)) {
    throw new Refusal("number must be the assignment number, like 369736", 400);
  }
  for (const field of ["start", "end"]) {
    if (typeof body[field] !== "string" || !STAMP.test(body[field] as string)) {
      throw new Refusal(`${field} must look like 2026-09-25 21:30`, 400);
    }
  }
  checkKinds(body, RUN_FIELDS, "");
  const assistants = body.assistants ?? [];
  if (!Array.isArray(assistants)) throw new Refusal("assistants must be a list", 400);
  assistants.forEach((x: Json, i: number) => {
    if (!x || typeof x !== "object") throw new Refusal(`assistants[${i}] is not a person`, 400);
    checkKinds(x, ASSISTANT_FIELDS, `assistants[${i}].`);
  });
  checkPrinted(body.printedAt, nowMs);
  checkSizes(body, "", 0);
}

/** A string field of a patch, trimmed and cut to length; blank is null. */
export function clip(v: unknown, n = 120): string | null {
  return v === undefined || v === null ? null : String(v).trim().slice(0, n) || null;
}

/** How long each correctable field may be. */
export const FIELD_MAX: Record<string, number> = {
  flightNumber: 12, phone: 40, note: MAX_STRING, where: 120, eta: 12, etd: 12, time: 12, line: 300,
};

/** As the phone types it: "ua 995" is UA995. */
export function normFlight(v: string | null): string | null {
  return v === null ? null : v.replace(/\s+/g, "").toUpperCase() || null;
}

/** The shared travel-time table (token-guarded): hundreds of pairs, not MBs. */
export const MAX_TABLE_BYTES = 1024 * 1024;

const isMinutes = (v: unknown, max: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;

/** Throws a Refusal unless each settings field sent has its type and a sane
 *  range. A field that is no setting (the buffer and the drive times went in
 *  v69: nothing read them) is not looked at, and not stored. */
export function checkSettings(body: Json): void {
  const minutes: [string, number][] = [["checkInLeadMinutes", 600], ["checkInLeadIntlMinutes", 600]];
  for (const [field, max] of minutes) {
    if (body[field] !== undefined && !isMinutes(body[field], max)) {
      throw new Refusal(`${field} must be a number of minutes from 0 to ${max}`, 400);
    }
  }
  if (body.showPassengerNames !== undefined && typeof body.showPassengerNames !== "boolean") {
    throw new Refusal("showPassengerNames must be true or false", 400);
  }
  if (body.retentionDays !== undefined && typeof body.retentionDays !== "number") {
    throw new Refusal("retentionDays must be a number", 400);
  }
}

/** The OKs a list record keeps (ListData.seen): well past every run the
 *  longest retention (30 days) holds. */
export const MAX_SEEN = 200;

/** POST /api/assignments/seen: a run's number and the print of it the driver
 *  read. The number goes into a KV key. */
export function checkSeen(body: Json): void {
  if (typeof body.number !== "string" || !ASSIGNMENT_NUMBER.test(body.number)) {
    throw new Refusal("number must be an assignment number", 400);
  }
  if (typeof body.printedAt !== "string" || !body.printedAt || body.printedAt.length > 40) {
    throw new Refusal("printedAt must be the copy's print time", 400);
  }
}

export const MAX_PLACES = 200;

/** POST /api/places: a code as the notes print it, a name and an address of
 *  sane length (the address is what Maps is given, so it must be there). */
export function checkPlace(body: Json): void {
  if (typeof body.code !== "string" || !/^[A-Z0-9]{2,8}$/.test(body.code)) {
    throw new Refusal("code must be 2 to 8 capital letters or digits", 400);
  }
  if (body.remove !== undefined && typeof body.remove !== "boolean") {
    throw new Refusal("remove must be true or false", 400);
  }
  if (body.remove) return;
  if (body.name !== undefined && body.name !== null && typeof body.name !== "string") {
    throw new Refusal("name must be text", 400);
  }
  if (typeof body.address !== "string" || !body.address.trim()) {
    throw new Refusal("address is required", 400);
  }
  if (String(body.name ?? "").length > 80 || body.address.length > 200) {
    throw new Refusal("name is at most 80 characters, address 200", 413);
  }
}

export const MAX_AIRLINES = 100;

/** POST /api/airlines: an airline's name as a sheet printed it, and the
 *  two-character code a driver said it is (letters or digits, one letter at
 *  least: WS, B6, 9W). */
export function checkAirline(body: Json): void {
  if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 60) {
    throw new Refusal("name must be the airline as the sheet prints it (at most 60 characters)", 400);
  }
  if (body.remove !== undefined && typeof body.remove !== "boolean") {
    throw new Refusal("remove must be true or false", 400);
  }
  if (body.remove) return;
  if (typeof body.code !== "string" || !/^(?=.*[A-Z])[A-Z0-9]{2}$/.test(body.code)) {
    throw new Refusal("code must be the airline's two-character code, like WS", 400);
  }
}

const KINDS = ["field", "remove", "addEntity", "addStep", "addLeg"];

/** Throws a Refusal for a patch POST that is malformed before it is aimed:
 *  a ref that is not an edit id, an unknown kind, a value that is not text,
 *  or a flight number that is not one. */
export function checkPatch(body: Json): void {
  if (body.ref !== undefined && body.ref !== null && (typeof body.ref !== "string" || !REF.test(body.ref))) {
    throw new Refusal("ref is not an edit id", 400);
  }
  const kind = body.kind ?? "field";
  if (typeof kind !== "string" || !KINDS.includes(kind)) throw new Refusal(`unknown kind "${String(kind)}"`, 400);
  for (const field of ["value", "was", "by", "label", "field", "at", "basis"]) {
    const v = body[field];
    if (v !== undefined && v !== null && typeof v !== "string") throw new Refusal(`${field} must be text`, 400);
  }
  if (kind === "field" && body.field === "flightNumber") {
    const v = normFlight(clip(body.value, FIELD_MAX.flightNumber));
    if (v !== null && !isFlightNumber(v)) throw new Refusal("a flight number looks like UA995", 400);
  }
  if (kind === "addEntity") {
    const e = body.entity as Json | undefined;
    if (!e || typeof e !== "object") throw new Refusal("a passenger needs a name", 400);
    const v = normFlight(clip(e.flightNumber, FIELD_MAX.flightNumber));
    if (v !== null && !isFlightNumber(v)) throw new Refusal("a flight number looks like UA995", 400);
  }
  if (kind === "addLeg" && (!body.leg || typeof body.leg !== "object" || typeof (body.leg as Json).line !== "string")) {
    throw new Refusal("a leg starts with its time, then what happens", 400);
  }
  if (kind === "addStep" && (!body.step || typeof body.step !== "object")) {
    throw new Refusal("a stop needs a place, a date and the time you reach it", 400);
  }
}
