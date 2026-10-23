/**
 * Retention (spec "Archive and retention"): a run is deleted a chosen number of
 * days after it ends -- 2, 7, 14 or 30, default 7. Long enough to check what
 * happened last Tuesday, short enough that names, mobiles and hospitals are
 * not kept for a month by default. Archiving (10h after the end) is only a
 * view, and lives in the client.
 *
 * Pure apart from the KV it is handed, so the sweep runs in tests on bare node.
 */

export const RETENTION_CHOICES = [2, 7, 14, 30];
export const DEFAULT_RETENTION_DAYS = 7;

/** The department's clock. A run's `end` is printed in it, without a zone. */
const HOME_ZONE = "America/New_York";

/** "2026-08-31 21:30" -> ms, as if the wall time were UTC. A carrier for
 *  comparing wall times, never an instant. */
function wallMs(wall: string): number | null {
  const m = String(wall || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

/** Now, as the wall clock at home reads it: "2026-09-25 10:32". */
export function wallNow(ms: number, timeZone = HOME_ZONE): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** A choice the driver never made is the default, never a guess. */
export function retentionDays(stored: unknown): number {
  return RETENTION_CHOICES.includes(stored as number) ? (stored as number) : DEFAULT_RETENTION_DAYS;
}

/** Past its retention. A run that cannot be dated is kept: deleting on a guess
 *  is the one mistake that cannot be undone. */
export function expired(end: string | null | undefined, days: number, nowWall: string): boolean {
  const e = wallMs(end ?? ""), n = wallMs(nowWall);
  if (e === null || n === null) return false;
  return n >= e + days * 86400000;
}

/** The slice of KVNamespace the sweep uses. */
export interface SweepKV {
  list(opts: { prefix: string; cursor?: string }): Promise<{
    keys: { name: string; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<string | null>;
}

/**
 * Every stored run past its list's retention, handed to `remove` (which takes
 * its corrections and flight trackers with it, as DELETE does). One list of
 * `assign:` per thousand runs; `end` rides in key metadata, so a get is spent
 * only on a key stored before that, and on the runs actually removed.
 */
export async function sweep(
  kv: SweepKV,
  nowMs: number,
  daysFor: (listCode: string) => Promise<number>,
  remove: (listCode: string, number: string, stored: { end?: string }) => Promise<void>,
): Promise<string[]> {
  const nowWall = wallNow(nowMs);
  const days = new Map<string, number>();
  const removed: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "assign:", cursor });
    for (const entry of page.keys) {
      // assign:<list>:<number>. A list code never holds a colon, so the number
      // is everything after the second one: a legacy "1:x" must not be read
      // as run 1 of the same list (review B7).
      const rest = entry.name.slice("assign:".length);
      const at = rest.indexOf(":");
      const code = at > 0 ? rest.slice(0, at) : "";
      const number = at > 0 ? rest.slice(at + 1) : "";
      if (!code || !number) continue;
      if (!days.has(code)) days.set(code, await daysFor(code));
      let stored: { end?: string } | null = null;
      let end = (entry.metadata as { end?: string } | undefined)?.end;
      if (!end) {
        const raw = await kv.get(entry.name);
        stored = raw ? JSON.parse(raw) : null;
        end = stored?.end;
      }
      if (!expired(end, days.get(code)!, nowWall)) continue;
      if (!stored) {
        const raw = await kv.get(entry.name);
        stored = raw ? JSON.parse(raw) : null;
      }
      if (!stored) continue;
      await remove(code, number, stored);
      removed.push(`${code}:${number}`);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return removed;
}
