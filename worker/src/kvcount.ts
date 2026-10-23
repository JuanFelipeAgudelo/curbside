/**
 * Where the KV quota goes (v65). The free tier is one account-wide pool a day
 * (1,000 lists, 1,000 writes, 1,000 deletes, 100,000 reads), and every tester
 * adds to it. Each request or cron tick that touched KV leaves one line in
 * Workers Logs: the route and four counts, never a code, topic or name (B5).
 * Logged as an object, so the dashboard's query builder can sum a field by
 * route over a day.
 */

export interface KVOps { get: number; put: number; delete: number; list: number }

const KIND: Record<string, keyof KVOps> = {
  get: "get", getWithMetadata: "get", put: "put", delete: "delete", list: "list",
};

/** The namespace, counting each call it passes through. */
export function countingKV<T extends object>(kv: T): { kv: T; ops: KVOps } {
  const ops: KVOps = { get: 0, put: 0, delete: 0, list: 0 };
  const wrapped = new Proxy(kv, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      const kind = typeof prop === "string" ? KIND[prop] : undefined;
      if (!kind || typeof value !== "function") return value;
      return (...args: unknown[]) => { ops[kind]++; return value.apply(target, args); };
    },
  });
  return { kv: wrapped, ops };
}

/** A route as it may be logged: the app's own paths only, else "other" (a
 *  made-up path is whatever a caller typed). */
export function routeName(method: string, pathname: string): string {
  const path = /^\/api\/[a-z]+(\/[a-z]+){0,2}$/.test(pathname) ? pathname : "other";
  return `${/^[A-Z]{3,7}$/.test(method) ? method : "OTHER"} ${path}`;
}

/** The line, or null when nothing touched KV. */
export function kvLine(route: string, ops: KVOps): ({ kv: "ops"; route: string } & KVOps) | null {
  return ops.get + ops.put + ops.delete + ops.list ? { kv: "ops", route, ...ops } : null;
}

/** Only on Cloudflare: node (the tests) says otherwise. */
export function onWorkers(): boolean {
  return (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers";
}
