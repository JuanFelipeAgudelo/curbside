/**
 * Retention: delete a run its list's chosen days after it ends (spec
 * "Archive and retention").
 *
 *   node --test --experimental-strip-types src/retention.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { expired, retentionDays, sweep, wallNow, type SweepKV } from "./retention.ts";

test("now is read on the home wall clock, not UTC", () => {
  // 00:30 UTC on 09-25 is still 8:30 PM on 09-24 in New York.
  assert.equal(wallNow(Date.UTC(2026, 8, 25, 0, 30)), "2026-09-24 20:30");
});

test("a run expires the chosen number of days after its end, to the minute", () => {
  assert.equal(expired("2026-09-01 03:00", 7, "2026-09-08 02:59"), false);
  assert.equal(expired("2026-09-01 03:00", 7, "2026-09-08 03:00"), true);
  assert.equal(expired("2026-09-01 03:00", 2, "2026-09-03 03:00"), true);
});

test("a run that cannot be dated is never deleted", () => {
  assert.equal(expired(undefined, 2, "2030-01-01 00:00"), false);
  assert.equal(expired("soon", 2, "2030-01-01 00:00"), false);
});

test("only the offered choices are honoured; anything else is the default", () => {
  assert.equal(retentionDays(14), 14);
  assert.equal(retentionDays(3), 7);
  assert.equal(retentionDays(undefined), 7);
});

function fakeKV(entries: Record<string, { value: object; metadata?: object }>, pageSize = 2) {
  let gets = 0;
  const kv: SweepKV = {
    async list({ prefix, cursor }) {
      const names = Object.keys(entries).filter((k) => k.startsWith(prefix)).sort();
      const from = cursor ? Number(cursor) : 0;
      const slice = names.slice(from, from + pageSize);
      const done = from + pageSize >= names.length;
      return {
        keys: slice.map((name) => ({ name, metadata: entries[name].metadata })),
        list_complete: done,
        cursor: done ? undefined : String(from + pageSize),
      };
    },
    async get(key) {
      gets++;
      return entries[key] ? JSON.stringify(entries[key].value) : null;
    },
  };
  return { kv, gets: () => gets };
}

test("the sweep removes each list's expired runs by that list's own window", async () => {
  const run = (end: string) => ({ value: { number: "x", end }, metadata: { end } });
  const { kv, gets } = fakeKV({
    "assign:aaa:1": run("2026-09-01 03:00"),              // 7 days: expired
    "assign:aaa:2": run("2026-09-20 03:00"),              // 7 days: kept
    "assign:bbb:3": run("2026-09-20 03:00"),              // 2 days: expired
    "assign:bbb:4": { value: { end: "2026-09-01 03:00" } }, // stored before metadata
    "assign:ccc:5": run("2026-09-24 23:00"),              // not yet
    "flight:UA1:2026-09-01": { value: {} },
  });
  const removed: string[] = [];
  const out = await sweep(
    kv,
    Date.UTC(2026, 8, 25, 14, 0),
    async (code) => (code === "bbb" ? 2 : 7),
    async (code, number, stored) => { removed.push(`${code}:${number}:${stored.end}`); },
  );
  assert.deepEqual(out, ["aaa:1", "bbb:3", "bbb:4"]);
  assert.deepEqual(removed, ["aaa:1:2026-09-01 03:00", "bbb:3:2026-09-20 03:00", "bbb:4:2026-09-01 03:00"]);
  // A get for each removal, and one for the old key's missing metadata.
  assert.equal(gets(), 3);
});

test("a legacy number with a colon is its own run, never run 1 of the same list", async () => {
  const run = (end: string) => ({ value: { end }, metadata: { end } });
  const { kv } = fakeKV({
    "assign:aaa:1": run("2026-09-24 03:00"),   // not yet
    "assign:aaa:1:x": run("2026-09-01 03:00"), // expired
  });
  const removed: string[] = [];
  await sweep(kv, Date.UTC(2026, 8, 25, 14, 0), async () => 7,
    async (code, number) => { removed.push(`${code}|${number}`); });
  assert.deepEqual(removed, ["aaa|1:x"]);
});
