import type { Notice } from "./notify";

/** ntfy refused or never answered; `status` 0 when nothing came back. */
export class NtfyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** A push that hangs must not hold a cron tick or a save past the phone's own
 *  wait (the outbox gives up at 10 s): ntfy answered a
 *  test from a Worker with a 522 after 19.5 s (2026-10-02). */
const NTFY_TIMEOUT_MS = 5_000;

/**
 * Publishes as JSON to the root URL rather than with a Title header. Headers
 * must be Latin-1, and every verb-first title carries an em dash, which fetch
 * rejects outright -- the push never leaves the Worker.
 *
 * With a token, ntfy counts the push against the token's plan. Without one it
 * counts it against the sending IP address, which for a Worker is shared with
 * everyone else's: on 2026-10-02 ntfy.sh answered 429 "daily message quota
 * reached" to a Worker that had sent nothing that day.
 */
export async function sendNtfyNotification(topic: string, notice: Notice, token?: string): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers,
      body: JSON.stringify({
        topic,
        title: notice.title,
        message: notice.body || notice.title,
        priority: notice.priority,
        tags: notice.tags,
      }),
      signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new NtfyError(0, `ntfy publish failed: ${err instanceof Error ? err.name : "no answer"}`);
  }
  if (!res.ok) throw new NtfyError(res.status, `ntfy publish failed: ${res.status} ${await res.text()}`);
}

/** ntfy's own daily limit, as opposed to a topic or a message it refused. */
export function quotaReached(err: unknown): boolean {
  return err instanceof NtfyError && err.status === 429;
}
