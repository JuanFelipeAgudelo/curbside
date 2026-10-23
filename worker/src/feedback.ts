import type { Notice } from "./notify";

/**
 * A tester's note to the owner, sent from Settings -> SEND FEEDBACK.
 *
 * One KV write per note, kept 60 days by KV's own expiry (no sweep, no list
 * to find old ones). The key starts with the time, so listing the prefix
 * reads them in order; it carries a tester id, never the list code: the code
 * is the list's only key (review B5), and feedback is read by a person.
 */
export const FEEDBACK_PREFIX = "feedback:";
export const FEEDBACK_MAX_CHARS = 2000;
export const FEEDBACK_PER_DAY = 5;
export const FEEDBACK_KEEP_SECONDS = 60 * 24 * 3600;

export interface Feedback {
  at: string;
  tester: string;
  version: string | null;
  text: string;
}

/** `feedback:<iso>:<tester>:<rand>`: in time order, a day's by prefix. */
export function feedbackKey(at: Date, tester: string, rand: string): string {
  return `${FEEDBACK_PREFIX}${at.toISOString()}:${tester}:${rand}`;
}

export function dayPrefix(at: Date): string {
  return `${FEEDBACK_PREFIX}${at.toISOString().slice(0, 10)}`;
}

/** Whose note a key holds (the iso time has colons of its own). */
export function testerOfKey(key: string): string | null {
  return /Z:([0-9a-f]+):[0-9a-f]+$/.exec(key)?.[1] ?? null;
}

/**
 * The same list always gives the same id, and the id gives nothing back. A
 * list code is only 32 bits, so a hash of the code alone could be reversed by
 * trying them all; the list's ntfy topic (96 random bits) goes in with it.
 */
export async function testerId(code: string, topic: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${code}:${topic}`));
  return Array.from(new Uint8Array(digest).slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The app's version as Settings shows it ("v52", "v60.1": a whole number is
 *  a release, a point a fix), or null for anything else. */
export function cleanVersion(v: unknown): string | null {
  return typeof v === "string" && /^v\d{1,5}(\.\d{1,3})?$/.test(v) ? v : null;
}

/**
 * The owner's push. Never the text: ntfy.sh topics are public to anyone who
 * knows the name, and a note may name a passenger. Low priority: news, not
 * an alarm.
 */
export function feedbackNotice(version: string | null, tester: string): Notice {
  return {
    title: version ? `New feedback · ${version}` : "New feedback",
    body: `From tester ${tester}. Ask Claude to read it.`,
    priority: 2,
    tags: ["speech_balloon"],
  };
}

/**
 * Notes per tester per UTC day, per isolate: the free check in front of the
 * KV list that counts across isolates, so a loop with a real code costs
 * nothing once it is over. Best effort, like the registration map.
 */
const sent = new Map<string, number>();

export function feedbackAllowed(tester: string, at: Date): boolean {
  const key = `${tester}:${at.toISOString().slice(0, 10)}`;
  if (sent.size > 10_000) sent.clear(); // never grow without bound
  return (sent.get(key) ?? 0) < FEEDBACK_PER_DAY;
}

export function countFeedback(tester: string, at: Date, total?: number): void {
  const key = `${tester}:${at.toISOString().slice(0, 10)}`;
  sent.set(key, total ?? (sent.get(key) ?? 0) + 1);
}
