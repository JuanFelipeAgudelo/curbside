/**
 * public/_headers: what the app's pages are served with (the static-assets
 * Worker of wrangler.curbside.toml reads it). Security review, 2026-10-04.
 *
 * The app builds its screens as HTML strings from what a sheet, a list and an
 * airline's feed say. Every value is escaped where it is written, and one slip
 * (a passenger count printed as it arrived) was enough to run a stranger's
 * script on a phone, with the list code in reach. The Content-Security-Policy
 * is the net under that: only this origin's script files run, and the pages'
 * own inline scripts by their hash. So a hash has to follow its script, and
 * these tests fail when one does not.
 *
 *   node --test --experimental-strip-types src/headers.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

const pub = new URL("../../public/", import.meta.url);
// A browser reads CRLF as LF before it hashes a script's text.
const read = (path: string) => readFileSync(new URL(path, pub), "utf8").replace(/\r\n/g, "\n");

const PAGES = ["index.html", "alpha/index.html", "guide/index.html"];
const headers = read("_headers");

/** The headers of the one rule, by name. */
function served(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of headers.split("\n")) {
    const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

/** The policy's directives: name -> its sources. */
function policy(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of (served().get("Content-Security-Policy") ?? "").split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

const hashOf = (script: string) => `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`;

test("one rule covers every page, and each line is one Cloudflare takes", () => {
  const rules = headers.split("\n").filter((l) => l && !/^\s/.test(l) && !l.startsWith("#"));
  assert.deepEqual(rules, ["/*"]);
  for (const line of headers.split("\n")) assert.ok(line.length <= 2000, "a line is at most 2,000 characters");
});

test("every page's inline script is allowed by its hash, and no hash is left over", () => {
  const wanted = [...new Set(PAGES.flatMap((page) => inlineScripts(read(page)).map(hashOf)))];
  assert.ok(wanted.length >= PAGES.length, "each page sets its theme inline, before the first paint");
  const allowed = (policy().get("script-src") ?? []).filter((s) => s.startsWith("'sha256-"));
  assert.deepEqual([...allowed].sort(), [...wanted].sort(),
    `an inline script changed: script-src must be exactly\n  script-src 'self' ${wanted.join(" ")}`);
});

test("only this origin's script files run: nothing inline, nothing evaluated, no other host", () => {
  const sources = policy().get("script-src") ?? [];
  assert.ok(sources.includes("'self'"));
  for (const s of sources) assert.ok(s === "'self'" || s.startsWith("'sha256-"), `script-src ${s}`);
  assert.deepEqual(policy().get("default-src"), ["'self'"]);
  assert.deepEqual(policy().get("object-src"), ["'none'"]);
  assert.deepEqual(policy().get("base-uri"), ["'none'"]);
});

test("the app talks to its own Worker and to nothing else", () => {
  const api = /"(https:\/\/[a-z0-9.-]+\.workers\.dev)"/.exec(read("app.js"));
  assert.ok(api, "app.js names the Worker");
  assert.deepEqual(policy().get("connect-src"), ["'self'", api[1]]);
});

test("fonts and styles come from where the pages ask for them", () => {
  assert.deepEqual(policy().get("style-src"), ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]);
  assert.deepEqual(policy().get("font-src"), ["'self'", "https://fonts.gstatic.com"]);
  for (const page of PAGES) {
    for (const [, url] of read(page).matchAll(/<link[^>]+href="(https:\/\/[^"]+)"[^>]*rel="stylesheet"/g)) {
      assert.ok(url.startsWith("https://fonts.googleapis.com/"), url);
    }
  }
});

test("no other site can frame the app; a type is never guessed; no address is sent on", () => {
  assert.deepEqual(policy().get("frame-ancestors"), ["'self'"], "the testers' page frames the app's preview");
  assert.equal(served().get("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(served().get("X-Content-Type-Options"), "nosniff");
  assert.equal(served().get("Referrer-Policy"), "no-referrer");
});

test("nothing the pages or the scripts write needs an inline handler: the policy would drop it in silence", () => {
  const handler = /\son[a-z]+\s*=\s*["'`$]/i;
  const files = [...PAGES, ...readdirSync(pub).filter((f) => f.endsWith(".js"))];
  for (const file of files) {
    const text = read(file);
    assert.ok(!handler.test(text), `${file} has an inline event handler`);
    assert.ok(!/javascript:/i.test(text), `${file} has a javascript: URL`);
  }
});
