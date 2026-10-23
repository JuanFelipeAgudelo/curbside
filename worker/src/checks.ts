/**
 * Flight checks on the free AeroDataBox plan (the owner, 2026-09-28: "keep it
 * free"). The plan is 400 units a month, a hard limit, and a flight lookup is
 * a Tier 2 call: 2 units, so 200 lookups a month for every driver together.
 *
 * So each flight gets only the checks that can change what the driver does:
 *   arrival    ~3h before landing   a delay or a cancellation before you leave
 *              ~45m before landing  the new time and the terminal, on the way
 *              ~15m after landing   landed, and the belt
 *   departure  ~3h before take-off  the terminal, or a cancellation. A later
 *              departure never moves the drop-off (the check-in deadline counts
 *              from the EARLIER of scheduled and estimated), so no more.
 * The first check is planned from the sheet's own printed time, so importing a
 * run costs nothing.
 *
 * And a budget: the worker counts what it spends and never runs into the hard
 * limit. Near the end of the month only the check before landing is made; at
 * the end, none, and the app says "flight checks paused until …".
 *
 * Everything here is pure; index.ts does the KV and the fetching.
 */

import type { Assignment } from "./assignment";
import { isFlightRef, removed } from "./assignment";
import type { FlightStatus } from "./types";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

export type Rung = "first" | "a3h" | "a45" | "a15" | "d3h";

/** Whose arrival or departure the flight is, from the sheet's tag (A / GBA,
 *  D / GBD), and the time the sheet printed for it. KV metadata on the flight's
 *  poll key: listing the poll set returns it for free. */
export interface CheckMeta {
  r: "a" | "d";
  t: string | null; // ISO instant of the sheet's printed time, or null
}

/** The flight's schedule key holds the plan: the next check, and the checks
 *  already made or skipped. The legacy values (an ISO instant, "done") are
 *  re-planned on sight. */
export interface Plan {
  at: string;
  rung: Rung;
  done: Rung[];
  miss?: number; // lookups in a row that found nothing
  /** A tick found no run meeting the flight when this check came due, and
   *  left it due: the tick after passes the check without a lookup, unless a
   *  run meets the flight again by then (index.ts tick, v69). */
  unmet?: 1;
}
export const DONE = "done";

const RUNGS: Record<Exclude<Rung, "first">, { leg: "arr" | "dep"; offset: number }> = {
  a3h: { leg: "arr", offset: -3 * HOUR },
  a45: { leg: "arr", offset: -45 * MIN },
  a15: { leg: "arr", offset: 15 * MIN },
  d3h: { leg: "dep", offset: -3 * HOUR },
};
const ARRIVAL: Rung[] = ["a3h", "a45", "a15"];
const DEPARTURE: Rung[] = ["d3h"];
// A check is not worth making when the next one is this close: imported an
// hour before landing, the 3h check is skipped for the 45m one. Under the hour
// between the 45m and after-landing checks, even with the cron 20 min late.
const SUPERSEDE_MS = 40 * MIN;
// How late the after-landing check may still be made (a late cron, a delay).
const LATE_MS = 2 * HOUR;
// Lookups in a row that find nothing (a wrong number, an API error) before
// the flight is given up on: every one of them is spent from the same 200.
export const MAX_MISSES = 2;

export interface Anchors {
  role: "a" | "d";
  arr: number | null; // landing, ms
  dep: number | null; // take-off, ms
}

/** The times to plan from: AeroDataBox's latest estimate when there is one,
 *  otherwise the sheet's printed time. */
export function anchorsOf(meta: CheckMeta | null | undefined, status: FlightStatus | null): Anchors {
  const role = meta?.r ?? "a";
  const ms = (iso: string | null | undefined) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(t) ? null : t;
  };
  const sheet = ms(meta?.t);
  const arr = ms(status?.arrival.estimatedTimeUtc || status?.arrival.scheduledTimeUtc);
  const dep = ms(status?.departure.estimatedTimeUtc || status?.departure.scheduledTimeUtc);
  return {
    role,
    arr: arr ?? (role === "a" ? sheet : null),
    dep: dep ?? (role === "d" ? sheet : null),
  };
}

/** The next check for a flight, or DONE when nothing more is worth a unit. */
export function planNext(anchors: Anchors, done: Rung[], now: number, miss = 0): Plan | typeof DONE {
  if (miss >= MAX_MISSES) return DONE;
  const ladder = anchors.role === "d" ? DEPARTURE : ARRIVAL;
  // A check before one already made is passed too: a delay can put the 3h
  // mark back in the future, and that is not a reason to go back for it.
  const reached = Math.max(-1, ...done.map((r) => ladder.indexOf(r)));
  const live = ladder
    .slice(reached + 1)
    .map((r) => {
      const { leg, offset } = RUNGS[r as keyof typeof RUNGS];
      const event = leg === "arr" ? anchors.arr : anchors.dep;
      return { r, event, at: event === null ? null : event + offset };
    });
  if (live.some((x) => x.event === null)) {
    // No time to plan from, sheet or API: one lookup to learn it.
    return done.includes("first") ? DONE : { at: iso(now), rung: "first", done, miss };
  }
  const open = live.filter((x) => {
    // Before the event, or (after landing) within the late window.
    if (x.r === "a15") return now <= x.at! + LATE_MS;
    return now < x.event!;
  });
  const skipped: Rung[] = [];
  for (let i = 0; i < open.length; i++) {
    const next = open[i + 1];
    if (next && next.at! < now + SUPERSEDE_MS) { skipped.push(open[i].r); continue; }
    return { at: iso(Math.max(open[i].at!, now)), rung: open[i].r, done: [...done, ...skipped], miss };
  }
  return DONE;
}

/** The schedule key's value, read back. Legacy values need a re-plan. */
export function readPlan(raw: string | null): Plan | typeof DONE | null {
  if (raw === DONE) return DONE;
  if (!raw || raw[0] !== "{") return null;
  try {
    const p = JSON.parse(raw) as Plan;
    return typeof p.at === "string" && typeof p.rung === "string" && Array.isArray(p.done) ? p : null;
  } catch { return null; }
}

export function writePlan(plan: Plan | typeof DONE): string {
  return plan === DONE ? DONE : JSON.stringify(plan);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/* ------------------------------------------------------------ the budget -- */

export const MONTHLY_UNITS = 400;
export const UNITS_PER_LOOKUP = 2;
// Below this, only the check before landing: it is the one that says where
// and when to stand. 60 units is 30 of them.
export const RESERVE_UNITS = 60;
// Below this, none: the hard limit is never touched.
export const STOP_UNITS = 4;

/** What has been spent this period. `remaining` / `resetAt` are RapidAPI's
 *  own figures when its answer carried them (they win over the count). */
export interface Budget {
  period: string;          // "2026-09": the month the count is for
  spent: number;           // units, counted here
  remaining?: number | null;
  resetAt?: string | null; // when RapidAPI's month turns, if it said
}

export type CheckState = "ok" | "low" | "paused";

function monthOf(now: number): string {
  return iso(now).slice(0, 7);
}

/** The budget for now: a new month (RapidAPI's, when it said when; else the
 *  calendar's) starts from nothing. */
export function currentBudget(stored: Budget | null, now: number): Budget {
  const fresh = { period: monthOf(now), spent: 0, remaining: null, resetAt: null };
  if (!stored) return fresh;
  if (stored.resetAt) return now >= Date.parse(stored.resetAt) ? fresh : stored;
  return stored.period === monthOf(now) ? stored : fresh;
}

export function unitsLeft(b: Budget): number {
  const counted = MONTHLY_UNITS - b.spent;
  return typeof b.remaining === "number" ? Math.min(b.remaining, counted) : counted;
}

export function checkState(b: Budget): CheckState {
  const left = unitsLeft(b);
  return left < STOP_UNITS + UNITS_PER_LOOKUP ? "paused" : left < RESERVE_UNITS ? "low" : "ok";
}

/** When checks start again: RapidAPI's reset when it said, else the 1st. */
export function pausedUntil(b: Budget): string {
  if (b.resetAt) return b.resetAt;
  const [y, m] = b.period.split("-").map(Number);
  return iso(Date.UTC(y, m, 1));
}

/** Which of the due checks may be made, in order, spending as it goes so a
 *  tick with many due never overshoots. Before-landing checks go first. */
export function allowChecks(b: Budget, rungs: Rung[]): boolean[] {
  let left = unitsLeft(b);
  const order = rungs.map((r, i) => ({ r, i })).sort((x, y) => Number(y.r === "a45") - Number(x.r === "a45"));
  const out = rungs.map(() => false);
  for (const { r, i } of order) {
    if (left - UNITS_PER_LOOKUP < STOP_UNITS) break;
    if (left < RESERVE_UNITS && r !== "a45") continue;
    out[i] = true;
    left -= UNITS_PER_LOOKUP;
  }
  return out;
}

/** RapidAPI's quota headers, whatever it calls them this year: the units
 *  remaining and the seconds until they reset. */
export function quotaFrom(headers: Headers, now: number): { remaining?: number; resetAt?: string } {
  const out: { remaining?: number; resetAt?: string } = {};
  headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (!n.includes("ratelimit") || !n.includes("unit")) return;
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    if (n.endsWith("remaining")) out.remaining = v;
    else if (n.endsWith("reset")) out.resetAt = iso(now + v * 1000);
  });
  return out;
}

/** What the app is told: the state, and for Settings the lookups left this
 *  month (every driver's, one pool) and when they renew. `until` only when
 *  paused, as before v65. */
export function checksView(b: Budget): { state: CheckState; until?: string; left: number; renews: string } {
  const state = checkState(b);
  const left = Math.max(0, Math.floor(unitsLeft(b) / UNITS_PER_LOOKUP));
  const renews = pausedUntil(b);
  return state === "paused" ? { state, until: renews, left, renews } : { state, left, renews };
}

/* ------------------------------------------------------- the sheet's time -- */

/** Each flight on a run, with whose it is and the time the sheet printed:
 *  the poll key's metadata. Same flights, same order as flightsOf. */
export function checkMetaOf(assignment: Assignment): Map<string, CheckMeta> {
  const out = new Map<string, CheckMeta>();
  for (const step of assignment.steps) {
    if (removed(step)) continue;
    const stepDate = step.etaDate ?? step.date;
    for (const action of step.actions) {
      for (const e of action.entities) {
        if (!e.flightNumber || removed(e)) continue;
        const date = e.flightDate ?? stepDate;
        if (!isFlightRef({ flightNumber: e.flightNumber, date })) continue;
        const key = `${e.flightNumber}:${date}`;
        if (out.has(key)) continue;
        const r = /D$/i.test(e.tag ?? "") ? "d" : "a";
        const at = date ? easternInstant(date, e.scheduledText) : null;
        out.set(key, { r, t: at === null ? null : iso(at) });
      }
    }
  }
  return out;
}

/** "3:39 PM ORD - Chicago" on 2026-09-28, at our airports (all Eastern), as
 *  an instant. Null when the sheet printed no time. */
export function easternInstant(date: string, printed: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})\s*([AP])\.?M/i.exec((printed ?? "").trim());
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || !d) return null;
  const hour = (Number(m[1]) % 12) + (m[3].toUpperCase() === "P" ? 12 : 0);
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), hour, Number(m[2]));
  // The wall time's offset, found from a first guess and checked once (DST).
  let at = wall - offsetAt(wall);
  at = wall - offsetAt(at);
  return at;
}

const NY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});

/** New York's offset from UTC at an instant, in ms (-4h in summer). */
function offsetAt(ms: number): number {
  const p: Record<string, number> = {};
  for (const part of NY.formatToParts(ms)) p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / MIN) * MIN;
}
