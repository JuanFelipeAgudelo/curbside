/**
 * What a push says. Phase 9.
 *
 * The notification is the only screen read without opening the app, so it
 * says WHAT TO DO, not what happened. "UA1503 — Delayed" is a database row read
 * aloud; "Leave 20 minutes later" is something a driver at a wheel can act on.
 * The flight is the evidence and moves to the second line.
 *
 * And the urgency runs the other way from a flight tracker's. A delay GIVES the
 * driver time; landing early TAKES it away. So an early arrival is the one that
 * goes out urgent, and delays go out calm.
 *
 * Every figure here is the same arithmetic the itinerary draws (clocksFor in
 * public/assignments.js), so opening the app after a buzz confirms rather than
 * puzzles. And every figure the app computes is sent beside dispatch's own
 * number for the same thing -- two numbers with their sources is reporting,
 * one that has replaced dispatch's is deciding.
 *
 * Pure: no KV, no fetch, no clock. index.ts gathers the statuses and says what
 * time it is.
 */

import type { Assignment, Step } from "./assignment";
import type { FlightLeg, FlightStatus } from "./types";

// Mirrors public/assignments.js. HuB's own figures.
const BUFFER_MIN = 15;
const BUFFER_GB_MIN = 30;
const LEAD_DOM_MIN = 120;
const LEAD_INTL_MIN = 180;
const DEPLANE_DOM_MIN = 45;
const DEPLANE_INTL_MIN = 105;

/** Below this, a moved estimate is noise: AeroDataBox revises by a minute or
 *  two all evening, and "leave 2 minutes later" is a buzz for nothing. */
const MIN_SHIFT_MIN = 5;
/** A stop this far behind us is history, not a job. */
const STALE_AFTER_MIN = 180;

export const AIRPORTS = new Set(["EWR", "JFK", "LGA", "SWF", "HPN", "ALB", "BDL"]);

export type Priority = 1 | 2 | 3 | 4 | 5; // ntfy: min, low, default, high, urgent

export interface Notice {
  title: string;
  body: string;
  priority: Priority;
  tags: string[];
  /** The run the alert is about: a tap on it opens that run (v69). None on
   *  a notice that is about no run (a test, a tester's note). */
  run?: string;
}

export interface FlightId {
  flightNumber: string;
  date: string;
}

export function flightIdOf(f: FlightId): string {
  return `${f.flightNumber}:${f.date}`;
}

/** One flight row at a stop. */
export interface Row {
  id: string; // flightIdOf
  flightNumber: string;
  departure: boolean;
  gb: boolean;
}

/** One airport stop, as far as notifications care. */
export interface Stop {
  /** The assignment's number: which run the stop is on. */
  run?: string;
  code: string | null;
  rows: Row[];
  /** Dispatch's printed times, e.g. "11:00 PM" -- dispatch's even when the
   *  driver corrected them, because they are printed as "dispatch planned". */
  plannedEta: string | null;
  plannedEtd: string | null;
  /** Dispatch's time for leaving the stop before this one: when the driver
   *  sets off to come here. */
  plannedLeave: string | null;
  /** The driver's own time for the same thing, only where it differs from
   *  dispatch's. The clocks already run on it (the leg is read from the
   *  corrected times); these are for saying so beside dispatch's. */
  yourEta?: string | null;
  yourEtd?: string | null;
  yourLeave?: string | null;
  /** Dispatch's own leg to this stop, in minutes. Null when the document has
   *  none, and then nothing is said about when to leave -- only when to be
   *  there. The table is never consulted here: a push is not a suggestion the
   *  driver gets to look at first. */
  legMinutes: number | null;
  gb: boolean;
}

/* --------------------------------------------------------------- times -- */

function wallMinutes(printed: string | null | undefined): number | null {
  const m = String(printed || "").match(/^(\d{1,2}):(\d{2})\s*([AP])M$/i);
  if (!m) return null;
  const h = Number(m[1]) % 12;
  return (h + (m[3].toUpperCase() === "P" ? 12 : 0)) * 60 + Number(m[2]);
}

function fmtWall(total: number | null): string | null {
  if (total === null) return null;
  const m = ((total % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m % 60).padStart(2, "0")}${h24 < 12 ? "a" : "p"}`;
}

function printed(p: string | null): string | null {
  return fmtWall(wallMinutes(p));
}

/** An instant from a leg: the UTC field, else the local string's own offset. */
function instantOf(utc: string | null, local: string | null): number | null {
  if (utc) {
    const t = Date.parse(utc);
    if (!Number.isNaN(t)) return t;
  }
  const m = String(local || "").match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?([+-]\d{2}:?\d{2}|Z)$/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:00${m[3]}`);
  return Number.isNaN(t) ? null : t;
}

function estimated(leg: FlightLeg): number | null {
  return instantOf(leg.estimatedTimeUtc, leg.estimatedTime) ?? scheduled(leg);
}

function scheduled(leg: FlightLeg): number | null {
  return instantOf(leg.scheduledTimeUtc, leg.scheduledTime);
}

/** Wall clock at the airport, read straight off the local string so the push
 *  says exactly what the airport board says. */
function localClock(local: string | null): string | null {
  const m = String(local || "").match(/[ T](\d{2}):(\d{2})/);
  return m ? fmtWall(Number(m[1]) * 60 + Number(m[2])) : null;
}

function clockAt(ms: number, timeZone: string | null): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", hourCycle: "h23",
    timeZone: timeZone || "America/New_York",
  }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const min = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return fmtWall(h * 60 + min) as string;
}

/* ----------------------------------------------------------- the clocks -- */

/** International = either end outside the US and its territories. Told by the
 *  airport's country; a status stored without one falls back to its time zone,
 *  where only a US zone counts as domestic ("America/..." also covers Canada,
 *  Mexico, the Caribbean and South America, which are international). */
const US_COUNTRIES = new Set(["US", "PR", "VI", "GU", "AS", "MP"]);
const US_ZONES = /^(America\/(New_York|Detroit|Kentucky\/.+|Indiana\/.+|Chicago|Menominee|North_Dakota\/.+|Denver|Boise|Phoenix|Los_Angeles|Anchorage|Juneau|Sitka|Metlakatla|Yakutat|Nome|Adak|Puerto_Rico|St_Thomas)|Pacific\/(Honolulu|Guam|Pago_Pago|Saipan))$/;

function domesticLeg(leg: FlightStatus["departure"]): boolean | null {
  if (leg.countryCode) return US_COUNTRIES.has(leg.countryCode);
  if (leg.timeZone) return US_ZONES.test(leg.timeZone);
  return null;
}

function isIntl(status: FlightStatus | null): boolean | null {
  if (!status) return null;
  const dep = domesticLeg(status.departure), arr = domesticLeg(status.arrival);
  if (dep === null || arr === null) return null;
  return !(dep && arr);
}

export interface Clocks {
  parkedBy: number | null;
  leavingAt: number | null;
  first: string | null;
  last: string | null;
}

/**
 * Be there for the earliest obligation, leave after the latest one.
 *
 * A pickup's obligation is its touchdown, less the buffer and NOTHING else --
 * the deplane allowance is a maximum, not a licence to arrive late. A
 * drop-off's is its check-in deadline, taken from the EARLIER of scheduled and
 * estimated departure: a delayed flight does not move the check-in desk, and
 * guessing that it does is the expensive mistake.
 */
export function clocksFor(stop: Stop, statuses: Record<string, FlightStatus | null>): Clocks {
  let parkedBy: number | null = null, leavingAt: number | null = null;
  let first: string | null = null, last: string | null = null;
  for (const row of stop.rows) {
    const status = statuses[row.id];
    if (!status) continue;
    const intl = isIntl(status);
    if (row.departure) {
      const s = scheduled(status.departure), e = estimated(status.departure);
      const at = s === null ? e : e === null ? s : Math.min(s, e);
      if (at === null) continue;
      const due = at - (intl === false ? LEAD_DOM_MIN : LEAD_INTL_MIN) * 60000;
      if (parkedBy === null || due < parkedBy) { parkedBy = due; first = row.id; }
    } else {
      const at = estimated(status.arrival);
      if (at === null) continue;
      const buffer = row.gb ? BUFFER_GB_MIN : BUFFER_MIN;
      const due = at - buffer * 60000;
      if (parkedBy === null || due < parkedBy) { parkedBy = due; first = row.id; }
      const free = at + (intl === false ? DEPLANE_DOM_MIN : DEPLANE_INTL_MIN) * 60000;
      if (leavingAt === null || free > leavingAt) { leavingAt = free; last = row.id; }
    }
  }
  return { parkedBy, leavingAt, first, last };
}

/* --------------------------------------------------------- the stops ---- */

function legBetween(from: Step | undefined, to: Step): number | null {
  const d = wallMinutes(from?.etd), a = wallMinutes(to.eta);
  if (d === null || a === null) return null;
  return (a - d + 1440) % 1440;
}

/** Marked "not happening" by the driver (patch.ts). Local, not imported: this
 *  module stays free of value imports so its tests run on bare node. */
function removed(host: object): boolean {
  return Boolean((host as { _removed?: unknown })._removed);
}

/** Dispatch's time for a step field, under any correction the driver made
 *  (patch.ts hangs it off the step as the edit's documentValue). A stop the
 *  driver added has none: dispatch planned no such stop, so its times are
 *  quoted as "you set", never as "dispatch planned" (v69). */
function sheetTime(step: Step | undefined, field: "eta" | "etd"): string | null {
  if (!step || (step as { _add?: unknown })._add) return null;
  const marks = (step as { _edit?: Record<string, { documentValue: string | null }> })._edit;
  const e = marks?.[field];
  return e ? e.documentValue : step[field] ?? null;
}

/** The driver's time where it differs from dispatch's, else null. */
function yours(step: Step | undefined, field: "eta" | "etd"): string | null {
  const now = step?.[field] ?? null;
  return now !== sheetTime(step, field) ? now : null;
}

/** "dispatch planned 9:30p", or both when the driver set their own. */
function planned(dispatch: string | null, mine: string | null | undefined): string {
  if (mine) return `you set ${printed(mine)}${dispatch ? `, dispatch ${printed(dispatch)}` : ""}`;
  return dispatch ? `dispatch planned ${printed(dispatch)}` : "";
}

/** Every airport stop in an assignment where this flight is worked. */
export function stopsFor(assignment: Assignment, flight: FlightId): Stop[] {
  const out: Stop[] = [];
  // A stop the driver removed is not driven to, and a passenger they removed
  // is not waited for: neither may move a clock or send a push.
  const steps = assignment.steps.filter((s) => !removed(s));
  steps.forEach((step, i) => {
    if (!step.code || !AIRPORTS.has(step.code)) return;
    const date = step.etaDate ?? step.date;
    const rows: Row[] = [];
    for (const action of step.actions) {
      for (const entity of action.entities) {
        if (!entity.flightNumber || removed(entity)) continue;
        const departure = entity.tag === "D" || entity.tag === "GBD" || entity.tag === "TD";
        rows.push({
          id: flightIdOf({ flightNumber: entity.flightNumber, date: entity.flightDate ?? date }),
          flightNumber: entity.flightNumber,
          departure,
          gb: !!entity.gb,
        });
      }
    }
    if (!rows.some((r) => r.id === flightIdOf(flight))) return;
    const prev = steps[i - 1];
    out.push({
      run: assignment.number,
      code: step.code,
      rows,
      plannedEta: sheetTime(step, "eta"),
      plannedEtd: sheetTime(step, "etd"),
      plannedLeave: sheetTime(prev, "etd"),
      yourEta: yours(step, "eta"),
      yourEtd: yours(step, "etd"),
      yourLeave: yours(prev, "etd"),
      legMinutes: legBetween(prev, step),
      gb: !!assignment.gb || rows.some((r) => r.gb),
    });
  });
  return out;
}

/** The ids every stop needs a status for. */
export function flightIdsAt(stops: Stop[]): string[] {
  return [...new Set(stops.flatMap((s) => s.rows.map((r) => r.id)))];
}

/* ---------------------------------------------------------- the notice -- */

interface Candidate {
  title: string;
  detail: string;
  priority: Priority;
}

function minutesBetween(a: number, b: number): number {
  return Math.round((a - b) / 60000);
}

function plural(n: number): string {
  return `${n} minute${n === 1 ? "" : "s"}`;
}

const CANCELLED = /cancel/i;
const DIVERTED = /divert/i;
const DOWN = /landed|arrived/i;

/**
 * The push for one change to one flight at one stop, or null when nothing the
 * driver does has moved.
 *
 * Status churn that moves no clock -- "Expected", "En Route", "Departed" --
 * says nothing and is not sent. A gate at the far end of the flight is not the
 * driver's business either.
 */
export function noticeFor(
  stop: Stop,
  flight: FlightId,
  prev: FlightStatus,
  next: FlightStatus,
  others: Record<string, FlightStatus | null>,
  now: number,
  /** What the last push was computed from; the clocks move against this. */
  told: FlightStatus | null = null
): Notice | null {
  const id = flightIdOf(flight);
  const row = stop.rows.find((r) => r.id === id);
  if (!row) return null;
  const fn = row.flightNumber;
  const where = stop.code || next.arrival.airportCode || "the airport";
  const tz = (row.departure ? next.departure : next.arrival).timeZone
    ?? (row.departure ? next.arrival : next.departure).timeZone;
  // No passenger names: the topic is public ntfy.sh, and anyone who has it
  // could read who is landing where, GB runs included (review B4; the owner,
  // 2026-09-26). The flight and the stop say who; the app has the name.
  const who = `your ${fn} ${row.departure ? "drop-off" : "pickup"}`;

  const was = clocksFor(stop, { ...others, [id]: told ?? prev });
  const is = clocksFor(stop, { ...others, [id]: next });

  const lastTouch = was.leavingAt ?? was.parkedBy;
  if (lastTouch !== null && now - lastTouch > STALE_AFTER_MIN * 60000) return null;

  const leg = stop.legMinutes;
  const leaveBy = (c: Clocks) => (c.parkedBy === null || leg === null ? null : c.parkedBy - leg * 60000);
  const beforeLeaving = leaveBy(was) !== null
    ? now < (leaveBy(was) as number)
    : was.parkedBy !== null && now < was.parkedBy;

  const pLeg = row.departure ? prev.departure : prev.arrival;
  const nLeg = row.departure ? next.departure : next.arrival;
  const nowAt = localClock(nLeg.estimatedTime ?? nLeg.scheduledTime);
  const moves = row.departure ? "departs" : "lands";

  const cands: Candidate[] = [];
  const statusMoved = prev.status !== next.status;

  // ---- the flight is not coming ----
  if (statusMoved && (CANCELLED.test(next.status) || DIVERTED.test(next.status))) {
    const cancelled = CANCELLED.test(next.status);
    const at = printed(stop.plannedEta), mine = printed(stop.yourEta ?? null);
    cands.push({
      title: `Call dispatch — ${fn} ${cancelled ? "cancelled" : "diverted"}`,
      detail: cancelled
        ? (mine ? `you set ${where} ${mine}${at ? `, dispatch ${at}` : ""}` : `dispatch planned ${where}${at ? ` ${at}` : ""}`)
        : `now landing ${next.arrival.airportCode ?? next.arrival.airport}`,
      priority: 5,
    });
  }

  // ---- on the ground ----
  const landed = !row.departure && statusMoved && DOWN.test(next.status) && !DOWN.test(prev.status);
  if (landed && !cands.length) {
    const at = estimated(next.arrival);
    const wasAt = estimated(prev.arrival);
    const extras = [
      next.arrival.baggageBelt ? `Belt ${next.arrival.baggageBelt}` : null,
      next.arrival.terminal ? `Terminal ${next.arrival.terminal}` : null,
    ].filter(Boolean).join(" · ");
    if (at !== null && was.parkedBy !== null && at < was.parkedBy) {
      const ahead = wasAt !== null ? minutesBetween(wasAt, at) : 0;
      const lb = leaveBy(was);
      cands.push({
        title: lb !== null && now < lb ? "Leave now — landed early" : `Call ${who} — landed early`,
        detail: `${fn} on the ground ${localClock(next.arrival.estimatedTime) ?? clockAt(at, tz)}`
          + (ahead >= 1 ? ` · ${plural(ahead)} ahead` : "")
          + (extras ? ` · ${extras}` : ""),
        priority: 5,
      });
    } else {
      cands.push({
        title: `Call ${who} — landed`,
        detail: `on the ground ${nowAt ?? (at !== null ? clockAt(at, tz) : "now")}${extras ? ` · ${extras}` : ""}`,
        priority: 4,
      });
    }
  }

  // ---- the clocks moved ----
  if (!cands.length) {
    const dp = was.parkedBy !== null && is.parkedBy !== null ? minutesBetween(is.parkedBy, was.parkedBy) : 0;
    const dl = was.leavingAt !== null && is.leavingAt !== null ? minutesBetween(is.leavingAt, was.leavingAt) : 0;
    const flightLine = `${fn} now ${moves} ${nowAt}`;

    let parkedSaid = false;
    if (Math.abs(dp) >= MIN_SHIFT_MIN && is.parkedBy !== null) {
      const early = dp < 0;
      const n = Math.abs(dp);
      const lb = leaveBy(is);
      const parked = clockAt(is.parkedBy, tz);
      const dispatchPark = planned(stop.plannedEta, stop.yourEta);
      if (beforeLeaving && lb !== null) {
        const dispatchLeave = planned(stop.plannedLeave, stop.yourLeave);
        cands.push({
          title: early
            ? (lb <= now + 2 * 60000 ? `Leave now — ${fn} early` : `Leave ${plural(n)} earlier`)
            : `Leave ${plural(n)} later`,
          detail: `${flightLine} · leave by ${clockAt(lb, tz)}${dispatchLeave ? `, ${dispatchLeave}` : ""}`,
          priority: early ? 5 : 3,
        });
        parkedSaid = true;
      } else if (beforeLeaving) {
        cands.push({
          title: `Be at ${where} ${plural(n)} ${early ? "earlier" : "later"}`,
          detail: `${flightLine} · parked by ${parked}${dispatchPark ? `, ${dispatchPark}` : ""}`,
          priority: early ? 5 : 3,
        });
        parkedSaid = true;
      } else if (early) {
        // Already on the road, or there. Leaving earlier is moot; the one
        // number that still matters is when to be parked.
        cands.push({
          title: is.parkedBy > now ? `Park by ${parked} — ${fn} early` : `Hurry to ${where} — ${fn} early`,
          detail: `${flightLine}${dispatchPark ? ` · ${dispatchPark}` : ""}`,
          priority: 5,
        });
        parkedSaid = true;
      }
    }

    if (Math.abs(dl) >= MIN_SHIFT_MIN && is.leavingAt !== null) {
      const n = Math.abs(dl);
      const dispatchOut = planned(stop.plannedEtd, stop.yourEtd);
      const lastRow = stop.rows.find((r) => r.id === is.last);
      const lastStatus = is.last === id ? next : (is.last ? others[is.last] : null);
      const lastAt = lastStatus ? localClock(lastStatus.arrival.estimatedTime ?? lastStatus.arrival.scheduledTime) : null;
      cands.push({
        title: dl > 0 ? `Wait ${plural(n)} longer at ${where}` : `Leave ${where} ${plural(n)} sooner`,
        detail: `${lastRow ? lastRow.flightNumber : fn} now lands ${lastAt ?? nowAt} · leaving ${clockAt(is.leavingAt, tz)}`
          + (dispatchOut ? `, ${dispatchOut}` : "")
          + (!parkedSaid && is.parkedBy !== null && beforeLeaving ? ` · still parked by ${clockAt(is.parkedBy, tz)}` : ""),
        priority: 3,
      });
    }

    // A departure that slips moves nothing (see clocksFor), but the driver
    // will hear about it from the passenger, so say it changes nothing.
    if (row.departure && !cands.length) {
      const s = estimated(pLeg), e = estimated(nLeg);
      if (s !== null && e !== null && minutesBetween(e, s) >= MIN_SHIFT_MIN) {
        cands.push({
          title: `Leave as planned — ${fn} delayed`,
          detail: `${flightLine} · check-in keeps to the schedule`,
          priority: 2,
        });
      }
    }
  }

  // ---- where exactly ----
  if (nLeg.terminal && pLeg.terminal && nLeg.terminal !== pLeg.terminal) {
    cands.push({
      title: `${row.departure ? "Drop at" : "Go to"} Terminal ${nLeg.terminal} — ${fn} moved from ${pLeg.terminal}`,
      detail: "",
      priority: 4,
    });
  }
  if (!row.departure && next.arrival.baggageBelt && next.arrival.baggageBelt !== prev.arrival.baggageBelt) {
    cands.push(prev.arrival.baggageBelt
      ? { title: `Go to Belt ${next.arrival.baggageBelt} — ${fn} moved from ${prev.arrival.baggageBelt}`, detail: "", priority: 4 }
      : { title: `Meet at Belt ${next.arrival.baggageBelt} — ${fn}`, detail: "", priority: 3 });
  }
  if (nLeg.gate && pLeg.gate && nLeg.gate !== pLeg.gate) {
    cands.push({ title: `Expect gate ${nLeg.gate} — ${fn} moved from ${pLeg.gate}`, detail: "", priority: 2 });
  }

  if (!cands.length) return null;

  // The loudest one leads; the rest ride underneath so nothing is lost.
  let top = cands[0];
  for (const c of cands) if (c.priority > top.priority) top = c;
  const lines = [
    top.detail,
    ...cands.filter((c) => c !== top).map((c) => (c.detail ? `${c.title} · ${c.detail}` : c.title)),
    `${where} ${row.departure ? "drop-off" : "pickup"} · ${fn}`,
  ].filter(Boolean);

  // A GB run is the one that should reach the driver soonest and loudest. The
  // HuB "no notifications" rule for GB governs emails to the passenger, and
  // passengers never see this app.
  const priority = (stop.gb ? Math.min(5, top.priority + 1) : top.priority) as Priority;
  return {
    title: top.title,
    body: lines.join("\n"),
    priority,
    tags: stop.gb ? ["GOVERNING BODY"] : [],
    ...(stop.run ? { run: stop.run } : {}),
  };
}

/**
 * A flight as its timetable had it: what its FIRST check is measured from.
 *
 * Importing a run looks nothing up (checks.ts), so the first check has no
 * earlier one to be compared with, and it is the check that matters most: the
 * one about three hours out, before the driver leaves. Dispatch planned the
 * run when the flight was on time, so "on time" is what the driver knows, and
 * what moved is the estimate against the schedule in the same answer: the
 * difference the list's own LATE chip shows. A flight already cancelled,
 * diverted or down was none of those when the sheet was printed.
 */
export function asScheduled(status: FlightStatus): FlightStatus {
  const timetable = (leg: FlightLeg): FlightLeg => ({ ...leg, estimatedTime: null, estimatedTimeUtc: null });
  const news = CANCELLED.test(status.status) || DIVERTED.test(status.status) || DOWN.test(status.status);
  return {
    ...status,
    status: news ? "Scheduled" : status.status,
    departure: timetable(status.departure),
    arrival: timetable(status.arrival),
  };
}

/** Does a first check have anything to say? Asked before any run is read for
 *  it: a flight on its timetable costs no more than its lookup. */
export function offSchedule(status: FlightStatus): boolean {
  if (CANCELLED.test(status.status) || DIVERTED.test(status.status) || DOWN.test(status.status)) return true;
  return [status.departure, status.arrival].some((leg) => {
    const s = scheduled(leg), e = estimated(leg);
    return s !== null && e !== null && Math.abs(minutesBetween(e, s)) >= MIN_SHIFT_MIN;
  });
}

/** Settings > SEND A TEST ALERT: proves the list's topic reaches the phone
 *  without waiting for a real delay. Default priority, so it sounds the way
 *  an ordinary flight alert does. */
export function testNotice(): Notice {
  return {
    title: "Test alert · Curbside",
    body: "Flight alerts reach this phone. A real one says which flight moved and your new times.",
    priority: 3,
    tags: [],
  };
}
