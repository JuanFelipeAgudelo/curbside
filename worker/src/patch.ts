/**
 * Manual corrections, as an ordered log that survives the next PDF.
 *
 * The importer refuses to guess: an airline it cannot resolve leaves the flight
 * number blank, a door dispatch left empty stays empty, a passenger with no
 * printed number shows none. Two in five real assignments carry at least one
 * such gap. This is how a driver closes one — and how the correction survives
 * `POST /api/assignments`, which is a whole-record replace that never merges.
 *
 * So patches are NEVER written into the assignment. They live in their own
 * keys, are re-resolved against whatever document is current, and are applied
 * on read. Dispatch's record stays exactly as dispatch sent it.
 *
 * THE HARD PART IS TARGETING. Nothing below `Assignment.number` has a stable
 * identity -- `Step`, `Action` and `Entity` carry no id, steps are addressed by
 * array index and entities by name. A patch therefore names its target by
 * content, and the whole design question is what happens when that content
 * moves.
 *
 * The rule, which is the project's existing rule applied to targeting:
 * **never guess.** An ambiguous target orphans and is surfaced. It does not
 * resolve to its best candidate, because the failure mode of guessing here is a
 * correction silently landing on the wrong stop.
 */

import type { Action, Assignment, Entity, Step } from "./assignment";

/* ------------------------------------------------------------- anchors -- */

export interface StepAnchor {
  /** `${code ?? place}|${date}` — what identifies the stop. */
  key: string;
  /** Index among steps sharing that key, NOT a global index. A stop inserted
   *  elsewhere therefore does not renumber the second WRK. */
  nth: number;
  /** How many steps shared the key when the patch was written.
   *
   *  This is not redundant, it is the entire safety mechanism. Measured against
   *  real fixture 334184 (WRK -> TUX -> NCB -> TUX -> WRK):
   *
   *    a stop INSERTED mid-run    every target still resolves correctly,
   *                               because sibling counts are untouched
   *    the opening WRK DROPPED    without this field, WRK#0 silently resolves
   *                               to the RETURN stop -- a correction meant for
   *                               the departure lands on the arrival
   *
   *  So a changed sibling count means the ordinal is untrustworthy, and the
   *  patch orphans rather than binding to the wrong occurrence. */
  sibs: number;
}

export interface ActionAnchor {
  verb: string;
  /** The normalised names of everyone under this action, sorted.
   *
   *  4 of 48 real steps hold two actions with the same verb -- 369736 has two
   *  Drop-Offs at WKL, one per door. An ordinal alone would send a door
   *  correction to the wrong kerb if they were ever reordered. The passenger
   *  set is the strongest discriminator available and, crucially, it is
   *  orthogonal to `where`, which is the field being edited. */
  names: string[];
  nth: number;
  sibs: number;
}

/**
 * One of the driver notes' lines, by its own words (the phone keys its tick the
 * same way). Shuttle sheets print their real steps there (374819, 2026-09-29),
 * so the driver corrects, adds and drops those "legs" like stops.
 */
export interface LineAnchor {
  /** The line as dispatch printed it, trimmed. */
  text: string;
  /** Among lines with exactly these words, and how many there were: the same
   *  sibling guard as a stop's. */
  nth: number;
  sibs: number;
  /** Its leading time as printed ("7:45*"). A later sheet that rewords the
   *  line but keeps its time still binds -- when exactly one line has that
   *  time -- and the driver sees both, as with any field (contested). */
  time: string | null;
}

/** A notes line as served: dispatch's words, and what shows (`line`: the
 *  driver's when they corrected it). Built on read from `driverNotes`, which
 *  stays exactly as printed. A leg the driver added has no `printed`. */
export interface NoteLine {
  printed: string | null;
  line: string;
  _at?: string;
}

export interface PatchTarget {
  /** One of dispatch's steps. Exactly one of `step`, `line` and `on` is set. */
  step?: StepAnchor;
  line?: LineAnchor;
  /** A row the DRIVER added: the key of the patch that added it (its client
   *  ref, else its id). Added rows need no content anchor -- the add patch is
   *  their identity, and it survives every re-import because it is not in the
   *  document. */
  on?: string;
  /** With `on` naming an added step: its one action, where the door lives. */
  level?: "action";
  /** Absent for step-level fields. */
  action?: ActionAnchor;
  /** Normalised entity name. Absent for the door, which belongs to the action. */
  entity?: string;
}

/** The fields a driver may correct, by the row they live on.
 *
 *  Step times joined on 2026-09-23 (the owner: "as mine beside theirs"). The
 *  driver's time is written into the field like any correction, so the clocks,
 *  the pushes and the call list all run on it; dispatch's stays readable as the
 *  edit's `documentValue`, and every "dispatch planned" reads it from there.
 *  Only a time the sheet printed can be corrected -- the first step's missing
 *  ETA is not invented. Only the wall clock changes, never the date.
 *
 *  A stop the driver added is theirs throughout: `time` moves a one-time stop
 *  (both its times, as before v69), and `eta` / `etd` each move one, a leave
 *  it was added without included (see AddedStep). */
export const PATCHABLE = {
  entity: ["flightNumber", "phone", "note"],
  action: ["where"],
  step: ["eta", "etd"],
  addedStep: ["time", "eta", "etd"],
  line: ["line"],
} as const;

const TIME_FIELDS = new Set(["eta", "etd", "time"]);

/**
 * What a patch does. Absent means "field", as every patch before Phase 7b.
 *
 * - field      one value corrected
 * - remove     "not happening": a no-show, or cancelled by phone. The row is
 *              MARKED, never spliced out -- dispatch's original stays underneath
 *              and the driver sees a ghost with its own undo.
 * - addEntity  a passenger dispatch added by phone, under an existing action
 * - addStep    a stop the driver added: phoned in by dispatch, or their own
 *              (fuel); with one action, or none when nothing happens there
 * - addLeg     a timed notes line the driver adds ("7:58a Wait at the lobby")
 *
 * Adds and removes are the driver's, never the app's: converter-not-planner
 * forbids unasked-for decisions, not driver edits (the owner, 2026-09-23).
 */
export type PatchKind = "field" | "remove" | "addEntity" | "addStep" | "addLeg";

/** A passenger as the driver typed them. */
export interface AddedEntity {
  name: string;
  flightNumber?: string | null;
  phone?: string | null;
  note?: string | null;
  /** A or D, which the clocks read to tell an arrival from a departure. The
   *  phone proposes it from the stop and verb; the driver can change it. */
  tag?: string | null;
}

/** A stop as the driver typed it: when they reach it and, when they said,
 *  when they leave it (v69). A stop added before that has the one time, a
 *  pickup or a drop-off, and reads as it always did. */
export interface AddedStep {
  place: string;
  code?: string | null;
  /** The day it is reached. */
  date: string; // YYYY-MM-DD
  /** ARRIVE: "3:40 PM", the sheet's own format. */
  time: string;
  /** LEAVE, when the driver gave one. Without it the stop has one time. */
  leave?: string | null;
  /** What happens there: a pickup, a drop-off, or the driver's own words
   *  ("Fuel"). None: nothing does, and the stop has no action and no door. */
  verb?: string | null;
  where?: string | null;
  /** Dispatch steps sharing this stop's key when it was added. More of them on
   *  a later sheet means dispatch now has the stop too: the add is "agreed". */
  sibs?: number;
}

/** A leg as the driver typed it: its time first, as a notes line reads. */
export interface AddedLeg {
  line: string;
}

export interface Patch {
  id: string;
  kind?: PatchKind;
  /** Absent only for addStep, which is placed by its own time. */
  target?: PatchTarget;
  field?: string;
  /** What the driver set. `null` means "clear this". */
  value?: string | null;
  /** What the document said WHEN THEY EDITED. Without it there is no way to
   *  tell a genuine dispatch correction from the value already overridden. */
  was?: string | null;
  entity?: AddedEntity;
  step?: AddedStep;
  leg?: AddedLeg;
  /** What a removal took out, in words, so it can still be named once a later
   *  sheet has dropped the row too. */
  label?: string | null;
  at: string;
  /** Which device wrote it. Driver and helper share one list code, so without
   *  this the log reads as one person contradicting themselves. */
  by?: string | null;
  /** The client's own id for this edit. An offline edit is replayed until the
   *  server answers, and an answer lost to a dropped bar means the same edit
   *  arrives twice; the ref is how the second one is recognised. */
  ref?: string | null;
}

export interface AppliedEdit {
  patchId: string;
  /** Which field on the host object this edit changed. */
  field: string;
  value: string | null;
  was: string | null;
  /** What the CURRENT document says, before the patch was applied. */
  documentValue: string | null;
  /** The new sheet disagrees with what the driver saw. Show both, let them
   *  pick — never silently override what may be a dispatch correction. */
  contested: boolean;
  /** Dispatch has caught up and now says what the driver said. Surfaced so the
   *  patch can be retired, but never auto-dropped: that would be a silent
   *  write. */
  agreed: boolean;
  at: string;
  by?: string | null;
  /** The phone's ref for the edit, so it can recognise its own edit in GET
   *  whichever of two same-ref copies the server kept. */
  ref?: string | null;
  /** Set on the OTHER appearances of a passenger that a correction reached.
   *  They show they were changed, but the choice is only asked once, where the
   *  correction was made -- one decision should not be a prompt per row. */
  propagated?: boolean;
}

/* --------------------------------------------------------- normalising -- */

/**
 * A name reduced to what is stable across re-prints: case, spacing and
 * separator style all drift between copies of the same sheet.
 *
 * Normalising cannot merge two different people — measured 0 duplicate names
 * within any action across 55 real rows. FUZZY MATCHING IS PROHIBITED: it is
 * the only route from a party splitting ("Sandoval, Noor & Vera" becoming two
 * rows) to one person's phone number landing on somebody else.
 */
export function nameKey(name: string | null | undefined): string {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s*&\s*/g, " & ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stepKeyOf(step: Step): string {
  return `${step.code ?? step.place}|${step.date}`;
}

/** Set on a row the driver added. Anchors are about DISPATCH's content only:
 *  counted in, an added WRK would change the sibling count of every WRK and
 *  orphan every correction on them -- so added rows are invisible to anchoring,
 *  and are addressed by their own patch instead. */
export function isAdded(host: unknown): boolean {
  return Boolean(host && (host as { _add?: unknown })._add);
}

/** Set on a row the driver said is not happening. */
export function isRemoved(host: unknown): boolean {
  return Boolean(host && (host as { _removed?: unknown })._removed);
}

function dispatchSteps(assignment: Assignment): Step[] {
  return (assignment.steps || []).filter((s) => !isAdded(s));
}

function dispatchEntities(action: Action): Entity[] {
  return (action.entities || []).filter((e) => !isAdded(e));
}

// A notes line that starts with a time, as the phone reads one (NOTE_TIME in
// public/assignments.js): "7:45a", "7:55am", a bare "6:15", "14:30", "7:45*".
const LINE_TIME = /^(\d{1,2}:\d{2}(?:\s?[ap]m?)?\*?)\s+\S/i;

/** A line's leading time as printed, lower case, no spaces; null for prose. */
export function lineTime(line: string | null | undefined): string | null {
  const m = LINE_TIME.exec(String(line ?? "").trim());
  return m ? m[1].toLowerCase().replace(/\s+/g, "") : null;
}

/** Dispatch's notes as lines: trimmed, blanks dropped. The phone splits them
 *  the same way (ensureLines), so `n3` names the same line on both. */
export function notesLines(notes: string | null | undefined): string[] {
  return String(notes ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function linesOf(assignment: Assignment): NoteLine[] {
  const a = assignment as Assignment & { lines?: NoteLine[] };
  return a.lines || (a.lines = []);
}

function dispatchLines(assignment: Assignment): NoteLine[] {
  return linesOf(assignment).filter((l) => !isAdded(l));
}

function namesOf(action: Action): string[] {
  return dispatchEntities(action).map((e) => nameKey(e.name)).sort();
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/* ------------------------------------------------------------ building -- */

/** `stepIdx` indexes DISPATCH's steps -- the stored copy, which has no others. */
export function stepAnchor(assignment: Assignment, stepIdx: number): StepAnchor {
  const steps = dispatchSteps(assignment);
  const key = stepKeyOf(steps[stepIdx]);
  let nth = 0;
  let sibs = 0;
  for (let i = 0; i < steps.length; i++) {
    if (stepKeyOf(steps[i]) !== key) continue;
    if (i < stepIdx) nth++;
    sibs++;
  }
  return { key, nth, sibs };
}

export function actionAnchor(step: Step, actionIdx: number): ActionAnchor {
  const actions = step.actions || [];
  const verb = actions[actionIdx].verb;
  let nth = 0;
  let sibs = 0;
  for (let i = 0; i < actions.length; i++) {
    if (actions[i].verb !== verb) continue;
    if (i < actionIdx) nth++;
    sibs++;
  }
  return { verb, names: namesOf(actions[actionIdx]), nth, sibs };
}

/** `idx` indexes dispatch's lines (notesLines of the stored notes). */
export function lineAnchor(texts: string[], idx: number): LineAnchor {
  const text = texts[idx];
  let nth = 0;
  let sibs = 0;
  texts.forEach((t, i) => {
    if (t !== text) return;
    if (i < idx) nth++;
    sibs++;
  });
  return { text, nth, sibs, time: lineTime(text) };
}

export function targetFor(
  assignment: Assignment,
  stepIdx: number,
  actionIdx?: number,
  entityIdx?: number
): PatchTarget {
  const target: PatchTarget = { step: stepAnchor(assignment, stepIdx) };
  if (actionIdx === undefined) return target;

  const step = dispatchSteps(assignment)[stepIdx];
  target.action = actionAnchor(step, actionIdx);
  if (entityIdx === undefined) return target;

  const entity = (step.actions[actionIdx].entities || [])[entityIdx];
  target.entity = nameKey(entity.name);
  return target;
}

/* ----------------------------------------------------------- resolving -- */

export interface Resolved {
  /** Unset only for a notes line. */
  step?: Step;
  line?: NoteLine;
  action?: Action;
  entity?: Entity;
  /** How it bound, for the UI and for diagnosis. */
  how: "exact" | "byNames";
}

function resolveStep(assignment: Assignment, anchor: StepAnchor): Step | null {
  const steps = dispatchSteps(assignment);
  const matching = steps.filter((s) => stepKeyOf(s) === anchor.key);
  // The guard. A changed sibling count means an occurrence was added or removed
  // and the ordinal no longer counts the same things.
  if (matching.length !== anchor.sibs) return null;
  return matching[anchor.nth] ?? null;
}

/** By its words, under the sibling guard; else, when a later sheet reworded
 *  every line with those words away, by its printed time if exactly one line
 *  has it. Never by position: a line added above would shift every index. */
function resolveLine(assignment: Assignment, anchor: LineAnchor): NoteLine | null {
  const lines = dispatchLines(assignment);
  const same = lines.filter((l) => l.printed === anchor.text);
  if (same.length) return same.length === anchor.sibs ? same[anchor.nth] ?? null : null;
  if (!anchor.time) return null;
  const byTime = lines.filter((l) => lineTime(l.printed) === anchor.time);
  return byTime.length === 1 ? byTime[0] : null;
}

function resolveAction(step: Step, anchor: ActionAnchor): { action: Action; how: Resolved["how"] } | null {
  const actions = (step.actions || []).filter((a) => a.verb === anchor.verb);

  // Prefer the passenger set: it survives reordering, which an ordinal does
  // not, and it cannot be disturbed by editing the door.
  const byNames = actions.filter((a) => sameSet(namesOf(a), anchor.names));
  if (byNames.length === 1) return { action: byNames[0], how: "byNames" };

  // Fall back to position, under the same sibling-count guard as steps.
  if (actions.length !== anchor.sibs) return null;
  const at = actions[anchor.nth];
  return at ? { action: at, how: "exact" } : null;
}

/**
 * Where a patch points in THIS copy of the document, or null if nowhere.
 *
 * Null is a normal outcome, not an error: dispatch reprinted the sheet and the
 * thing the driver corrected is no longer recognisable. The patch is kept and
 * surfaced so they can re-place it — the one thing never done is binding it to
 * a near-miss.
 */
export function resolveTarget(
  assignment: Assignment,
  target: PatchTarget,
  added: Map<string, Resolved> = new Map(),
): Resolved | null {
  if (target.on) {
    const host = added.get(target.on);
    if (!host) return null;
    if (target.level === "action") {
      if (host.entity || !host.step?.actions?.[0]) return null;
      return { step: host.step, action: host.step.actions[0], how: "exact" };
    }
    return host;
  }
  if (target.line) {
    const line = resolveLine(assignment, target.line);
    return line ? { line, how: "exact" } : null;
  }
  if (!target.step) return null;
  const step = resolveStep(assignment, target.step);
  if (!step) return null;
  if (!target.action) return { step, how: "exact" };

  const found = resolveAction(step, target.action);
  if (!found) return null;
  if (!target.entity) return { step, action: found.action, how: found.how };

  const entity = dispatchEntities(found.action).find((e) => nameKey(e.name) === target.entity);
  if (!entity) return null;
  return { step, action: found.action, entity, how: found.how };
}

/* ------------------------------------------------------------ applying -- */

/** What an add or a removal did, for the undo row and the ghosts. */
export interface AppliedChange {
  patchId: string;
  kind: "remove" | "addEntity" | "addStep" | "addLeg";
  /** A name or a stop, in words. */
  label: string | null;
  /** Dispatch has caught up: a removed row is gone from the sheet too, or an
   *  added one is on it now. Said, never acted on -- auto-dropping the patch
   *  would be the app deciding. */
  agreed: boolean;
  /** A removal whose row a later sheet no longer has. Nothing to draw a ghost
   *  on, so it is listed instead. */
  gone?: boolean;
  at: string;
  by?: string | null;
  ref?: string | null;
}

export interface ApplyResult {
  edits: AppliedEdit[];
  orphaned: Patch[];
  changes: AppliedChange[];
}

function hostOf(r: Resolved): Record<string, unknown> {
  return (r.line ?? r.entity ?? r.action ?? r.step) as unknown as Record<string, unknown>;
}

function readField(r: Resolved, field: string): string | null {
  const v = hostOf(r)[field === "time" ? "eta" : field];
  return v === undefined || v === null ? null : String(v);
}

function writeField(r: Resolved, field: string, value: string | null): void {
  const host = hostOf(r);
  if (field === "time") { host.eta = value; host.etd = value; return; }
  host[field] = value;
}

/**
 * Hang the edit off the object it changed, keyed by field.
 *
 * The alternative is a side table the client joins by recomputing the target
 * path in JavaScript -- a second implementation of the one piece of logic whose
 * subtlety is the entire problem, and the first thing that would drift. Here a
 * renderer just asks `entity._edit?.flightNumber`.
 *
 * Safe to attach because this is the copy about to be serialised, never the
 * stored record.
 */
function markField(r: Resolved, field: string, edit: AppliedEdit): void {
  const host = hostOf(r);
  const marks = (host._edit as Record<string, AppliedEdit>) || {};
  marks[field] = edit;
  host._edit = marks;
}

/**
 * Give every row of dispatch's copy its address: `step.action.entity`, as
 * indices into the STORED document. The client names what it edits by this, and
 * the server turns it into a content target from the stored copy.
 *
 * Why not the index into the served array: added stops are placed by time, so
 * the served array is not dispatch's. An index into it would point at a
 * different stop on the server -- and would move again when KV's list lag hides
 * the add from the next request. The address is fixed when the row is read.
 */
function address(assignment: Assignment): void {
  // The notes' lines, each addressable like a row: `n3`, dispatch's fourth.
  (assignment as Assignment & { lines?: NoteLine[] }).lines = notesLines(assignment.driverNotes)
    .map((text, i) => ({ printed: text, line: text, _at: `n${i}` }));
  (assignment.steps || []).forEach((step, s) => {
    (step as unknown as Record<string, unknown>)._at = `${s}`;
    (step.actions || []).forEach((action, a) => {
      (action as unknown as Record<string, unknown>)._at = `${s}.${a}`;
      (action.entities || []).forEach((entity, e) => {
        (entity as unknown as Record<string, unknown>)._at = `${s}.${a}.${e}`;
      });
    });
  });
}

/** The identity of a row the driver added: its patch's client ref, which the
 *  phone knows before the server has answered, else the patch id. */
export function addKey(patch: Patch): string {
  return patch.ref || patch.id;
}

function sortKey(step: Step): string {
  const t = wallMinutes(step.eta) ?? wallMinutes(step.etd) ?? 0;
  return `${step.etaDate ?? step.date} ${String(t).padStart(4, "0")}`;
}

/** A time as a sheet prints it ("3:40 PM"), in minutes of its day. */
export function wallMinutes(printed: string | null | undefined): number | null {
  const m = String(printed || "").match(/^(\d{1,2}):(\d{2})\s*([AP])M$/i);
  if (!m) return null;
  const h = Number(m[1]) % 12;
  return (h + (m[3].toUpperCase() === "P" ? 12 : 0)) * 60 + Number(m[2]);
}

/** "2026-08-31" -> "2026-09-01". */
function dayAfter(day: string): string {
  const next = new Date(`${day}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return Number.isNaN(next.getTime()) ? day : next.toISOString().slice(0, 10);
}

function change(patch: Patch, kind: AppliedChange["kind"], label: string | null, agreed: boolean): AppliedChange {
  return { patchId: patch.id, kind, label, agreed, at: patch.at, by: patch.by ?? null, ref: patch.ref ?? null };
}

/** A stop the driver added, placed among dispatch's by its time. Placing it is
 *  safe only because nothing addresses a row by its position in THIS array. */
function addStep(assignment: Assignment, patch: Patch, added: Map<string, Resolved>): AppliedChange | null {
  const a = patch.step;
  if (!a || !a.place || !a.date || !a.time) return null;
  const key = addKey(patch);
  const code = a.code || null;
  const sibs = dispatchSteps(assignment)
    .filter((s) => stepKeyOf(s) === `${code ?? a.place}|${a.date}`).length;
  const done = change(patch, "addStep", code || a.place, sibs > (a.sibs ?? 0));
  const actions = a.verb
    ? [{ verb: a.verb, where: a.where ?? null, entities: [], _at: `+${key}.0` } as unknown as Action]
    : [];
  // Dated as a sheet's stop is: `etaDate` the day it is reached, `date` the
  // day it is left, which is the next when the leave is past midnight.
  const leave = a.leave || a.time;
  const overnight = (wallMinutes(leave) ?? 0) < (wallMinutes(a.time) ?? 0);
  const step = {
    code, place: a.place, date: overnight ? dayAfter(a.date) : a.date, etaDate: a.date, eta: a.time, etd: leave,
    actions, _add: done, _at: `+${key}`,
  } as unknown as Step;
  const steps = assignment.steps || (assignment.steps = []);
  const at = steps.findIndex((s) => sortKey(s) > sortKey(step));
  steps.splice(at < 0 ? steps.length : at, 0, step);
  added.set(key, { step, how: "exact" });
  return done;
}

/**
 * Place the driver's stops again, once every patch has run. A stop is placed
 * by its time when it is added, but a later patch can move that time -- or a
 * dispatch time it was placed against. Dispatch's steps keep dispatch's order
 * whatever their times say: re-sorting them would be the app re-planning.
 */
function placeAdded(assignment: Assignment): void {
  const all = assignment.steps || [];
  const mine = all.filter(isAdded);
  if (!mine.length) return;
  const steps = all.filter((s) => !isAdded(s));
  for (const step of mine) {
    const at = steps.findIndex((s) => sortKey(s) > sortKey(step));
    steps.splice(at < 0 ? steps.length : at, 0, step);
  }
  assignment.steps = steps;
}

/** A leg the driver added, after dispatch's lines: the phone places it by its
 *  time. On a later sheet in the same words, dispatch has it too (agreed). */
function addLeg(assignment: Assignment, patch: Patch, added: Map<string, Resolved>): AppliedChange | null {
  const text = String(patch.leg?.line ?? "").trim();
  if (!lineTime(text)) return null;
  const key = addKey(patch);
  const done = change(patch, "addLeg", text, dispatchLines(assignment).some((l) => l.printed === text));
  const line = { printed: null, line: text, _add: done, _at: `+${key}` } as NoteLine;
  linesOf(assignment).push(line);
  added.set(key, { line, how: "exact" });
  return done;
}

/** A passenger the driver added, at the end of the action they belong to. */
function addEntity(r: Resolved, patch: Patch, added: Map<string, Resolved>): AppliedChange | null {
  const a = patch.entity;
  if (!a || !a.name || !r.action || r.entity) return null;
  const key = addKey(patch);
  const who = nameKey(a.name);
  const done = change(patch, "addEntity", a.name,
    dispatchEntities(r.action).some((e) => nameKey(e.name) === who));
  const entity = {
    name: a.name, pax: 1,
    flightNumber: a.flightNumber ?? null, phone: a.phone ?? null, note: a.note ?? null,
    tag: a.tag ?? null,
    _add: done, _at: `+${key}`,
  } as unknown as Entity;
  (r.action.entities || (r.action.entities = [])).push(entity);
  added.set(key, { step: r.step, action: r.action, entity, how: "exact" });
  return done;
}

/**
 * A removal that no longer binds. Either a later sheet dropped the row too --
 * dispatch agrees, and it is said -- or the row moved so it cannot be told
 * apart, and it is an orphan like any other. Never a guess: a passenger counts
 * as gone only if their name is nowhere in the run, a stop only if no stop of
 * that key remains.
 */
function goneFromSheet(assignment: Assignment, target: PatchTarget): boolean {
  if (target.line) {
    const { text, time } = target.line;
    return !dispatchLines(assignment).some((l) => l.printed === text || (time !== null && lineTime(l.printed) === time));
  }
  if (!target.step) return false;
  const steps = dispatchSteps(assignment);
  if (target.entity) {
    return !steps.some((s) => (s.actions || []).some((a) =>
      dispatchEntities(a).some((e) => nameKey(e.name) === target.entity)));
  }
  if (target.action) return false;
  return !steps.some((s) => stepKeyOf(s) === target.step!.key);
}

/**
 * Apply an ordered log to an assignment IN PLACE, and report what happened.
 *
 * Mutates the copy the request is about to serialise, never the stored record.
 * The field keeps its plain type, so every existing renderer goes on working
 * unchanged and only the ones that want the "you edited this" mark consult the
 * returned edits.
 */
export function applyPatches(assignment: Assignment, patches: Patch[]): ApplyResult {
  const edits: AppliedEdit[] = [];
  const orphaned: Patch[] = [];
  const changes: AppliedChange[] = [];
  const added = new Map<string, Resolved>();
  const refs = new Set<string>();
  address(assignment);

  for (const patch of patches) {
    // One edit, written twice: its answer was lost to a dropped bar, the phone
    // sent it again, and KV's list lag hid the first copy from admitPatch. The
    // first copy is the edit; a second would add the passenger twice.
    if (patch.ref) {
      if (refs.has(patch.ref)) continue;
      refs.add(patch.ref);
    }
    const kind = patch.kind ?? "field";

    if (kind === "addStep" || kind === "addLeg") {
      const done = kind === "addStep" ? addStep(assignment, patch, added) : addLeg(assignment, patch, added);
      if (done) changes.push(done); else orphaned.push(patch);
      continue;
    }

    const resolved = patch.target ? resolveTarget(assignment, patch.target, added) : null;
    if (!resolved) {
      if (kind === "remove" && patch.target && goneFromSheet(assignment, patch.target)) {
        changes.push({ ...change(patch, "remove", patch.label ?? null, true), gone: true });
      } else {
        orphaned.push(patch);
      }
      continue;
    }

    if (kind === "remove") {
      const done = change(patch, "remove", patch.label ?? null, false);
      hostOf(resolved)._removed = done;
      changes.push(done);
      // A no-show at the pickup is not coming to the drop-off either: the
      // passenger's every row goes, as a person-level correction does (the
      // owner, 2026-09-23). One patch, so one UNDO brings them all back.
      // Exact normalised name only, never fuzzy.
      if (resolved.entity) {
        const who = nameKey(resolved.entity.name);
        for (const st of assignment.steps || []) {
          for (const act of st.actions || []) {
            for (const other of act.entities || []) {
              if (other === resolved.entity || isRemoved(other) || nameKey(other.name) !== who) continue;
              (other as unknown as Record<string, unknown>)._removed = { ...done, propagated: true };
            }
          }
        }
      }
      continue;
    }

    if (kind === "addEntity") {
      const done = addEntity(resolved, patch, added);
      if (done) changes.push(done); else orphaned.push(patch);
      continue;
    }

    if (!patch.field) { orphaned.push(patch); continue; }
    // A time belongs to a stop, a line's words to a line. Aimed at anything
    // else, it binds nowhere.
    if (TIME_FIELDS.has(patch.field) && (resolved.action || resolved.entity || resolved.line)) { orphaned.push(patch); continue; }
    if ((patch.field === "line") !== Boolean(resolved.line)) { orphaned.push(patch); continue; }
    const field = patch.field;
    const value = patch.value ?? null;
    const was = patch.was ?? null;
    // Dispatch's value, not what an earlier correction of the same field left
    // there: a second edit must not present the driver's first as the sheet's.
    const shown = readField(resolved, field);
    const prior = (hostOf(resolved)._edit as Record<string, AppliedEdit> | undefined)?.[field];
    const documentValue = prior ? prior.documentValue : shown;
    writeField(resolved, field, value);
    const edit: AppliedEdit = {
      patchId: patch.id,
      field,
      value,
      was,
      documentValue,
      contested: documentValue !== was && documentValue !== value,
      agreed: documentValue === value,
      at: patch.at,
      by: patch.by ?? null,
      ref: patch.ref ?? null,
    };
    markField(resolved, field, edit);
    edits.push(edit);

    // A passenger is printed once per step they take part in -- picked up at
    // WRK, dropped at JFK. Their flight number and phone are facts about the
    // PERSON, so a correction made at one appearance applies to the others too;
    // otherwise the driver fixes the same blank twice and the itinerary
    // disagrees with itself.
    //
    // Only where the other appearance holds the SAME value that was corrected
    // (the same blank, the same wrong number). Someone on two different flights
    // in one run has a different value on their other row and is left alone.
    // Exact normalised name only -- never fuzzy, for the reason nameKey gives.
    if (resolved.entity) {
      const who = nameKey(resolved.entity.name);
      for (const st of assignment.steps || []) {
        for (const act of st.actions || []) {
          for (const other of act.entities || []) {
            if (other === resolved.entity || nameKey(other.name) !== who) continue;
            const r2: Resolved = { step: st, action: act, entity: other, how: resolved.how };
            if (readField(r2, field) !== shown) continue;
            const prior2 = (hostOf(r2)._edit as Record<string, AppliedEdit> | undefined)?.[field];
            writeField(r2, field, value);
            markField(r2, field, { ...edit, documentValue: prior2 ? prior2.documentValue : edit.documentValue, propagated: true });
          }
        }
      }
    }
  }
  placeAdded(assignment);
  return { edits, orphaned, changes };
}

/* ------------------------------------------------------------- writing -- */

export interface PatchRequest {
  kind?: PatchKind;
  /** The row, by the `_at` address GET gave it. */
  at?: string;
  /** The same, the Phase 7a way: indices into dispatch's arrays. */
  stepIdx?: number;
  actionIdx?: number;
  entityIdx?: number;
  field?: string;
  value?: string | null;
  entity?: AddedEntity;
  step?: AddedStep;
  leg?: AddedLeg;
}

export type Aim =
  | { target?: PatchTarget; step?: AddedStep; leg?: AddedLeg; onSheet: boolean }
  | { error: string };

const DISPATCH_AT = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const ADDED_AT = /^\+([^.]+)(\.0)?$/;
const LINE_AT = /^n(\d+)$/;
const LEG_MAX = 300;

/**
 * Turn what the phone sent into what the log stores, or say why not.
 *
 * `onSheet` is whether the target was named by position in dispatch's copy --
 * only then can a re-import have moved it, so only then does `basis` apply. A
 * row the driver added is named by its own patch, which no sheet can move.
 */
export function aimPatch(stored: Assignment, req: PatchRequest): Aim {
  const kind = req.kind ?? "field";

  if (kind === "addStep") {
    const a = req.step;
    const needs = { error: "a stop needs a place, a date and the time you reach it" };
    if (!a || !a.place || !/^\d{4}-\d{2}-\d{2}$/.test(a.date || "") || wallMinutes(a.time) === null) return needs;
    // Only the fields a stop has, each cut to length: the request is anyone's.
    const text = (v: unknown, n: number) => (v === undefined || v === null ? null : String(v).trim().slice(0, n) || null);
    const code = text(a.code, 8);
    const place = text(a.place, 80);
    if (!place) return needs;
    // What happens there, in anyone's words; nothing at all is a stop too
    // (fuel, a wait), and a door belongs to a pickup or a drop-off.
    const verb = text(a.verb, 40);
    // A leave that is no time is refused: dropped in silence, the stop would
    // save as something the driver did not type.
    const leave = text(a.leave, 12);
    if (leave && wallMinutes(leave) === null) return { error: "a time looks like 3:40 PM" };
    const sibs = dispatchSteps(stored).filter((s) => stepKeyOf(s) === `${code ?? place}|${a.date}`).length;
    const step: AddedStep = { place, code, date: a.date, time: text(a.time, 12)!, verb, where: verb ? text(a.where, 120) : null, sibs };
    if (leave) step.leave = leave;
    return { step, onSheet: false };
  }

  if (kind === "addLeg") {
    const line = String(req.leg?.line ?? "").trim().slice(0, LEG_MAX);
    if (!lineTime(line)) return { error: "a leg starts with its time, then what happens" };
    return { leg: { line }, onSheet: false };
  }

  // A leg: one of dispatch's timed notes lines, named by its words.
  const lineAt = req.at ? LINE_AT.exec(req.at) : null;
  if (lineAt) {
    const texts = notesLines(stored.driverNotes);
    const idx = Number(lineAt[1]);
    if (idx >= texts.length) return { error: "no such line" };
    if (!lineTime(texts[idx])) return { error: "only a line that starts with a time is a leg" };
    if (kind === "addEntity") return { error: "a passenger is added to a pickup or a drop-off" };
    if (kind === "field") {
      if (req.field !== "line") return { error: `${req.field} is not correctable here` };
      if (!lineTime(req.value)) return { error: "a leg starts with its time, then what happens" };
    }
    return { target: { line: lineAnchor(texts, idx) }, onSheet: true };
  }

  let s = req.stepIdx, ai = req.actionIdx, ei = req.entityIdx;
  let on: string | null = null, onAction = false;
  if (req.at) {
    const d = DISPATCH_AT.exec(req.at), p = ADDED_AT.exec(req.at);
    if (d) {
      s = Number(d[1]);
      ai = d[2] === undefined ? undefined : Number(d[2]);
      ei = d[3] === undefined ? undefined : Number(d[3]);
    } else if (p) {
      on = p[1];
      onAction = Boolean(p[2]);
    } else {
      return { error: "unreadable row address" };
    }
  }

  let target: PatchTarget;
  if (on) {
    // Not checked against the log: KV's list lag can hide an add written
    // seconds ago. An `on` that never binds is kept and shown as an orphan.
    target = onAction ? { on, level: "action" } : { on };
  } else {
    const step = typeof s === "number" ? dispatchSteps(stored)[s] : undefined;
    if (!step) return { error: "no such step" };
    const action = ai === undefined ? undefined : step.actions?.[ai];
    if (ai !== undefined && !action) return { error: "no such action" };
    if (ei !== undefined && !action?.entities?.[ei]) return { error: "no such passenger" };
    target = targetFor(stored, s!, ai, ei);
  }

  const isAction = on ? onAction : ai !== undefined && ei === undefined;
  if (kind === "remove" && isAction) return { error: "remove a stop or a passenger" };
  if (kind === "addEntity") {
    if (!isAction) return { error: "a passenger is added to a pickup or a drop-off" };
    if (!req.entity?.name?.trim()) return { error: "a passenger needs a name" };
  }
  if (kind === "field") {
    if (!req.field) return { error: "field is required" };
    // Which row the address names. An `on` address without `.0` is an added
    // step or an added passenger; the add patch may still be queued behind
    // KV's lag, so a time field decides it is a step.
    const level = isAction ? "action"
      : on ? (req.field === "line" ? "line" : TIME_FIELDS.has(req.field) ? "addedStep" : "entity")
      : ei !== undefined ? "entity" : "step";
    if (!(PATCHABLE[level] as readonly string[]).includes(req.field)) {
      return { error: `${req.field} is not correctable here` };
    }
    if (req.field === "line" && !lineTime(req.value)) {
      return { error: "a leg starts with its time, then what happens" };
    }
    if (TIME_FIELDS.has(req.field)) {
      // A time is corrected, never cleared or invented.
      if (wallMinutes(req.value) === null) return { error: "a time looks like 3:40 PM" };
      if (level === "step" && !(dispatchSteps(stored)[s!] as unknown as Record<string, unknown>)[req.field]) {
        return { error: "the sheet printed no such time for this stop" };
      }
    }
  }
  return { target, onSheet: !on };
}

/* ----------------------------------------------------------- admission -- */

export type Admission =
  | { kind: "new" }
  | { kind: "duplicate"; patch: Patch }
  | { kind: "stale" };

/**
 * Whether a patch POST may be written. Queued edits make two things possible
 * that a live tap never could:
 *
 * - **A replay.** The edit reached the server but the answer did not reach the
 *   phone, so it is sent again. Same `ref` -> the patch already written.
 * - **A sheet that changed underneath it.** The edit names its value by array
 *   index into the copy the driver was looking at. If dispatch re-sent the run
 *   while the phone had no signal, those indices point into a different
 *   document -- and targetFor would build a confident target for the wrong
 *   stop. `basis` is the importedAt of the copy the driver saw; a mismatch is
 *   refused, and the client hands the correction back to the driver rather
 *   than guess.
 *
 * The duplicate check runs first: a replay of an edit that was written before
 * a re-import is already in the log, and refusing it as stale would tell the
 * driver it was lost when it was not.
 */
export function admitPatch(
  stored: Assignment,
  log: Patch[],
  basis: string | null | undefined,
  ref: string | null | undefined,
): Admission {
  if (ref) {
    const seen = log.find((p) => p.ref === ref);
    if (seen) return { kind: "duplicate", patch: seen };
  }
  if (basis && stored.importedAt && basis !== stored.importedAt) return { kind: "stale" };
  return { kind: "new" };
}
