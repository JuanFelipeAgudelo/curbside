/**
 * Airlines a list learned from its drivers (the owner, 2026-09-30).
 *
 * The importer refuses to guess an airline it has no code for: "WestJet 1680"
 * comes in with no flight number and a line saying so. When a driver fixes
 * that row (WS1680), they can have the list remember WestJet = WS, and every
 * later sheet naming WestJet gets its flight filled in -- marked as learned,
 * with the driver's own correction always winning. It is applied when a run
 * is read, like corrections, and never written into dispatch's stored copy.
 *
 * Pure: index.ts reads the list's airlines and hands them in.
 */
import type { Assignment } from "./assignment";
import type { LearnedAirline } from "./types";

/** How a name is compared: the importer's own (airlines.js lookup): lower
 *  case, runs of space as one. */
export function airlineKey(name: string): string {
  return String(name).toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Fills in the flights of rows whose airline the list has learned. A row the
 * driver corrected, or that already has a number, is left alone. Each filled
 * row carries `_learned` {name, code} for the screen (a render field, never
 * stored). Returns how many rows it filled.
 */
export function applyLearned(assignment: Assignment, airlines: LearnedAirline[] | undefined): number {
  if (!airlines || !airlines.length) return 0;
  const known = new Map(airlines.map((a) => [airlineKey(a.name), a]));
  let filled = 0;
  for (const step of assignment.steps ?? []) {
    for (const action of step.actions ?? []) {
      for (const entity of action.entities ?? []) {
        const u = entity.unknownAirline;
        if (!u || !u.number || entity.flightNumber) continue;
        const edit = (entity as { _edit?: Record<string, unknown> })._edit;
        if (edit && "flightNumber" in edit) continue; // the driver's say, even a blank
        const hit = known.get(airlineKey(u.name));
        if (!hit) continue;
        entity.flightNumber = `${hit.code}${u.number}`;
        if (u.date) entity.flightDate = u.date;
        (entity as { _learned?: unknown })._learned = { name: hit.name, code: hit.code };
        filled++;
      }
    }
  }
  return filled;
}
