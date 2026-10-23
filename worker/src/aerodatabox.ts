import type { FlightRef, FlightStatus } from "./types";
import { AIRPORTS } from "./notify";

const API_HOST = "aerodatabox.p.rapidapi.com";

// AeroDataBox response shape is trimmed to the fields we actually use.
interface AeroDataBoxAirport {
  name: string;
  iata?: string;
  timeZone?: string;
  countryCode?: string;
}

interface AeroDataBoxLeg {
  airport: AeroDataBoxAirport;
  scheduledTime?: { local: string; utc: string };
  // AeroDataBox uses different field names depending on the airport/flight quality tier —
  // check both rather than assuming one.
  revisedTime?: { local: string; utc: string };
  predictedTime?: { local: string; utc: string };
  terminal?: string;
  gate?: string;
  // Arriving flights only. The redesign handoff assumed this wasn't available and
  // specced a hand-maintained "usual belt" guess table; the API does return it.
  baggageBelt?: string;
}

// AeroDataBox returns UTC as "2026-07-24 00:30Z" — reshape to a standard ISO
// instant ("2026-07-24T00:30:00Z") so `new Date(...)` parses it reliably everywhere.
function toIsoUtc(raw: string | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})Z$/);
  return match ? `${match[1]}T${match[2]}:00Z` : null;
}

interface AeroDataBoxFlight {
  number: string;
  status: string;
  airline?: { name: string };
  departure: AeroDataBoxLeg;
  arrival: AeroDataBoxLeg;
}

/** A lookup that never answers must not hold a cron tick: the tick's count
 *  of units and its log line wait for every flight. Past this it is a failed
 *  lookup, and the same check is tried once more at the next tick (index.ts). */
const LOOKUP_TIMEOUT_MS = 10_000;

export async function fetchFlightStatus(
  apiKey: string,
  flight: FlightRef,
  // RapidAPI's answer carries the plan's quota; checks.ts keeps the count.
  onAnswer?: (res: Response) => void,
  timeoutMs: number = LOOKUP_TIMEOUT_MS
): Promise<FlightStatus | null> {
  const url = `https://${API_HOST}/flights/number/${encodeURIComponent(
    flight.flightNumber
  )}/${encodeURIComponent(flight.date)}`;

  const res = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": apiKey,
      "X-RapidAPI-Host": API_HOST,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  onAnswer?.(res);

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`AeroDataBox request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as AeroDataBoxFlight[];
  if (!data.length) return null;

  const f = pickFlight(data, flight.date);
  return {
    flightNumber: flight.flightNumber,
    date: flight.date,
    // Read as text everywhere (landed? cancelled? the phone lower-cases it).
    status: typeof f.status === "string" ? f.status : "Unknown",
    airline: f.airline?.name ?? null,
    departure: {
      airport: f.departure.airport.name,
      airportCode: f.departure.airport.iata ?? null,
      countryCode: f.departure.airport.countryCode ?? null,
      timeZone: f.departure.airport.timeZone ?? null,
      scheduledTime: f.departure.scheduledTime?.local ?? null,
      estimatedTime: f.departure.revisedTime?.local ?? f.departure.predictedTime?.local ?? null,
      scheduledTimeUtc: toIsoUtc(f.departure.scheduledTime?.utc),
      estimatedTimeUtc: toIsoUtc(f.departure.revisedTime?.utc ?? f.departure.predictedTime?.utc),
      terminal: f.departure.terminal ?? null,
      gate: f.departure.gate ?? null,
      baggageBelt: null, // arriving flights only
    },
    arrival: {
      airport: f.arrival.airport.name,
      airportCode: f.arrival.airport.iata ?? null,
      countryCode: f.arrival.airport.countryCode ?? null,
      timeZone: f.arrival.airport.timeZone ?? null,
      scheduledTime: f.arrival.scheduledTime?.local ?? null,
      estimatedTime: f.arrival.revisedTime?.local ?? f.arrival.predictedTime?.local ?? null,
      scheduledTimeUtc: toIsoUtc(f.arrival.scheduledTime?.utc),
      estimatedTimeUtc: toIsoUtc(f.arrival.revisedTime?.utc ?? f.arrival.predictedTime?.utc),
      terminal: f.arrival.terminal ?? null,
      gate: f.arrival.gate ?? null,
      baggageBelt: f.arrival.baggageBelt ?? null,
    },
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * The instance this app works: the answer can hold more than one -- each leg
 * of a through-number, or a red-eye listed for the day it leaves and the day it
 * lands. The one touching one of the department's airports on the date asked
 * for (that side's local date), else one touching them at all, else the first.
 */
export function pickFlight<F extends Pick<AeroDataBoxFlight, "departure" | "arrival">>(data: F[], date: string): F {
  const home = (leg: AeroDataBoxLeg) => !!leg?.airport?.iata && AIRPORTS.has(leg.airport.iata);
  const on = (leg: AeroDataBoxLeg) => home(leg) && (leg.scheduledTime?.local ?? "").slice(0, 10) === date;
  return data.find((f) => on(f.arrival) || on(f.departure))
    ?? data.find((f) => home(f.arrival) || home(f.departure))
    ?? data[0];
}

/** Compares two statuses and returns a list of plain-language change lines, or [] if nothing changed. */
export function diffFlightStatus(
  prev: FlightStatus | null,
  next: FlightStatus
): string[] {
  if (!prev) return [];

  const changes: string[] = [];

  if (prev.status !== next.status) {
    changes.push(`Status changed: ${prev.status} → ${next.status}`);
  }

  for (const side of ["departure", "arrival"] as const) {
    const label = side === "departure" ? "Departure" : "Arrival";
    const p = prev[side];
    const n = next[side];

    if (p.estimatedTime !== n.estimatedTime && n.estimatedTime) {
      changes.push(`${label} time changed: ${p.estimatedTime ?? p.scheduledTime} → ${n.estimatedTime}`);
    }
    if (p.gate !== n.gate) {
      changes.push(`${label} gate changed: ${p.gate ?? "unknown"} → ${n.gate ?? "unknown"}`);
    }
    if (p.terminal !== n.terminal) {
      changes.push(`${label} terminal changed: ${p.terminal ?? "unknown"} → ${n.terminal ?? "unknown"}`);
    }
  }

  // A reassigned carousel sends the driver to the wrong end of the hall, so it's
  // worth a push on its own. Only announce it once it's actually known — going
  // from nothing to a belt is the belt being published, not a change.
  const prevBelt = prev.arrival.baggageBelt;
  const nextBelt = next.arrival.baggageBelt;
  if (prevBelt !== nextBelt && nextBelt) {
    changes.push(
      prevBelt
        ? `Baggage claim changed: ${prevBelt} → ${nextBelt}`
        : `Baggage claim: ${nextBelt}`
    );
  }

  return changes;
}
