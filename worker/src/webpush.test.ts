/**
 * Web Push (webpush.ts): the encryption against RFC 8291's own worked
 * example, the VAPID token against its public key, and what is sent where.
 *
 * The receiver here is written with node:crypto, not with the code under
 * test: a message only this file's sender could read would prove nothing.
 *
 *   node --test --experimental-strip-types src/webpush.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";

import {
  MAX_SUBSCRIPTIONS,
  allowedEndpoint,
  b64u,
  encryptPayload,
  payloadOf,
  sendWebPush,
  subscriptionFrom,
  subscriptionsKey,
  ttlOf,
  unb64u,
  urgencyOf,
  usableKey,
  vapidToken,
  withSubscription,
  withoutEndpoints,
  type Subscription,
  type Vapid,
} from "./webpush.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A P-256 key pair for ECDH from its base64url parts, as RFC 8291 prints them. */
async function ecdhPair(publicKey: string, privateKey: string): Promise<CryptoKeyPair> {
  const pub = unb64u(publicKey)!;
  const jwk = { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) };
  const curve = { name: "ECDH", namedCurve: "P-256" };
  return {
    publicKey: await crypto.subtle.importKey("jwk", jwk, curve, true, []),
    privateKey: await crypto.subtle.importKey("jwk", { ...jwk, d: privateKey }, curve, false, ["deriveBits"]),
  };
}

/** What a phone does with a push (RFC 8291 section 3.4 and RFC 8188), on node:crypto. */
function receive(body: Uint8Array, uaPrivate: string, uaPublic: string, auth: string): Uint8Array {
  const salt = body.subarray(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const record = body.subarray(21 + idLen);
  assert.ok(record.length <= recordSize, "one record");

  const ua = createECDH("prime256v1");
  ua.setPrivateKey(Buffer.from(unb64u(uaPrivate)!));
  const shared = ua.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), unb64u(uaPublic)!, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, unb64u(auth)!, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  const open = createDecipheriv("aes-128-gcm", cek, nonce);
  open.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([open.update(record.subarray(0, record.length - 16)), open.final()]);
  // The last record ends with the delimiter 2, then only padding zeros.
  let end = plain.length - 1;
  while (plain[end] === 0) end--;
  assert.equal(plain[end], 2, "the last-record delimiter");
  return new Uint8Array(plain.subarray(0, end));
}

/** A phone: its keys as a browser gives them, and the private half to read with. */
function phone(endpoint = "https://fcm.googleapis.com/fcm/send/abc123") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub: Subscription = { endpoint, p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth), at: "2026-10-02T12:00:00.000Z" };
  return { sub, privateKey: b64u(ecdh.getPrivateKey()) };
}

async function vapidPair(): Promise<Vapid> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey) as { d: string };
  return {
    publicKey: b64u(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer),
    privateKey: jwk.d,
    subject: "https://curbside.test",
  };
}

const NOTICE = { title: "Leave 20 minutes earlier", body: "UA1503 now lands 10:40 PM · leave by 9:10 PM", priority: 5 as const, tags: [] };

/* ------------------------------------------------- RFC 8291, Appendix A -- */

// Copied from the RFC's text (rfc-editor.org/rfc/rfc8291.txt, section 5 and
// Appendix A), not from memory.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
    + "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"
    + "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("encryption: RFC 8291's worked example comes out byte for byte", async () => {
  const body = await encryptPayload(new TextEncoder().encode(RFC.plaintext), RFC.uaPublic, RFC.auth, {
    salt: unb64u(RFC.salt)!, keys: await ecdhPair(RFC.asPublic, RFC.asPrivate),
  });
  assert.equal(b64u(body), RFC.body);
  // And this file's receiver reads the RFC's own message: it is a fair judge below.
  assert.equal(text(receive(unb64u(RFC.body)!, RFC.uaPrivate, RFC.uaPublic, RFC.auth)), RFC.plaintext);
});

test("encryption: a phone reads what it is sent; each message has its own key and salt", async () => {
  const { sub, privateKey } = phone();
  const plain = payloadOf(NOTICE, 1_790_000_000_000);
  const one = await encryptPayload(plain, sub.p256dh, sub.auth);
  const two = await encryptPayload(plain, sub.p256dh, sub.auth);
  assert.deepEqual(JSON.parse(text(receive(one, privateKey, sub.p256dh, sub.auth))),
    { title: NOTICE.title, body: NOTICE.body, priority: 5, at: 1_790_000_000_000 });
  assert.equal(text(receive(two, privateKey, sub.p256dh, sub.auth)), text(plain));
  assert.notEqual(b64u(one.subarray(0, 16)), b64u(two.subarray(0, 16)), "salt");
  assert.notEqual(b64u(one.subarray(21, 86)), b64u(two.subarray(21, 86)), "the message's own key");
  assert.equal(one.length, 86 + plain.length + 1 + 16);
  // Another phone cannot read it.
  const other = phone();
  assert.throws(() => receive(one, other.privateKey, other.sub.p256dh, other.sub.auth));
});

test("encryption: keys that are not a phone's are refused, not sent to", async () => {
  await assert.rejects(encryptPayload(new Uint8Array(1), "not base64 !!", "AAAA"));
  // 65 bytes that start like a point and are not on the curve.
  const off = b64u(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : 1)));
  assert.equal(await usableKey(off), false);
  assert.equal(await usableKey(phone().sub.p256dh), true);
});

/* ---------------------------------------------------------------- VAPID -- */

test("vapid: an ES256 token the public key verifies, for one push service, for 12 hours", async () => {
  const vapid = await vapidPair();
  const now = Date.parse("2026-10-02T12:00:00Z");
  const token = await vapidToken("https://web.push.apple.com", vapid, now);
  const [head, claims, signature] = token.split(".");
  assert.deepEqual(JSON.parse(text(unb64u(head)!)), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(text(unb64u(claims)!)),
    { aud: "https://web.push.apple.com", exp: now / 1000 + 12 * 3600, sub: "https://curbside.test" });
  const key = await crypto.subtle.importKey("raw", unb64u(vapid.publicKey)!, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(unb64u(signature)!.length, 64, "r||s, not DER");
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64u(signature)!,
    new TextEncoder().encode(`${head}.${claims}`)), true);
});

test("vapid: one signature per push service while it lasts; a new one before it runs out", async () => {
  const vapid = await vapidPair();
  const now = Date.parse("2026-10-02T12:00:00Z");
  const first = await vapidToken("https://fcm.googleapis.com", vapid, now);
  assert.equal(await vapidToken("https://fcm.googleapis.com", vapid, now + 10 * 3600e3), first, "reused with two hours left");
  assert.notEqual(await vapidToken("https://updates.push.services.mozilla.com", vapid, now), first, "each service its own");
  const later = await vapidToken("https://fcm.googleapis.com", vapid, now + 11.5 * 3600e3);
  assert.notEqual(later, first, "under an hour left: signed again");
  assert.equal(JSON.parse(text(unb64u(later.split(".")[1])!)).exp, (now + 11.5 * 3600e3) / 1000 + 12 * 3600);
});

test("vapid: keys that are not a pair are an error, never a token", async () => {
  const a = await vapidPair(), b = await vapidPair();
  await assert.rejects(vapidToken("https://fcm.googleapis.com", { ...a, privateKey: b.privateKey }, Date.now()));
  await assert.rejects(vapidToken("https://fcm.googleapis.com", { ...a, privateKey: "short" }, Date.now()));
  await assert.rejects(vapidToken("https://fcm.googleapis.com", { ...a, publicKey: "" }, Date.now()));
});

/* ------------------------------------------------- endpoints and records -- */

test("endpoint: only a browser's push service, over https, is ever fetched", () => {
  for (const ok of [
    "https://fcm.googleapis.com/fcm/send/dQw4:APA91b",
    "https://fcm.googleapis.com/wp/dQw4",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
    "https://web.push.apple.com/QGuQyavXutnMH9RN",
    "https://wns2-by3p.notify.windows.com/w/?token=BQYAAAD",
  ]) assert.equal(allowedEndpoint(ok), true, ok);
  for (const bad of [
    "http://fcm.googleapis.com/fcm/send/x",
    "https://fcm.googleapis.com.evil.example/fcm/send/x",
    "https://evil.example/fcm.googleapis.com",
    "https://fcm.googleapis.com@evil.example/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://push.apple.com.evil.example/x",
    "https://notify.windows.com/x",
    "https://127.0.0.1/x",
    "https://flightwatch-worker.juanfe02agu.workers.dev/api/assignments",
    `https://fcm.googleapis.com/${"x".repeat(2100)}`,
    "", "fcm.googleapis.com", null, 42,
  ]) assert.equal(allowedEndpoint(bad), false, String(bad));
});

test("subscription: a phone's is taken as it is; anything else is refused with a reason", () => {
  const { sub } = phone("https://web.push.apple.com/QGuQ");
  const read = subscriptionFrom({ endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: `${sub.p256dh}=`, auth: `${sub.auth}==` } });
  assert.deepEqual(read, { sub: { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth } }, "padding dropped");
  const keys = { p256dh: sub.p256dh, auth: sub.auth };
  assert.match((subscriptionFrom({ endpoint: "https://evil.example/x", keys }) as { error: string }).error, /push service/);
  for (const bad of [
    null, "x", {},
    { endpoint: sub.endpoint },
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh } },
    { endpoint: sub.endpoint, keys: { p256dh: sub.auth, auth: sub.auth } },
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.p256dh } },
    { endpoint: sub.endpoint, keys: { p256dh: b64u(new Uint8Array(65)), auth: sub.auth } },
    { endpoint: sub.endpoint, keys: { p256dh: 7, auth: {} } },
  ]) assert.ok("error" in subscriptionFrom(bad), JSON.stringify(bad));
});

test("the list's phones: the same one twice writes nothing; new keys replace; the oldest gives way", () => {
  const a = phone("https://fcm.googleapis.com/fcm/send/a").sub;
  const { at: _at, ...bare } = a;
  const one = withSubscription([], bare, "T1")!;
  assert.deepEqual(one, [{ ...bare, at: "T1" }]);
  assert.equal(withSubscription(one, bare, "T2"), null, "already there: no write");
  const rekeyed = { ...bare, auth: phone().sub.auth };
  assert.deepEqual(withSubscription(one, rekeyed, "T3"), [{ ...rekeyed, at: "T3" }]);

  let many: Subscription[] = [];
  for (let i = 0; i < MAX_SUBSCRIPTIONS + 2; i++) {
    many = withSubscription(many, { ...bare, endpoint: `https://fcm.googleapis.com/fcm/send/${i}` }, `T${i}`)!;
  }
  assert.equal(many.length, MAX_SUBSCRIPTIONS);
  assert.equal(many[0].endpoint, "https://fcm.googleapis.com/fcm/send/2");
  assert.equal(many.at(-1)!.endpoint, `https://fcm.googleapis.com/fcm/send/${MAX_SUBSCRIPTIONS + 1}`);

  assert.equal(withoutEndpoints(one, ["https://fcm.googleapis.com/fcm/send/nope"]), null);
  assert.deepEqual(withoutEndpoints(one, [a.endpoint]), []);
  assert.equal(subscriptionsKey("curbside-abc"), "push:curbside-abc");
});

/* -------------------------------------------------------- what is sent -- */

test("payload: the notice as the phone shows it; a GB run says so first; never too long to be taken", () => {
  const read = (n: Parameters<typeof payloadOf>[0]) => JSON.parse(text(payloadOf(n, 5)));
  assert.deepEqual(read(NOTICE), { title: NOTICE.title, body: NOTICE.body, priority: 5, at: 5 });
  assert.equal(read({ ...NOTICE, tags: ["GOVERNING BODY"] }).body, `GOVERNING BODY\n${NOTICE.body}`);
  assert.equal(read({ ...NOTICE, body: "", tags: [] }).body, "");
  const long = payloadOf({ ...NOTICE, body: "é".repeat(4000) }, 5);
  assert.ok(long.length < 3000);
  assert.deepEqual(JSON.parse(text(long)), { title: NOTICE.title, body: "", priority: 5, at: 5 });
});

test("payload: an alert about a run says which, cut short or not, so its tap opens that run (v69)", () => {
  const read = (n: Parameters<typeof payloadOf>[0]) => JSON.parse(text(payloadOf(n, 5)));
  assert.deepEqual(read({ ...NOTICE, run: "369736" }),
    { title: NOTICE.title, body: NOTICE.body, priority: 5, at: 5, run: "369736" });
  assert.equal(read({ ...NOTICE, run: "369736", body: "é".repeat(4000) }).run, "369736");
  assert.ok(!("run" in read(NOTICE)), "a test alert is about no run");
});

test("urgency: anything about a flight wakes the phone; quiet news waits, for a day at most", () => {
  assert.deepEqual([5, 4, 3, 2, 1].map(urgencyOf), ["high", "high", "high", "normal", "normal"]);
  assert.deepEqual([5, 3, 2].map(ttlOf), [10800, 10800, 86400]);
});

/** sendWebPush with the push service stubbed. */
async function send(sub: Subscription, answer: number | "down", vapid: Vapid, notice = NOTICE, said = "no") {
  const calls: { url: string; init: RequestInit & { headers: Record<string, string> } }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: never) => {
    calls.push({ url: String(url), init });
    if (answer === "down") throw new TypeError("fetch failed");
    return new Response(answer === 201 ? null : said, { status: answer });
  }) as never;
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  try {
    return { result: await sendWebPush(sub, notice, vapid, Date.parse("2026-10-02T12:00:00Z")), calls, errors };
  } finally { globalThis.fetch = real; console.error = realError; }
}

test("send: one POST to the phone's push service, signed, encrypted, urgent, kept three hours", async () => {
  const vapid = await vapidPair();
  const { sub, privateKey } = phone("https://web.push.apple.com/QGuQyavX");
  const { result, calls } = await send(sub, 201, vapid);
  assert.deepEqual(result, { status: 201, ok: true, gone: false });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, sub.endpoint);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  assert.deepEqual({ ...init.headers, Authorization: "" }, {
    TTL: "10800", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: "",
  });
  const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(init.headers.Authorization)!;
  assert.ok(m, init.headers.Authorization);
  assert.equal(m[2], vapid.publicKey);
  assert.equal(JSON.parse(text(unb64u(m[1].split(".")[1])!)).aud, "https://web.push.apple.com");
  const shown = JSON.parse(text(receive(init.body as Uint8Array, privateKey, sub.p256dh, sub.auth)));
  assert.equal(shown.title, NOTICE.title);
  assert.ok(!text(init.body as Uint8Array).includes("UA1503"), "the push service cannot read it");

  const quiet = await send(sub, 201, vapid, { ...NOTICE, priority: 2 });
  assert.deepEqual([quiet.calls[0].init.headers.TTL, quiet.calls[0].init.headers.Urgency], ["86400", "normal"]);
});

test("send: 404 and 410 mean the phone is gone; a refusal or no answer does not", async () => {
  const vapid = await vapidPair();
  const { sub } = phone();
  assert.deepEqual((await send(sub, 410, vapid)).result, { status: 410, ok: false, gone: true });
  assert.deepEqual((await send(sub, 404, vapid)).result, { status: 404, ok: false, gone: true });
  for (const status of [400, 401, 403, 413, 429, 500, 301]) {
    assert.deepEqual((await send(sub, status, vapid)).result, { status, ok: false, gone: false }, String(status));
  }
  assert.deepEqual((await send(sub, "down", vapid)).result, { status: 0, ok: false, gone: false });
  // Apple's own word for a subscription that is not a phone's, as it answered
  // a made-up one on 2026-10-02. Its other refusals are about the request.
  assert.deepEqual((await send(sub, 400, vapid, NOTICE, '{"reason":"BadDeviceToken"}')).result, { status: 400, ok: false, gone: true });
  assert.deepEqual((await send(sub, 403, vapid, NOTICE, '{"reason":"BadJwtToken"}')).result, { status: 403, ok: false, gone: false });
});

test("send: a record that is not a phone's is dropped without a fetch; bad server keys keep the phone", async () => {
  const vapid = await vapidPair();
  const { sub } = phone();
  const aimed = await send({ ...sub, endpoint: "https://evil.example/x" }, 201, vapid);
  assert.deepEqual([aimed.result, aimed.calls.length], [{ status: 0, ok: false, gone: true }, 0]);
  const unkeyed = await send({ ...sub, p256dh: b64u(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : 1))) }, 201, vapid);
  assert.deepEqual([unkeyed.result, unkeyed.calls.length], [{ status: 0, ok: false, gone: true }, 0]);

  const broken = await send(sub, 201, { ...vapid, privateKey: "short" });
  assert.deepEqual([broken.result, broken.calls.length], [{ status: 0, ok: false, gone: false }, 0]);
  assert.ok(broken.errors.length === 1 && !broken.errors[0].includes(sub.endpoint));
});
