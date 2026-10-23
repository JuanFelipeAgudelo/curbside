export interface Env {
  FLIGHT_DATA: KVNamespace;
  AERODATABOX_KEY: string;
  /** Guards writes to SHARED keys -- the ones that are one table for everybody
   *  and so cannot be protected by a list code the way a person's own data is.
   *  Optional in the type because a fresh deploy has not set it yet; the check
   *  fails closed, so "unset" means "refuse writes", never "allow them". */
  WRITE_TOKEN?: string;
  /** Workers rate-limit bindings ([[ratelimits]] in wrangler.toml), keyed by
   *  client address. Optional: absent in the tests and wherever the binding
   *  is not configured, and then nothing is limited (they fail open). */
  API_LIMITER?: RateLimit;
  REGISTER_LIMITER?: RateLimit;
  /** The owner's ntfy topic, for "new feedback" pushes (never the text).
   *  Unset: feedback is still kept, and nobody is told. */
  FEEDBACK_TOPIC?: string;
  /** An ntfy.sh access token (v65). Unset, pushes go anonymously, and ntfy
   *  limits those per IP address: Cloudflare's, shared by every Worker, whose
   *  daily quota other people use up. Set, the token's plan limits apply. */
  NTFY_TOKEN?: string;
  /** Web Push (v66, webpush.ts): the server's own P-256 key pair, base64url.
   *  A phone subscribes with the public half (it travels with the runs as
   *  `pushKey`), and every push is signed with the private half. Without
   *  both, no phone can turn alerts on in the app and all go by ntfy. */
  VAPID_PUBLIC?: string;
  VAPID_PRIVATE?: string;
  /** Who a push service may contact about these pushes: a URL or a mailto:.
   *  Unset, the app's own address. */
  VAPID_SUBJECT?: string;
}

/** A flight's identity: its number and its day. Everything that touches the
 *  shared status and trackers records takes this. */
export interface FlightRef {
  flightNumber: string;
  date: string;
}

// The list-wide choices. Density and theme are deliberately NOT here — those
// are per-device (a dispatcher's tablet and a driver's phone can share a list
// code and want different views).
// Defaults follow the department's own written guidelines rather than being
// invented here — see docs/spec-assignments.md for the quoted rules.
//
// The buffer and the per-place drive times of the old flat list went in v69:
// nothing had read them since its routes went (2026-10-04). The buffer is
// HuB's own figure in notify.ts, and a drive time is the sheet's ETD-to-ETA
// gap. A list that stored them still loads: resolveSettings leaves them out.
export interface ListSettings {
  // Departures only: how early the passenger must be at the terminal.
  //   "Domestic: Passengers should arrive at least 2 hours before their flight
  //    departs / International: ...at least 3 hours"
  // The same manual ALSO quotes TSA Pre-Check guidance of 1.5h and 2h, and
  // those are the numbers this app shipped with by mistake — they are a
  // qualifier for passengers who hold Pre-Check, not the rule. Only 4 of 186
  // real assignments mention Pre-Check at all, so the document almost never
  // tells us, and the default has to be the longer lead: guessing Pre-Check
  // makes the driver leave late, which is the one error that misses a flight.
  checkInLeadMinutes: number; // domestic
  checkInLeadIntlMinutes: number;
  showPassengerNames: boolean;
  // Days a run is kept after it ends: 2, 7, 14 or 30 (retention.ts).
  retentionDays: number;
  // The list's own places: codes the notes use that no sheet gives an address
  // for (a shuttle's CLN, SGA), added by the drivers. The route in Maps reads
  // them before the sheet (spec "Route in Maps"). POST /api/places, by code.
  places: Place[];
  // Airlines the list learned from a driver's fix: a name the importer could
  // not turn into a code ("WestJet" is WS). Filled into later sheets when
  // read, marked as learned, never into the stored run (learned.ts).
  // POST /api/airlines, by name.
  airlines: LearnedAirline[];
}

export interface LearnedAirline {
  name: string; // as a sheet printed it: "WestJet"
  code: string; // its IATA code: "WS"
}

export interface Place {
  code: string;    // as the notes print it, upper case: "SGA"
  name: string;    // "Stonegate Apartments"; may be ""
  address: string; // what Maps is given
}

// Values the app previously shipped as defaults, before the department's
// manuals were consulted. A list still carrying one of these never chose it —
// it inherited a guess — so it is upgraded to the documented figure on read.
// Anything else is a deliberate choice by the owner and is left alone.
export const SUPERSEDED_DEFAULTS: Partial<Record<keyof ListSettings, number>> = {
  // The Pre-Check figures, which this app wrongly shipped as the defaults for
  // every passenger. A list still carrying them inherited a mistake rather than
  // choosing a shorter lead, so it is upgraded to the department's general rule.
  checkInLeadMinutes: 90,
  checkInLeadIntlMinutes: 120,
};

/** What a list saved before v69 may still hold, and nothing reads. */
const RETIRED_SETTINGS = ["bufferMinutes", "driveMinutes"];

/** Fills in defaults, replaces values that were only ever an old default, and
 *  leaves out the settings that are gone: the list's next save drops them. */
export function resolveSettings(stored?: ListSettings): ListSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  for (const key of RETIRED_SETTINGS) delete (merged as Record<string, unknown>)[key];
  for (const [key, superseded] of Object.entries(SUPERSEDED_DEFAULTS)) {
    const k = key as keyof ListSettings;
    if (merged[k] === superseded) {
      (merged as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
    }
  }
  return merged;
}

export const DEFAULT_SETTINGS: ListSettings = {
  checkInLeadMinutes: 120, // 2h domestic
  checkInLeadIntlMinutes: 180, // 3h international
  showPassengerNames: true,
  retentionDays: 7,
  places: [],
  airlines: [],
};

// One private per-person list, keyed by an opaque list code the client holds
// in localStorage.
export interface ListData {
  /** Legacy, never read: the jobs of the old flat list (the retired flight UI;
   *  its routes, /api/flights and /api/history, went 2026-10-04). A new list
   *  gets an empty one; what an old list holds rides through every save. */
  flights: unknown[];
  settings?: ListSettings;
  /** The list's ntfy topic: its own random secret, never derived from the
   *  code. Given on registration, or on first use for a list made before. */
  topic?: string;
  /** Run number -> the print of it whose changes the list has seen (OK on
   *  WHAT DISPATCH CHANGED; POST /api/assignments/seen, changes.ts). One OK
   *  for every phone on the list. */
  seen?: Record<string, string>;
}

export interface FlightLeg {
  airport: string;
  airportCode: string | null; // IATA, e.g. "HPN"
  // ISO 3166, e.g. "US". Absent on statuses stored before 2026-09-27.
  countryCode?: string | null;
  timeZone: string | null; // IANA, e.g. "America/New_York"
  scheduledTime: string | null;
  estimatedTime: string | null;
  scheduledTimeUtc: string | null; // ISO instant, for real time-math (countdowns etc.)
  estimatedTimeUtc: string | null;
  terminal: string | null;
  gate: string | null;
  // Arriving flights only, and null where the airport doesn't publish it.
  baggageBelt: string | null;
}

export interface FlightStatus {
  flightNumber: string;
  date: string;
  status: string; // e.g. "Scheduled", "Delayed", "Cancelled", "Landed"
  airline: string | null; // e.g. "JetBlue Airways"
  departure: FlightLeg;
  arrival: FlightLeg;
  fetchedAt: string;
}

export function flightKey(flight: FlightRef): string {
  return `flight:${flight.flightNumber}:${flight.date}`;
}

// Reverse index: which list codes are currently tracking this flight, so cron
// can route notifications without scanning every list on every poll.
export function trackersKey(flight: FlightRef): string {
  return `${flightKey(flight)}:trackers`;
}

// Where an older Worker kept a flight's change lines, for the retired flight
// UI. Nothing writes or reads one now: the key is named only so that an old
// one is deleted with its flight.
export function historyKey(flight: FlightRef): string {
  return `${flightKey(flight)}:history`;
}

/** When cron should next spend a unit on this flight. Deliberately its OWN key
 *  rather than a field on the shared poll set: cron would otherwise rewrite that
 *  whole array on every tick, and with no compare-and-swap in KV a concurrent
 *  add would be silently dropped from polling. Cron now only READS the poll set.
 *  An absent value means due — a flight whose schedule failed to compute must
 *  cost a unit, never go unpolled. */
export function scheduleKey(flight: FlightRef): string {
  return `${flightKey(flight)}:sched`;
}

/** The status the driver's clocks were last pushed from. A clock shift is
 *  measured from it, not from the previous poll, so an estimate creeping a few
 *  minutes a poll adds up until it is worth saying. */
export function toldKey(flight: FlightRef): string {
  return `${flightKey(flight)}:told`;
}

export function listKey(code: string): string {
  return `list:${code}`;
}

// The list's stamp: a fresh value on every write GET /api/assignments would
// show, so a phone asks "anything new?" for one read and no list (index.ts
// `bump`, GET /api/stamp).
export function stampKey(code: string): string {
  return `stamp:${code}`;
}

// The ntfy topic is a second secret, not the list code: pushes live on public
// ntfy.sh, and a topic derived from the code made anyone who could read them
// able to read, edit and delete the list (review B4; the owner, 2026-09-26).
// 12 random bytes, so it cannot be guessed from the code or from another topic.
export function newTopic(randomHex: (bytes: number) => string): string {
  return `curbside-${randomHex(12)}`;
}

// The set cron polls: ONE KEY PER FLIGHT, listed by prefix.
//
// This used to be a single `all-tracked-flights` key holding the whole array,
// which every add and every remove rewrote via read-modify-write. Workers KV
// has no compare-and-swap and its reads are eventually consistent, so two adds
// close together can both read the same array and the second write silently
// drops the first — the flight stays on the user's list, shows the status from
// its add-time fetch, and is never polled again. Nothing surfaces the loss.
//
// A key per flight removes the shared write entirely: an add is one put, a
// remove is one delete, and they cannot interfere. Cron lists the prefix
// instead of reading an array.
export const POLL_PREFIX = "poll:";

export function pollKey(flight: FlightRef): string {
  return `${POLL_PREFIX}${flight.flightNumber}:${flight.date}`;
}

/** The inverse of pollKey. A flight number never contains ":", and the date is
 *  always the final segment, so splitting on the LAST colon is unambiguous. */
export function flightFromPollKey(key: string): FlightRef | null {
  const rest = key.startsWith(POLL_PREFIX) ? key.slice(POLL_PREFIX.length) : key;
  const at = rest.lastIndexOf(":");
  if (at <= 0 || at === rest.length - 1) return null;
  return { flightNumber: rest.slice(0, at), date: rest.slice(at + 1) };
}

/** The retired shared key. Read once on the next cron tick to migrate whatever
 *  it still holds into per-flight keys, then deleted. */
export const ALL_TRACKED_KEY = "all-tracked-flights";
