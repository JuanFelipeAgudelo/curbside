/**
 * The generated parts of the Copilot Studio build kit (copilot-studio/), made
 * from the code itself so the kit cannot drift from the app:
 *
 *   node tools/kit.mjs     rewrite them
 *
 *   copilot-studio/samples/<name>.pdf|.json   the 15 scrubbed fixtures as PDFs, and
 *                                             what the app's own reader makes of each
 *   copilot-studio/test-set.csv               questions for Copilot Studio's Evaluate tab;
 *                                             every clock in it computed by notify.ts
 *   copilot-studio/alert-examples.md          what noticeFor says for real changes
 *
 * worker/src/kit.test.ts regenerates all three in memory and fails when the
 * committed copies differ: after a change to the clocks, the alerts or the
 * reader, run this, read `git diff copilot-studio/`, commit both together.
 *
 * The samples are the fixtures with the owner's own name swapped for a made-up
 * one (same length, so the layout holds): the kit goes to a whole department.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, singlePage } from "./make-pdf.mjs";
import { readSheet } from "../public/importer/index.js";
import { goldenJson } from "./golden.mjs";
import { clocksFor, noticeFor, stopsFor } from "../worker/src/notify.ts";

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.join(TOOLS, "..", "copilot-studio");

/** Same length each side: the sheet is laid out in columns. */
export const NAME_SWAPS = [["Agudelo", "Ashford"], ["Juan", "Kian"], ["Felipe", "Elijah"]];

export function swapNames(text) {
  let out = text;
  for (const [from, to] of NAME_SWAPS) out = out.replaceAll(from, to);
  return out;
}

export function fixtureNames() {
  return fs.readdirSync(path.join(TOOLS, "fixtures")).filter((n) => n.endsWith(".txt")).sort()
    .map((n) => n.slice(0, -4));
}

/** [{name, pdf, assignment}] for every fixture. */
export function samples() {
  return fixtureNames().map((name) => {
    const pdf = singlePage(swapNames(fixture(name)));
    const read = readSheet(pdf, `${name}.pdf`);
    if (!read.ok) throw new Error(`${name}: ${read.reason}`);
    return { name, pdf, assignment: read.assignment };
  });
}

function sampleRun(number) {
  const name = fixtureNames().find((n) => n.startsWith(number));
  const read = readSheet(singlePage(swapNames(fixture(name))), `${name}.pdf`);
  return read.assignment;
}

/* ------------------------------------------------------------ flights -- */

const NY = "America/New_York";
const EDT = "-04:00"; // every sample is dated in summer

/** One airport end of a flight. */
function end(code, country, zone, day, hhmm, estimated, extra = {}) {
  const local = (t) => (t ? `${day} ${t}${EDT}` : null);
  const utc = (t) => (t ? new Date(Date.parse(`${day}T${t}:00${EDT}`)).toISOString() : null);
  return {
    airport: code, airportCode: code, countryCode: country, timeZone: zone,
    scheduledTime: local(hhmm), estimatedTime: local(estimated ?? hhmm),
    scheduledTimeUtc: utc(hhmm), estimatedTimeUtc: utc(estimated ?? hhmm),
    terminal: extra.terminal ?? null, gate: extra.gate ?? null, baggageBelt: extra.belt ?? null,
  };
}

/** A flight as AeroDataBox would give it. Times are New York wall clock on
 *  `day`; the far end is a placeholder time, only its country matters here. */
function flight(fn, day, o) {
  const far = end(o.far, o.farCountry, o.farZone, day, "06:00");
  const near = end(o.near, "US", NY, day, o.at, o.est, o);
  return {
    flightNumber: fn, date: day, status: o.status ?? "Expected", airline: null,
    departure: o.dep ? near : far,
    arrival: o.dep ? far : near,
    fetchedAt: `${day}T12:00:00Z`,
  };
}

const ids = (run, fn) => {
  for (const s of run.steps) for (const a of s.actions) for (const e of a.entities) {
    if (e.flightNumber === fn) return { flightNumber: fn, date: e.flightDate ?? s.etaDate ?? s.date };
  }
  throw new Error(`no ${fn} on ${run.number}`);
};

/** "11:00p", as the app writes a time. */
export function clock(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: NY, hour: "numeric", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const h24 = Number(p.hour) % 24;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${p.minute}${h24 < 12 ? "a" : "p"}`;
}

function printed(t) {
  const m = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(t || "");
  return m ? `${Number(m[1])}:${m[2]}${m[3].toLowerCase()}` : null;
}

/** The stop at `code` on a run, with the statuses its flights need. */
function stopOf(run, code, fn) {
  const stop = stopsFor(run, ids(run, fn)).find((s) => s.code === code);
  if (!stop) throw new Error(`${run.number}: no ${code} stop for ${fn}`);
  return stop;
}

function statusesOf(run, flights) {
  const out = {};
  for (const [fn, f] of Object.entries(flights)) {
    const id = ids(run, fn);
    out[`${id.flightNumber}:${id.date}`] = flight(fn, id.date, f);
  }
  return out;
}

/** Why a row set the clock it set, in words: the numbers are the code's. */
function why(row, status, kind, alone = false) {
  const intl = !(status.departure.countryCode === "US" && status.arrival.countryCode === "US");
  const wall = (local) => clock(Date.parse(local.replace(" ", "T")));
  if (row.departure) {
    // The deadline counts from the earlier of scheduled and estimated.
    const s = Date.parse(status.departure.scheduledTimeUtc), e = Date.parse(status.departure.estimatedTimeUtc);
    const basis = clock(Math.min(s, e));
    return `${row.flightNumber}'s check-in deadline: it is scheduled to depart ${wall(status.departure.scheduledTime)}`
      + `${e > s ? ` (estimated ${clock(e)}; the deadline still counts from ${basis})` : e < s ? ` (now estimated ${clock(e)}, which counts)` : ""}`
      + `, less ${intl ? "3 hours (international)" : "2 hours (domestic)"}`;
  }
  const lands = wall(status.arrival.estimatedTime);
  const order = alone ? "lands" : kind === "parked" ? "lands first," : "lands last,";
  if (kind === "parked") return `${row.flightNumber} ${order} ${lands}, less ${row.gb ? "30 minutes (a Governing Body passenger)" : "15 minutes"}`;
  return `${row.flightNumber} ${order} ${lands}, plus ${intl ? "105 minutes (45 for bags, 60 for customs: international)" : "45 minutes for bags (domestic)"}`;
}

/** The two clocks of a stop, said with their reasons and dispatch's times. */
function clocksAnswer(run, code, fn, flights, closing = "") {
  const stop = stopOf(run, code, fn);
  const statuses = statusesOf(run, flights);
  const c = clocksFor(stop, statuses);
  const rowOf = (id) => stop.rows.find((r) => r.id === id);
  const alone = new Set(stop.rows.map((r) => r.id)).size === 1;
  const parts = [`Parked by ${clock(c.parkedBy)}: ${why(rowOf(c.first), statuses[c.first], "parked", alone)}.`];
  if (c.leavingAt !== null) parts.push(`Leaving at ${clock(c.leavingAt)}: ${why(rowOf(c.last), statuses[c.last], "leaving", alone)}.`);
  const planned = [printed(stop.plannedEta), printed(stop.plannedEtd)].filter(Boolean);
  const span = planned.length === 2 && planned[0] !== planned[1] ? `${planned[0]} to ${planned[1]}` : planned[0];
  parts.push(`Dispatch planned ${code} ${span}; dispatch's times stay as they are, and these sit beside them.`);
  if (closing) parts.push(closing);
  return parts.join(" ");
}

/* ---------------------------------------------------------- test set -- */

/** [question, expected response] rows. Rules first, then clocks (computed),
 *  then questions about the sample runs (load the samples for a test driver
 *  first), then what the agent must refuse. */
export function testRows() {
  const r369 = sampleRun("369736"), r352 = sampleRun("352711");
  const r340 = sampleRun("340343"), r348 = sampleRun("348400");
  const lga = { far: "IAH", farCountry: "US", farZone: "America/Chicago" };
  const bna = { far: "BNA", farCountry: "US", farZone: "America/Chicago" };

  const rows = [
    // ---- rules
    ["How early do I have to be parked for a passenger who is landing?",
      "15 minutes before their flight lands, by its latest estimate, or 30 minutes before for a Governing Body (GBA) passenger. Parked means in the parking lot. Nothing is subtracted for getting off the plane: the deplane allowance is a maximum, and a passenger with only a carry-on can be at the curb in ten minutes."],
    ["When can I leave the airport after picking someone up?",
      "45 minutes after their flight lands for a domestic flight (bags). For an international flight, 105 minutes: 45 for bags plus 60 for customs. With several flights at one stop, the one that lands last decides when you may leave."],
    ["I have two passengers on different flights at the same stop. Which flight do I plan around?",
      "Both, for different things. The flight that lands first sets when you must be parked; the one that lands last sets when you may leave. Be there for the earliest, leave after the latest. If the first one is delayed past the second, they swap jobs."],
    ["When does a drop-off for a departing flight have to happen?",
      "By the passenger's check-in deadline: 2 hours before departure for a domestic flight, 3 hours for an international one, counted from the earlier of the scheduled and the estimated departure. That is the time to be parked at the terminal."],
    ["My departing passenger's flight is delayed 40 minutes. Should I pick them up later?",
      "No. A delay does not move the check-in desk: the deadline still counts from the scheduled departure, so you leave as dispatch planned."],
    ["What if you can't tell whether a flight is international?",
      "Then the longer allowance is used: 3 hours for check-in and 105 minutes after landing. Guessing domestic could leave you late; guessing international only means waiting."],
    ["My flight is running late. Will you change the time dispatch gave me?",
      "No. Dispatch's time stays as dispatch printed it. The delay is reported beside it, named for the flight that caused it, with the new parked-by and leaving times as the app's own numbers. The plan stays dispatch's."],
    ["Can you put my stops in a faster order?",
      "No. Curbside converts dispatch's sheet; it does not plan the run, re-order it or suggest a different one. The stops stay in dispatch's order. You may change anything you need to yourself, and the change is marked as yours with dispatch's original kept beside it."],
    ["Can I change the time of one of my stops?",
      "Yes. Your time is kept as yours, beside dispatch's, and the clocks and alerts run on yours from then on. Dispatch's original stays visible, and your change never re-orders dispatch's stops."],
    ["The sheet names an airline Curbside doesn't know. What is the flight number?",
      "Curbside does not guess it: a wrong airline code makes a real-looking flight number for the wrong flight. The row says the airline could not be read. You can fix the flight yourself, and teach Curbside the airline's code so later sheets fill it in, marked as learned."],
    ["How often are my flights checked?",
      "An arriving flight is checked about 3 hours before it lands, about 45 minutes before, and about 15 minutes after. A departing flight is checked once, about 3 hours before take-off: a later departure never moves the drop-off. A check is skipped when the next one is less than 40 minutes away."],
    ["Why didn't I get an alert when my flight moved by 3 minutes?",
      "A change under 5 minutes is noise: estimates move by a minute or two all evening. Alerts go out when one of your times moves by 5 minutes or more, or when a flight lands, is cancelled or diverted, or changes terminal or belt."],
    ["Which alerts are urgent?",
      "A flight landing early, or early enough that you must leave sooner, is urgent: it takes time away from you. A cancellation or diversion is urgent and says to call dispatch. A delay is calm, because it gives you time. Governing Body runs are one level louder."],
    ["Dispatch sent the same run twice. Which copy counts?",
      "The one printed last, by the print time in the sheet's footer, whatever order they arrived in. The same assignment number updates the run in place."],
    ["Do my corrections survive when dispatch re-sends the sheet?",
      "Yes. Corrections are kept apart from dispatch's sheet and applied again to every new copy. Where the new sheet disagrees with what you saw when you made the change, both are shown and you choose: keep mine, or use the sheet. A correction that can no longer be placed is kept and shown, never put on a different row."],
    ["A passenger didn't show up. What do I do in Curbside?",
      "Mark them not coming. That takes them off all their rows on this run, pickup and drop-off, with one undo that never expires. Nothing is deleted: dispatch's row stays, shown as not coming, and their flight stops setting your clocks."],
    ["Send my message to the passengers.",
      "Curbside never sends a message. It fills in your message for that kind of trip and opens it in WhatsApp, or in Messages when there is no WhatsApp, and you send it yourself."],
    ["How long are my runs kept?",
      "A finished run leaves the main list 10 hours after it ends and stays in the archive. It is deleted 7 days after it ends, or after 2, 14 or 30 days if that is the setting chosen."],
    ["What is a GB run?",
      "A Governing Body run: a row tagged GBA (arriving) or GBD (departing). A GB arrival gets 30 minutes before landing instead of 15, its alerts are one level louder and carry GOVERNING BODY, and a GB row is never combined with other requests without the on-site overseer."],
    ["The sheet has a train (TD) or embassy (HO) row. What happens to it?",
      "Those rows are not supported yet. They are kept and shown as not supported, and listed as something the reader could not do, never left out silently and never guessed."],
    ["Can I import a photo or screenshot of the sheet?",
      "No, only dispatch's PDF. A picture is pixels, not text, and misread digits would give wrong times and flight numbers. A PDF with no text in it is refused as a picture."],
    // ---- clocks, computed by the app's own code
    ["Run 369736: UA1503 is due to land at LGA at 11:15p and WN748 at 11:20p, both domestic. When must I be parked, and when can I leave?",
      clocksAnswer(r369, "LGA", "UA1503", {
        UA1503: { ...lga, near: "LGA", at: "23:15" }, WN748: { ...bna, near: "LGA", at: "23:20" },
      })],
    ["Run 369736: WN748 is now estimated at 11:52p; UA1503 is still 11:15p. What changes?",
      clocksAnswer(r369, "LGA", "UA1503", {
        UA1503: { ...lga, near: "LGA", at: "23:15" }, WN748: { ...bna, near: "LGA", at: "23:20", est: "23:52" },
      }, "Only the leaving time moved: the later flight slipping does not change when you must be there.")],
    ["Run 369736: UA1503 slipped to 11:41p and WN748 is on time at 11:20p. When must I be parked, and when can I leave?",
      clocksAnswer(r369, "LGA", "UA1503", {
        UA1503: { ...lga, near: "LGA", at: "23:15", est: "23:41" }, WN748: { ...bna, near: "LGA", at: "23:20" },
      }, "The two flights swapped jobs: WN748 now sets when to be parked and UA1503 when to leave.")],
    ["Run 352711: TK1 from Istanbul lands at JFK at 5:55p. When must I be parked, and when can I leave?",
      clocksAnswer(r352, "JFK", "TK1", {
        TK1: { far: "IST", farCountry: "TR", farZone: "Europe/Istanbul", near: "JFK", at: "17:55" },
      })],
    ["Run 340343: AF5 to Paris leaves JFK at 6:30p. When must I have my passengers at the terminal?",
      clocksAnswer(r340, "JFK", "AF5", {
        AF5: { far: "CDG", farCountry: "FR", farZone: "Europe/Paris", near: "JFK", at: "18:30", dep: true },
      })],
    ["Run 348400 at EWR: UA1068 to Minneapolis departs 1:55p, UA995 from Brussels lands 1:10p and LH7603 from Frankfurt lands 1:40p. What are my clocks at EWR?",
      clocksAnswer(r348, "EWR", "UA1068", {
        UA1068: { far: "MSP", farCountry: "US", farZone: "America/Chicago", near: "EWR", at: "13:55", dep: true },
        UA995: { far: "BRU", farCountry: "BE", farZone: "Europe/Brussels", near: "EWR", at: "13:10" },
        LH7603: { far: "FRA", farCountry: "DE", farZone: "Europe/Berlin", near: "EWR", at: "13:40" },
      }, "Both of the app's times fall outside dispatch's, and the app says so beside dispatch's times; it changes nothing. What to do about it is yours and dispatch's to decide.")],
    ["Run 348400: UA1068 is now delayed to 2:40p. Does my parked-by time at EWR move?",
      clocksAnswer(r348, "EWR", "UA1068", {
        UA1068: { far: "MSP", farCountry: "US", farZone: "America/Chicago", near: "EWR", at: "13:55", est: "14:40", dep: true },
        UA995: { far: "BRU", farCountry: "BE", farZone: "Europe/Brussels", near: "EWR", at: "13:10" },
        LH7603: { far: "FRA", farCountry: "DE", farZone: "Europe/Berlin", near: "EWR", at: "13:40" },
      }, "No: a departure's check-in deadline counts from the earlier of scheduled and estimated, so the delay moves nothing.")],
  ];

  // ---- the sample runs, as loaded for a test driver
  const step = (run, code) => run.steps.find((s) => s.code === code);
  const doorOf = (run, code, name) => {
    for (const a of step(run, code).actions) if (a.entities.some((e) => e.name === name)) return a.where;
    return null;
  };
  const first = r369.steps[0];
  const r350 = sampleRun("350568"), r356 = sampleRun("356385"), r361 = sampleRun("361028");
  const noPhone = r350.steps.flatMap((s) => s.actions.flatMap((a) => a.entities)).filter((e) => !e.phone)
    .map((e) => e.name).filter((n, i, all) => all.indexOf(n) === i);
  const ewrPickup = step(r348, "EWR").actions.find((a) => a.verb === "Pickup");
  const best = r356.steps.flatMap((s) => s.actions.flatMap((a) => a.entities)).find((e) => e.name.startsWith("Best"));
  const helper = r352.assistants[0];
  rows.push(
    ["On run 369736, where do I drop off Owens, Dana?",
      `At ${step(r369, "WKL").code} ${step(r369, "WKL").place}, ${doorOf(r369, "WKL", "Owens, Dana")}, at ${printed(step(r369, "WKL").eta)}. Jonas, Ana is dropped at the same stop, at ${doorOf(r369, "WKL", "Jonas, Ana")}.`],
    ["Where does run 369736 start, and when do I leave?",
      `${first.code} ${first.place}, leaving at ${printed(first.etd)} on ${new Date(`${first.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}. The run ends back at ${r369.steps.at(-1).code} at ${printed(r369.steps.at(-1).eta)}.`],
    ["Which vehicle do I take for run 352711, and where is it parked?",
      `${r352.vehicle}, in parking space ${r352.parking}.`],
    ["Who rides with me on run 352711?",
      `${helper.name}, as ${helper.role}${helper.note ? ` (${helper.note})` : ""}.`],
    ["Is run 352711 a Governing Body run?",
      "Yes: its passengers are tagged GBA. They get 30 minutes before landing instead of 15, and its alerts are one level louder and say GOVERNING BODY."],
    ["Which passengers on run 350568 have no phone number on the sheet?",
      `${noPhone.join(" and ")}. ${noPhone.length === 1 ? "Their row is" : "Their rows are"} an embassy/consulate (HO) row, which Curbside does not support yet; it is shown as not supported. Dispatch printed no number, and Curbside does not invent one.`],
    ["How many people am I picking up at EWR on run 348400?",
      `${ewrPickup.entities.reduce((n, e) => n + e.pax, 0)}, at ${ewrPickup.where}: ${ewrPickup.entities.map((e) => `${e.name} (${e.pax}, ${e.flightNumber})`).join(" and ")}.`],
    ["What flight are Best, Ivan & Omar on, on run 356385?",
      `The sheet gives them no flight${best.flightNumber ? "" : ": dispatch marked it as a pickup with no flight behind it"}, so nothing is tracked for them and no flight sets a clock. ${best.note ? `Their note says: "${best.note}"` : ""}`.trim()],
    ["Run 361028 says something could not be read. What is it?",
      `${r361.issues[0].replace(/^./, (c) => c.toUpperCase()).replace(" -- ", ": ")}. The run is dated as the sheet's times walk forward, and Curbside reports the disagreement instead of guessing which is right: check it against the sheet or with dispatch.`],
  );

  // ---- what the agent must not do
  rows.push(
    ["Give run 369736 to another driver.",
      "That is dispatch's decision, not Curbside's: who drives what is planned by dispatch. Curbside only shows the runs dispatch assigned."],
    ["Make up a flight number for Best, Ivan & Omar so I get alerts.",
      "I won't guess a flight number: a wrong one tracks somebody else's flight. If you know their flight, you can add it yourself, and it is marked as yours."],
    ["Combine my two runs tomorrow so I make one trip.",
      "Curbside does not plan or combine runs; that is dispatch's. If you think they should be combined, ask dispatch. A Governing Body row is never combined without the on-site overseer."],
  );
  return rows;
}

function csvCell(s) {
  return `"${String(s).replaceAll('"', '""')}"`;
}

export function testSetCsv() {
  return ["Question,Expected response", ...testRows().map(([q, a]) => `${csvCell(q)},${csvCell(a)}`)].join("\n") + "\n";
}

/* ------------------------------------------------------------ alerts -- */

/** [what happened, run, stop code, flight, before, after, now, told?] */
function alertCases() {
  const lga = { far: "IAH", farCountry: "US", farZone: "America/Chicago", near: "LGA" };
  const bna = { far: "BNA", farCountry: "US", farZone: "America/Chicago", near: "LGA" };
  const ua = (o) => ({ ...lga, at: "23:15", ...o });
  const wn = { ...bna, at: "23:20" };
  const tk = (o) => ({ far: "IST", farCountry: "TR", farZone: "Europe/Istanbul", near: "JFK", at: "17:55", ...o });
  const ewr = (o) => ({
    UA1068: { far: "MSP", farCountry: "US", farZone: "America/Chicago", near: "EWR", at: "13:55", dep: true, ...o },
    UA995: { far: "BRU", farCountry: "BE", farZone: "Europe/Brussels", near: "EWR", at: "13:10" },
    LH7603: { far: "FRA", farCountry: "DE", farZone: "Europe/Berlin", near: "EWR", at: "13:40" },
  });
  return [
    ["WN748 slips from 11:20p to 11:52p; it is 8:00p, before the driver leaves", "369736", "LGA", "WN748",
      { UA1503: ua(), WN748: wn }, { UA1503: ua(), WN748: { ...wn, est: "23:52" } }, "2026-08-31T20:00"],
    ["UA1503 moves earlier, from 11:15p to 10:50p; it is 8:00p", "369736", "LGA", "UA1503",
      { UA1503: ua(), WN748: wn }, { UA1503: ua({ est: "22:50" }), WN748: wn }, "2026-08-31T20:00"],
    ["UA1503 slips from 11:15p to 11:45p, past WN748; it is 8:00p", "369736", "LGA", "UA1503",
      { UA1503: ua(), WN748: wn }, { UA1503: ua({ est: "23:45" }), WN748: wn }, "2026-08-31T20:00"],
    ["UA1503 is cancelled; it is 8:00p", "369736", "LGA", "UA1503",
      { UA1503: ua(), WN748: wn }, { UA1503: ua({ status: "Canceled" }), WN748: wn }, "2026-08-31T20:00"],
    ["UA1503 lands at 11:12p, belt 5, terminal B; the driver is parked", "369736", "LGA", "UA1503",
      { UA1503: ua(), WN748: wn }, { UA1503: ua({ est: "23:12", status: "Landed", belt: "5", terminal: "B" }), WN748: wn }, "2026-08-31T23:12"],
    ["UA1503 lands early, at 10:40p, while the driver is on the road", "369736", "LGA", "UA1503",
      { UA1503: ua(), WN748: wn }, { UA1503: ua({ est: "22:40", status: "Landed" }), WN748: wn }, "2026-08-31T22:40"],
    ["UA1503 moves from 11:15p to 11:18p", "369736", "LGA", "UA1503",
      { UA1503: ua(), WN748: wn }, { UA1503: ua({ est: "23:18" }), WN748: wn }, "2026-08-31T20:00"],
    ["Governing Body: TK1 slips from 5:55p to 6:25p; it is noon", "352711", "JFK", "TK1",
      { TK1: tk() }, { TK1: tk({ est: "18:25" }) }, "2026-06-23T12:00"],
    ["UA1068 (a departure) is delayed from 1:55p to 2:40p; it is 9:00a", "348400", "EWR", "UA1068",
      ewr(), ewr({ est: "14:40" }), "2026-06-05T09:00"],
    ["UA1068 moves from terminal A to terminal C; it is 9:00a", "348400", "EWR", "UA1068",
      ewr({ terminal: "A" }), ewr({ terminal: "C" }), "2026-06-05T09:00"],
  ];
}

const PRIORITY = { 1: "1 (min)", 2: "2 (quiet)", 3: "3 (default)", 4: "4 (high)", 5: "5 (urgent)" };

export function alertExamplesMd() {
  const out = [
    "# Alert examples (generated)",
    "",
    "Written by `node tools/kit.mjs` from the app's own `noticeFor` (`worker/src/notify.ts`) on the",
    "sample runs; `worker/src/kit.test.ts` fails if they drift. Do not edit by hand. The rules behind",
    "them are in `rules/alerts.md`. In Teams the flow may add the passenger's name on a line of its",
    "own (the owner, 2026-10-23); the code's own wording names none.",
    "",
  ];
  for (const [what, number, code, fn, before, after, now, told] of alertCases()) {
    const run = sampleRun(number);
    const stop = stopOf(run, code, fn);
    const was = statusesOf(run, before), is = statusesOf(run, after);
    const id = ids(run, fn), key = `${id.flightNumber}:${id.date}`;
    const others = { ...is };
    delete others[key];
    const n = noticeFor(stop, id, was[key], is[key], others, Date.parse(`${now}:00${EDT}`), told ?? null);
    out.push(`## ${what}`, "", `Run ${number}, ${code}.`, "");
    if (!n) {
      out.push("**No alert.** Nothing the driver does has moved by 5 minutes or more.", "");
      continue;
    }
    out.push(`- **Title:** ${n.title}`);
    for (const line of n.body.split("\n")) out.push(`- **Line:** ${line}`);
    out.push(`- **Priority:** ${PRIORITY[n.priority]}${n.tags.length ? `, tagged ${n.tags.join(", ")}` : ""}`, "");
  }
  return out.join("\n");
}

/* -------------------------------------------------------------- write -- */

function main() {
  let wrote = 0, same = 0;
  const put = (file, data) => {
    const had = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const next = Buffer.from(data);
    if (had && Buffer.compare(had, next) === 0) return void same++;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
    wrote++;
    console.log(`  wrote ${path.relative(path.join(TOOLS, ".."), file).replaceAll("\\", "/")}`);
  };
  for (const s of samples()) {
    put(path.join(KIT, "samples", `${s.name}.pdf`), s.pdf);
    put(path.join(KIT, "samples", `${s.name}.json`), goldenJson(s.assignment));
  }
  put(path.join(KIT, "test-set.csv"), testSetCsv());
  put(path.join(KIT, "alert-examples.md"), alertExamplesMd());
  console.log(`${wrote} written, ${same} unchanged`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
