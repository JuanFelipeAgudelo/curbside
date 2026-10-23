/** Where the KV quota goes: the counter, the route names, the line. */
import test from "node:test";
import assert from "node:assert/strict";
import { countingKV, kvLine, onWorkers, routeName } from "./kvcount.ts";

test("kv count: each call is counted by kind and still answers as the namespace would", async () => {
  const seen: string[] = [];
  const kv = {
    async get(k: string) { seen.push(`get ${k}`); return "v"; },
    async getWithMetadata(k: string) { seen.push(`gwm ${k}`); return { value: "v", metadata: null }; },
    async put(k: string, v: string) { seen.push(`put ${k}=${v}`); },
    async delete(k: string) { seen.push(`delete ${k}`); },
    async list(o: { prefix: string }) { seen.push(`list ${o.prefix}`); return { keys: [] }; },
    name: "ns",
  };
  const { kv: c, ops } = countingKV(kv);
  assert.equal(await c.get("a"), "v");
  await c.getWithMetadata("b");
  await c.put("a", "1");
  await c.put("b", "2");
  await c.delete("a");
  assert.deepEqual(await c.list({ prefix: "p" }), { keys: [] });
  assert.equal(c.name, "ns");
  assert.deepEqual(ops, { get: 2, put: 2, delete: 1, list: 1 });
  assert.deepEqual(seen, ["get a", "gwm b", "put a=1", "put b=2", "delete a", "list p"]);
});

test("kv count: the app's paths are logged as they are; anything else is 'other', never a code", () => {
  assert.equal(routeName("GET", "/api/assignments"), "GET /api/assignments");
  assert.equal(routeName("POST", "/api/assignments/patches/undo"), "POST /api/assignments/patches/undo");
  assert.equal(routeName("GET", "/api/stamp"), "GET /api/stamp");
  assert.equal(routeName("GET", "/api/flights/ab12cd34"), "GET other");
  assert.equal(routeName("GET", "/whatever"), "GET other");
  assert.equal(routeName("get <x>", "/api/stamp"), "OTHER /api/stamp");
});

test("kv count: a line only when KV was touched; only on Cloudflare", () => {
  assert.equal(kvLine("GET /api/stamp", { get: 0, put: 0, delete: 0, list: 0 }), null);
  assert.deepEqual(kvLine("cron", { get: 3, put: 1, delete: 0, list: 2 }),
    { kv: "ops", route: "cron", get: 3, put: 1, delete: 0, list: 2 });
  assert.equal(onWorkers(), false);
});
