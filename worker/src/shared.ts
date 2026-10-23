/**
 * Places and airlines every driver gets (the owner, 2026-10-01).
 *
 * "CLS and CLN will always be the same for everyone, so if I set it he
 * shouldn't have to." One list is the keeper's -- the owner's, told by its
 * push topic being the FEEDBACK_TOPIC secret, so no new secret and no login --
 * and everything in ITS Places and Airlines is every list's default: the
 * catalog, one KV record, rewritten whole whenever the keeper saves one. A
 * list's own entry for the same code or name still wins on that list.
 *
 * What another driver adds goes to the keeper as a suggestion: "if he goes to
 * a new spot, like a new doctor, when he adds the address we should see it to
 * decide if it is baked into the app". The keeper's own app lists them; adding
 * one there is an ordinary save on the keeper's list, which puts it in the
 * catalog. The app never adds one by itself.
 *
 * Pure: index.ts reads and writes the two records.
 */
import type { Notice } from "./notify";
import type { LearnedAirline, Place } from "./types";
import { airlineKey } from "./learned";

export const CATALOG_KEY = "shared:catalog";
export const SUGGESTIONS_KEY = "shared:suggestions";
export const MAX_SUGGESTIONS = 100;
/** How many of one list's suggestions wait for the keeper at a time. Each is a
 *  push to the keeper's phone and a write, and any list can make them; past
 *  this the place or airline is still saved on the list that added it. */
export const MAX_SUGGESTIONS_PER_LIST = 20;
const MAX_DISMISSED = 300;

/** A list's mark of the catalog's airlines it last tracked flights for. */
export function sharedSeenKey(listCode: string): string {
  return `sharedseen:${listCode}`;
}

export interface Catalog {
  places: Place[];
  airlines: LearnedAirline[];
  /** When the airlines last changed: lists re-track their learned flights once per change. */
  airlinesAt: string | null;
}

export interface Suggestion {
  id: string;
  kind: "place" | "airline";
  /** A place's code, or the airline's two-character code. */
  code: string;
  /** A place's name (may be ""), or the airline as the sheet prints it. */
  name: string;
  address?: string;
  /** The tester id of the list that added it (feedback.ts), never its code. */
  by: string;
  at: string;
}

export interface Suggestions {
  items: Suggestion[];
  /** Keys already answered, so the same thing is not suggested twice. */
  dismissed: string[];
}

const words = (s: string | undefined) => String(s ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");

/** What makes two suggestions the same one. */
export function suggestionKey(s: Pick<Suggestion, "kind" | "code" | "name" | "address">): string {
  return s.kind === "place" ? `place|${s.code}|${words(s.address)}` : `airline|${airlineKey(s.name)}|${s.code}`;
}

/** A list's airlines with the catalog's behind them: its own win, by name. */
export function mergeAirlines(own: LearnedAirline[], shared: LearnedAirline[] | undefined): LearnedAirline[] {
  if (!shared || !shared.length) return own;
  const mine = new Set(own.map((a) => airlineKey(a.name)));
  return [...own, ...shared.filter((a) => !mine.has(airlineKey(a.name)))];
}

/** The catalog as the keeper's list now stands. `airlinesAt` moves only when
 *  the airlines did. */
export function catalogFrom(
  places: Place[], airlines: LearnedAirline[], before: Catalog | null, now: string,
): Catalog {
  const same = before && JSON.stringify(before.airlines) === JSON.stringify(airlines);
  return { places, airlines, airlinesAt: same ? before.airlinesAt : now };
}

/**
 * Another driver's place or airline, for the keeper to look at. Null when
 * there is nothing new to say: the catalog already has exactly this, or it
 * was suggested or answered before.
 */
export function suggest(
  record: Suggestions | null, catalog: Catalog | null, item: Suggestion,
): Suggestions | null {
  const key = suggestionKey(item);
  const has = item.kind === "place"
    ? (catalog?.places ?? []).some((p) => suggestionKey({ kind: "place", code: p.code, name: p.name, address: p.address }) === key)
    : (catalog?.airlines ?? []).some((a) => suggestionKey({ kind: "airline", code: a.code, name: a.name }) === key);
  if (has) return null;
  const items = record?.items ?? [];
  const dismissed = record?.dismissed ?? [];
  if (dismissed.includes(key) || items.some((s) => suggestionKey(s) === key)) return null;
  if (items.filter((s) => s.by === item.by).length >= MAX_SUGGESTIONS_PER_LIST) return null;
  return { items: [...items, item].slice(-MAX_SUGGESTIONS), dismissed };
}

/** Answered: its key is remembered so it does not come back. */
function answer(record: Suggestions, gone: Suggestion[]): Suggestions {
  const ids = new Set(gone.map((s) => s.id));
  return {
    items: record.items.filter((s) => !ids.has(s.id)),
    dismissed: [...record.dismissed, ...gone.map(suggestionKey)].slice(-MAX_DISMISSED),
  };
}

/** DISMISS on the keeper's phone. Null when there is no such suggestion. */
export function dismiss(record: Suggestions | null, id: string): Suggestions | null {
  const hit = (record?.items ?? []).filter((s) => s.id === id);
  return record && hit.length ? answer(record, hit) : null;
}

/** The keeper saved a place for this code, or an airline of this name: every
 *  suggestion about it is answered, whichever address or code the keeper
 *  chose. Null when none was waiting. */
export function settle(record: Suggestions | null, kind: Suggestion["kind"], what: string): Suggestions | null {
  const hit = (record?.items ?? []).filter((s) => s.kind === kind
    && (kind === "place" ? s.code === what : airlineKey(s.name) === airlineKey(what)));
  return record && hit.length ? answer(record, hit) : null;
}

/** The keeper's push. Only the code: topics on ntfy.sh are readable by anyone
 *  who knows the name, and an address is nobody else's business. Quiet. */
export function suggestionNotice(item: Suggestion): Notice {
  return {
    title: item.kind === "place" ? `A driver added a place · ${item.code}` : `A driver taught an airline · ${item.code}`,
    body: `Open Settings, ${item.kind === "place" ? "Places" : "Airlines"}, to add it for everyone or dismiss it.`,
    priority: 2,
    tags: ["round_pushpin"],
  };
}
