/**
 * The launch splash's check (M12), the inline <head> script in
 * public/index.html, run in a node:vm context with a fixed clock: at most
 * once a day, the day turning at 4 AM local time; never in the motion
 * preview or with reduce motion; ?splash forces it without spending the day's.
 *
 *   node --test --experimental-strip-types src/splash.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).find((s) => s.includes("fw_splash_day"));
if (!src) throw new Error("index.html has no splash check");
// Only the splash's own IIFE: the theme's, before it, needs a <meta>.
const splash = src.slice(src.indexOf("(function", src.indexOf("M12")));

/** One launch at local wall time `at`; true when the splash shows. */
function launch(store: Map<string, string>, at: string, opts: { search?: string; reduce?: boolean } = {}) {
  const classes = new Set<string>();
  const RealDate = Date;
  const now = new RealDate(at).getTime();
  class FixedDate extends RealDate {
    constructor(...a: any[]) { super(...(a.length ? a : [now]) as []); }
    static now() { return now; }
  }
  vm.runInNewContext(splash, {
    Date: FixedDate,
    URLSearchParams,
    location: { search: opts.search || "" },
    matchMedia: () => ({ matches: !!opts.reduce }),
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
    },
    document: { documentElement: { classList: { add: (c: string) => classes.add(c) } } },
  });
  return classes.has("splash");
}

test("the splash shows once a day, and the day turns at 4 AM", () => {
  const store = new Map<string, string>();
  assert.equal(launch(store, "2026-09-28T09:00:00"), true, "first launch of the day");
  assert.equal(launch(store, "2026-09-28T09:05:00"), false, "a relaunch the same morning");
  assert.equal(launch(store, "2026-09-28T23:30:00"), false, "late the same evening");
  assert.equal(launch(store, "2026-09-29T02:00:00"), false, "2 AM is still the 28th's day");
  assert.equal(launch(store, "2026-09-29T03:59:00"), false);
  assert.equal(launch(store, "2026-09-29T04:00:00"), true, "4 AM: a new day");
  assert.equal(launch(store, "2026-09-29T04:01:00"), false);
});

test("the splash never shows in the preview or with reduce motion", () => {
  const store = new Map<string, string>();
  assert.equal(launch(store, "2026-09-28T09:00:00", { search: "?preview" }), false);
  assert.equal(launch(store, "2026-09-28T09:00:00", { reduce: true }), false);
  assert.equal(store.size, 0, "neither spends the day's splash");
  assert.equal(launch(store, "2026-09-28T09:00:00"), true);
});

test("?splash forces it, without spending the day's", () => {
  const store = new Map<string, string>();
  assert.equal(launch(store, "2026-09-28T09:00:00", { search: "?splash" }), true);
  assert.equal(launch(store, "2026-09-28T09:00:01", { search: "?preview&splash" }), true);
  assert.equal(store.size, 0);
  assert.equal(launch(store, "2026-09-28T09:01:00"), true, "the real one still comes");
  assert.equal(launch(store, "2026-09-28T09:02:00", { search: "?splash" }), true, "and ?splash again after it");
});

test("no storage (private mode): no splash, rather than one every launch", () => {
  const classes = new Set<string>();
  vm.runInNewContext(splash, {
    Date, URLSearchParams, location: { search: "" }, matchMedia: () => ({ matches: false }),
    localStorage: { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } },
    document: { documentElement: { classList: { add: (c: string) => classes.add(c) } } },
  });
  assert.equal(classes.size, 0);
});
