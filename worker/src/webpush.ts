/**
 * Web Push: a notice straight to the installed app on a phone (v66).
 *
 * ntfy.sh turns a Worker's pushes away (its free limit is per IP address, and
 * a Worker's is Cloudflare's, shared), so the alert goes the way every
 * browser already offers: the phone subscribes with this server's key, hands
 * the subscription to its list, and the Worker posts each notice to the
 * phone's own push service. No second app, no public topic, no quota shared
 * with strangers.
 *
 * Three standards, done with WebCrypto and nothing else:
 *   RFC 8030  the POST itself: a TTL, an Urgency, the encrypted body.
 *   RFC 8292  VAPID: an ES256 token signed with VAPID_PRIVATE, so the push
 *             service takes the message only from the server whose public
 *             key the phone subscribed with.
 *   RFC 8291  the body, encrypted to the phone's own key (aes128gcm, RFC
 *             8188): the push service carries it and cannot read it.
 *
 * Pure but for the one fetch in sendWebPush: no KV, no Env. index.ts keeps
 * the subscriptions and says who gets what.
 */

import type { Notice } from "./notify";

/** One phone's subscription, as its list keeps it. */
export interface Subscription {
  endpoint: string; // the push service's URL for this phone
  p256dh: string;   // the phone's public key (P-256, uncompressed), base64url
  auth: string;     // its 16-byte secret, base64url
  at: string;       // when the list first took it
}

/** The server's own key pair (the two secrets) and who answers for it. */
export interface Vapid {
  publicKey: string;  // 65 bytes, base64url: what the phone subscribes with
  privateKey: string; // 32 bytes, base64url
  subject: string;    // a URL or mailto: the push service may contact
}

/** A list's phones. More than a driver has; the oldest gives way. */
export const MAX_SUBSCRIPTIONS = 10;

/** Keyed by the list's TOPIC, not its code: feedback and suggestions are
 *  sent to the keeper's topic, and reach the keeper's phones with no lookup. */
export function subscriptionsKey(topic: string): string {
  return `push:${topic}`;
}

/* ------------------------------------------------------------ base64url -- */

export function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Null for anything that is not base64url (padded or not). */
export function unb64u(text: unknown): Uint8Array | null {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(text)) return null;
  const bare = text.replace(/=+$/, "");
  if (bare.length % 4 === 1) return null;
  try {
    const bin = atob(bare.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const utf8 = new TextEncoder();

/* -------------------------------------------------- whose endpoint it is -- */

/**
 * The push services browsers use. The Worker FETCHES a subscription's
 * endpoint, and a subscription is whatever a caller with a list code posts,
 * so anything else would let the Worker be pointed at any address (SSRF).
 */
const PUSH_HOSTS: RegExp[] = [
  /^fcm\.googleapis\.com$/,                  // Chrome, Edge, Samsung, Brave, Opera
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^([a-z0-9-]+\.)+push\.apple\.com$/,       // Safari, and every iPhone Home Screen app
  /^([a-z0-9-]+\.)+notify\.windows\.com$/,   // Edge on Windows
];

const MAX_ENDPOINT = 2048;

export function allowedEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT) return false;
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
  return PUSH_HOSTS.some((host) => host.test(url.hostname));
}

/**
 * A subscription as the phone sends it (PushSubscription.toJSON()), or why it
 * is refused. The keys' sizes are checked here; that the public key is a
 * point on the curve, by usableKey.
 */
export function subscriptionFrom(raw: unknown): { sub: Omit<Subscription, "at"> } | { error: string } {
  const s = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!s || typeof s !== "object") return { error: "subscription is required" };
  if (!allowedEndpoint(s.endpoint)) return { error: "that is not a browser's push service" };
  const p256dh = unb64u(s.keys?.p256dh), auth = unb64u(s.keys?.auth);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4 || !auth || auth.length !== 16) {
    return { error: "the subscription's keys are not a phone's" };
  }
  return { sub: { endpoint: s.endpoint as string, p256dh: b64u(p256dh), auth: b64u(auth) } };
}

/** Can a message be encrypted to this key at all? A made-up one cannot. */
export async function usableKey(p256dh: string): Promise<boolean> {
  try {
    await crypto.subtle.importKey("raw", unb64u(p256dh)!, { name: "ECDH", namedCurve: "P-256" }, false, []);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------ the list's own record -- */

/**
 * The list's phones with this one among them: the same endpoint is replaced
 * where it stands (its keys may have changed), a new one goes last, and past
 * the cap the oldest gives way. Null when the list already has exactly this,
 * so a phone that says so again at every launch costs a read and no write.
 */
export function withSubscription(
  list: Subscription[], sub: Omit<Subscription, "at">, at: string,
): Subscription[] | null {
  const i = list.findIndex((s) => s.endpoint === sub.endpoint);
  if (i >= 0) {
    if (list[i].p256dh === sub.p256dh && list[i].auth === sub.auth) return null;
    return list.map((s, n) => (n === i ? { ...sub, at } : s));
  }
  return [...list, { ...sub, at }].slice(-MAX_SUBSCRIPTIONS);
}

/** The list without these endpoints; null when it held none of them. */
export function withoutEndpoints(list: Subscription[], endpoints: string[]): Subscription[] | null {
  const left = list.filter((s) => !endpoints.includes(s.endpoint));
  return left.length === list.length ? null : left;
}

/* -------------------------------------------------- what the phone gets -- */

/**
 * The whole POST may be 4096 bytes on the strictest services; the header, the
 * tag and the delimiter take 103. Kept well under: a notice is a few lines.
 */
const MAX_PLAINTEXT = 3000;

/**
 * The notice as the phone's service worker reads it (public/sw.js). ntfy's
 * tags have no place on a phone's own notification, so the one tag there is
 * (GOVERNING BODY) leads the text instead. `run`, when the notice is about
 * one, is the assignment's number: the tap opens that run (v69). A phone on
 * an older app ignores it and opens the list, as before.
 */
export function payloadOf(notice: Notice, now: number): Uint8Array {
  const body = [notice.tags.join(" · "), notice.body].filter(Boolean).join("\n");
  const rest = { priority: notice.priority, at: now, ...(notice.run ? { run: notice.run } : {}) };
  const full = utf8.encode(JSON.stringify({ title: notice.title, body, ...rest }));
  if (full.length <= MAX_PLAINTEXT) return full;
  // Never sent too long to be taken: the title alone still says what to do.
  return utf8.encode(JSON.stringify({ title: notice.title.slice(0, 200), body: "", ...rest }));
}

/**
 * How soon the push service must wake the phone. Anything about a flight is
 * "high": "normal" waits for a sleeping Android phone to wake by itself, and
 * a delay heard after the driver has left is no use. Only quiet news (a gate
 * to expect, a tester's note) can wait; nothing is ever "low", which is held
 * back until the phone is charging or on Wi-Fi.
 */
export function urgencyOf(priority: number): "high" | "normal" {
  return priority >= 3 ? "high" : "normal";
}

/**
 * Seconds the push service keeps a message for a phone it cannot reach. Three
 * hours for a flight: the phone coming out of a dead zone must still hear
 * that a flight is EARLY, and past three hours the stop is history
 * (notify.ts STALE_AFTER_MIN). A day for quiet news, which is no less true
 * in the morning.
 */
export function ttlOf(priority: number): number {
  return priority >= 3 ? 3 * 3600 : 24 * 3600;
}

/* ------------------------------------------------- encryption, RFC 8291 -- */

const RECORD_SIZE = 4096;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/**
 * The message body for one subscription: the aes128gcm header (salt, record
 * size, this message's own public key), then the one encrypted record.
 *
 * A fresh key pair and salt for every message. `fixed` is for the tests only:
 * RFC 8291's worked example gives both, and the bytes must come out the same.
 */
export async function encryptPayload(
  plaintext: Uint8Array, p256dh: string, auth: string,
  fixed?: { salt: Uint8Array; keys: CryptoKeyPair },
): Promise<Uint8Array> {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  if (!uaPublic || !authSecret) throw new Error("not a subscription's keys");
  const curve = { name: "ECDH", namedCurve: "P-256" };
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, curve, false, []);
  const pair = fixed?.keys ?? (await crypto.subtle.generateKey(curve, false, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  // The runtime reads `public`; the Workers types name the field `$public`.
  const withPhone = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(withPhone, pair.privateKey, 256));

  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(authSecret, shared, concat(utf8.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8.encode("Content-Encoding: nonce\0"), 12);

  // One record, so its nonce is the derived one as it is (sequence 0), and
  // the delimiter is 2: the last record. No padding beyond it.
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, key, concat(plaintext, Uint8Array.of(2))));

  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

/* ------------------------------------------------------ VAPID, RFC 8292 -- */

/** A token's life. The limit is 24 hours; a push service may refuse more. */
const TOKEN_LIFE_S = 12 * 3600;
/** Signed once per push service and reused while it has this long left. */
const TOKEN_SPARE_S = 3600;

const tokens = new Map<string, { token: string; exp: number }>();

/** `aud` is the push service's origin; the token is good only there. */
export async function vapidToken(audience: string, vapid: Vapid, now: number): Promise<string> {
  const nowS = Math.floor(now / 1000);
  const kept = tokens.get(`${vapid.publicKey}|${audience}`);
  if (kept && kept.exp - nowS > TOKEN_SPARE_S && kept.exp - nowS <= TOKEN_LIFE_S) return kept.token;

  const pub = unb64u(vapid.publicKey), d = unb64u(vapid.privateKey);
  if (!pub || pub.length !== 65 || pub[0] !== 4 || !d || d.length !== 32) {
    throw new Error("the VAPID keys are not a P-256 pair");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)), d: b64u(d) },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const exp = nowS + TOKEN_LIFE_S;
  const signed = `${b64u(utf8.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })))}.`
    + b64u(utf8.encode(JSON.stringify({ aud: audience, exp, sub: vapid.subject })));
  // WebCrypto signs ECDSA as r||s, 64 bytes: the form a JWT wants.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8.encode(signed));
  const token = `${signed}.${b64u(signature)}`;
  if (tokens.size > 50) tokens.clear(); // never grow without bound
  tokens.set(`${vapid.publicKey}|${audience}`, { token, exp });
  return token;
}

/* ------------------------------------------------------------- sending -- */

/** Like ntfy's: a push service that hangs must not hold a tick or a save. */
const PUSH_TIMEOUT_MS = 5_000;

export interface PushResult {
  /** The push service's answer; 0 when it gave none, or nothing could be sent. */
  status: number;
  /** Taken for delivery (201). */
  ok: boolean;
  /** The subscription is no more (the app was removed, or alerts turned off
   *  in the phone's own settings): it leaves the list. */
  gone: boolean;
}

export async function sendWebPush(
  sub: Subscription, notice: Notice, vapid: Vapid, now: number = Date.now(),
): Promise<PushResult> {
  let body: Uint8Array, token: string;
  try {
    // Checked when it was taken, and again here: a record written any other
    // way must not aim the Worker somewhere else.
    if (!allowedEndpoint(sub.endpoint)) return { status: 0, ok: false, gone: true };
    body = await encryptPayload(payloadOf(notice, now), sub.p256dh, sub.auth);
  } catch {
    // Keys nothing can be encrypted to will never work.
    return { status: 0, ok: false, gone: true };
  }
  try {
    token = await vapidToken(new URL(sub.endpoint).origin, vapid, now);
  } catch (err) {
    // Ours to fix, not the phone's: the subscription stays.
    console.error("web push not signed:", err instanceof Error ? err.message : "unknown");
    return { status: 0, ok: false, gone: false };
  }
  let res: Response;
  try {
    res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        TTL: String(ttlOf(notice.priority)),
        Urgency: urgencyOf(notice.priority),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Authorization: `vapid t=${token}, k=${vapid.publicKey}`,
      },
      body,
      // A push service has no reason to send the message elsewhere.
      redirect: "manual",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
  } catch {
    return { status: 0, ok: false, gone: false };
  }
  let gone = res.status === 404 || res.status === 410;
  try {
    // Apple answers 400 "BadDeviceToken" for a subscription that is not a
    // phone's (asked 2026-10-02 with a made-up one); any other 400 is about
    // the request, which is ours to fix, and the phone stays.
    if (res.status === 400) gone = /BadDeviceToken/.test((await res.text()).slice(0, 300));
    else await res.body?.cancel();
  } catch { /* nothing to read */ }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, gone };
}
