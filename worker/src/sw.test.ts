/**
 * The service worker's shell fetch (public/sw.js), run in a node:vm context
 * with a stubbed `self`, `caches` and `fetch`.
 *
 *   node --test --experimental-strip-types src/sw.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readdirSync, readFileSync } from "node:fs";

const src = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://curbside.test";

interface Res { ok: boolean; redirected: boolean; type: string; body: string; clone(): Res }
const res = (body: string, over: Partial<Res> = {}): Res => {
  const r: Res = { ok: true, redirected: false, type: "basic", body, clone: () => ({ ...r }), ...over };
  return r;
};

function load(network: () => Promise<Res>) {
  const handlers: Record<string, (e: any) => void> = {};
  const cache = new Map<string, Res>([[`${ORIGIN}/assignments.js`, res("good code")]]);
  const ctx = vm.createContext({
    URL,
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, fn: (e: any) => void) => { handlers[type] = fn; },
      skipWaiting() {}, clients: { claim() {} },
    },
    caches: {
      open: async () => ({ put: async (req: { url: string }, r: Res) => { cache.set(req.url, r); } }),
      match: async (req: { url: string } | string) => cache.get(typeof req === "string" ? `${ORIGIN}${req}` : req.url),
    },
    fetch: network,
    setTimeout,
  });
  vm.runInContext(src, ctx, { filename: "sw.js" });
  const get = async (path: string): Promise<Res> => {
    let answer: Promise<Res> | undefined;
    handlers.fetch({
      request: { method: "GET", url: `${ORIGIN}${path}`, mode: "no-cors" },
      respondWith: (p: Promise<Res>) => { answer = p; },
      waitUntil: () => {},
    });
    const out = await answer!;
    await new Promise((r) => setTimeout(r, 0)); // let the cache.put land
    return out;
  };
  return { get, cache };
}

test("sw: a good shell response is served and cached", async () => {
  const sw = load(async () => res("new code"));
  assert.equal((await sw.get("/assignments.js")).body, "new code");
  assert.equal(sw.cache.get(`${ORIGIN}/assignments.js`)!.body, "new code");
});

test("sw: a wifi login page (200 after a redirect) is never cached as the app", async () => {
  const sw = load(async () => res("<html>Sign in to Airport WiFi</html>", { redirected: true }));
  assert.equal((await sw.get("/assignments.js")).body, "good code");
  assert.equal(sw.cache.get(`${ORIGIN}/assignments.js`)!.body, "good code");
});

test("sw: a 404 or 5xx keeps the last good copy", async () => {
  for (const status of [404, 503]) {
    const sw = load(async () => res(`HTTP ${status}`, { ok: false }));
    assert.equal((await sw.get("/assignments.js")).body, "good code");
    assert.equal(sw.cache.get(`${ORIGIN}/assignments.js`)!.body, "good code");
  }
});

test("sw: with nothing cached, a bad response is still passed through, not swallowed", async () => {
  const sw = load(async () => res("HTTP 500", { ok: false }));
  sw.cache.clear();
  assert.equal((await sw.get("/app.js")).body, "HTTP 500");
  assert.equal(sw.cache.size, 0);
});

test("sw: a network that never answers serves the cached shell after a few seconds", async () => {
  const sw = load(() => new Promise<Res>(() => {}));
  const t = Date.now();
  assert.equal((await sw.get("/assignments.js")).body, "good code");
  assert.ok(Date.now() - t < 5000);
});

/* ------------------------------------------------- import: reader, shares -- */

/** sw.js with its install/activate/share side stubbed: caches by name. */
function loadWith(cacheNames: string[] = []) {
  const handlers: Record<string, (e: any) => void> = {};
  const stores = new Map<string, Map<string, any>>(cacheNames.map((n) => [n, new Map()]));
  const deleted: string[] = [];
  class StubResponse {
    body: unknown; headers: Record<string, string>; status = 200; url = "";
    constructor(body: unknown, init: { headers?: Record<string, string> } = {}) {
      this.body = body;
      this.headers = init.headers ?? {};
    }
    static redirect(url: string, status: number) {
      return Object.assign(new StubResponse(null), { url, status });
    }
  }
  const ctx = vm.createContext({
    URL, console,
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, fn: (e: any) => void) => { handlers[type] = fn; },
      skipWaiting() {}, clients: { claim() {} },
    },
    caches: {
      open: async (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map());
        const store = stores.get(name)!;
        return { put: async (key: string, value: any) => { store.set(key, value); } };
      },
      keys: async () => [...stores.keys()],
      delete: async (name: string) => { deleted.push(name); return stores.delete(name); },
    },
    Response: StubResponse,
  });
  vm.runInContext(src, ctx, { filename: "sw.js" });
  return { ctx, handlers, stores, deleted };
}

test("sw: every module of the sheet reader is precached, so a sheet reads with no signal", () => {
  const { ctx } = loadWith();
  const core: string[] = vm.runInContext("CORE_ASSETS", ctx);
  const modules = readdirSync(new URL("../../public/importer/", import.meta.url)).filter((f) => f.endsWith(".js"));
  assert.ok(modules.length >= 8);
  for (const m of modules) assert.ok(core.includes(`/importer/${m}`), `/importer/${m} is precached`);
  assert.ok(core.includes("/import.js"));
  assert.ok(vm.runInContext("SHELL", ctx).has("/import.js"), "the page's own code is network-first");
});

test("sw: Share -> Curbside keeps the files for the page and answers with the app, 303", async () => {
  const { handlers, stores } = loadWith();
  const pdf = new File(["%PDF-1.4"], "Transportation Report.pdf", { type: "application/pdf" });
  let answer: Promise<any> | undefined;
  handlers.fetch({
    request: {
      method: "POST", url: `${ORIGIN}/share-target`, mode: "navigate",
      formData: async () => ({ getAll: (k: string) => (k === "sheets" ? [pdf, "a link, not a file"] : []) }),
    },
    respondWith: (p: Promise<any>) => { answer = p; },
  });
  const res = await answer!;
  assert.equal(res.status, 303, "a reload is a plain GET, never a second share");
  assert.equal(res.url, "/?shared=1");
  const kept = [...stores.get("curbside-shared")!.entries()];
  assert.equal(kept.length, 1, "files only");
  assert.match(kept[0][0], /^\/shared\/\d+-000$/);
  assert.equal(decodeURIComponent(kept[0][1].headers["X-File-Name"]), "Transportation Report.pdf");
  assert.equal(kept[0][1].headers["Content-Type"], "application/pdf");
});

test("sw: a share that can't be read still opens the app, which says nothing arrived", async () => {
  const { handlers } = loadWith();
  let answer: Promise<any> | undefined;
  handlers.fetch({
    request: { method: "POST", url: `${ORIGIN}/share-target`, formData: async () => { throw new TypeError("bad form"); } },
    respondWith: (p: Promise<any>) => { answer = p; },
  });
  assert.equal((await answer!).url, "/?shared=1");
});

/* ------------------------------------------------- alerts (v66): push -- */

/** sw.js with a registration that records what it shows, and windows to
 *  focus or open. */
function loadPush(windows: { url: string; focus?: () => unknown }[] = []) {
  const handlers: Record<string, (e: any) => void> = {};
  const shown: { title: string; options: any }[] = [];
  const opened: string[] = [];
  const ctx = vm.createContext({
    URL, console,
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, fn: (e: any) => void) => { handlers[type] = fn; },
      skipWaiting() {},
      registration: { showNotification: async (title: string, options: any) => { shown.push({ title, options }); } },
      clients: {
        claim() {},
        matchAll: async () => windows,
        openWindow: async (url: string) => { opened.push(url); },
      },
    },
    caches: {},
  });
  vm.runInContext(src, ctx, { filename: "sw.js" });
  const push = async (data: unknown) => {
    let done: Promise<unknown> | undefined;
    handlers.push({ data, waitUntil: (p: Promise<unknown>) => { done = p; } });
    assert.ok(done, "the worker is kept alive until the alert is on screen");
    await done;
  };
  const tap = async () => {
    let done: Promise<unknown> | undefined, closed = false;
    handlers.notificationclick({ notification: { close: () => { closed = true; } }, waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    return closed;
  };
  return { push, tap, shown, opened };
}

const pushed = (n: unknown) => ({ json: () => n, text: () => JSON.stringify(n) });

test("sw: an alert is shown as the Worker wrote it; quiet news makes no sound", async () => {
  const sw = loadPush();
  await sw.push(pushed({ title: "Leave 20 minutes earlier", body: "UA1503 now lands 10:40 PM", priority: 5, at: 1790000000000 }));
  assert.deepEqual(JSON.parse(JSON.stringify(sw.shown[0])), {
    title: "Leave 20 minutes earlier",
    options: { body: "UA1503 now lands 10:40 PM", icon: "/icon-192.png", badge: "/badge-96.png", silent: false, timestamp: 1790000000000 },
  });
  await sw.push(pushed({ title: "New feedback · v66", body: "", priority: 2 }));
  assert.equal(sw.shown[1].options.silent, true);
  assert.equal("timestamp" in sw.shown[1].options, false);
});

test("sw: a push it cannot read still shows something: an iPhone ends the alerts of an app that shows nothing", async () => {
  const sw = loadPush();
  await sw.push(null);                                                       // no payload at all
  await sw.push({ json: () => { throw new SyntaxError("not JSON"); } });     // not ours
  await sw.push(pushed({ body: "no title" }));
  await sw.push(pushed("a string"));
  assert.equal(sw.shown.length, 4);
  for (const s of sw.shown) {
    assert.equal(s.title, "Curbside");
    assert.match(s.options.body, /Open Curbside/);
  }
});

test("sw: a tap on an alert closes it and brings up the app: the open one, else a new one", async () => {
  let focused = 0;
  const open = loadPush([
    { url: "https://elsewhere.test/" },
    { url: `${ORIGIN}/`, focus: () => { focused++; } },
  ]);
  assert.equal(await open.tap(), true);
  assert.deepEqual([focused, open.opened], [1, []]);
  const shut = loadPush();
  await shut.tap();
  assert.deepEqual(shut.opened, ["/"]);
  // The guide open in a tab is not the app: the alert is about a run.
  let guide = 0;
  const reading = loadPush([
    { url: `${ORIGIN}/guide/`, focus: () => { guide++; } },
    { url: `${ORIGIN}/alpha/`, focus: () => { guide++; } },
  ]);
  await reading.tap();
  assert.deepEqual([guide, reading.opened], [0, ["/"]]);
  // The app opened by a share, or as the preview, is still the app.
  let app = 0;
  const shared = loadPush([{ url: `${ORIGIN}/?shared=1`, focus: () => { app++; } }]);
  await shared.tap();
  assert.deepEqual([app, shared.opened], [1, []]);
});

test("sw: the badge an alert names is a file the app serves", () => {
  const png = readFileSync(new URL("../../public/badge-96.png", import.meta.url));
  assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [96, 96]);
});

test("sw: an update clears old versions but never a share waiting for the page", async () => {
  // The name this sw.js carries, so a release changes one line, not this test too.
  const current = /const CACHE_NAME = "([^"]+)";/.exec(src)![1];
  const { handlers, deleted } = loadWith(["curbside-v59", "curbside-shared", "curbside-v60", current]);
  let done: Promise<unknown> | undefined;
  handlers.activate({ waitUntil: (p: Promise<unknown>) => { done = p; } });
  await done;
  assert.deepEqual(deleted, ["curbside-v59", "curbside-v60"].filter((n) => n !== current));
});
