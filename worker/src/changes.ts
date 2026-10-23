/**
 * What dispatch changed: one of its copies of a run against an earlier one.
 *
 * Dispatch re-sends a sheet when the run changes -- 35 of 186 real runs, 62
 * re-sends, 13 of which changed nothing but the print time. Each re-send
 * replaces the stored record whole (assignment.ts), so without this the driver
 * holds the new sheet and has to find the difference themselves.
 *
 * Raw against raw: dispatch's copies only, never the driver's corrections --
 * those are the patch log's, applied on read after this has run. The copy
 * compared against is the one the LIST last OK'd (`base`, kept inside the
 * stored record and never served), so changes add up across re-sends until
 * someone says OK, and the marks stay on the stops after it until dispatch's
 * next change (spec "What changed").
 *
 * Counted per place and per person, one each -- a person's pickup and
 * drop-off are one change: the vehicle; the parking; a stop's times; a stop's
 * door, place or address; a stop added or dropped; a person added, dropped or
 * moved; a person's fact (their flight, phone, bags, party, tag, note...); a
 * leg added, dropped, retimed or reworded; the prose notes. The run's own start
 * and end follow its stops, so they count only when no stop changed.
 *
 * Pure: no KV. Never guesses a person: exact normalised names (nameKey), as
 * the patch targeting does.
 */

import type { Assignment } from "./assignment";
import { nameKey, notesLines, wallMinutes } from "./patch";

/* ------------------------------------------------------------ the base -- */

/** The entity fields a copy is compared on: dispatch's, as printed. */
const ENTITY_FIELDS = [
  "name", "pax", "flightNumber", "scheduledText", "flightDate", "phone", "otherPhones", "bags", "note",
  "tag", "gb", "origin", "destination", "appointmentTime", "duration", "route",
] as const;

type Field = (typeof ENTITY_FIELDS)[number];
export type Facts = Partial<Record<Field, unknown>>;

/** A person's facts, by what the driver would call one change: a rebooked
 *  flight moves its number and its time together, and is one. */
const FACTS: Record<string, readonly Field[]> = {
  flight: ["flightNumber", "scheduledText", "flightDate"],
  phone: ["phone", "otherPhones"],
  bags: ["bags"],
  pax: ["pax"],
  tag: ["tag", "gb"],
  note: ["note"],
  appointment: ["appointmentTime", "duration"],
  trip: ["origin", "destination", "route"],
};

export interface BaseAction { verb: string; where: string | null; entities: Facts[] }

export interface BaseStep {
  code: string | null;
  place: string;
  address: string | null;
  eta: string | null;
  etd: string | null;
  date: string;
  etaDate: string;
  actions: BaseAction[];
}

/** The part of a copy that is dispatch's, and nothing the importer or the app
 *  added (issues, importedAt, the driver's name, which no screen shows). */
export interface BaseCopy {
  printedAt: string | null;
  start: string;
  end: string;
  vehicle: string | null;
  parking: string | null;
  driverNotes: string | null;
  steps: BaseStep[];
}

/** A run as stored: dispatch's copy, and what this module keeps beside it. */
export type StoredRun = Assignment & {
  /** Dispatch's copy as of the list's last OK (else its first copy): what the
   *  changes are counted from. Never served. */
  base?: BaseCopy;
  /** A reprint that changed nothing replaced a copy the list had OK'd: the OK
   *  carries over to it. Never served. */
  seenPrintedAt?: string | null;
};

export function baseOf(a: Assignment): BaseCopy {
  const facts = (e: object): Facts => {
    const out: Facts = {};
    for (const f of ENTITY_FIELDS) {
      const v = (e as Record<string, unknown>)[f];
      if (v !== undefined && v !== null) out[f] = v;
    }
    return out;
  };
  return {
    printedAt: a.printedAt ?? null,
    start: a.start,
    end: a.end,
    vehicle: a.vehicle ?? null,
    parking: a.parking ?? null,
    driverNotes: a.driverNotes ?? null,
    steps: (a.steps || []).map((s) => ({
      code: s.code ?? null,
      place: s.place,
      address: s.address ?? null,
      eta: s.eta ?? null,
      etd: s.etd ?? null,
      date: s.date,
      etaDate: s.etaDate ?? s.date,
      actions: (s.actions || []).map((x) => ({
        verb: x.verb,
        where: x.where ?? null,
        entities: (x.entities || []).map(facts),
      })),
    })),
  };
}

/* ----------------------------------------------------------- the answer -- */

export interface Times { eta: string | null; etd: string | null; date: string; etaDate: string }
export interface Door {
  /** The door in the new copy; null for one that is gone. */
  at: string | null;
  was: { verb: string; where: string | null } | null;
  now: { verb: string; where: string | null } | null;
}
/** Where a person was, and where the new copy puts their ghost: the stop and
 *  door that took the old one's place, else nothing (the stop is gone too). */
export interface Gone { step: string | null; action: string | null; verb: string; code: string; to: string | null }
/** A row of theirs the new copy has that the old one did not have there, and
 *  the stop they left for it, when one. */
export interface Here { at: string; code: string; from: string | null }

export type Change =
  | { kind: "vehicle" | "parking"; was: string | null; now: string | null }
  | { kind: "runTimes"; was: { start: string; end: string }; now: { start: string; end: string } }
  | { kind: "times"; at: string; code: string; was: Times; now: Times }
  | {
      kind: "place"; at: string; code: string;
      was: { place?: string; address?: string | null }; now: { place: string; address: string | null };
      doors: Door[];
    }
  | { kind: "stopAdded"; at: string; code: string; place: string }
  | {
      kind: "stopDropped"; after: string | null; code: string; place: string;
      eta: string | null; etd: string | null; date: string; etaDate: string;
    }
  | { kind: "personAdded"; name: string; codes: string[]; rows: string[] }
  | { kind: "personDropped"; name: string; codes: string[]; gone: Gone[] }
  | { kind: "personMoved"; name: string; codes: string[]; here: Here[]; gone: Gone[] }
  | {
      kind: "fact"; fact: string; name: string; codes: string[];
      was: Facts; now: Facts; rows: { at: string; was: Facts }[];
    }
  | { kind: "legAdded"; at: string; line: string }
  | { kind: "legDropped"; line: string }
  | { kind: "legRetimed" | "legReworded"; at: string; was: string; line: string }
  | { kind: "notes"; added: string[]; dropped: string[] };

export interface SheetChanges {
  /** When dispatch printed the copy the changes are counted from. */
  since: string | null;
  count: number;
  /** One per change, in the order the panel lists them. Addresses (`at`) are
   *  the NEW copy's, the ones GET gives its rows (patch.ts `address`). */
  items: Change[];
  /** The run's own start and end as they were, when they moved (the card). */
  run: { start?: string; end?: string };
}

/* ------------------------------------------------------------- helpers -- */

function norm(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(norm).join(" | ");
  return String(v).trim().replace(/\s+/g, " ").toLowerCase();
}

/** Case and spacing drift between prints of the same words; neither is a change. */
function same(a: unknown, b: unknown): boolean {
  return norm(a) === norm(b);
}

/** A stop's time on one running clock, its date folded in. */
function clockOf(s: BaseStep): number | null {
  const eta = wallMinutes(s.eta);
  const etd = wallMinutes(s.etd);
  const day = eta !== null ? s.etaDate || s.date : etd !== null ? s.date : null;
  const m = eta ?? etd;
  if (!day || m === null) return null;
  const [y, mo, d] = day.split("-").map(Number);
  return Date.UTC(y, mo - 1, d) / 60000 + m;
}

function codeOf(s: BaseStep): string {
  return s.code || s.place;
}

/** What makes two stops the same stop: its code, else its printed place. */
function stepKey(s: BaseStep): string {
  return norm(s.code) || norm(s.place);
}

function namesOf(s: BaseStep): Set<string> {
  return new Set(s.actions.flatMap((x) => x.entities.map((e) => nameKey(e.name as string))));
}

function timesOf(s: BaseStep): Times {
  return { eta: s.eta, etd: s.etd, date: s.date, etaDate: s.etaDate };
}

function pick(f: Facts, fields: readonly Field[]): Facts {
  const out: Facts = {};
  for (const k of fields) out[k] = f[k] ?? null;
  return out;
}

/* ------------------------------------------------------------- pairing -- */

/**
 * Old stops to new, in order: a pair needs the same stop (code, else place);
 * it scores more for the same date, each passenger both hold, and a close
 * time. Gaps cost nothing, so every stop that can pair does, and a stop
 * inserted before another of the same code takes the one nearer its own time
 * and passengers. Measured on every re-send in the owner's corpus.
 */
function alignSteps(A: BaseStep[], B: BaseStep[]): [number, number][] {
  const nA = A.map(namesOf), nB = B.map(namesOf);
  const tA = A.map(clockOf), tB = B.map(clockOf);
  const n = A.length, m = B.length;
  const S = Array.from({ length: n }, () => new Array<number>(m).fill(-Infinity));
  const D = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (stepKey(A[i]) === stepKey(B[j])) {
        let shared = 0;
        for (const x of nA[i]) if (nB[j].has(x)) shared++;
        const ta = tA[i], tb = tB[j];
        const dt = ta === null || tb === null ? 0 : Math.min(Math.abs(ta - tb), 600);
        S[i][j] = 10 + (A[i].date === B[j].date ? 2 : 0) + 3 * shared - dt / 120;
      }
      const s = S[i][j];
      D[i][j] = Math.max(D[i + 1][j], D[i][j + 1], s === -Infinity ? -Infinity : s + D[i + 1][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    const s = S[i][j];
    if (s !== -Infinity && D[i][j] === s + D[i + 1][j + 1]) { pairs.push([i, j]); i++; j++; }
    else if (D[i][j] === D[i + 1][j]) i++;
    else j++;
  }
  return pairs;
}

/** A stop's doors, old to new: the same verb and the same people first, the
 *  printed order last. A door with a new verb still pairs by its people. */
function pairActions(a: BaseAction[], b: BaseAction[]): Map<number, number> {
  const cands: [number, number, number][] = [];
  a.forEach((x, i) => {
    const had = new Set(x.entities.map((e) => nameKey(e.name as string)));
    b.forEach((y, j) => {
      let shared = 0;
      for (const e of y.entities) if (had.has(nameKey(e.name as string))) shared++;
      const verb = same(x.verb, y.verb);
      if (!verb && !shared) return;
      cands.push([i, j, (verb ? 4 : 0) + 3 * shared + (same(x.where, y.where) ? 1 : 0) + (i === j ? 0.5 : 0)]);
    });
  });
  cands.sort((p, q) => q[2] - p[2] || p[0] - q[0] || p[1] - q[1]);
  const out = new Map<number, number>();
  const used = new Set<number>();
  for (const [i, j] of cands) {
    if (out.has(i) || used.has(j)) continue;
    out.set(i, j);
    used.add(j);
  }
  return out;
}

interface Row { key: string; name: string; s: number; a: number; e: number; verb: string; code: string; facts: Facts }

function rowsOf(steps: BaseStep[]): Row[] {
  const rows: Row[] = [];
  steps.forEach((st, s) => st.actions.forEach((x, a) => x.entities.forEach((f, e) => {
    rows.push({ key: nameKey(f.name as string), name: String(f.name ?? ""), s, a, e, verb: x.verb, code: codeOf(st), facts: f });
  })));
  return rows;
}

function codesOf(rows: Row[]): string[] {
  return [...new Set(rows.map((r) => r.code))];
}

/** A person's rows that left one place and arrived at another: the same verb
 *  first (a pickup moved is a pickup), then in the printed order. */
function matchMoves(left: Row[], arrived: Row[]): Map<Row, Row> {
  const out = new Map<Row, Row>();
  const free = [...arrived];
  for (const pass of [true, false]) {
    for (const r of left) {
      if (out.has(r)) continue;
      const k = free.findIndex((x) => !pass || same(x.verb, r.verb));
      if (k >= 0) out.set(r, free.splice(k, 1)[0]);
    }
  }
  return out;
}

/* --------------------------------------------------------------- lines -- */

// A timed notes line as the phone reads one (timedLine in assignments.js):
// its time as printed, then the words.
const LEG = /^(\d{1,2}):(\d{2})((?:\s?[ap]m?)?\*?)\s+(\S.*)$/i;

function legParts(line: string): { time: string; words: string } | null {
  const m = LEG.exec(line.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return { time: `${m[1]}:${m[2]}${m[3]}`.toLowerCase().replace(/\s+/g, ""), words: m[4] };
}

/* ---------------------------------------------------------------- diff -- */

/**
 * Everything dispatch changed from `base` to `current`, one entry per change.
 * `current` is the stored copy exactly as dispatch sent it: call this before
 * the driver's corrections are applied to it (applyPatches mutates).
 */
export function diffCopies(base: BaseCopy, current: Assignment): SheetChanges {
  const A = base;
  const B = baseOf(current);
  const A_steps = A.steps || [];
  const run: SheetChanges["run"] = {};
  const head: Change[] = [];
  if (!same(A.vehicle, B.vehicle)) head.push({ kind: "vehicle", was: A.vehicle, now: B.vehicle });
  if (!same(A.parking, B.parking)) head.push({ kind: "parking", was: A.parking, now: B.parking });
  if (!same(A.start, B.start)) run.start = A.start;
  if (!same(A.end, B.end)) run.end = A.end;

  /* The stops. */
  const pairs = alignSteps(A_steps, B.steps);
  const stepMap = new Map(pairs);
  const matchedNew = new Set(pairs.map(([, j]) => j));
  const actMaps = new Map<number, Map<number, number>>();
  for (const [i, j] of pairs) actMaps.set(i, pairActions(A_steps[i].actions, B.steps[j].actions));

  const perStop: Change[][] = B.steps.map(() => []);
  const dropped = new Map<string, Change[]>(); // "" = before every stop
  let stopsChanged = false;
  let lastNew: number | null = null;
  A_steps.forEach((a, i) => {
    const j = stepMap.get(i);
    if (j === undefined) {
      stopsChanged = true;
      const after = lastNew === null ? null : String(lastNew);
      const list = dropped.get(after ?? "") ?? [];
      list.push({
        kind: "stopDropped", after, code: codeOf(a), place: a.place,
        eta: a.eta, etd: a.etd, date: a.date, etaDate: a.etaDate,
      });
      dropped.set(after ?? "", list);
      return;
    }
    lastNew = j;
    const b = B.steps[j];
    if (!same(a.eta, b.eta) || !same(a.etd, b.etd) || !same(a.date, b.date) || !same(a.etaDate, b.etaDate)) {
      stopsChanged = true;
      perStop[j].push({ kind: "times", at: String(j), code: codeOf(b), was: timesOf(a), now: timesOf(b) });
    }
    const am = actMaps.get(i)!;
    const doors: Door[] = [];
    a.actions.forEach((x, ai) => {
      const bj = am.get(ai);
      // A door nobody is under: its people (none) cannot say it moved.
      if (bj === undefined) {
        if (!x.entities.length) doors.push({ at: null, was: { verb: x.verb, where: x.where }, now: null });
        return;
      }
      const y = b.actions[bj];
      if (!same(x.where, y.where) || !same(x.verb, y.verb)) {
        doors.push({ at: `${j}.${bj}`, was: { verb: x.verb, where: x.where }, now: { verb: y.verb, where: y.where } });
      }
    });
    const taken = new Set(am.values());
    b.actions.forEach((y, bj) => {
      if (!taken.has(bj) && !y.entities.length) doors.push({ at: `${j}.${bj}`, was: null, now: { verb: y.verb, where: y.where } });
    });
    const was: { place?: string; address?: string | null } = {};
    if (!same(a.place, b.place)) was.place = a.place;
    if (!same(a.address, b.address)) was.address = a.address;
    if (doors.length || Object.keys(was).length) {
      perStop[j].push({ kind: "place", at: String(j), code: codeOf(b), was, now: { place: b.place, address: b.address }, doors });
    }
  });
  B.steps.forEach((b, j) => {
    if (matchedNew.has(j)) return;
    stopsChanged = true;
    perStop[j].unshift({ kind: "stopAdded", at: String(j), code: codeOf(b), place: b.place });
  });
  const stops: Change[] = [...(dropped.get("") ?? [])];
  perStop.forEach((list, j) => stops.push(...list, ...(dropped.get(String(j)) ?? [])));

  // The run's start and end move with its stops; said on their own only when
  // no stop changed, so a moved end is never a change that shows nowhere.
  if ((run.start || run.end) && !stopsChanged) {
    head.push({ kind: "runTimes", was: { start: A.start, end: A.end }, now: { start: B.start, end: B.end } });
  }

  /* The people. */
  const rowsA = rowsOf(A_steps), rowsB = rowsOf(B.steps);
  // Every row a door has under one name, in the printed order: dispatch does
  // print a name twice, and the second is a row of its own, not the first
  // moved (a reprint of such a sheet used to count as a change).
  const newAt = new Map<string, Row[]>();
  for (const r of rowsB) {
    const k = `${r.s}.${r.a}|${r.key}`;
    newAt.set(k, [...(newAt.get(k) ?? []), r]);
  }
  const stayed = new Map<Row, Row>(); // old row -> the new row at the same place
  const kept = new Set<Row>();
  for (const r of rowsA) {
    const j = stepMap.get(r.s);
    const bj = j === undefined ? undefined : actMaps.get(r.s)!.get(r.a);
    const hit = bj === undefined ? undefined : (newAt.get(`${j}.${bj}|${r.key}`) ?? []).find((x) => !kept.has(x));
    if (hit) { stayed.set(r, hit); kept.add(hit); }
  }
  const at = (r: Row) => `${r.s}.${r.a}.${r.e}`;
  const goneOf = (r: Row, to: string | null): Gone => {
    const j = stepMap.get(r.s);
    const bj = j === undefined ? undefined : actMaps.get(r.s)!.get(r.a);
    return {
      step: j === undefined ? null : String(j),
      action: bj === undefined ? null : `${j}.${bj}`,
      verb: r.verb, code: r.code, to,
    };
  };

  const people: Change[] = [];
  for (const key of new Set([...rowsB.map((r) => r.key), ...rowsA.map((r) => r.key)])) {
    const olds = rowsA.filter((r) => r.key === key);
    const news = rowsB.filter((r) => r.key === key);
    const name = (news[0] ?? olds[0]).name;
    if (!olds.length) { people.push({ kind: "personAdded", name, codes: codesOf(news), rows: news.map(at) }); continue; }
    if (!news.length) { people.push({ kind: "personDropped", name, codes: codesOf(olds), gone: olds.map((r) => goneOf(r, null)) }); continue; }
    const compared: [Row, Row][] = olds.filter((r) => stayed.has(r)).map((r) => [r, stayed.get(r)!]);
    const left = olds.filter((r) => !stayed.has(r));
    const arrived = news.filter((r) => !kept.has(r));
    if (left.length || arrived.length) {
      const moves = matchMoves(left, arrived);
      const fromOf = new Map([...moves].map(([o, n]) => [n, o.code]));
      people.push({
        kind: "personMoved", name, codes: codesOf(news),
        here: arrived.map((r) => ({ at: at(r), code: r.code, from: fromOf.get(r) ?? null })),
        gone: left.map((r) => goneOf(r, moves.get(r)?.code ?? null)),
      });
      compared.push(...moves);
    }
    for (const [fact, fields] of Object.entries(FACTS)) {
      const changed = compared.filter(([o, n]) => fields.some((f) => !same(o.facts[f], n.facts[f])));
      if (!changed.length) continue;
      const [o, n] = changed[0];
      people.push({
        kind: "fact", fact, name, codes: codesOf(news),
        was: pick(o.facts, fields), now: pick(n.facts, fields),
        rows: changed.map(([x, y]) => ({ at: at(y), was: pick(x.facts, fields) })),
      });
    }
  }

  /* The notes: legs line by line, the prose as one. */
  const la = notesLines(A.driverNotes), lb = notesLines(B.driverNotes);
  const usedA = new Set<number>(), usedB = new Set<number>();
  lb.forEach((t, k) => {
    const i = la.findIndex((u, x) => !usedA.has(x) && same(u, t));
    if (i >= 0) { usedA.add(i); usedB.add(k); }
  });
  const legs: [number, Change][] = [];
  // The same words at a new time: retimed.
  lb.forEach((t, k) => {
    const p = usedB.has(k) ? null : legParts(t);
    if (!p) return;
    const i = la.findIndex((u, x) => {
      const q = usedA.has(x) ? null : legParts(u);
      return Boolean(q) && same(q!.words, p.words);
    });
    if (i < 0) return;
    usedA.add(i); usedB.add(k);
    legs.push([k, { kind: "legRetimed", at: `n${k}`, was: la[i], line: t }]);
  });
  // New words at the same time, when only one line on each side has it: reworded.
  const restA = la.map((u, x) => ({ x, p: usedA.has(x) ? null : legParts(u) })).filter((r) => r.p);
  const restB = lb.map((t, k) => ({ k, p: usedB.has(k) ? null : legParts(t) })).filter((r) => r.p);
  for (const { k, p } of restB) {
    const olds = restA.filter((r) => r.p!.time === p!.time);
    const news = restB.filter((r) => r.p!.time === p!.time);
    if (olds.length !== 1 || news.length !== 1) continue;
    usedA.add(olds[0].x); usedB.add(k);
    legs.push([k, { kind: "legReworded", at: `n${k}`, was: la[olds[0].x], line: lb[k] }]);
  }
  const added: string[] = [];
  const gone: string[] = [];
  lb.forEach((t, k) => {
    if (usedB.has(k)) return;
    if (legParts(t)) legs.push([k, { kind: "legAdded", at: `n${k}`, line: t }]);
    else added.push(t);
  });
  la.forEach((u, x) => {
    if (usedA.has(x)) return;
    if (legParts(u)) legs.push([lb.length + x, { kind: "legDropped", line: u }]);
    else gone.push(u);
  });
  legs.sort((p, q) => p[0] - q[0]);

  const items = [...head, ...stops, ...people, ...legs.map(([, c]) => c)];
  if (added.length || gone.length) items.push({ kind: "notes", added, dropped: gone });
  return { since: A.printedAt, count: items.length, items, run };
}

/** Nothing a driver could see differs: a reprint. */
export function sameContent(a: Assignment, b: Assignment): boolean {
  return diffCopies(baseOf(a), b).count === 0;
}
