import { diffFlightStatus, fetchFlightStatus } from "./aerodatabox";
import { quotaReached, sendNtfyNotification } from "./ntfy";
import {
  sendWebPush,
  subscriptionFrom,
  subscriptionsKey,
  usableKey,
  withSubscription,
  withoutEndpoints,
  type Subscription,
  type Vapid,
} from "./webpush";
import { countingKV, kvLine, onWorkers, routeName } from "./kvcount";
import {
  asScheduled, flightIdOf, flightIdsAt, noticeFor, offSchedule, stopsFor, testNotice, type Notice, type Stop,
} from "./notify";
import {
  Assignment,
  TRAVEL_TIMES_KEY,
  TRAVEL_TIMES_PREV_KEY,
  TravelTimes,
  assignmentKey,
  assignmentPrefixFor,
  flightsOf,
  isNewerCopy,
  newPatchId,
  patchKey,
  patchPrefixFor,
} from "./assignment";
import { admitPatch, aimPatch, applyPatches, type Patch, type PatchRequest } from "./patch";
import { baseOf, diffCopies, sameContent, type StoredRun } from "./changes";
import { airlineKey, applyLearned } from "./learned";
import { RETENTION_CHOICES, retentionDays, sweep } from "./retention";
import {
  CATALOG_KEY,
  SUGGESTIONS_KEY,
  catalogFrom,
  dismiss,
  mergeAirlines,
  settle,
  sharedSeenKey,
  suggest,
  suggestionNotice,
  type Catalog,
  type Suggestion,
  type Suggestions,
} from "./shared";
import {
  FEEDBACK_KEEP_SECONDS,
  FEEDBACK_MAX_CHARS,
  FEEDBACK_PER_DAY,
  Feedback,
  cleanVersion,
  countFeedback,
  dayPrefix,
  feedbackAllowed,
  feedbackKey,
  feedbackNotice,
  testerId,
  testerOfKey,
} from "./feedback";
import {
  FIELD_MAX,
  MAX_AIRLINES,
  MAX_ASSIGNMENT_BYTES,
  MAX_FLIGHTS,
  MAX_PATCH_BYTES,
  MAX_PATCHES,
  MAX_PLACES,
  MAX_RUNS,
  MAX_SEEN,
  REGISTER_PER_DAY,
  TEST_ALERT_LIMIT,
  MAX_STRING,
  MAX_TABLE_BYTES,
  Refusal,
  checkAirline,
  checkAssignment,
  checkPatch,
  checkPlace,
  checkRunKey,
  checkSeen,
  checkSettings,
  clip,
  isFlightRef,
  isListCode,
  normFlight,
  readBody,
} from "./limits";
import {
  ALL_TRACKED_KEY,
  POLL_PREFIX,
  pollKey,
  flightFromPollKey,
  resolveSettings,
  Env,
  FlightStatus,
  ListData,
  ListSettings,
  LearnedAirline,
  FlightRef,
  flightKey,
  historyKey,
  toldKey,
  scheduleKey,
  listKey,
  newTopic,
  stampKey,
  trackersKey,
} from "./types";
import {
  Budget,
  CheckMeta,
  DONE,
  MAX_MISSES,
  Plan,
  UNITS_PER_LOOKUP,
  allowChecks,
  anchorsOf,
  checkMetaOf,
  checksView,
  currentBudget,
  planNext,
  quotaFrom,
  readPlan,
  writePlan,
} from "./checks";

/** What this month's AeroDataBox lookups have cost (checks.ts). */
const BUDGET_KEY = "adb:budget";

/** A flight in the poll set, with its poll key's metadata: whose arrival or
 *  departure it is and the sheet's time (checks.ts). */
type Tracked = FlightRef & { meta?: CheckMeta };

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function getJSON<T>(env: Env, key: string, fallback: T): Promise<T> {
  const raw = await env.FLIGHT_DATA.get(key);
  return raw ? (JSON.parse(raw) as T) : fallback;
}

async function putJSON(env: Env, key: string, value: unknown): Promise<void> {
  await env.FLIGHT_DATA.put(key, JSON.stringify(value));
}

async function getList(env: Env, code: string): Promise<ListData | null> {
  return getJSON<ListData | null>(env, listKey(code), null);
}

async function saveList(env: Env, code: string, data: ListData): Promise<void> {
  return putJSON(env, listKey(code), data);
}

/**
 * Something GET /api/assignments would show has changed for this list: its
 * stamp gets a fresh value. A blind put -- no read, nothing to lose a race
 * on -- and the phones compare it each minute (GET /api/stamp) instead of
 * re-reading the list, which costs two list() calls of the 1,000 a day.
 *
 * Never fails the write it follows: a missed bump only means the other phone
 * sees the change at its next full load.
 */
async function bump(env: Env, code: string): Promise<void> {
  try {
    await env.FLIGHT_DATA.put(stampKey(code), `${new Date().toISOString()}:${randomHex(3)}`);
  } catch (err) {
    console.error("stamp not written:", err);
  }
}

/** The stamp as the edge has it. 30 s is the shortest KV lets a read be
 *  cached (the default is 60), so a change is seen a little sooner. */
async function stampOf(env: Env, code: string): Promise<string | null> {
  return env.FLIGHT_DATA.get(stampKey(code), { cacheTtl: 30 });
}

/* ---- places and airlines every driver gets (shared.ts) ---- */

/** The keeper's list: the one whose push topic is the FEEDBACK_TOPIC secret.
 *  Its Places and Airlines are every list's defaults. */
function isKeeper(env: Env, list: ListData | null): boolean {
  return Boolean(env.FEEDBACK_TOPIC && list?.topic && list.topic === env.FEEDBACK_TOPIC);
}

async function catalogOf(env: Env): Promise<Catalog | null> {
  return getJSON<Catalog | null>(env, CATALOG_KEY, null);
}

/** A list's airlines as its runs are read and tracked: its own, then the
 *  catalog's. One read. */
async function airlinesOf(env: Env, list: ListData | null): Promise<LearnedAirline[]> {
  return mergeAirlines(resolveSettings(list?.settings).airlines, (await catalogOf(env))?.airlines);
}

/**
 * After a list saved a place or an airline. The keeper's: the catalog is
 * rewritten from its list as it now stands (never read-modify-write: the list
 * is the truth), and suggestions about what it just saved are answered.
 * Anyone else's: a suggestion for the keeper, with a quiet push the first
 * time. Never fails the save it follows.
 */
async function shareSaved(
  env: Env, code: string, list: ListData, item: Omit<Suggestion, "id" | "by" | "at"> | null,
): Promise<void> {
  if (!env.FEEDBACK_TOPIC) return; // no keeper: nothing is shared
  try {
    if (isKeeper(env, list)) {
      const settings = resolveSettings(list.settings);
      const now = new Date().toISOString();
      await putJSON(env, CATALOG_KEY, catalogFrom(settings.places, settings.airlines, await catalogOf(env), now));
      if (item) {
        const left = settle(await getJSON<Suggestions | null>(env, SUGGESTIONS_KEY, null), item.kind,
          item.kind === "place" ? item.code : item.name);
        if (left) await putJSON(env, SUGGESTIONS_KEY, left);
      }
      return;
    }
    if (!item) return; // a removal on someone's own list is theirs alone
    const full: Suggestion = {
      ...item, id: randomHex(4), by: await testerId(code, await topicOf(env, code, list)), at: new Date().toISOString(),
    };
    const next = suggest(await getJSON<Suggestions | null>(env, SUGGESTIONS_KEY, null), await catalogOf(env), full);
    if (!next) return;
    await putJSON(env, SUGGESTIONS_KEY, next);
    await pushTo(env, env.FEEDBACK_TOPIC, suggestionNotice(full));
  } catch (err) {
    console.error("sharing a place or an airline failed:", err);
  }
}

/* ---- alerts: every way a list has (webpush.ts, ntfy.ts) ---- */

/** Who a push service may contact about Curbside's pushes: the app itself. */
const VAPID_SUBJECT = "https://curbside.juanfe02agu.workers.dev";

/** The server's push keys, or null: then no phone can turn alerts on in the
 *  app, and every alert goes by ntfy alone. A piped secret may end in a
 *  newline. */
function vapidOf(env: Env): Vapid | null {
  const publicKey = env.VAPID_PUBLIC?.trim(), privateKey = env.VAPID_PRIVATE?.trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: env.VAPID_SUBJECT?.trim() || VAPID_SUBJECT };
}

/** How one notice went out. */
interface Sent {
  /** The phones the list had when it was sent. */
  phones: number;
  /** The endpoints whose push service took it. */
  app: string[];
  /** ntfy took it. */
  ntfy: boolean;
  /** ntfy refused it for its daily limit (ntfy-quota, 2026-10-02). */
  quota: boolean;
}

/** Was the driver told at all? */
function delivered(sent: Sent): boolean {
  return sent.app.length > 0 || sent.ntfy;
}

/**
 * One notice, to everything listening on a topic: each phone that turned
 * alerts on in the app (Web Push), and the topic on ntfy.sh as before. Both,
 * always: a second phone on the list may still rely on the ntfy app, and a
 * push taken by a push service is not yet one shown on a screen.
 *
 * By topic, not by list code, so a notice for the keeper (feedback, a
 * suggestion) is sent the same way as a list's own. Never throws: the caller
 * reads from the answer whether anything took it. 1 get with push keys set,
 * and 1 more with a put or a delete when a phone turned out to be gone.
 */
async function pushTo(env: Env, topic: string, notice: Notice): Promise<Sent> {
  const [phones, ntfy] = await Promise.all([toPhones(env, topic, notice), toNtfy(env, topic, notice)]);
  return { ...phones, ...ntfy };
}

async function toPhones(env: Env, topic: string, notice: Notice): Promise<Pick<Sent, "phones" | "app">> {
  const vapid = vapidOf(env);
  if (!vapid) return { phones: 0, app: [] };
  try {
    const key = subscriptionsKey(topic);
    const subs = await getJSON<Subscription[]>(env, key, []);
    if (!subs.length) return { phones: 0, app: [] };
    const results = await Promise.all(subs.map((sub) => sendWebPush(sub, notice, vapid)));
    const gone = subs.filter((_, i) => results[i].gone).map((s) => s.endpoint);
    if (gone.length) {
      // Read again, so a phone that turned alerts on meanwhile is not lost.
      const left = withoutEndpoints(await getJSON<Subscription[]>(env, key, []), gone);
      if (left?.length) await putJSON(env, key, left);
      else if (left) await env.FLIGHT_DATA.delete(key);
    }
    // Statuses only: an endpoint is a phone's address, and never logged (B5).
    const refused = results.filter((r) => !r.ok && !r.gone).map((r) => r.status);
    if (refused.length) console.error(`web push not taken for ${refused.length} phone(s): ${[...new Set(refused)].join(", ")}`);
    return { phones: subs.length, app: subs.filter((_, i) => results[i].ok).map((s) => s.endpoint) };
  } catch (err) {
    console.error("web push failed:", err instanceof Error ? err.name : "unknown");
    return { phones: 0, app: [] };
  }
}

async function toNtfy(env: Env, topic: string, notice: Notice): Promise<Pick<Sent, "ntfy" | "quota">> {
  try {
    await sendNtfyNotification(topic, notice, env.NTFY_TOKEN);
    return { ntfy: true, quota: false };
  } catch (err) {
    // Never the topic: it is a key to the list's alerts.
    console.error("ntfy push failed:", err instanceof Error ? err.message.replaceAll(topic, "<topic>") : "unknown");
    return { ntfy: false, quota: quotaReached(err) };
  }
}

/** The list's own ntfy topic, given (one write, once) to a list made before
 *  topics were their own secret. Its old code-derived topic gets nothing more. */
async function topicOf(env: Env, code: string, list: ListData): Promise<string> {
  if (!list.topic) {
    list.topic = newTopic(randomHex);
    await saveList(env, code, list);
  }
  return list.topic;
}

/** Every flight in the poll set, by listing the prefix. Pages through the
 *  cursor: KV returns at most 1000 keys per call, and at 238 assignments a day
 *  that ceiling is reachable. */
async function getAllTracked(env: Env): Promise<Tracked[]> {
  const out: Tracked[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FLIGHT_DATA.list({ prefix: POLL_PREFIX, cursor });
    for (const key of page.keys) {
      const flight = flightFromPollKey(key.name);
      if (flight) out.push({ ...flight, meta: (key.metadata as CheckMeta | undefined) ?? undefined });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** One-shot migration off the retired shared array. Runs on a cron tick, costs
 *  one read when the key is gone, and deletes it once its contents are per-flight
 *  keys. Safe to run repeatedly. */
async function migrateSharedPollSet(env: Env): Promise<number> {
  const legacy = await getJSON<FlightRef[] | null>(env, ALL_TRACKED_KEY, null);
  if (!legacy) return 0;
  for (const flight of legacy) {
    if (flight?.flightNumber && flight?.date) {
      await putJSON(env, pollKey(flight), flight);
    }
  }
  await env.FLIGHT_DATA.delete(ALL_TRACKED_KEY);
  return legacy.length;
}

/**
 * One assignment's correction log, in order.
 *
 * The key carries a sortable stamp, so KV's lexicographic listing IS the
 * ordering -- no counter to keep, and nothing to rewrite when a patch is
 * appended.
 */
async function listPatches(env: Env, listCode: string, number: string): Promise<Patch[]> {
  return (await readPatches(env, patchPrefixFor(listCode, number))).get(number) ?? [];
}

/** Every patch on a list, grouped by assignment number -- ONE list call.
 *
 *  KV's free tier allows 1,000 list operations a day, account-wide. Listing
 *  per assignment spent one per assignment on every GET (16 for a 15-run list),
 *  and a day of testing hit 90% of the cap. The patch itself rides in the key's
 *  metadata, so reading the log costs no gets either; a key written before
 *  that, or too big for metadata, is read the old way. */
async function readPatches(
  env: Env, prefix: string, names?: Map<string, string[]>,
): Promise<Map<string, Patch[]>> {
  const out = new Map<string, Patch[]>();
  let cursor: string | undefined;
  do {
    const page = await env.FLIGHT_DATA.list<Patch>({ prefix, cursor });
    for (const entry of page.keys) {
      // patch:<list>:<number>:<id>
      const number = entry.name.split(":").slice(-2, -1)[0];
      // Every key, readable or not, so a run's removal takes all of them.
      if (names) names.set(number, [...(names.get(number) ?? []), entry.name]);
      const found = entry.metadata ?? await getJSON<Patch | null>(env, entry.name, null);
      if (!found) continue;
      if (!out.has(number)) out.set(number, []);
      out.get(number)!.push(found);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** KV caps metadata at 1024 BYTES serialised. A correction is a target and a
 *  short value, far under it -- but a long pasted value must still save, and
 *  an accented or non-Latin note is up to 3 bytes a character. */
async function putPatch(env: Env, key: string, patch: Patch): Promise<void> {
  const body = JSON.stringify(patch);
  const fits = new TextEncoder().encode(body).length <= 1000;
  await env.FLIGHT_DATA.put(key, body, fits ? { metadata: patch } : undefined);
}

/**
 * A run, gone: the run, its corrections and its flight trackers. Shared by
 * DELETE /api/assignments and the retention sweep.
 *
 * Corrections go with it. A six-digit assignment number eventually recycles,
 * and patches that outlive their assignment would then apply a dead run's
 * corrections to a live one -- a mis-target ACROSS assignments, which is worse
 * than anything the targeting can do wrong.
 *
 * Flights are untracked from the stored copy AND the corrected one: a
 * passenger the driver added carries a flight the sheet never printed.
 */
async function removeAssignment(
  env: Env, listCode: string, number: string, stored: Assignment, airlines: LearnedAirline[] = [],
): Promise<number> {
  // Two list calls in all (the list's corrections, then its runs), each read
  // once: the same listing that applies this run's corrections names the keys
  // to delete. The sweep used to list the same prefix twice.
  const keys = new Map<string, string[]>();
  const logs = await readPatches(env, patchPrefixFor(listCode), keys);
  const patched = structuredClone(stored);
  applyPatches(patched, logs.get(number) ?? []);
  applyLearned(patched, airlines);
  const flights = new Map<string, { flightNumber: string; date: string }>();
  for (const f of [...flightsOf(stored), ...flightsOf(patched)]) flights.set(`${f.flightNumber}:${f.date}`, f);

  // A flight another run on this list still has stays tracked for the list:
  // a reissued run, or two runs meeting the same arrival (review #8).
  const stillUsed = new Set<string>();
  if (flights.size) {
    let cursor: string | undefined;
    do {
      const page = await env.FLIGHT_DATA.list({ prefix: assignmentPrefixFor(listCode), cursor });
      for (const entry of page.keys) {
        if (entry.name === assignmentKey(listCode, number)) continue;
        const other = await getJSON<Assignment | null>(env, entry.name, null);
        if (!other) continue;
        applyPatches(other, logs.get(other.number) ?? []);
        applyLearned(other, airlines);
        for (const f of flightsOf(other)) stillUsed.add(`${f.flightNumber}:${f.date}`);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }

  // Corrections before the run: if the day's KV quota runs out between the
  // two, a finished run is left without its corrections until tomorrow's
  // sweep. The other order would leave corrections with no run, waiting for
  // the number to recycle.
  const mine = keys.get(number) ?? [];
  for (const key of mine) await env.FLIGHT_DATA.delete(key);
  await env.FLIGHT_DATA.delete(assignmentKey(listCode, number));

  // Stop tracking flights nobody else references.
  for (const [id, flight] of flights) {
    if (stillUsed.has(id)) continue;
    const trackers = (await getTrackers(env, flight)).filter((c) => c !== listCode);
    await saveTrackers(env, flight, trackers);
    await removeFromAllTrackedIfOrphaned(env, flight, trackers);
  }
  return mine.length;
}

/**
 * Make sure every flight an assignment now references is actually polled.
 *
 * Registration happens at import (POST /api/assignments), and cron reads the
 * poll keys without ever re-reading assignments. So a CORRECTED flight number
 * would otherwise display perfectly and be tracked not at all -- the headline
 * case, where the parser could not resolve an airline, would produce a row that
 * looks live and never updates. Called after a patch for exactly that reason.
 */
async function trackFlightsOf(
  env: Env, listCode: string, assignment: Assignment, was?: Map<string, CheckMeta>,
): Promise<number> {
  const flights = flightsOf(assignment);
  const meta = checkMetaOf(assignment);
  for (const flight of flights) {
    const id = `${flight.flightNumber}:${flight.date}`;
    // Already this list's: its poll key was written when it became so, and
    // its checks planned from it since. Writing it again on every correction
    // cost a put per flight of the day's 1,000 for nothing, and put a flight
    // that landed long ago back in the poll set.
    const trackers = await getTrackers(env, flight);
    if (trackers.includes(listCode)) {
      // `was`: the copy of the run this one replaces, as it was tracked.
      const now = meta.get(id), old = was?.get(id);
      if (now && old && (now.t !== old.t || now.r !== old.r)) await retimeChecks(env, flight, now);
      continue;
    }
    await addToAllTracked(env, flight, meta.get(id));
    await saveTrackers(env, flight, [...trackers, listCode]);
  }
  return flights.length;
}

/**
 * A re-sent sheet moved a flight's printed time, or turned an arrival into a
 * departure (v69). Its first check was planned from the old time when the run
 * came in, and a time moved EARLIER left the check before the driver leaves
 * too late to be that. So the poll key gets the new time, and a first check
 * not yet made is planned again from it. Once AeroDataBox has answered, its
 * own times plan the checks and a sheet's no longer do. Up to 2 gets and 2
 * puts, only for a flight a re-send retimed.
 */
async function retimeChecks(env: Env, flight: FlightRef, meta: CheckMeta): Promise<void> {
  if (await env.FLIGHT_DATA.get(flightKey(flight))) return;
  await addToAllTracked(env, flight, meta);
  const plan = readPlan(await getSchedule(env, flight));
  // Not planned yet: the next tick plans it, from the new time. Given up on:
  // a new time is no reason to pay for it again.
  if (!plan || plan === DONE) return;
  // The lookups that found nothing still count towards giving up.
  await setSchedule(env, flight, writePlan(planNext(anchorsOf(meta, null), [], Date.now(), plan.miss ?? 0)));
}

function stripRenderFields(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(stripRenderFields); return; }
  if (!value || typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  delete o._edit;
  delete o._at;
  delete o._add;
  delete o._removed;
  delete o._learned;
  delete o.edits;
  delete o.orphanedEdits;
  delete o.changes;
  // The server's own: what changes are counted from, and the OK.
  delete o.sheetChanges;
  delete o.base;
  delete o.seenPrintedAt;
  Object.values(o).forEach(stripRenderFields);
}

/** A stored run as it may be answered: without what the server keeps beside
 *  dispatch's copy (changes.ts). */
function served(run: StoredRun): Assignment {
  const { base: _base, seenPrintedAt: _seen, ...rest } = run;
  return rest;
}

/**
 * Every assignment on a list, soonest first, with corrections applied to the
 * copy -- never to the stored record, so dispatch's document stays exactly as
 * dispatch sent it.
 *
 * Applied server-side because the client caches the GET response verbatim, so
 * the offline copy inherits every correction for free. And cron reads through
 * here too, so a push is written from the corrected run: a flight the driver
 * fixed is the flight the push names.
 *
 * With `seen` (the list's OKs, ListData.seen) each run also carries what
 * dispatch changed since the list last OK'd it (changes.ts), worked out from
 * dispatch's copies alone, before the corrections touch the run. No extra KV
 * operation: the copy it is counted from rides inside the stored record.
 *
 * With `airlines` (the list's learned ones), a row whose airline the importer
 * could not name gets its flight filled in, after the corrections: a driver's
 * own number for the row wins (learned.ts).
 */
async function assignmentsOf(
  env: Env, listCode: string, seen?: Record<string, string>, airlines?: LearnedAirline[],
): Promise<Assignment[]> {
  const prefix = assignmentPrefixFor(listCode);
  const assignments: Assignment[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FLIGHT_DATA.list({ prefix, cursor });
    for (const entry of page.keys) {
      const found = await getJSON<StoredRun | null>(env, entry.name, null);
      if (!found) continue;
      if (seen && found.base) {
        const changes = diffCopies(found.base, found);
        if (changes.count) {
          (found as Assignment & { sheetChanges?: unknown }).sheetChanges = {
            ...changes,
            seen: Boolean(found.printedAt) && (seen[found.number] === found.printedAt
              || found.seenPrintedAt === found.printedAt),
          };
        }
      }
      assignments.push(served(found));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  assignments.sort((a, b) => a.start.localeCompare(b.start));

  const logs = await readPatches(env, patchPrefixFor(listCode));
  for (const assignment of assignments) {
    // Applied even to an empty log: that is what gives every row its `_at`
    // address, which the phone names its edits by.
    const patches = logs.get(assignment.number) ?? [];
    const { edits, orphaned, changes } = applyPatches(assignment, patches);
    if (edits.length) (assignment as Assignment & { edits?: unknown }).edits = edits;
    if (changes.length) (assignment as Assignment & { changes?: unknown }).changes = changes;
    if (orphaned.length) {
      (assignment as Assignment & { orphanedEdits?: unknown }).orphanedEdits = orphaned;
    }
    applyLearned(assignment, airlines);
  }
  return assignments;
}

/** The run as its flights are tracked: with the list's learned airlines, on
 *  a copy (the stored run stays dispatch's). */
function withLearned(assignment: Assignment, airlines: LearnedAirline[]): Assignment {
  if (!airlines.length) return assignment;
  const copy = structuredClone(assignment);
  applyLearned(copy, airlines);
  return copy;
}

/**
 * The pushes one list gets for one flight's change: one per stop where the
 * flight is worked, written from that stop's own two clocks.
 *
 * A flight no run on the list meets gets none: there is no stop to be at.
 *
 * `prev` is what the change is measured from: the check before, or the
 * flight's timetable at its first (notify.ts asScheduled). `runs` are the
 * list's, as the tick already read them (runsReader): no second read.
 */
async function noticesFor(
  env: Env,
  runs: Assignment[],
  flight: FlightRef,
  prev: FlightStatus,
  next: FlightStatus,
  now: number,
  told: FlightStatus | null = null
): Promise<Notice[]> {
  const stops: Stop[] = [];
  for (const assignment of runs) stops.push(...stopsFor(assignment, flight));

  // No stop: another list's flight, or a pickup at no airport stop. It may
  // not push: it would name a pickup nobody has.
  if (!stops.length) return [];

  // The other flights at each stop, as they stand now: a combo's clocks are
  // set by whichever row is earliest and latest, not by the one that moved.
  const others: Record<string, FlightStatus | null> = {};
  for (const id of flightIdsAt(stops)) {
    if (id === flightIdOf(flight)) continue;
    const [flightNumber, date] = [id.slice(0, id.lastIndexOf(":")), id.slice(id.lastIndexOf(":") + 1)];
    others[id] = await getJSON<FlightStatus | null>(env, flightKey({ flightNumber, date }), null);
  }

  return stops
    .map((stop) => noticeFor(stop, flight, prev, next, others, now, told))
    .filter((n): n is Notice => n !== null);
}

/** A list as a cron tick reads it: its record, and its runs as GET serves
 *  them (corrections applied, learned airlines filled in). */
interface ListRuns {
  list: ListData | null;
  runs: Assignment[];
}

/**
 * Reads each list at most once a tick, however many of its flights are due:
 * who meets a flight is asked of it before a lookup, and a push is written
 * from it after. 2 gets (the list, the catalog), 2 list() calls and a get per
 * run, for each list that tracks a flight about to be looked up.
 */
function runsReader(env: Env): (code: string) => Promise<ListRuns> {
  const read = new Map<string, Promise<ListRuns>>();
  return (code) => {
    let got = read.get(code);
    if (!got) {
      got = (async () => {
        // Read first: a flight the list learned is named by its airlines.
        const list = await getList(env, code);
        return { list, runs: list ? await assignmentsOf(env, code, undefined, await airlinesOf(env, list)) : [] };
      })();
      read.set(code, got);
    }
    return got;
  };
}

async function getTrackers(env: Env, flight: FlightRef): Promise<string[]> {
  return getJSON<string[]>(env, trackersKey(flight), []);
}

async function saveTrackers(env: Env, flight: FlightRef, codes: string[]): Promise<void> {
  if (!isFlightRef(flight)) return; // a malformed ref names somebody else's key
  const key = trackersKey(flight);
  if (codes.length === 0) {
    await env.FLIGHT_DATA.delete(key);
  } else {
    await putJSON(env, key, codes);
  }
}

// One put, one delete. Idempotent, and no read-modify-write to lose. The value
// repeats the ref so the key is self-describing when read by hand; listing only
// returns names, so nothing depends on it.
async function addToAllTracked(env: Env, flight: FlightRef, meta?: CheckMeta): Promise<void> {
  if (!isFlightRef(flight)) return; // never poll, never key, a made-up ref
  const ref = { flightNumber: flight.flightNumber, date: flight.date };
  if (meta) await env.FLIGHT_DATA.put(pollKey(ref), JSON.stringify(ref), { metadata: meta });
  else await putJSON(env, pollKey(ref), ref);
}

async function removeFromAllTracked(env: Env, flight: FlightRef): Promise<void> {
  await env.FLIGHT_DATA.delete(pollKey(flight));
}

// Drops a flight from the global poll set once nobody's list references it anymore,
// so cron stops burning AeroDataBox quota on abandoned flights. Takes the caller's
// already-fetched remaining trackers list rather than re-reading the same KV key.
async function removeFromAllTrackedIfOrphaned(
  env: Env,
  flight: FlightRef,
  remainingTrackers: string[]
): Promise<void> {
  if (remainingTrackers.length > 0) return;
  // Never delete keys built from a malformed ref: "…:trackers" as a date is
  // another flight's tracker index.
  if (!isFlightRef(flight)) return;
  await removeFromAllTracked(env, flight);
  await env.FLIGHT_DATA.delete(flightKey(flight));
  await env.FLIGHT_DATA.delete(historyKey(flight));
  await env.FLIGHT_DATA.delete(scheduleKey(flight));
  await env.FLIGHT_DATA.delete(toldKey(flight));
}

// A landed/arrived flight's status won't change again, so keep polling for a
// grace window (in case of a late correction) and then stop for good — this is
// the single biggest lever on AeroDataBox quota, since nothing previously ever
// stopped cron from polling a flight that landed weeks ago.
const LANDED_POLL_GRACE_MS = 2 * 60 * 60 * 1000; // 2 hours past arrival

function isLanded(status: FlightStatus): boolean {
  return /landed|arrived/i.test(status.status);
}

async function stopPollingIfLongLanded(env: Env, flight: FlightRef, status: FlightStatus): Promise<void> {
  if (!isLanded(status)) return;
  const arrivalUtc = status.arrival.estimatedTimeUtc ?? status.arrival.scheduledTimeUtc;
  if (!arrivalUtc) return;
  if (Date.now() - new Date(arrivalUtc).getTime() > LANDED_POLL_GRACE_MS) {
    await removeFromAllTracked(env, flight);
    // Out of the poll set, so nothing reads this again — without the delete it
    // would sit in KV for the life of the namespace.
    await env.FLIGHT_DATA.delete(scheduleKey(flight));
  }
}

// Each flight's schedule lives under its own key, so writing one never touches
// another and cron never rewrites the shared poll set.
async function getSchedule(env: Env, flight: FlightRef): Promise<string | null> {
  return env.FLIGHT_DATA.get(scheduleKey(flight));
}

async function setSchedule(env: Env, flight: FlightRef, at: string): Promise<void> {
  await env.FLIGHT_DATA.put(scheduleKey(flight), at);
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-List-Code",
    // The list code rides in a header, which makes every call preflighted;
    // a day's cache keeps that to one OPTIONS a day, not one per call.
    "Access-Control-Max-Age": "86400",
  };
}

/** Constant-time string compare. A bearer token checked with `===` leaks its
 *  length and prefix through timing; over the public internet that is a weak
 *  channel, but this is six lines and removes the argument. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * May this request write a SHARED key?
 *
 * Per-person data is already protected by its list code, which types.ts rightly
 * calls an unguessable secret. Shared data -- one travel-time table for
 * everybody -- has no such code to hide behind, and the Worker's URL is in a
 * public repository, so "nobody knows the address" was never a control.
 *
 * The risk here is integrity, not secrecy: the table is drive times between
 * sites, which is not confidential, but it feeds every leave-by the app
 * computes. A bad table sends drivers at the wrong time, quietly.
 *
 * Fails CLOSED. An unset WRITE_TOKEN refuses the write rather than waving it
 * through, because "not configured yet" is exactly the state in which an open
 * endpoint goes unnoticed.
 */
function mayWriteShared(request: Request, env: Env): boolean {
  const expected = env.WRITE_TOKEN;
  if (!expected) return false;
  const got = request.headers.get("Authorization") ?? "";
  return got.startsWith("Bearer ") && safeEqual(got.slice(7), expected);
}

/** Every answer: JSON that nothing may read as another type or keep. A run
 *  holds names and phones, and the code may still ride in a URL's query. */
function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      ...corsHeaders(),
      ...extra,
    },
  });
}

/** The address a request came from: what the rate limiters count by. */
function clientOf(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/**
 * May this caller go on? Asks a Workers rate-limit binding, and fails OPEN:
 * with no binding (the tests, an account without it) or a limiter that
 * errors, the request goes through. A broken brake must not become a broken
 * app. The binding counts per Cloudflare location and is approximate by
 * design: it stops a loop burning the KV quota, not a distributed attack.
 */
async function underLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch (err) {
    console.error("rate limiter failed, letting the request through:", err);
    return true;
  }
}

function tooMany(message: string): Response {
  return json({ error: message }, 429, { "Retry-After": "60" });
}

/**
 * Registrations per client address, per isolate, per HOUR: the binding's
 * window is at most a minute, so this backs it up over the longer span. Best
 * effort only: Cloudflare runs many isolates and recycles them. Each
 * registration is a KV write, and the free tier allows 1,000 a day,
 * account-wide.
 */
const REGISTER_LIMIT = 10;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const registrations = new Map<string, number[]>();

/** At most `limit` in any `windowMs`, per key, per isolate: counted here, and
 *  refused once over. Best effort (isolates come and go), and never unbounded. */
function withinLimit(seen: Map<string, number[]>, key: string, limit: number, windowMs: number, now: number): boolean {
  const recent = (seen.get(key) ?? []).filter((t) => now - t < windowMs);
  if (seen.size > 10_000) seen.clear(); // never grow without bound
  if (recent.length >= limit) { seen.set(key, recent); return false; }
  recent.push(now);
  seen.set(key, recent);
  return true;
}

function registerAllowed(request: Request, now: number): boolean {
  return withinLimit(registrations, clientOf(request), REGISTER_LIMIT, REGISTER_WINDOW_MS, now);
}

/**
 * Test alerts per list, per isolate, per hour (Settings > SEND A TEST ALERT).
 * Best effort, like the register limit; each one is a push to ntfy.sh, which
 * limits publishers on its own, and a KV get, never a write.
 */
const TEST_ALERT_WINDOW_MS = 60 * 60 * 1000;
const testAlerts = new Map<string, number[]>();

function testAlertAllowed(code: string, now: number): boolean {
  return withinLimit(testAlerts, code, TEST_ALERT_LIMIT, TEST_ALERT_WINDOW_MS, now);
}

/** Every HTTP route. Throws a Refusal for a request refused for what it
 *  carries; `fetch` turns that into a 400 or 413. */
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  // Before anything touches KV: a flood from one address, made-up list codes
  // or not, then costs no reads, lists or writes at all.
  if (!(await underLimit(env.API_LIMITER, clientOf(request)))) {
    return tooMany("too many requests from here; try again in a minute");
  }

  // Does this list exist? One KV get per code per request, asked BEFORE any
  // list() or write: a list call costs 1 of the 1,000 a day (account-wide),
  // so an unknown code must be turned away for the price of a read.
  // The list code is the list's only key, so it travels in a header and
  // nowhere else: a URL lands in browser history and in every proxy's and
  // Cloudflare's logs (review B5, 2026-09-26). The query string and the body
  // were read too until 2026-10-04, for a frontend and an importer that are
  // both gone; a code in either names nothing now.
  const headerCode = request.headers.get("X-List-Code")?.trim() || null;
  // It is a code's shape before it is read as a key (limits.ts isListCode):
  // none at all is null, anything else is refused.
  const sentCode = (): string | null => {
    if (headerCode === null) return null;
    if (!isListCode(headerCode)) throw new Refusal("that is not a list code", 400);
    return headerCode;
  };
  // A body, with the header's code as its `listCode`, where the routes read
  // it. Whatever the body itself said under that name is dropped.
  const readListBody = async <T extends object>(max?: number): Promise<T> => {
    const body = await readBody<T>(request, max);
    const named = body as { listCode?: unknown };
    const code = sentCode();
    if (code) named.listCode = code;
    else delete named.listCode;
    return body;
  };

  const lists = new Map<string, Promise<ListData | null>>();
  const knownList = (code: string): Promise<ListData | null> => {
    if (!lists.has(code)) lists.set(code, getList(env, code));
    return lists.get(code)!;
  };

  // POST /api/register — first-visit call: creates a private list + its own ntfy topic
  if (request.method === "POST" && url.pathname === "/api/register") {
    // It takes no input. Anything but an empty body or a small JSON object
    // is not the app.
    const text = await request.text();
    if (text.length > 1024) return json({ error: "request body too large" }, 413);
    if (text.trim()) {
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return json({ error: "malformed JSON" }, 400); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return json({ error: "expected a JSON object" }, 400);
      }
    }
    if (!(await underLimit(env.REGISTER_LIMITER, clientOf(request))) ||
        !registerAllowed(request, Date.now())) {
      return tooMany("too many new lists from here; try again later");
    }
    // New lists a day, from every address together: the limits above are per
    // address and per isolate, and each list is a write of the day's 1,000.
    // Counted in a key of the UTC day that expires by itself; two at the same
    // moment may count as one, which is near enough. 1 get, and 1 more put.
    const dayKey = `registered:${new Date().toISOString().slice(0, 10)}`;
    const made = Number(await env.FLIGHT_DATA.get(dayKey)) || 0;
    if (made >= REGISTER_PER_DAY) return tooMany("no more new lists today; try again tomorrow");
    let listCode = randomHex(4);
    while (await getList(env, listCode)) {
      listCode = randomHex(4); // extremely unlikely, but don't silently clobber an existing list
    }
    const topic = newTopic(randomHex);
    await saveList(env, listCode, { flights: [], topic });
    await env.FLIGHT_DATA.put(dayKey, String(made + 1), { expirationTtl: 2 * 86400 });
    return json({ listCode, ntfyTopic: topic });
  }

  // POST /api/feedback — a tester's note to the owner (feedback.ts). Costs a
  // get, a list and one write; the owner gets a quiet push without the text.
  if (request.method === "POST" && url.pathname === "/api/feedback") {
    const body = await readListBody<{ listCode?: string; text?: unknown; version?: unknown }>(16 * 1024);
    if (!body.listCode) return json({ error: "listCode is required" }, 400);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "the note is empty" }, 400);
    if (text.length > FEEDBACK_MAX_CHARS) {
      return json({ error: `the note is too long (max ${FEEDBACK_MAX_CHARS} characters)` }, 413);
    }
    const list = await knownList(body.listCode);
    if (!list) return json({ error: "Unknown listCode" }, 404);

    const tester = await testerId(body.listCode, await topicOf(env, body.listCode, list));
    const now = new Date();
    const overLimit = tooMany(`that's ${FEEDBACK_PER_DAY} notes today; send more tomorrow`);
    if (!feedbackAllowed(tester, now)) return overLimit;
    const today = await env.FLIGHT_DATA.list({ prefix: dayPrefix(now) });
    const already = today.keys.filter((k) => testerOfKey(k.name) === tester).length;
    if (already >= FEEDBACK_PER_DAY) { countFeedback(tester, now, already); return overLimit; }

    const version = cleanVersion(body.version);
    const note: Feedback = { at: now.toISOString(), tester, version, text };
    await env.FLIGHT_DATA.put(feedbackKey(now, tester, randomHex(2)), JSON.stringify(note), {
      expirationTtl: FEEDBACK_KEEP_SECONDS,
      metadata: { version, chars: text.length },
    });
    countFeedback(tester, now);
    // Kept either way: a missed push must not lose the note or make the
    // tester send it twice.
    if (env.FEEDBACK_TOPIC) await pushTo(env, env.FEEDBACK_TOPIC, feedbackNotice(version, tester));
    return json({ ok: true });
  }

  // POST /api/push — this phone takes the list's alerts in the app itself
  // (webpush.ts): its browser's subscription, kept under the list's topic.
  // DELETE — it no longer does. Neither bumps the stamp: no phone shows
  // another's. A subscription is checked before any KV call. POST: 2 gets,
  // and 1 put only when the list did not have exactly this already, so a
  // phone says so again at every launch for two reads. DELETE: 2 gets, and a
  // put or a delete when the phone was there.
  if (url.pathname === "/api/push" && (request.method === "POST" || request.method === "DELETE")) {
    const body = await readListBody<{ listCode?: string; subscription?: unknown; endpoint?: unknown }>(4 * 1024);
    if (!body.listCode) return json({ error: "listCode is required" }, 400);
    if (request.method === "DELETE") {
      if (typeof body.endpoint !== "string" || !body.endpoint || body.endpoint.length > 2048) {
        return json({ error: "endpoint is required" }, 400);
      }
      const list = await knownList(body.listCode);
      if (!list) return json({ error: "Unknown listCode" }, 404);
      const key = subscriptionsKey(await topicOf(env, body.listCode, list));
      const left = withoutEndpoints(await getJSON<Subscription[]>(env, key, []), [body.endpoint]);
      if (left?.length) await putJSON(env, key, left);
      else if (left) await env.FLIGHT_DATA.delete(key);
      return json({ ok: true, removed: Boolean(left) });
    }
    const read = subscriptionFrom(body.subscription);
    if ("error" in read) return json({ error: read.error }, 400);
    if (!vapidOf(env)) return json({ error: "alerts in the app are not set up on this server" }, 503);
    if (!(await usableKey(read.sub.p256dh))) return json({ error: "the subscription's keys are not a phone's" }, 400);
    const list = await knownList(body.listCode);
    if (!list) return json({ error: "Unknown listCode" }, 404);
    const key = subscriptionsKey(await topicOf(env, body.listCode, list));
    const next = withSubscription(await getJSON<Subscription[]>(env, key, []), read.sub, new Date().toISOString());
    if (next) await putJSON(env, key, next);
    return json({ ok: true });
  }

  // POST /api/alerts/test — one alert the way a real one goes (pushTo): to
  // every phone with alerts on, and to the list's ntfy topic, so the driver
  // sees alerts arrive before a real delay has to prove it. The phone sends
  // its own endpoint, and is told whether IT was among those that took it
  // (`here`). Refused only when nothing took it. 1 get, 2 with push keys set;
  // no write but the one-time topic for a list made before topics were its
  // own, and a phone found to be gone.
  if (request.method === "POST" && url.pathname === "/api/alerts/test") {
    const body = await readListBody<{ listCode?: string; endpoint?: unknown }>(4 * 1024);
    if (!body.listCode) return json({ error: "listCode is required" }, 400);
    const list = await knownList(body.listCode);
    if (!list) return json({ error: "Unknown listCode" }, 404);
    if (!testAlertAllowed(body.listCode, Date.now())) {
      return tooMany(`that's ${TEST_ALERT_LIMIT} test alerts this hour; try again later`);
    }
    const sent = await pushTo(env, await topicOf(env, body.listCode, list), testNotice());
    const facts = {
      app: sent.app.length,
      phones: sent.phones,
      here: typeof body.endpoint === "string" && sent.app.includes(body.endpoint),
      ntfy: sent.ntfy,
    };
    if (delivered(sent)) return json({ ok: true, ...facts });
    // The finding this button exists for: say it as it is.
    const app = sent.phones ? "the phone's push service did not take the alert, and " : "";
    if (sent.quota) {
      return json({ error: `${app}ntfy.sh's daily limit for Curbside's server is used up`, quota: true, ...facts }, 503);
    }
    return json({ error: `${app}ntfy.sh did not take the alert; try again in a minute`, ...facts }, 502);
  }

  // PUT /api/settings — write this list's check-in leads, display and retention
  if (request.method === "PUT" && url.pathname === "/api/settings") {
    const body = await readListBody<Partial<ListSettings> & { listCode?: string }>();
    if (!body.listCode) return json({ error: "listCode is required" }, 400);
    checkSettings(body as unknown as Record<string, unknown>);

    const list = await knownList(body.listCode);
    if (!list) return json({ error: "Unknown listCode" }, 404);

    const current = resolveSettings(list.settings);
    const settings: ListSettings = {
      checkInLeadMinutes: body.checkInLeadMinutes ?? current.checkInLeadMinutes,
      checkInLeadIntlMinutes: body.checkInLeadIntlMinutes ?? current.checkInLeadIntlMinutes,
      showPassengerNames: body.showPassengerNames ?? current.showPassengerNames,
      retentionDays: body.retentionDays ?? current.retentionDays,
      places: current.places, // POST /api/places, one at a time
      airlines: current.airlines, // POST /api/airlines, one at a time
    };
    if (!RETENTION_CHOICES.includes(settings.retentionDays)) {
      return json({ error: `retentionDays must be one of ${RETENTION_CHOICES.join(", ")}` }, 400);
    }

    list.settings = settings;
    await saveList(env, body.listCode, list);
    await bump(env, body.listCode);
    return json({ settings });
  }

  // POST /api/places — add, change or remove one of the list's places, by its
  // code. One place per call, so two phones adding different places never
  // overwrite each other. 1 get + 2 writes (the list, its stamp).
  if (request.method === "POST" && url.pathname === "/api/places") {
    const body = await readListBody<{ listCode?: string; code?: unknown; name?: unknown; address?: unknown; remove?: unknown }>();
    if (!body.listCode) return json({ error: "listCode is required" }, 400);
    checkPlace(body as unknown as Record<string, unknown>);

    const list = await knownList(body.listCode);
    if (!list) return json({ error: "Unknown listCode" }, 404);

    const settings = resolveSettings(list.settings);
    const code = String(body.code);
    const places = settings.places.filter((p) => p.code !== code);
    if (!body.remove) {
      if (places.length >= MAX_PLACES) return json({ error: `A list keeps at most ${MAX_PLACES} places` }, 413);
      places.push({ code, name: String(body.name ?? "").trim(), address: String(body.address).trim() });
      places.sort((a, b) => a.code.localeCompare(b.code));
    }
    list.settings = { ...settings, places };
    await saveList(env, body.listCode, list);
    await bump(env, body.listCode);
    await shareSaved(env, body.listCode, list, body.remove ? null
      : { kind: "place", code, name: String(body.name ?? "").trim(), address: String(body.address).trim() });
    return json({ places });
  }

  // POST /api/airlines — the list learns (or forgets) what an airline's name
  // on the sheets is as a code: "WestJet" is WS (learned.ts). One per call, by
  // name, like places. The runs that name it get their flights tracked now,
  // so a learned flight is watched like any other. 1 get + 1 write, then 2
  // lists + a get per run, only when something was learned.
  if (request.method === "POST" && url.pathname === "/api/airlines") {
    const body = await readListBody<{ listCode?: string; name?: unknown; code?: unknown; remove?: unknown }>();
    if (!body.listCode) return json({ error: "listCode is required" }, 400);
    checkAirline(body as unknown as Record<string, unknown>);

    const list = await knownList(body.listCode);
    if (!list) return json({ error: "Unknown listCode" }, 404);

    const settings = resolveSettings(list.settings);
    const name = String(body.name).trim().replace(/\s+/g, " ");
    const airlines = settings.airlines.filter((a) => airlineKey(a.name) !== airlineKey(name));
    if (!body.remove) {
      if (airlines.length >= MAX_AIRLINES) return json({ error: `A list keeps at most ${MAX_AIRLINES} airlines` }, 413);
      airlines.push({ name, code: String(body.code) });
      airlines.sort((a, b) => airlineKey(a.name).localeCompare(airlineKey(b.name)));
    }
    list.settings = { ...settings, airlines };
    await saveList(env, body.listCode, list);
    await bump(env, body.listCode);
    await shareSaved(env, body.listCode, list, body.remove ? null
      : { kind: "airline", code: String(body.code), name });

    // Forgetting leaves the flights tracked until their runs go: a poll
    // spent on a number nobody shows is cheaper than untracking one another
    // row still names.
    let tracked = 0;
    if (!body.remove) {
      const key = airlineKey(name);
      for (const run of await assignmentsOf(env, body.listCode, undefined, airlines)) {
        const names = run.steps.some((s) => s.actions.some((a) => a.entities.some((e) =>
          (e as { _learned?: { name: string } })._learned && airlineKey(e.unknownAirline?.name ?? "") === key)));
        if (names) tracked += await trackFlightsOf(env, body.listCode, run);
      }
    }
    return json({ airlines, tracked });
  }

  // GET /api/travel-times — the department's approved matrix.
  // PUT /api/travel-times — replace it. Data, not code: it changes when the
  // department changes it, and should never need a deploy.
  if (url.pathname === "/api/travel-times") {
    if (request.method === "GET") {
      // The department's own table: for a list (the app gets it with its
      // runs, and never asks here) or the holder of the write token (the
      // loader's --show), not for whoever has the Worker's address.
      if (!mayWriteShared(request, env)) {
        const listCode = sentCode();
        if (!listCode) return json({ error: "listCode is required" }, 400);
        if (!(await knownList(listCode))) return json({ error: "Unknown listCode" }, 404);
      }
      const table = await getJSON<TravelTimes | null>(env, TRAVEL_TIMES_KEY, null);
      return json(table ?? { pairs: {} });
    }
    if (request.method === "PUT") {
      if (!mayWriteShared(request, env)) {
        return json({ error: "a write token is required" }, 401);
      }
      const body = await readBody<TravelTimes>(request, MAX_TABLE_BYTES);
      if (!body || typeof body.pairs !== "object" || !body.pairs) {
        return json({ error: "pairs is required" }, 400);
      }
      const bad = Object.entries(body.pairs).find(
        ([k, v]) => !/^[A-Z]{2,8}>[A-Z]{2,8}$/.test(k) || typeof v !== "number"
      );
      if (bad) return json({ error: `bad entry: ${bad[0]}` }, 400);
      // Displace, don't destroy. Read before write, so an upload of the wrong
      // workbook costs one command to reverse instead of a hunt for the
      // original file. Only ever one step deep: this is an undo, not history.
      const current = await getJSON<TravelTimes | null>(env, TRAVEL_TIMES_KEY, null);
      if (current) await putJSON(env, TRAVEL_TIMES_PREV_KEY, current);
      await putJSON(env, TRAVEL_TIMES_KEY, body);
      return json({
        ok: true,
        pairs: Object.keys(body.pairs).length,
        replaced: current ? Object.keys(current.pairs ?? {}).length : 0,
      });
    }
  }

  // POST /api/travel-times/undo — put the displaced copy back.
  //
  // A swap rather than a one-way restore: undoing an undo returns you to
  // where you were, so a driver who guesses wrong at 5 AM is not stuck with
  // the guess.
  if (url.pathname === "/api/travel-times/undo" && request.method === "POST") {
    if (!mayWriteShared(request, env)) {
      return json({ error: "a write token is required" }, 401);
    }
    const prev = await getJSON<TravelTimes | null>(env, TRAVEL_TIMES_PREV_KEY, null);
    if (!prev) return json({ error: "nothing to undo" }, 404);
    const current = await getJSON<TravelTimes | null>(env, TRAVEL_TIMES_KEY, null);
    await putJSON(env, TRAVEL_TIMES_KEY, prev);
    if (current) await putJSON(env, TRAVEL_TIMES_PREV_KEY, current);
    return json({
      ok: true,
      pairs: Object.keys(prev.pairs ?? {}).length,
      source: prev.source ?? null,
    });
  }

  // POST /api/assignments — import one assignment, whole.
  //
  // The same number UPDATES in place; a different number is a new
  // assignment. That is the owner's rule and the document's own: the helper
  // receives the same run under the same number, so the driver is not part of
  // identity.
  if (request.method === "POST" && url.pathname === "/api/assignments") {
    const body = await readListBody<Assignment & { listCode?: string }>(MAX_ASSIGNMENT_BYTES);
    if (!body.listCode) return json({ error: "listCode is required" }, 400);
    if (!body.number) return json({ error: "number is required" }, 400);
    if (!body.start || !body.end) return json({ error: "start and end are required" }, 400);
    // Refused before any KV operation: a malformed run costs nothing.
    checkAssignment(body as unknown as Record<string, unknown>);

    const list = await knownList(body.listCode);
    if (!list) return json({ error: "Unknown listCode" }, 404);

    const key = assignmentKey(body.listCode, body.number);
    const existing = await getJSON<StoredRun | null>(env, key, null);

    // A run the list does not have yet is one more for every load to read:
    // counted, for one list() (a re-send of a run it has costs none).
    if (!existing) {
      const held = await env.FLIGHT_DATA.list({ prefix: assignmentPrefixFor(body.listCode), limit: MAX_RUNS });
      if (held.keys.length >= MAX_RUNS) {
        return json({ error: `this list holds ${MAX_RUNS} runs, the most it can: remove one, or wait for the old ones to be cleared` }, 413);
      }
    }

    const incoming: StoredRun = {
      ...body,
      steps: body.steps ?? [],
      importedAt: new Date().toISOString(),
    };
    delete (incoming as Partial<{ listCode: string }>).listCode;
    // Render-only fields added by GET (edits, orphanedEdits, and the _edit
    // mark hung on each corrected object) must never be stored as part of
    // dispatch's document. The importer builds from PDFs and does not send
    // them today, but anything that ever round-trips a GET response would,
    // and a stored _edit would then shadow the real patch log.
    stripRenderFields(incoming);

    // A re-send that reaches us AFTER a newer copy must not overwrite it.
    if (!isNewerCopy(incoming, existing)) {
      return json({
        assignment: existing && served(existing),
        applied: false,
        reason: "a newer copy is already stored",
      });
    }

    // What dispatch changed (changes.ts) is counted from the copy the list
    // last OK'd: a second re-send before anyone looked adds to the first, and
    // once they had, the OK'd copy is what the next change is measured from.
    // A reprint that changes nothing keeps it all as it was, the OK included.
    let told: { same?: true; changes?: number; since?: string | null } = {};
    if (existing) {
      const seen = Boolean(existing.printedAt) && (list.seen?.[existing.number] === existing.printedAt
        || existing.seenPrintedAt === existing.printedAt);
      if (sameContent(existing, incoming)) {
        if (existing.base) incoming.base = existing.base;
        if (seen) incoming.seenPrintedAt = incoming.printedAt ?? null;
        told = { same: true };
      } else {
        incoming.base = !existing.base || seen ? baseOf(existing) : existing.base;
        const counted = diffCopies(incoming.base, incoming);
        told = { changes: counted.count, since: counted.since };
      }
    }

    // `end` rides in the key's metadata so the retention sweep can date a
    // run from the listing alone.
    await env.FLIGHT_DATA.put(key, JSON.stringify(incoming), { metadata: { end: incoming.end } });

    // Track every flight the assignment references, deduped: a passenger
    // appears at both their pickup and their drop-off, which is one flight.
    // With the sheet's time, so the first check is planned without a lookup.
    // A flight the list learned the airline of is one of them.
    // A re-send that moves a flight's printed time plans its first check
    // again (retimeChecks): told by what the copy before it printed.
    const airlines = await airlinesOf(env, list);
    const tracked = await trackFlightsOf(env, body.listCode, withLearned(incoming, airlines),
      existing ? checkMetaOf(withLearned(served(existing), airlines)) : undefined);
    await bump(env, body.listCode);

    return json({
      assignment: served(incoming),
      applied: true,
      replaced: Boolean(existing),
      flightsTracked: tracked,
      ...told,
    });
  }

  // POST /api/assignments/seen — the list has read what dispatch changed on
  // one copy of a run: its chip and its panel go on every phone on the list,
  // and the marks on the stops stay until dispatch's next change.
  //
  // Kept in the LIST's record, never written into the run: KV reads can lag a
  // write made elsewhere, and writing a run back could put an older copy over
  // the newer one another phone had just imported. Here a lost race only
  // brings a panel back. 2 gets + 2 writes (the list, its stamp).
  if (request.method === "POST" && url.pathname === "/api/assignments/seen") {
    const body = await readListBody<{ listCode?: string; number?: unknown; printedAt?: unknown }>();
    if (!body.listCode) return json({ error: "listCode is required" }, 400);
    checkSeen(body as unknown as Record<string, unknown>);
    const list = await knownList(body.listCode);
    if (!list) return json({ error: "Unknown listCode" }, 404);
    const number = String(body.number);
    const stored = await getJSON<StoredRun | null>(env, assignmentKey(body.listCode, number), null);
    if (!stored) return json({ error: "Unknown assignment" }, 404);
    // The copy the driver read, only: an OK says nothing about a newer one.
    if (!stored.printedAt || stored.printedAt !== body.printedAt) {
      return json({ error: "a newer copy is stored", printedAt: stored.printedAt ?? null }, 409);
    }
    if (list.seen?.[number] !== stored.printedAt) {
      // Runs are deleted by retention without touching the list record, so
      // the oldest OKs make room (their prints sort as they were made).
      const kept = Object.entries({ ...(list.seen ?? {}), [number]: stored.printedAt })
        .sort((a, b) => b[1].localeCompare(a[1])).slice(0, MAX_SEEN);
      list.seen = Object.fromEntries(kept);
      await saveList(env, body.listCode, list);
      await bump(env, body.listCode);
    }
    return json({ ok: true, number, printedAt: stored.printedAt });
  }

  // POST /api/assignments/patches — one driver edit: a corrected field, a
  // row that is not happening, or a passenger or stop dispatch added by phone.
  //
  // Authorised by listCode alone, like every other per-list route; WRITE_TOKEN
  // guards only the two shared /api/travel-times routes.
  if (request.method === "POST" && url.pathname === "/api/assignments/patches") {
    const body = await readListBody<Partial<Patch> & PatchRequest & {
      listCode?: string;
      number?: string;
      basis?: string | null;
    }>(MAX_PATCH_BYTES);
    if (!body.listCode) return json({ error: "listCode is required" }, 400);
    if (!body.number) return json({ error: "number is required" }, 400);
    checkRunKey(body as unknown as Record<string, unknown>);
    if (typeof body.stepIdx !== "number" && !body.at && body.kind !== "addStep" && body.kind !== "addLeg") {
      return json({ error: "at is required" }, 400);
    }
    checkPatch(body as unknown as Record<string, unknown>);
    const list = await knownList(body.listCode);
    if (!list) return json({ error: "Unknown listCode" }, 404);

    const stored = await getJSON<Assignment | null>(
      env, assignmentKey(body.listCode, body.number), null
    );
    if (!stored) return json({ error: "Unknown assignment" }, 404);

    // The client names the row by its address in dispatch's copy (or by the
    // patch that added it) and the target is computed HERE, from the
    // server's own copy -- one implementation of targetFor/nameKey, not two
    // that drift. `basis` guards only the first kind: a row the driver added
    // is not in any sheet, so no re-import can move it.
    const offSheet = body.kind === "addStep" || body.kind === "addLeg" || String(body.at ?? "").startsWith("+");
    const older = await listPatches(env, body.listCode, body.number);
    const admission = admitPatch(stored, older, offSheet ? null : body.basis, body.ref);
    if (admission.kind === "duplicate") {
      const { edits, orphaned, changes } = applyPatches(stored, older);
      return json({ patch: admission.patch, edits, orphaned, changes, duplicate: true }, 200);
    }
    if (admission.kind === "stale") {
      return json({ error: "the sheet changed since this edit was made", stale: true }, 409);
    }

    if (older.length >= MAX_PATCHES) {
      return json({ error: `this run has ${MAX_PATCHES} changes, the most it can hold: undo one first` }, 413);
    }

    const aim = aimPatch(stored, body);
    if ("error" in aim) return json({ error: aim.error }, 400);

    const kind = body.kind ?? "field";
    const patch: Patch = {
      id: newPatchId(randomHex(2)),
      at: new Date().toISOString(),
      by: clip(body.by, 40),
      ref: body.ref ?? null,
    };
    if (kind !== "field") patch.kind = kind;
    if (aim.target) patch.target = aim.target;
    if (kind === "field") {
      const field = body.field!;
      patch.field = field;
      const value = clip(body.value, FIELD_MAX[field] ?? 120);
      patch.value = field === "flightNumber" ? normFlight(value) : value;
      // What the sheet said, kept as sent (not trimmed): it is compared with
      // the document to tell a dispatch correction from the driver's own.
      patch.was = typeof body.was === "string" ? body.was.slice(0, MAX_STRING) : null;
    } else if (kind === "remove") {
      patch.label = clip(body.label, 80);
    } else if (kind === "addEntity") {
      const e = body.entity!;
      patch.entity = {
        name: clip(e.name, 80)!,
        flightNumber: normFlight(clip(e.flightNumber, 12)),
        phone: clip(e.phone, 40),
        note: clip(e.note, 200),
        tag: clip(e.tag, 4),
      };
    } else if (kind === "addStep") {
      patch.step = aim.step;
    } else if (kind === "addLeg") {
      patch.leg = aim.leg;
    }
    // The run as it reads with this change, worked out before the change is
    // written. The patch is appended to the log IN MEMORY rather than re-read:
    // KV does not guarantee read-after-write, and listing after the write
    // returned the log without it -- so the new flight number was not
    // applied, flightsOf() saw only the old flights, and the corrected flight
    // was never registered. The log was listed before the write, and the id
    // is sortable and newest, so appending is the correct order.
    const changed = structuredClone(stored);
    const { edits, orphaned, changes } = applyPatches(changed, [...older, patch]);

    // A sheet may name MAX_FLIGHTS flights, and corrections are held to the
    // same: each flight a run names is tracked, and its checks are paid from
    // the month's lookups every list shares. A change that would name one
    // more past that is refused; one that names no new flight (a door, a
    // phone, one flight for another) never is, whatever the run already has.
    const named = flightsOf(changed);
    if (named.length > MAX_FLIGHTS) {
      applyPatches(stored, older);
      const before = new Set(flightsOf(stored).map(flightIdOf));
      if (named.some((f) => !before.has(flightIdOf(f)))) {
        return json({ error: `this run meets ${MAX_FLIGHTS} flights, the most a run can: this change would add another` }, 413);
      }
    }

    await putPatch(env, patchKey(body.listCode, body.number, patch.id), patch);
    await bump(env, body.listCode);

    // Register whatever flights the run now references: a corrected flight
    // number is only useful if cron polls it. A flight it no longer names is
    // left as it is: cron asks who meets a flight before each check (tick).
    const tracked = await trackFlightsOf(env, body.listCode, changed);

    return json({ patch, edits, orphaned, changes, flightsTracked: tracked }, 201);
  }

  // DELETE /api/assignments/patches — drop one correction, by id. This is
  // "use the sheet" on a contested field: dispatch's value returns.
  if (request.method === "DELETE" && url.pathname === "/api/assignments/patches") {
    const body = await readListBody<{
      listCode?: string; number?: string; id?: string;
    }>();
    if (!body.listCode || !body.number || !body.id) {
      return json({ error: "listCode, number and id are required" }, 400);
    }
    checkRunKey(body, true);
    const list = await knownList(body.listCode);
    if (!list) return json({ error: "Unknown listCode" }, 404);
    // One list (the patch rides in its key's metadata, so no gets), which
    // also finds any other copy of the same edit: a replay that KV's list
    // lag let through writes a second patch with the same ref, and undoing
    // one copy must undo the edit. A patch too new to be listed yet is read
    // by its key, as before.
    const log = await listPatches(env, body.listCode, body.number);
    const found = log.find((p) => p.id === body.id)
      ?? await getJSON<Patch | null>(env, patchKey(body.listCode, body.number, body.id), null);
    if (!found) return json({ error: "Unknown patch" }, 404);
    const ids = new Set([body.id]);
    if (found.ref) for (const p of log) if (p.ref === found.ref) ids.add(p.id);
    for (const id of ids) await env.FLIGHT_DATA.delete(patchKey(body.listCode, body.number, id));
    await bump(env, body.listCode);

    // A "not happening" undone, or a flight fix undone, gives the run a
    // flight back, and cron may have let that flight go meanwhile (tick: a
    // flight nobody meets through its last check). It is tracked again here,
    // where no list lag can hide the undo: the log was listed before the
    // delete and the patch is left out of it in memory. Any other undo names
    // no flight the run did not name, and costs what it did. 2 gets (the
    // run, the catalog) and one per flight.
    const gone = [found, ...log.filter((p) => ids.has(p.id))];
    if (gone.some((p) => p.kind === "remove" || p.field === "flightNumber")) {
      const stored = await getJSON<Assignment | null>(env, assignmentKey(body.listCode, body.number), null);
      if (stored) {
        applyPatches(stored, log.filter((p) => !ids.has(p.id)));
        applyLearned(stored, await airlinesOf(env, list));
        await trackFlightsOf(env, body.listCode, stored);
      }
    }
    return json({ ok: true, deleted: ids.size });
  }

  // GET /api/assignments — every assignment on a list, soonest first.
  if (request.method === "GET" && url.pathname === "/api/assignments") {
    const listCode = sentCode();
    if (!listCode) return json({ error: "listCode is required" }, 400);
    const list = await knownList(listCode);
    if (!list) return json({ error: "Unknown listCode" }, 404);

    // The keeper's places and airlines come with every list's runs (shared.ts).
    // A catalog not yet written is made from the keeper's list on its own read.
    const keeper = isKeeper(env, list);
    const own = resolveSettings(list.settings);
    let catalog = await catalogOf(env);
    if (keeper && !catalog && (own.places.length || own.airlines.length)) {
      catalog = catalogFrom(own.places, own.airlines, null, new Date().toISOString());
      await putJSON(env, CATALOG_KEY, catalog);
    }
    const assignments = await assignmentsOf(env, listCode, list.seen ?? {}, mergeAirlines(own.airlines, catalog?.airlines));

    // A flight filled in by an airline the catalog learned AFTER the run was
    // imported is shown but not yet polled. Once per change of the catalog's
    // airlines, each list tracks its learned flights; its mark is its own key,
    // so the list record is never rewritten on a read.
    if (!keeper && catalog?.airlinesAt && catalog.airlines.length) {
      const learned = assignments.filter((run) => run.steps.some((s) => s.actions.some((a) =>
        a.entities.some((e) => (e as { _learned?: unknown })._learned))));
      if (learned.length && (await env.FLIGHT_DATA.get(sharedSeenKey(listCode))) !== catalog.airlinesAt) {
        for (const run of learned) await trackFlightsOf(env, listCode, run);
        await env.FLIGHT_DATA.put(sharedSeenKey(listCode), catalog.airlinesAt);
      }
    }

    // Live status for every flight referenced, so the client renders an
    // itinerary without a request per passenger. A flight from yesterday on
    // also has its trackers read: two lists saving one flight's trackers at
    // once can lose one (review B8, a read-modify-write on one key), and the
    // list that lost it would get no pushes. Each load puts its own back: a
    // get per flight, a write only when one was lost.
    const statuses: Record<string, FlightStatus> = {};
    const asked = new Set<string>();
    const since = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
    let healed = 0;
    for (const assignment of assignments) {
      const meta = checkMetaOf(assignment);
      for (const flight of flightsOf(assignment)) {
        const id = `${flight.flightNumber}:${flight.date}`;
        if (asked.has(id)) continue;
        asked.add(id);
        const status = await getJSON<FlightStatus | null>(env, flightKey(flight), null);
        if (status) statuses[id] = status;
        if (flight.date < since) continue;
        const trackers = await getTrackers(env, flight);
        if (trackers.includes(listCode)) continue;
        await addToAllTracked(env, flight, meta.get(id));
        await saveTrackers(env, flight, [...trackers, listCode]);
        healed++;
      }
    }
    // A count only (B5): how often the race happens in real use.
    if (healed) console.log(`Tracking restored for ${healed} flight(s)`);

    return json({
      assignments,
      statuses,
      ntfyTopic: await topicOf(env, listCode, list),
      // The key a phone turns alerts on with (webpush.ts); null when the
      // server has none, and alerts go by ntfy alone.
      pushKey: vapidOf(env)?.publicKey ?? null,
      settings: resolveSettings(list.settings),
      // Sent with the list so the client can work out a drive time for a job
      // typed in by hand, where there is no document to ask.
      travelTimes: await getJSON<TravelTimes | null>(env, TRAVEL_TIMES_KEY, null),
      // "ok", "low" (only the check before landing), or "paused" until a date.
      flightChecks: checksView(currentBudget(await getJSON<Budget | null>(env, BUDGET_KEY, null), Date.now())),
      // What the phone compares with GET /api/stamp each minute.
      stamp: await stampOf(env, listCode),
      // Every driver's defaults; the keeper's phone also gets what other
      // drivers added, to add for everyone or dismiss.
      shared: { places: catalog?.places ?? [], airlines: catalog?.airlines ?? [] },
      ...(keeper ? {
        keeper: true,
        suggestions: (await getJSON<Suggestions | null>(env, SUGGESTIONS_KEY, null))?.items ?? [],
      } : {}),
    });
  }

  // GET /api/stamp — has anything on this list changed? The phones ask every
  // minute while open, so it is ONE read: no list(), and no look at the list
  // record either. An unknown code and a list nothing was written to since
  // stamps began both answer null, so this tells nobody which codes exist.
  if (request.method === "GET" && url.pathname === "/api/stamp") {
    const listCode = headerCode;
    if (!listCode) return json({ error: "listCode is required" }, 400);
    // Answered without a read, and like a code nobody has: not a code's shape.
    if (!isListCode(listCode)) return json({ stamp: null });
    return json({ stamp: await stampOf(env, listCode) });
  }

  // POST /api/suggestions — the keeper dismisses what another driver added
  // (shared.ts). Adding it for everyone is an ordinary save on the keeper's
  // list. Anyone else's list is refused. 2 gets + 1 write.
  if (request.method === "POST" && url.pathname === "/api/suggestions") {
    const body = await readListBody<{ listCode?: string; id?: unknown }>();
    if (!body.listCode) return json({ error: "listCode is required" }, 400);
    if (typeof body.id !== "string" || !/^[0-9a-f]{8}$/.test(body.id)) {
      return json({ error: "id must be a suggestion's id" }, 400);
    }
    const list = await knownList(body.listCode);
    if (!list) return json({ error: "Unknown listCode" }, 404);
    if (!isKeeper(env, list)) return json({ error: "not this list's to answer" }, 403);
    const left = dismiss(await getJSON<Suggestions | null>(env, SUGGESTIONS_KEY, null), body.id);
    if (left) {
      await putJSON(env, SUGGESTIONS_KEY, left);
      await bump(env, body.listCode);
    }
    return json({ ok: true, dismissed: Boolean(left) });
  }

  // DELETE /api/assignments — remove one from a list.
  if (request.method === "DELETE" && url.pathname === "/api/assignments") {
    const body = await readListBody<{ listCode?: string; number?: string }>();
    if (!body.listCode || !body.number) {
      return json({ error: "listCode and number are required" }, 400);
    }
    checkRunKey(body);
    const list = await knownList(body.listCode);
    if (!list) return json({ error: "Unknown listCode" }, 404);
    const key = assignmentKey(body.listCode, body.number);
    const existing = await getJSON<Assignment | null>(env, key, null);
    if (!existing) return json({ error: "Unknown assignment" }, 404);

    const purged = await removeAssignment(env, body.listCode, body.number, existing,
      await airlinesOf(env, list));
    await bump(env, body.listCode);
    return json({ ok: true, patchesPurged: purged });
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const counted = countingKV(env.FLIGHT_DATA);
    try {
      return await route(request, { ...env, FLIGHT_DATA: counted.kv });
    } catch (err) {
      if (err instanceof Refusal) return json({ error: err.message }, err.status);
      // Anything else is ours, and still answers with CORS headers, so the
      // phone reads an error instead of an opaque network failure.
      console.error(`${request.method} ${new URL(request.url).pathname} failed:`, err);
      return json({ error: "internal error" }, 500);
    } finally {
      const line = kvLine(routeName(request.method, new URL(request.url).pathname), counted.ops);
      if (line && onWorkers()) console.log(line);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const counted = countingKV(env.FLIGHT_DATA);
    try {
      await tick(event, { ...env, FLIGHT_DATA: counted.kv });
    } finally {
      const line = kvLine("cron", counted.ops);
      if (line && onWorkers()) console.log(line);
    }
  },
};

/** One cron tick: retention at 08:00 UTC, then the flight checks that are due. */
async function tick(event: ScheduledEvent, env: Env): Promise<void> {
    // Retention, once a day: the tick in 08:00 UTC's first twenty minutes
    // (4 AM in New York in summer, 3 AM in winter), after the overnight runs.
    // A missed day is caught the next; the shortest window is two days.
    const tick = new Date(event.scheduledTime);
    if (tick.getUTCHours() === 8 && tick.getUTCMinutes() < 20) {
      try {
        const gone = await sweep(
          env.FLIGHT_DATA,
          event.scheduledTime,
          async (code) => retentionDays(resolveSettings((await getList(env, code))?.settings).retentionDays),
          async (code, number, stored) => {
            await removeAssignment(env, code, number, stored as Assignment,
              await airlinesOf(env, await getList(env, code)));
          },
        );
        // A count only: a list code in a log is a key to the list (B5).
        if (gone.length) console.log(`Retention removed ${gone.length} run(s)`);
        // "<list>:<number>": each list that lost a run shows it gone.
        for (const code of new Set(gone.map((g) => g.slice(0, g.indexOf(":"))))) await bump(env, code);
      } catch (err) {
        console.error("Retention sweep failed:", err);
      }
    }

    const migrated = await migrateSharedPollSet(env);
    if (migrated) {
      console.log(`Migrated ${migrated} flight(s) off the shared poll key`);
    }

    const tracked = await getAllTracked(env);
    const now = Date.now();

    // Cron wakes every 20 minutes (that part is free) and looks a flight up
    // only when its next check is due: three for an arrival, one for a
    // departure (checks.ts). A flight with no plan yet, or one from before
    // the plans, is planned here from what is already known, the sheet's time
    // or the last status, without a lookup.
    type Due = { flight: Tracked; plan: Plan; prev: FlightStatus | null; trackers?: string[] };
    let due: Due[] = [];
    await Promise.all(tracked.map(async (flight) => {
      let plan = readPlan(await getSchedule(env, flight));
      if (plan === DONE || (plan && Date.parse(plan.at) > now)) return;
      const prev = await getJSON<FlightStatus | null>(env, flightKey(flight), null);
      if (!plan) {
        const first = planNext(anchorsOf(flight.meta, prev), [], now);
        await setSchedule(env, flight, writePlan(first));
        if (first === DONE) return;
        plan = first;
      }
      if (Date.parse(plan.at) <= now) due.push({ flight, plan, prev });
    }));
    if (!due.length) return;

    // The free plan's units: counted here, never run into. Near the end only
    // the checks before landing are made, then none (checks.ts).
    const budget = currentBudget(await getJSON<Budget | null>(env, BUDGET_KEY, null), now);

    // Who meets each flight, asked before a unit is spent on it (v69). A
    // passenger marked not coming, a flight number corrected away, a sheet
    // re-sent without the flight: the flight stays tracked, and until now
    // went on being looked up (up to 6 units of the month's 400) for nobody.
    //
    // Asked HERE and not when the change is made: KV's lists lag a write by
    // seconds, a phone sends its changes back to back, and a flight wrongly
    // let go at one of them would be a flight on the screen that is never
    // checked again. Here the lists have long settled, and to be sure a
    // flight nobody meets is only marked at the first tick; the tick after
    // (20 minutes on) passes its check without a lookup. So an UNDO in
    // between loses nothing, and a run imported seconds before a tick is
    // never read as absent. When no check is left, the flight is let go: its
    // keys are deleted, and an UNDO or the next load tracks it afresh.
    //
    // The cost: each list tracking a due flight is read once (runsReader),
    // and the pushes below are written from the same read. Not at all when
    // the month's units are spent: then nothing is looked up anyway.
    const runsOf = runsReader(env);
    let unmet = 0;
    if (allowChecks(budget, due.map((d) => d.plan.rung)).some(Boolean)) {
      const met = await Promise.all(due.map(async (d) => {
        d.trackers = await getTrackers(env, d.flight);
        const id = flightIdOf(d.flight);
        const meets = await Promise.all(d.trackers.map(async (code) => {
          try {
            return (await runsOf(code)).runs.some((run) => flightsOf(run).some((f) => flightIdOf(f) === id));
          } catch (err) {
            // A list that cannot be read is not a list that dropped the flight.
            console.error(`Couldn't read a list to ask who meets ${d.flight.flightNumber}:`, err instanceof Error ? err.message : "unknown");
            return true;
          }
        }));
        return meets.some(Boolean);
      }));
      await Promise.all(due.map(async ({ flight, plan, prev }, i) => {
        if (met[i]) return;
        unmet++;
        try {
          if (!plan.unmet) {
            await setSchedule(env, flight, writePlan({ ...plan, unmet: 1 }));
            return;
          }
          const next = planNext(anchorsOf(flight.meta, prev), [...plan.done, plan.rung], now, plan.miss ?? 0);
          if (next !== DONE) {
            await setSchedule(env, flight, writePlan(next));
            return;
          }
          await saveTrackers(env, flight, []);
          await removeFromAllTrackedIfOrphaned(env, flight, []);
        } catch (err) {
          // Not written (the day's KV writes are spent): it is asked about
          // again at the next tick, and not looked up at this one either way.
          console.error(`Couldn't pass the check of ${flight.flightNumber}, which no run meets:`, err instanceof Error ? err.message : "unknown");
        }
      }));
      // Met again (an UNDO): the mark goes, and the check is made as ever.
      due = due.filter((_, i) => met[i]).map((d) => (d.plan.unmet ? { ...d, plan: { ...d.plan, unmet: undefined } } : d));
      if (!due.length) {
        console.log(`Checks: ${unmet} due for a flight no run meets, none looked up`);
        return;
      }
    }
    const allowed = allowChecks(budget, due.map((d) => d.plan.rung));

    // Nothing is looked up unless this tick can write. A lookup whose answer
    // and next check cannot be stored leaves the flight due, and is paid for
    // again at every tick until it can: with the day's KV writes used up (by
    // this app's lists or anything else on the account) every due flight
    // would be looked up three times an hour, and the month's units could go
    // in a day (security review, 2026-10-04). So the lookups about to be made are
    // counted as spent first, in the one write that proves a write is taken;
    // the tick's last write puts the true count over it.
    const reserved = allowed.filter(Boolean).length * UNITS_PER_LOOKUP;
    if (reserved) {
      try {
        await putJSON(env, BUDGET_KEY, { ...budget, spent: budget.spent + reserved } satisfies Budget);
      } catch (err) {
        console.error("KV took no write, so no flight is looked up this tick:", err instanceof Error ? err.message : "unknown");
        return;
      }
    }
    let spent = 0;
    const quota: { remaining?: number; resetAt?: string } = {};
    const onAnswer = (res: Response) => {
      // A refusal for the quota is not charged, and says there is none left.
      if (res.status === 429) { quota.remaining = 0; return; }
      spent += UNITS_PER_LOOKUP;
      const q = quotaFrom(res.headers, now);
      if (q.remaining !== undefined) quota.remaining = Math.min(quota.remaining ?? Infinity, q.remaining);
      if (q.resetAt) quota.resetAt = q.resetAt;
    };

    // What the tick did, for its one log line (Workers Logs): counts only.
    const tally = { held: 0, looked: 0, unknown: 0, changed: 0, pushes: 0, app: 0, ntfy: 0, unsent: 0, failed: 0 };

    // Independent per-flight, so poll and notify for all of them concurrently
    // instead of paying each flight's KV + AeroDataBox round-trip in sequence.
    await Promise.all(
      due.map(async ({ flight, plan, prev, trackers }, i) => {
        const done = [...plan.done, plan.rung];
        // After a check made, skipped or failed: the next one, from the latest
        // times known. Lookups in a row that find nothing count towards giving
        // up; one that finds the flight starts the count again.
        const moveOn = (status: FlightStatus | null, miss: number) =>
          setSchedule(env, flight, writePlan(
            status && /cancel/i.test(status.status) ? DONE
              : planNext(anchorsOf(flight.meta, status), done, now, miss)));
        const missed = (plan.miss ?? 0) + 1;
        if (!allowed[i]) {
          // Not this month: the units left are kept for checks before landing.
          tally.held++;
          await moveOn(prev, plan.miss ?? 0);
          return;
        }
        let next: FlightStatus | null;
        try {
          next = await fetchFlightStatus(env.AERODATABOX_KEY, flight, onAnswer);
        } catch (err) {
          tally.failed++;
          console.error(`Failed to poll ${flight.flightNumber} (${flight.date}):`, err);
          // The lookup itself failed: AeroDataBox's trouble or the network's,
          // not a flight nobody knows. The same check is tried once more at
          // the next tick; a second failure passes this check and goes on to
          // the one after. Never the whole flight: its landing is still to be
          // looked for, and each check is made at most twice.
          if (missed < MAX_MISSES) await setSchedule(env, flight, writePlan({ ...plan, miss: missed }));
          else await moveOn(prev, 0);
          return;
        }
        try {
          const key = flightKey(flight);
          tally.looked++;
          if (!next) {
            // Unknown to AeroDataBox: the next check tries once more, then no more.
            tally.unknown++;
            await moveOn(prev, missed);
            return;
          }

          const changes = diffFlightStatus(prev, next);
          await env.FLIGHT_DATA.put(key, JSON.stringify(next));
          await moveOn(next, 0);

          // Every list that has the flight shows the check: its times when
          // they moved, and "Flights checked just now" when they did not.
          const trackerCodes = trackers ?? await getTrackers(env, flight);
          await Promise.all(trackerCodes.map((code) => bump(env, code)));

          if (changes.length > 0) tally.changed++;

          // What this check is measured from. A later check: the one before
          // it. The first (an import looks nothing up, so nothing is stored):
          // the flight's own timetable, which is what dispatch planned from
          // and all the driver knows. Without that the check made before the
          // driver leaves could never say a delay or a cancellation, and a
          // flight that then stayed as late was never told at all.
          const from = prev ?? asScheduled(next);
          if (!prev && !offSchedule(next)) {
            // On its timetable: nothing to say. A later creep is measured
            // from the timetable, not from here.
            await putJSON(env, toldKey(flight), from);
          } else if (!prev || changes.length > 0) {
            if (!prev) tally.changed++;
            // Each list gets its own pushes, written from that list's own
            // assignment: the stop, the flight, dispatch's figures, sent to
            // the list's own phones and topic. From the runs read when the
            // tick asked who meets the flight.
            const told = prev ? await getJSON<FlightStatus | null>(env, toldKey(flight), null) : null;
            let pushed = false;
            await Promise.all(
              trackerCodes.map(async (code) => {
                try {
                  const { list, runs } = await runsOf(code);
                  const notices = await noticesFor(env, runs, flight, from, next, now, told);
                  if (!notices.length || !list) return;
                  const topic = await topicOf(env, code, list);
                  // One at a time: each may find a phone gone and rewrite
                  // the list's phones.
                  for (const notice of notices) {
                    const sent = await pushTo(env, topic, notice);
                    tally.app += sent.app.length;
                    if (sent.ntfy) tally.ntfy++;
                    if (!delivered(sent)) { tally.unsent++; continue; }
                    tally.pushes++;
                    pushed = true;
                  }
                } catch (err) {
                  console.error(`Couldn't notify a list about ${flight.flightNumber}:`, err);
                }
              })
            );
            // Pushed: the driver now knows `next`. Not pushed: keep the last
            // thing they were told, so the next small move adds to this one.
            if (pushed) await putJSON(env, toldKey(flight), next);
            else if (!told) await putJSON(env, toldKey(flight), from);
          }

          await stopPollingIfLongLanded(env, flight, next);
        } catch (err) {
          tally.failed++;
          console.error(`Couldn't finish the check of ${flight.flightNumber} (${flight.date}):`, err);
          // The lookup was made and paid for; what failed came after it (a
          // write, a push). Never due forever: this check is spent.
          await moveOn(next, 0);
        }
      })
    );

    // One write for the tick's lookups: what they did cost, over what was
    // set aside for them.
    if (reserved || spent || quota.remaining !== undefined) {
      await putJSON(env, BUDGET_KEY, {
        ...budget,
        spent: budget.spent + spent,
        remaining: quota.remaining ?? budget.remaining ?? null,
        resetAt: quota.resetAt ?? budget.resetAt ?? null,
      } satisfies Budget);
    }

    // One line per tick that had flights due, so the logs show the checks and
    // the pushes working, not only failing. Counts only: no flight, no list.
    const left = quota.remaining ?? budget.remaining;
    console.log(`Checks: ${due.length} due, ${tally.looked} looked up (${tally.unknown} unknown), `
      + `${tally.held} held for the budget, ${tally.changed} changed, ${tally.pushes} push(es) sent `
      + `(${tally.app} to phones, ${tally.ntfy} by ntfy), ${tally.unsent} taken by nothing, `
      + `${tally.failed} failed, ${unmet} more that no run meets${left === null || left === undefined ? "" : `; ${left} units left`}`);
}
