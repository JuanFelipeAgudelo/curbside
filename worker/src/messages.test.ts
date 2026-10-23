/**
 * The driver's messages (public/messages.js), run in node: filling a
 * template from a passenger's facts, the greeting, the day word, and the
 * printed number as WhatsApp and Messages want it.
 *
 *   node --test --experimental-strip-types src/messages.test.ts
 */

process.env.TZ = "America/New_York";

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../public/messages.js", import.meta.url), "utf8");
const store = new Map<string, string>();
const ctx = vm.createContext({
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
});
vm.runInContext(src, ctx, { filename: "messages.js" });
const m = ctx as unknown as Record<string, any>;
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const DEFAULTS = vm.runInContext("DEFAULT_MESSAGES", ctx);

const party = {
  name: "Castillo, Ana & Luis", pax: 2, tag: "D", kind: "departure",
  from: "Warwick", to: "JFK", door: "A-res WRK", flight: "DL404", time: "5:30a", appointment: null, day: "2026-09-29",
};
const single = { ...party, name: "Okafor, Daniel", pax: 1, tag: "A", kind: "arrival", from: "JFK", to: "Warwick", door: "Baggage Claim", flight: "B61123", time: "9:05a" };
const opts = { today: "2026-09-28", myName: "Sam Driver" };

test("messages: the trip type comes from the tag dispatch printed", () => {
  assert.deepEqual(["D", "GBD", "A", "GBA", "MED", "S", "HO", "TD", null, "X"].map(m.messageKind),
    ["departure", "departure", "arrival", "arrival", "medical", "shuttle", "other", "other", "other", "other"]);
});

test("messages: the owner's departure message, filled for a party", () => {
  assert.equal(m.fillMessage(DEFAULTS.departure, party, opts),
    "Dear Family Castillo,\n"
    + "I have the pleasure of being your driver from Warwick to JFK for flight DL404.\n"
    + "I'll meet you outside A-res WRK at 5:30a.\n"
    + "Does this work for you?\n\n"
    + "Please let me know if there's anything I can do to make your trip smoother.\n"
    + "See you tomorrow!\n-Sam Driver");
});

test("messages: a single is Brother, Sister or just the name, never guessed", () => {
  const t = "Dear [NAME],";
  assert.equal(m.fillMessage(t, single, { ...opts, greet: "brother" }), "Dear Brother Okafor,");
  assert.equal(m.fillMessage(t, single, { ...opts, greet: "sister" }), "Dear Sister Okafor,");
  assert.equal(m.fillMessage(t, single, { ...opts, greet: "name" }), "Dear Okafor,");
  assert.equal(m.fillMessage(t, single, opts), "Dear [NAME],");
  // Two on one row is a family even when the count is missing.
  assert.equal(m.fillMessage(t, { ...party, pax: undefined }, opts), "Dear Family Castillo,");
  assert.equal(m.lastNameOf("Solo"), "Solo");
});

test("messages: a field with nothing to fill stays in brackets, and says so", () => {
  const facts = { ...single, flight: null };
  const pieces = plain(m.fillPieces("Flight [FLIGHT] lands at [time] [GATE]. -[MY NAME]", facts, { today: opts.today }));
  assert.deepEqual(pieces, [
    { text: "Flight " }, { text: "[FLIGHT]", missing: true }, { text: " lands at " },
    { text: "9:05a", field: "TIME" }, { text: " " }, { text: "[GATE]", missing: true },
    { text: ". -" }, { text: "[MY NAME]", missing: true },
  ]);
  assert.equal(m.fillMessage("[ last  name ]", single, opts), "Okafor");
  assert.equal(m.fillMessage("no fields [1]", single, opts), "no fields [1]");
});

test("messages: a medical run's appointment, and every kind has its own message", () => {
  const med = { ...party, name: "Brennan, Ruth", pax: 1, tag: "MED", kind: "medical", from: "Wallkill", to: "the clinic", door: "F Res", flight: null, appointment: "10:30a", time: "9:15a" };
  assert.match(m.fillMessage(DEFAULTS.medical, med, { ...opts, greet: "sister" }),
    /^Dear Sister Brennan,\n.*from Wallkill to the clinic for your 10:30a appointment\.\nI'll meet you outside F Res at 9:15a\./);
  assert.match(DEFAULTS.arrival, /outside baggage claim when flight \[FLIGHT\] lands at \[TIME\]/);
  for (const k of vm.runInContext("MESSAGE_KINDS", ctx)) {
    assert.ok(DEFAULTS[k.kind].endsWith("-[MY NAME]"), k.kind);
    for (const f of (DEFAULTS[k.kind].match(/\[[A-Z ]+\]/g) || [])) {
      assert.ok(m.messageFields(k.kind).includes(f.slice(1, -1)), `${k.kind} offers ${f}`);
    }
  }
  assert.deepEqual(plain(m.messageFields("medical")), ["NAME", "LAST NAME", "FROM", "TO", "DOOR", "APPOINTMENT", "TIME", "DAY", "MY NAME"]);
});

test("messages: a message written with \"outside [FROM]\" meant the door, and says [DOOR] once v62 moves it", () => {
  const mine = { departure: "Hi [NAME], from [FROM] to [TO]. Outside [ from ] at [TIME], and outside [FROM] again.", arrival: "At [FROM]." };
  assert.deepEqual(plain(m.doorMigrated(mine)), {
    departure: "Hi [NAME], from [FROM] to [TO]. Outside [DOOR] at [TIME], and outside [DOOR] again.",
    arrival: "At [FROM].",
  });
});

test("messages: the day in words", () => {
  assert.equal(m.dayWord("2026-09-29", "2026-09-29"), "today");
  assert.equal(m.dayWord("2026-09-29", "2026-09-28"), "tomorrow");
  assert.equal(m.dayWord("2026-10-01", "2026-09-28"), "on Thursday");
  assert.equal(m.dayWord("2026-10-06", "2026-09-28"), "on Tue 6 Oct");
  // Across the November clock change, still whole days.
  assert.equal(m.dayWord("2026-11-02", "2026-11-01"), "tomorrow");
});

test("messages: the printed number as WhatsApp wants it", () => {
  assert.equal(m.waNumber("(845) 555-0142"), "18455550142");   // US: gets its 1
  assert.equal(m.waNumber("1-845-555-0142"), "18455550142");
  assert.equal(m.waNumber("+44 7700 900123"), "447700900123");  // says its country
  assert.equal(m.waNumber("0044 7700 900123"), "447700900123");
  assert.equal(m.waNumber("07700 900456"), null);               // whose country? no guess
  assert.equal(m.waNumber("555-0100"), null);
  assert.equal(m.waNumber("(045) 555-0142"), null);             // no US area code starts 0/1
  assert.equal(m.waNumber(""), null);
  assert.equal(m.waNumber(null), null);
});

test("messages: WhatsApp and Messages links carry the draft, or open an empty chat", () => {
  const text = "Dear Family Castillo,\nSee you & bye?";
  assert.equal(m.waLink("(845) 555-0142", text), `https://wa.me/18455550142?text=${encodeURIComponent(text)}`);
  assert.equal(m.waLink("(845) 555-0142", ""), "https://wa.me/18455550142");
  assert.equal(m.waLink("07700 900456", text), null);
  assert.equal(m.smsLink("(845) 555-0142", text), `sms:+18455550142?&body=${encodeURIComponent(text)}`);
  assert.equal(m.smsLink("07700 900456", ""), "sms:07700900456");
  assert.equal(m.smsLink("", "x"), null);
});

test("messages: the driver's wording is kept per kind; their default forgets it", () => {
  store.clear();
  assert.equal(m.messageTemplate("shuttle"), DEFAULTS.shuttle);
  m.saveMessageTemplate("shuttle", "Hi [NAME]");
  assert.equal(m.messageTemplate("shuttle"), "Hi [NAME]");
  assert.equal(m.messageTemplate("other"), DEFAULTS.other);
  m.saveMessageTemplate("shuttle", "");            // an empty message is theirs too
  assert.equal(m.messageTemplate("shuttle"), "");
  m.saveMessageTemplate("shuttle", DEFAULTS.shuttle);
  assert.equal(store.get("fw_messages"), "{}");
  m.setGreet("Okafor, Daniel", "brother");
  assert.equal(m.greetOf("Okafor, Daniel"), "brother");
  assert.equal(m.greetOf("Someone, Else"), null);
  store.set("fw_messages", "not json");
  assert.equal(m.messageTemplate("arrival"), DEFAULTS.arrival);
});
