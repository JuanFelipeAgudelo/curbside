/**
 * Airline name -> IATA code (ported from the Python importer's airlines.py:
 * in git at the tag python-importer-last).
 *
 * A closed set, from every airline string in the sample. An unknown name is
 * reported for the driver to confirm, never guessed: a wrong IATA code makes
 * a plausible flight number for the wrong flight, which is worse than none.
 */
import { cpLen, splitWs } from "./python.js";

export const AIRLINE_IATA = new Map(Object.entries({
  "aero mexico": "AM",
  "air canada": "AC",
  "alaska airlines": "AS",
  "american airlines": "AA",
  "arajet": "DM",
  "asiana": "OZ",
  "asiana oz": "OZ",
  "british airways": "BA",
  "caribbean": "BW", // Caribbean Airlines
  "cathay pacific airways": "CX",
  "delta": "DL",
  "delta air lines": "DL",
  "eva airways": "BR",
  "finnair": "AY",
  "jetblue": "B6",
  "jetblue airways": "B6",
  "korean air": "KE",
  "korean air lines": "KE",
  "lufthansa": "LH",
  "porter airlines": "PD",
  "qantas airways": "QF",
  "singapore airlines": "SQ",
  "southwest airlines": "WN",
  "sun country": "SY",
  "turkish": "TK", // Turkish Airlines
  "turkish airlines": "TK",
  "united airlines": "UA",
  "westjet": "WS", // the owner's sheet, 2026-09-30
}));

// Not an airline: dispatch writes this when a pickup has no flight behind it.
const NON_FLIGHT_STEM = "non-flight pickup";

/** Two characters, letters or digits, at least one letter: B6, F9, 9W. */
function isIata(token) {
  return cpLen(token) === 2 && /^[\p{L}\p{N}]+$/u.test(token) && /\p{L}/u.test(token);
}

/** [iata, reason]; iata is null when we refuse to guess. */
export function lookup(name) {
  const key = splitWs(name.toLowerCase()).join(" ");
  if (!key) return [null, "no-airline-name"];
  if (key.startsWith(NON_FLIGHT_STEM)) return [null, "non-flight-pickup"];
  if (AIRLINE_IATA.has(key)) return [AIRLINE_IATA.get(key), "table"];
  const words = splitWs(key);
  const tail = words[words.length - 1].toUpperCase();
  if (isIata(tail)) {
    const stem = words.slice(0, -1).join(" ");
    if (AIRLINE_IATA.has(stem)) {
      return AIRLINE_IATA.get(stem) === tail ? [tail, "table+inline-agree"]
        : [AIRLINE_IATA.get(stem), "table-wins-over-inline"];
    }
    return [tail, "inline-code-only"];
  }
  return [null, "unknown-airline"];
}
