/**
 * The assignment model: what dispatch actually sends, kept whole.
 *
 * The old model flattened an assignment into a list of jobs, which destroys the
 * itinerary. In real assignment 369736 a passenger appears twice -- once at the
 * LGA pickup and once at their own Wallkill drop-off -- and a flat list can only
 * hold one of them. That second appearance is not a duplicate; it is the other
 * half of the work.
 *
 * Four levels, taken from the owner's own markup of the assignment sheet:
 *
 *   Assignment   the run: number, window, vehicle, parking, driver, assistants
 *   └─ Step      a place and a time. The grey bar.
 *      └─ Action what happens there -- Pickup or Drop-off, and where exactly.
 *         └─ Entity  who, and what they are travelling on. The black bar's rows.
 */

/** UA995, B6123, WN748, AC8877, LH7603: a 2-3 character airline code, 1-4
 *  digits, an optional suffix letter. No spaces (the phone strips them), no
 *  colons: a flight's number and date are interpolated into KV keys
 *  (`flight:<number>:<date>:trackers`) and the AeroDataBox URL, and a date of
 *  "2026-10-01:trackers" would otherwise name another flight's tracker index
 *  (security review B3, 2026-09-25). */
export const FLIGHT_NUMBER = /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isFlightNumber(v: unknown): v is string {
  return typeof v === "string" && FLIGHT_NUMBER.test(v);
}

export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && ISO_DATE.test(v);
}

/** A flight identity safe to build KV keys and API URLs from. */
export function isFlightRef(f: { flightNumber?: unknown; date?: unknown } | null | undefined): boolean {
  return Boolean(f) && isFlightNumber(f!.flightNumber) && isIsoDate(f!.date);
}

/** A passenger, or a party travelling together. */
export interface Entity {
  /** Display name. A party is one entity: "Hauser, Marcus & Vera". */
  name: string;
  /** How many people this row represents. 1 unless it is a party. */
  pax: number;
  /** Where they are coming from and going to, as the row itself states them. */
  origin?: string | null;
  destination?: string | null;

  /** Airport rows. Resolved to an IATA-prefixed number, or null when the
   *  airline could not be resolved -- never guessed. */
  flightNumber?: string | null;
  /** The scheduled time and city as printed, kept even when the flight number
   *  could not be resolved, because it is still useful to a driver. */
  scheduledText?: string | null;
  /** The date the flight itself operates, pinned at import to the AIRPORT step.
   *  A passenger appears at two steps -- the airport and their own door -- and
   *  once those fall on different days, keying on the enclosing step tracked
   *  the same flight twice, on two dates, with half of it never resolving. */
  flightDate?: string | null;
  /** When the airline's name was one the importer has no code for: the name
   *  and the number as printed ("WestJet", "1680"), and the date the flight
   *  would be tracked on. A code the list learned fills it in (learned.ts). */
  unknownAirline?: { name: string; number: string; date?: string | null } | null;

  /** Fixed-time rows: medical appointments, embassy arrivals. */
  appointmentTime?: string | null;
  duration?: string | null;
  /** Shuttle rows. */
  route?: string | null;

  /** The passenger's number, as printed. Operationally required: assignments
   *  arrive at 5pm and the driver must reach every passenger before 9pm the
   *  night before, then again from the kerb until they are in the car.
   *
   *  Null is a real and common value -- 61 of 411 entities in the sample have
   *  none, and 29 of those have a `Phone:` label printed with nothing after it.
   *  The UI should say there is no number rather than show an empty space,
   *  because the driver still has to reach them somehow. */
  phone?: string | null;
  /** A party's other members' numbers, when they printed different ones.
   *  Shown as more links; corrections still target `phone`. */
  otherPhones?: string[];

  bags?: number | null;
  /** Per-passenger note. 76 across the sample, and they change the work:
   *  "I will be bringing a small cart with me", "Cell is WhatsApp#". */
  note?: string | null;

  /** The row's own tag: A, D, GBA, GBD, MED, S, TD, HO. */
  tag?: string | null;
  /** True for GBA/GBD. Governing Body runs have their own rules -- curbside is
   *  permitted, they are never combined without oversight, and they should
   *  reach the driver soonest. */
  gb?: boolean;
  /** Set when the row type is not yet supported (TD, HO), so it is visible as
   *  an unsupported row rather than silently missing. */
  unsupported?: string | null;
}

export interface Action {
  /** "Pickup" or "Drop-off". Others may exist; this is not a closed set. */
  verb: string;
  /** Where at the place -- "Baggage Claim", "A Front", "Curbside". Dispatch
   *  genuinely leaves this blank sometimes (24 across the sample), so null is a
   *  real value and the UI says so rather than showing a gap. */
  where?: string | null;
  entities: Entity[];
}

export interface Step {
  /** The site code where it is one ("WRK", "EWR"), else null. 28 assignments
   *  have a stop named in free text ("Dispatch", "Enterprise Rent"), and using
   *  those as a drive-time key looks up nothing. */
  code?: string | null;
  /** Always present: the place as printed. */
  place: string;
  address?: string | null;
  /** Wall-clock as printed. A first step has no eta; a last step has no etd. */
  eta?: string | null;
  etd?: string | null;
  /** Resolved calendar date of the DEPARTURE (etd), walked forward across
   *  midnight. The itinerary is ordered by this. */
  date: string; // YYYY-MM-DD
  /** Resolved date of the ARRIVAL (eta), which is not always the same day.
   *  LGA in 369736 is reached at 11:00 PM and left at 12:00 AM, so its eta is
   *  the 31st and its etd the 1st. Anything about arriving -- a flight's date
   *  above all -- must use this, or the flight is tracked a day out and never
   *  resolves. */
  etaDate?: string; // YYYY-MM-DD
  actions: Action[];
}

export interface Assistant {
  name: string;
  role?: string | null;
  note?: string | null;
}

export interface Assignment {
  /** IDENTITY. The same number updates in place; a different number is a new
   *  assignment. The helper receives the same run under the same number, so the
   *  driver is deliberately NOT part of identity. */
  number: string;

  /** Wall-clock window. `start` is dispatch's own departure time -- they have
   *  already done that calculation, so the app's leave-by is a cross-check
   *  rather than a replacement. `end` is when the driver should be back at the
   *  start site. */
  start: string; // "YYYY-MM-DD HH:MM"
  end: string;

  driver?: string | null;
  /** Vehicle id and description, present in 183 of 186 real assignments, and
   *  what the driver needs when collecting it. */
  vehicle?: string | null;
  /** Parking space as printed, e.g. "FKL-NBD-003". */
  parking?: string | null;
  /** The three-letter prefix of the parking space: where the day starts. The
   *  start really varies -- Warwick 107 times, Fishkill 37 -- and Warwick to
   *  Newark is 75 minutes where Fishkill to Newark is 90. */
  originCode?: string | null;

  /** Free text, often several lines, sometimes a whole timed itinerary. */
  driverNotes?: string | null;
  assistants?: Assistant[];

  steps: Step[];

  /** True when any row is GBA/GBD. */
  gb?: boolean;
  /** Anything the importer could not do, surfaced rather than swallowed: an
   *  unresolved airline, an unsupported row type, a date that disagrees with
   *  the document's own end date. */
  issues?: string[];

  /** The page-footer timestamp: when dispatch printed this copy. Re-sends do
   *  not always arrive in order, so this -- not arrival -- decides which copy
   *  wins. */
  printedAt?: string | null;
  /** When this copy was imported. */
  importedAt: string;
  source?: string | null;
}

/**
 * The department's approved travel times, as an origin-aware matrix.
 *
 * Keyed "ORIGIN>DEST" in minutes. This is HuB's own table -- the one the
 * manuals mean by "always consult HuB for approved travel times" -- and it
 * lives in KV rather than in the repository for two reasons: the repository is
 * public and this is internal operational data, and a table that changes when
 * the department changes it should not need a deploy.
 *
 * Precedence, and note that step 2 is a SUGGESTION rather than a substitution:
 *   1. the assignment's own ETD-to-ETA gap   dispatch's plan for THIS run -- used
 *   2. no usable leg in the document         leave it EMPTY; offer this table to
 *                                            the driver as a pre-filled value,
 *                                            labelled as coming from the table
 *   3. not in the table either               empty, and the driver says
 *
 * The table is never written into a record on its own. A table value that lands
 * there unlooked-at is indistinguishable, a week later, from one dispatch
 * actually specified -- and applying it is the app deciding. A suggestion the
 * driver accepts is the driver's number; one the app applies is the app's.
 *
 * Checked against times derived from real schedules: of 25 comparable pairs,
 * 15 matched exactly. The rest differ by about a quarter hour, which is the
 * gap between what was scheduled on a particular day and what the standard
 * allows -- so the document still wins when there is one.
 */
export const TRAVEL_TIMES_KEY = "travel-times";

/** The copy displaced by the last write, kept for exactly one step of undo.
 *
 *  A write replaces the whole table, and the realistic accident is not an
 *  attacker but a wrong file: a stale export, the wrong workbook, a script
 *  pointed at last quarter's copy. Without this, that mistake is permanent and
 *  the only way back is to find the original spreadsheet again. One key is a
 *  cheap answer to the likeliest failure. */
export const TRAVEL_TIMES_PREV_KEY = "travel-times:prev";

export interface TravelTimes {
  source?: string;
  pairs: Record<string, number>;
}

export function travelMinutes(
  table: TravelTimes | null,
  origin?: string | null,
  dest?: string | null
): number | null {
  if (!table || !origin || !dest) return null;
  const direct = table.pairs[`${origin}>${dest}`];
  if (typeof direct === "number") return direct;
  // The matrix is close to symmetric; the reverse leg is a better answer than
  // none, and is never averaged with anything.
  const back = table.pairs[`${dest}>${origin}`];
  return typeof back === "number" ? back : null;
}

/** One key per assignment, under the owning list. Deliberately not a field on
 *  the list record: an assignment is a large object and a day holds several, so
 *  a shared blob would be rewritten constantly -- the same read-modify-write
 *  hazard that cost the poll set its writes. */
export const ASSIGN_PREFIX = "assign:";

export function assignmentKey(listCode: string, number: string): string {
  return `${ASSIGN_PREFIX}${listCode}:${number}`;
}

export function assignmentPrefixFor(listCode: string): string {
  return `${ASSIGN_PREFIX}${listCode}:`;
}

/**
 * Manual corrections, one KV key each.
 *
 * NOT an array on the assignment and not one blob per list: KV has no
 * compare-and-swap, so a shared array loses concurrent writes -- the same
 * read-modify-write hazard that cost the poll set its writes, documented above.
 * One key per patch means a driver and their helper can never clobber one
 * another.
 *
 *   patch:<listCode>:<number>:<at>-<rand>
 *
 * `at` is a fixed-width sortable UTC stamp written by the SERVER, so listing
 * the prefix returns the log already in order and no counter is needed. Server
 * rather than client because a phone with a skewed clock would otherwise wedge
 * a patch into the middle of the log permanently.
 */
export const PATCH_PREFIX = "patch:";

export function patchPrefixFor(listCode: string, number?: string): string {
  return number
    ? `${PATCH_PREFIX}${listCode}:${number}:`
    : `${PATCH_PREFIX}${listCode}:`;
}

export function patchKey(listCode: string, number: string, id: string): string {
  return `${patchPrefixFor(listCode, number)}${id}`;
}

/** Sortable and unique: the stamp orders the log, the suffix breaks ties when
 *  two devices write in the same millisecond. */
export function newPatchId(rand: string): string {
  return `${new Date().toISOString().replace(/[-:.]/g, "")}-${rand}`;
}

export function numberFromAssignmentKey(key: string): string | null {
  const at = key.lastIndexOf(":");
  return at > 0 && at < key.length - 1 ? key.slice(at + 1) : null;
}

/**
 * Which copy of an assignment to keep.
 *
 * Latest wins by the PRINTED footer, not by arrival: a re-send can reach the
 * driver after a newer copy, and the footer is the only reliable clock in the
 * document. A copy with no footer never displaces one that has a readable date.
 */
export function isNewerCopy(incoming: Assignment, existing: Assignment | null): boolean {
  if (!existing) return true;
  if (!incoming.printedAt) return false;
  if (!existing.printedAt) return true;
  return incoming.printedAt > existing.printedAt;
}

/** A row the driver marked "not happening" (patch.ts). Only ever on a copy
 *  read with patches applied; the stored record never carries it. */
export function removed(host: object): boolean {
  return Boolean((host as { _removed?: unknown })._removed);
}

/** Every entity in an assignment, flattened — for counting and for finding the
 *  flights that need tracking. */
export function entitiesOf(assignment: Assignment): Entity[] {
  return assignment.steps.flatMap((s) => s.actions.flatMap((a) => a.entities));
}

/** The flights an assignment needs polled. Deduped: a passenger appears at both
 *  their pickup and their drop-off, and that is one flight, not two. */
export function flightsOf(assignment: Assignment): { flightNumber: string; date: string }[] {
  const seen = new Set<string>();
  const out: { flightNumber: string; date: string }[] = [];
  for (const step of assignment.steps) {
    // Not happening, on the driver's word: polling it spends quota on nothing.
    if (removed(step)) continue;
    // A flight belongs to the day it ARRIVES, which is not always the day the
    // driver leaves that stop. Using step.date here tracked an overnight
    // flight a day out, and a flight tracked on the wrong date never resolves
    // and never says why.
    const stepDate = step.etaDate ?? step.date;
    for (const action of step.actions) {
      for (const entity of action.entities) {
        if (!entity.flightNumber || removed(entity)) continue;
        // The flight's own date, pinned at import to the airport step. Falling
        // back to the enclosing step is what caused one flight to be tracked
        // as two.
        const date = entity.flightDate ?? stepDate;
        // Its number and date become KV keys and an AeroDataBox URL; a
        // malformed one is displayed but never tracked (review B3).
        if (!isFlightRef({ flightNumber: entity.flightNumber, date })) continue;
        const key =`${entity.flightNumber}:${date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ flightNumber: entity.flightNumber, date });
      }
    }
  }
  return out;
}
