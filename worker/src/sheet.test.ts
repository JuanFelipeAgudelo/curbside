/**
 * The sheet parser (public/importer/sheet.js). It was ported from a Python
 * importer, and every one of that importer's 67 tests has its twin: here, or
 * for the leg times in notify.test.ts, or for source hygiene in tools.test.ts
 * (the map, test by test: `git log --grep "67 tests"`; the Python itself: the
 * tag python-importer-last). Its flat-job path (build_jobs, leg_minutes: the
 * retired flight UI) was never ported; where one of those tests pinned a fact
 * the assignment also carries, that fact is asserted here on the assignment.
 *
 * Each case is a bug that shipped once. Fixtures are redacted layout text of
 * real assignments (tools/fixtures/), named for the fact they pin.
 *
 *   node --test --experimental-strip-types src/sheet.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  actionsIn, buildAssignment, codeForPlace, dropoffPoints, parseFlight, parseText, partyKey,
  partyLabel, placeCodeOf, rowEndpoints, unknownAirlineNumber,
} from "../../public/importer/sheet.js";
import { lookup } from "../../public/importer/airlines.js";
import { readText } from "../../public/importer/index.js";

const FIX = new URL("../../tools/fixtures/", import.meta.url);
const ALL = readdirSync(FIX).sort();
/** The fixtures: scrubbed layout text. Beside each, `<name>.json`: the run it must read as. */
const NAMES = ALL.filter((n) => n.endsWith(".txt"));

function fixtureText(stem: string): string {
  const name = NAMES.find((n) => n.startsWith(stem));
  if (!name) throw new Error(`no fixture starting ${stem}`);
  return readFileSync(new URL(name, FIX), "utf8").replace(/\r\n?/g, "\n");
}
/** parse_assignment on a .txt fixture: the text, the file name as source. */
function fixture(stem: string): any {
  const name = NAMES.find((n) => n.startsWith(stem))!;
  return parseText(fixtureText(stem), name);
}
const assignment = (stem: string): any => buildAssignment(fixture(stem));
const entities = (a: any): any[] => a.steps.flatMap((s: any) => s.actions.flatMap((x: any) => x.entities));
const iso = (d: any) => `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;

// ---------------------------------------------------------------- fixtures

test("every fixture parses", () => {
  assert.ok(NAMES.length >= 12, "fixtures are missing");
  for (const n of NAMES) {
    const doc = parseText(readFileSync(new URL(n, FIX), "utf8").replace(/\r\n?/g, "\n"), n);
    assert.ok(doc, `${n} returned null`);
    assert.match(doc.assignment, /^\d+$/);
    assert.ok(doc.printed, `${n}: no page-footer timestamp`);
  }
});

test("every fixture reads as its golden answer, whole", () => {
  // The run each .txt must read as, every field of it: the reader's own
  // output, committed. First written while the Python importer still ran, and
  // byte for byte what it answered. `node tools/golden.mjs` rewrites them
  // after a change that was meant; a difference nobody meant is the bug.
  const want = NAMES.map((n) => n.slice(0, -4) + ".json");
  assert.deepEqual(ALL.filter((n) => n.endsWith(".json")), want, "one answer per fixture, and no answer without one");
  for (const n of NAMES) {
    const got = readText(readFileSync(new URL(n, FIX), "utf8").replace(/\r\n?/g, "\n"), n);
    assert.ok(got.ok, `${n}: ${JSON.stringify(got)}`);
    const golden = JSON.parse(readFileSync(new URL(n.slice(0, -4) + ".json", FIX), "utf8"));
    assert.deepEqual(got.assignment, golden, `${n}: if this change was meant, node tools/golden.mjs and read the diff`);
  }
});

test("fixtures carry no obvious PII", () => {
  for (const n of ALL) {
    const body = readFileSync(new URL(n, FIX), "utf8");
    assert.ok(!body.includes("@bethel"), n);
    assert.doesNotMatch(body, /\+1 (?!555)\d{3}-\d{3}-\d{4}/, n);
  }
});

// ------------------------------------------------------------------ header

test("a timestamp wrapping mid-value still parses", () => {
  const a = assignment("375126");
  assert.equal(a.start, "2026-09-16 07:45");
  assert.equal(a.end, "2026-09-16 12:00");
});

test("an empty parking cell is not the next row", () => {
  const doc = fixture("373621");
  assert.equal(doc.origin, null);
  for (const bad of ["Driver notes", "Sprinter", "Seats"]) {
    if (doc.parking) assert.ok(!doc.parking.includes(bad));
  }
});

test("the parking prefix is the origin site", () => {
  const doc = fixture("369736");
  assert.ok(doc.parking.startsWith("FKL-NBD"));
  assert.equal(doc.origin, "FKL");
});

// ------------------------------------------------------------------- notes

test("notes are not truncated to one line", () => {
  const notes = fixture("334184").driverNotes;
  assert.ok(notes.includes("\n"));
  assert.ok(notes.includes("7:45a"));
  assert.ok(notes.includes("Depart WRK Lobby for HUB"));
});

test("notes stop before the next section", () => {
  const notes = fixture("353328").driverNotes;
  assert.ok(notes);
  assert.ok(!notes.includes("Assistant"));
  assert.ok(!notes.includes("ETA:"));
});

// ------------------------------------------------------------------- steps

test("(Unavailable) rows are not stops", () => {
  for (const s of fixture("369736").stops) assert.ok(!s.label.includes("Unavailable"));
});

test("the first step has no eta and the last no etd", () => {
  const { stops } = fixture("369736");
  assert.equal(stops[0].eta, null);
  assert.equal(stops[stops.length - 1].etd, null);
});

test("an overnight assignment rolls the date forward", () => {
  const doc = fixture("369736");
  assert.equal(iso(doc.stops[0].date), "2026-08-31");
  assert.equal(iso(doc.stops[doc.stops.length - 1].date), "2026-09-01");
  assert.ok(doc.dateOk, "the last stop should match the stated end date");
});

test("a disagreeing rollover is reported, not hidden", () => {
  const { issues } = assignment("361028");
  assert.ok(issues.some((i: string) => i.includes("end date")), JSON.stringify(issues));
});

// ------------------------------------------------------------- assignments

test("the itinerary survives", () => {
  const a = assignment("369736");
  assert.deepEqual(a.steps.map((s: any) => s.code), ["FKL", "LGA", "WKL", "FKL"]);
  assert.equal(a.steps[1].actions.length, 1, "one pickup at LGA");
  assert.equal(a.steps[2].actions.length, 2, "two drop-offs, two doors");
  assert.deepEqual(new Set(a.steps[2].actions.map((x: any) => x.where)), new Set(["A Front", "B Carport"]));
});

test("a passenger appears at pickup and at their own drop-off", () => {
  const a = assignment("369736");
  assert.equal(entities(a).length, 4, "two people, each twice: not a duplicate");
  for (const door of a.steps[2].actions) assert.equal(door.entities.length, 1, "one person per door");
});

test("arrival and departure dates can differ", () => {
  const lga = assignment("369736").steps.find((s: any) => s.code === "LGA");
  assert.equal(lga.eta, "11:00 PM");
  assert.equal(lga.etd, "12:00 AM");
  assert.equal(lga.etaDate, "2026-08-31");
  assert.equal(lga.date, "2026-09-01");
});

test("every passenger keeps their phone number", () => {
  const all = entities(assignment("369736"));
  assert.ok(all.length);
  for (const e of all) assert.ok(e.phone, `${e.name}: no phone`);
});

test("a field resolves the same at every step", () => {
  const seen = new Map<string, string>();
  for (const e of entities(assignment("369736"))) {
    if (!seen.has(e.name)) seen.set(e.name, e.scheduledText);
    assert.equal(e.scheduledText, seen.get(e.name), `${e.name} differs between steps`);
    assert.ok(e.scheduledText, `${e.name} lost its scheduled time`);
  }
});

test("a flight resolves to exactly one date", () => {
  const dates = new Map<string, Set<string>>();
  for (const e of entities(assignment("369736"))) {
    if (!e.flightNumber) continue;
    if (!dates.has(e.flightNumber)) dates.set(e.flightNumber, new Set());
    dates.get(e.flightNumber)!.add(e.flightDate);
  }
  assert.ok(dates.size);
  for (const [n, set] of dates) assert.equal(set.size, 1, `${n} resolved to ${[...set]}`);
});

test("an arrival is dated by when the plane lands", () => {
  const e = entities(assignment("369736")).find((x) => x.flightNumber === "UA1503");
  assert.equal(e.flightDate, "2026-08-31"); // LGA's eta is 11:00 PM on the 31st
});

test("the header fields real data added", () => {
  const a = assignment("369736");
  assert.ok(a.vehicle.includes("Sienna"));
  assert.ok(a.parking.startsWith("FKL-NBD"));
  assert.equal(a.originCode, "FKL");
  assert.ok(a.printedAt);
  assert.equal(a.gb, false);
});

test("an all-excluded assignment keeps its shape", () => {
  const a = assignment("366824");
  assert.ok(a.steps.length, "the embassy run still has its stops");
  assert.ok(a.issues.some((i: string) => i.includes("not yet supported")));
});

test("assistants are captured when present", () => {
  const a = assignment("353328");
  assert.ok(a.assistants.length, "353328 has an assistant table");
  assert.ok("role" in a.assistants[0]);
});

// -------------------------------------------------------------------- rows

test("row endpoints beat the enclosing stop", () => {
  // A departure is printed under the Warwick pickup too; its flight still
  // belongs to the JFK step its own Destination names.
  const doc = fixture("340343");
  const a = buildAssignment(doc);
  const jfk = a.steps.find((s: any) => s.code === "JFK");
  const flights = entities(a).filter((e) => e.flightNumber);
  assert.ok(flights.length >= 2, "the row at WRK and the row at JFK");
  for (const e of flights) {
    assert.equal(codeForPlace(doc, e.origin), "WRK");
    assert.equal(codeForPlace(doc, e.destination), "JFK");
    assert.equal(e.flightDate, jfk.date);
  }
  // The drive is the document's own: out of WRK at 1:30, at JFK at 3:30 (the
  // Worker's legBetween reads these two; notify.test.ts holds its arithmetic).
  assert.deepEqual([a.steps[0].code, a.steps[0].etd, jfk.eta], ["WRK", "1:30 PM", "3:30 PM"]);
});

test("a combo keeps both passengers, both arriving", () => {
  const lga = assignment("369736").steps.find((s: any) => s.code === "LGA");
  const ents = lga.actions.flatMap((x: any) => x.entities);
  assert.equal(new Set(ents.map((e: any) => e.name)).size, 2);
  for (const e of ents) assert.equal(e.tag, "A");
});

test("dedupe is within a step, not across steps", () => {
  const doc = fixture("369736");
  const at = (label: string) => doc.stops.filter((s: any) => s.label === label);
  const rowsAt = (stop: any) => doc.rows.filter((r: any) => r.line > stop.line && r.name);
  assert.ok(rowsAt(at("LGA")[0]).length, "no passenger rows under the LGA stop");
  assert.ok(rowsAt(at("WKL")[0]).length, "no passenger rows under the WKL stop");
});

test("endpoint columns are readable", () => {
  const doc = fixture("369736");
  const row = doc.rows.find((r: any) => r.name);
  const [origin, dest] = rowEndpoints(row.raw);
  assert.ok(origin, "Origin cell lost: check the redactor's padding");
  assert.ok(dest);
  assert.equal(codeForPlace(doc, origin), "LGA");
});

// ----------------------------------------------- facts from the flat jobs

test("a shift with no passengers keeps its steps and raises nothing", () => {
  const a = assignment("373621");
  assert.ok(a.steps.length);
  assert.equal(entities(a).length, 0);
  assert.deepEqual(a.issues, []);
  assert.deepEqual([a.start, a.end], ["2026-09-16 13:00", "2026-09-16 17:00"], "the shift's own hours");
});

test("excluded rows are named", () => {
  const { issues } = assignment("350568");
  assert.ok(issues.some((i: string) => i.includes("HO row not yet supported")), JSON.stringify(issues));
});

test("free-text stop labels are not site codes", () => {
  assert.equal(placeCodeOf({ label: "Enterprise Rent" }), null);
  assert.equal(placeCodeOf({ label: "Dr y LGA, JFK &" }), null);
  assert.equal(placeCodeOf({ label: "Dispatch" }), null);
  assert.equal(placeCodeOf({ label: "WRK" }), "WRK");
  assert.equal(placeCodeOf({ label: "EWR" }), "EWR");
});

test("a non-flight pickup is kept, with no flight and no complaint", () => {
  const a = assignment("356385");
  const nonFlight = entities(a).filter((e) => "flightNumber" in e && e.flightNumber === null);
  assert.ok(nonFlight.length, "the passenger made their own way; the driver still goes");
  assert.ok(!a.issues.some((i: string) => i.includes("could not resolve")), JSON.stringify(a.issues));
});

test("shuttle rows carry their route", () => {
  const shuttles = entities(assignment("339460")).filter((e) => e.tag === "S");
  assert.ok(shuttles.length, "no S rows");
  for (const e of shuttles) assert.ok(e.route, `${e.name}: no route`);
});

test("a headcount shuttle has no named passengers and keeps its notes", () => {
  const a = assignment("366222");
  assert.equal(entities(a).length, 0);
  assert.ok(a.driverNotes.includes("Stage at NCB by 5:50am"));
  assert.ok(a.steps.length >= 2, "a shuttle still has stops");
});

// ----------------------------------------------------------------- parties

const row = (name: string, flight: string) => ({ name, line: 0,
  raw: `  ${name}   LGA LaGuardia   Wallkill   Airline/Flight: ${flight}` });

test("same surname, same flight, same door is one party", () => {
  const rows = [row("Hauser, Marcus", "Lufthansa LH7603"), row("Hauser, Vera", "Lufthansa LH7603")];
  const doors = new Map([["Hauser, Marcus", "A Front"], ["Hauser, Vera", "A Front"]]);
  assert.equal(new Set(rows.map((r) => partyKey(r, doors))).size, 1);
});

test("different drop-off doors never merge", () => {
  const rows = [row("Hauser, Marcus", "Lufthansa LH7603"), row("Hauser, Vera", "Lufthansa LH7603")];
  const doors = new Map([["Hauser, Marcus", "A Front"], ["Hauser, Vera", "B Carport"]]);
  assert.equal(new Set(rows.map((r) => partyKey(r, doors))).size, 2);
});

test("different flights never merge", () => {
  const rows = [row("Hauser, Marcus", "Lufthansa LH7603"), row("Hauser, Vera", "United Airlines UA995")];
  const doors = new Map([["Hauser, Marcus", "A Front"], ["Hauser, Vera", "A Front"]]);
  assert.equal(new Set(rows.map((r) => partyKey(r, doors))).size, 2);
});

test("a surname printed in capitals for one and not the other is still one family", () => {
  // The owner's run 378725 (2026-10-04): a couple, same flight, same door,
  // came out as two rows, because dispatch typed him in capitals. No sheet
  // before it had. The rule is the same three things; only the surname's
  // case stops counting.
  const rows = [row("HAUSER, MARCUS", "Lufthansa LH7603"), row("Hauser, Vera", "Lufthansa LH7603")];
  const doors = new Map([["HAUSER, MARCUS", "A Front"], ["Hauser, Vera", "A Front"]]);
  assert.equal(new Set(rows.map((r) => partyKey(r, doors))).size, 1);
  // Still two when the door or the flight differs, and a different name is a different name.
  const apart = new Map([["HAUSER, MARCUS", "A Front"], ["Hauser, Vera", "B Carport"]]);
  assert.equal(new Set(rows.map((r) => partyKey(r, apart))).size, 2);
  const other = [row("HAUSER, MARCUS", "Lufthansa LH7603"), row("Hausen, Vera", "Lufthansa LH7603")];
  assert.equal(new Set(other.map((r) => partyKey(r, new Map([["HAUSER, MARCUS", "A Front"], ["Hausen, Vera", "A Front"]])))).size, 2);

  // On a whole sheet: 348400's couple with his rows retyped in capitals (the
  // same width, so no column moves). One party at every stop, named as
  // dispatch typed each of them, with both numbers' worth of people.
  const text = fixtureText("348400").replaceAll("Sandoval, Noor", "SANDOVAL, NOOR");
  assert.notEqual(text, fixtureText("348400"));
  const a: any = buildAssignment(parseText(text, "348400.txt"));
  const family = entities(a).filter((e) => /sandoval/i.test(e.name));
  assert.ok(family.length >= 2, "at the airport and at their door");
  for (const e of family) {
    assert.equal(e.name, "SANDOVAL, NOOR & Vera");
    assert.equal(e.pax, 2);
  }
  // And nothing else on the sheet moved.
  const plainRun: any = buildAssignment(parseText(fixtureText("348400"), "348400.txt"));
  const others = (x: any) => entities(x).filter((e) => !/sandoval/i.test(e.name));
  assert.deepEqual(others(a), others(plainRun));
});

test("the real fixture keeps its two passengers apart", () => {
  const doc = fixture("369736");
  const doors = dropoffPoints(doc);
  assert.ok(new Set(doors.values()).size >= 2, JSON.stringify([...doors]));
  const named = doc.rows.filter((r: any) => r.name);
  assert.equal(new Set(named.map((r: any) => partyKey(r, doors))).size, 2);
});

test("drop-off points are found at all (a space before the colon)", () => {
  const verbs = new Set(actionsIn(fixture("369736")).map((a: any) => a[1]));
  assert.ok(verbs.has("DROP-OFF"));
  assert.ok(verbs.has("PICKUP"));
});

test("a party label reads as one party", () => {
  assert.equal(partyLabel(["Hauser, Marcus", "Hauser, Vera"]), "Hauser, Marcus & Vera");
  assert.equal(partyLabel(["Ruiz, Ana", "Ruiz, Ben", "Ruiz, Cleo"]), "Ruiz, Ana, Ben & Cleo");
  assert.equal(partyLabel(["Ruiz, Ana"]), "Ruiz, Ana");
});

// ----------------------------------------------------------------- flights

test("flight numbers: inline prefixes, the table, padding, bags, codeshares", () => {
  assert.equal(parseFlight("United Airlines UA 1068")[0], "UA1068");
  assert.equal(parseFlight("Delta Air Lines 114")[0], "DL114");
  assert.equal(parseFlight("Turkish 1")[0], "TK1");
  assert.equal(parseFlight("Delta Air Lines DL0053")[0], "DL53");
  assert.equal(parseFlight("United Airlines 2227                1")[0], "UA2227");
  assert.equal(parseFlight("United Airlines SN8807 or UA995")[0], "UA995");
  assert.equal(parseFlight("Lufthansa LH7603")[0], "LH7603");
});

test("Caribbean is not read as an IATA prefix", () => {
  assert.equal(parseFlight("Caribbean 550")[0], "BW550");
});

test("an unknown carrier is refused, not guessed", () => {
  const [number, , why] = parseFlight("Somewhere Airlines 123");
  assert.equal(number, null);
  assert.equal(why, "unknown-airline");
});

test("an unknown carrier keeps its name and number, pinned to the flight's day, for a code learned later", () => {
  // A real sheet's rows with the airline swapped for one the table lacks,
  // the columns kept where they were.
  const text = fixtureText("352711").replace(/Turkish 1   /g, "Zed Air 1680");
  const a: any = buildAssignment(parseText(text, "352711.txt"));
  const rows = a.steps.flatMap((s: any) => s.actions.flatMap((x: any) => x.entities)).filter((e: any) => e.unknownAirline);
  assert.ok(rows.length > 0);
  for (const e of rows) {
    assert.equal(e.flightNumber, null);
    assert.equal(e.unknownAirline.name, "Zed Air");
    assert.equal(e.unknownAirline.number, "1680");
    assert.match(e.unknownAirline.date, /^\d{4}-\d\d-\d\d$/);
  }
  assert.ok(a.issues.some((i: string) => /could not resolve 'Zed Air' \(unknown-airline\)/.test(i)));
  assert.equal(unknownAirlineNumber("Somewhere Airlines 0123 or XX 9"), "123");
  assert.equal(unknownAirlineNumber("Somewhere Airlines"), null);
  assert.equal(parseFlight("WestJet 1680")[0], "WS1680"); // the owner's sheet, in the table since
});

test("a non-flight pickup is not an airline", () => {
  assert.equal(parseFlight("Non-Flight Pickup 0")[2], "non-flight-pickup");
  assert.equal(parseFlight("Non-Flight Pickup / Drop off")[2], "non-flight-pickup");
});

test("airline codes: digits allowed, lower case, the table wins", () => {
  assert.equal(lookup("JetBlue Airways B6")[0], "B6");
  assert.equal(lookup("jetblue airways")[0], "B6");
  assert.equal(lookup("Asiana oz")[0], "OZ");
  assert.deepEqual(lookup("United Airlines UA"), ["UA", "table+inline-agree"]);
  assert.equal(lookup("Totally Made Up Air")[0], null);
});

// ------------------------------------------------------- wrapped values

const at = (stem: string, code: string) => {
  const step = assignment(stem).steps.find((s: any) => s.code === code);
  assert.ok(step, `no ${code} step in ${stem}`);
  return step.actions.flatMap((x: any) => x.entities);
};

test("a tag printed ahead of the name still yields a name", () => {
  const named = fixture("348400").rows.filter((r: any) => r.name).map((r: any) => r.name);
  assert.ok(named.includes("Sandoval, Noor"));
  assert.ok(named.filter((n: string) => n === "Sandoval, Noor").length >= 2);
});

test("both halves of a couple get their drop-off door", () => {
  const doors = dropoffPoints(fixture("348400"));
  assert.equal(doors.get("Sandoval, Noor"), "Warwick Main Lobby");
  assert.equal(doors.get("Sandoval, Vera"), "Warwick Main Lobby");
});

test("a couple with a lost door still merges", () => {
  const names = at("348400", "EWR").map((e: any) => e.name);
  assert.ok(names.includes("Sandoval, Noor & Vera"));
  assert.ok(!names.includes("Sandoval, Noor"));
});

test("a codeshare alternate survives the line wrap", () => {
  const e = at("348400", "EWR").find((x: any) => x.name === "Sandoval, Noor & Vera");
  assert.equal(e.flightNumber, "UA995");
});

test("a party's bags are the sum, not the first member's", () => {
  const by = new Map(at("348400", "EWR").map((e: any) => [e.name, e]));
  assert.equal(by.get("Vargas, Eli & Rosa").bags, 2);
  assert.equal(by.get("Ford, Dana & Omar").bags, 4);
});

test("the same complaint is reported once", () => {
  const { issues } = assignment("366824");
  assert.equal(issues.length, new Set(issues).size);
  assert.ok(issues.some((i: string) => i.includes("Keller")));
});

// ------------------------------------------------------------- lost rows

test("the last stop keeps its drop-offs", () => {
  let last = assignment("339460").steps.at(-1);
  assert.equal(last.code, "WRK");
  assert.equal(last.actions.reduce((n: number, x: any) => n + x.entities.length, 0), 7);
  last = assignment("348400").steps.at(-1);
  assert.equal(last.actions.length, 2);
});

test("accented names and curly apostrophes are passengers", () => {
  const text = fixtureText("369736")
    .replaceAll("Jonas, Ana ", "Mu\u{f1}oz, Ana ")
    .replaceAll("Owens, Dana  ", "O\u{2019}Brien, Dana");
  const names = new Set(entities(buildAssignment(parseText(text))).map((e) => e.name));
  assert.deepEqual(names, new Set(["Mu\u{f1}oz, Ana", "O\u{2019}Brien, Dana"]));
});

test("an unreadable name is reported, not dropped silently", () => {
  const text = fixtureText("369736").replaceAll("Jonas, Ana ", "12345, Ana ");
  const { issues } = buildAssignment(parseText(text));
  assert.ok(issues.some((i: string) => i.includes("could not be read")), JSON.stringify(issues));
});

/**
 * 369736 rewritten so Ana and Dana Owens are one party on WN748 to one door,
 * printed Ana-first at the pickup and Dana-first at the drop-off, each with
 * her own number.
 */
function owensPartyText(): string {
  const lines = fixtureText("369736").split("\n");
  const ana = lines.flatMap((l, i) => (l.includes("Jonas, Ana") ? [i] : []));
  const dana = lines.flatMap((l, i) => (l.includes("Owens, Dana") ? [i] : []));
  const owensAna = lines[dana[0]].replaceAll("Owens, Dana", "Owens, Ana ");
  const phone = lines[dana[0] + 2];
  for (const i of ana) {
    lines[i] = owensAna;
    lines[i + 2] = phone.replaceAll("555-0100-000", "555-0100-111");
  }
  for (const j of dana) lines[j + 2] = phone.replaceAll("555-0100-000", "555-0100-222");
  lines.splice(ana[1] - 2, 2); // Ana's own "Drop-off : B Carport" header
  return lines.join("\n");
}

test("a party has one label at every step", () => {
  const names = new Set(entities(buildAssignment(parseText(owensPartyText()))).map((e) => e.name));
  assert.deepEqual(names, new Set(["Owens, Ana & Dana"]));
});

// ----------------------------------- rules no real sheet has exercised yet

test("a tag is read from its narrow column, not from a letter further right", () => {
  // cand[:30]: a bare "D" out past the Bags cell is not the row's tag.
  const lines = fixtureText("369736").split("\n");
  const i = lines.findIndex((l) => l.includes("Airline/Flight:"));
  lines[i] += "   D";
  const row = parseText(lines.join("\n")).rows.find((r: any) => r.line === i);
  assert.equal(row.tag, "A");
});

test("a code early on the next line is not a wrapped codeshare alternate", () => {
  // CODESHARE_CONT wants it deep in the line (.{60,}); nearer the left it
  // sits in another column. Moved to column 40, UA995 no longer counts and
  // the first code of "SN8807 or" stands.
  const text = fixtureText("348400").split("\n")
    .map((l) => (l.length > 60 && l.trimEnd().endsWith("UA995")
      ? l.slice(0, 16).padEnd(36) + "UA995" : l)).join("\n");
  const sandoval = entities(buildAssignment(parseText(text))).filter((e) => e.name.startsWith("Sandoval"));
  assert.ok(sandoval.length);
  for (const e of sandoval) assert.equal(e.flightNumber, "SN8807");
});

test("notes run on through two blank lines and stop at three", () => {
  const pad = " ".repeat(33);
  const text = [
    " Assignment number               123456          Driver          Doe, Jane",
    " Start date and time             Monday, August 31, 2026 9:30 PM          End date and time"
      + "          Tuesday, September 1, 2026 3:00 AM",
    " Driver notes                    First line",
    pad + "Second line", "", "",
    pad + "After two blanks", "", "", "",
    pad + "After three blanks",
    "Monday, August 31, 2026 8:00 PM          Page 1 of 1",
  ].join("\n");
  const notes = parseText(text).driverNotes;
  assert.equal(notes, "First line\nSecond line\nAfter two blanks");
});

test("every member's number is kept", () => {
  for (const e of entities(buildAssignment(parseText(owensPartyText())))) {
    assert.equal(e.phone, "+1 555-0100-111");
    assert.deepEqual(e.otherPhones, ["+1 555-0100-222"]);
  }
});
