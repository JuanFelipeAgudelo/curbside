// Curbside — getting dispatch's PDF in: the IMPORT button in the header, the
// empty list's button, a PDF dropped on the laptop, and Android's Share ->
// Curbside. Each file is read here, on the device, by public/importer/ (the
// laptop's importer runs the same code), so the PDF and the names in it never
// leave the phone; only the run it converts to is sent, through the outbox
// like any other write (queueImport, in assignments.js).
//
// Loaded after assignments.js and before app.js. Nothing here runs at load
// but the wiring; app.js's init calls takeShared().

/** The reader, loaded the first time a sheet is read: about 110 KB of plain
 *  JS, precached by the service worker so it reads with no signal. */
let readerLoad = null;
function loadReader() {
  if (!readerLoad) {
    readerLoad = import("/importer/index.js").catch((err) => {
      readerLoad = null; // a bad bar should not break every later import
      throw err;
    });
  }
  return readerLoad;
}

/** Dispatch's sheets are tens of KB. A file this big is something else, and
 *  is not read into a phone's memory to find that out. */
const MAX_SHEET_BYTES = 25 * 1024 * 1024;

/** Read each file, in order, and say what became of it. No confirm step: the
 *  newest printed copy wins on the server, and corrections live apart from
 *  the sheet, so an import can't cost the driver anything. */
async function importFiles(files) {
  if (!listCode || !files.length) return;
  startImport();
  let reader = null;
  try {
    reader = await loadReader();
  } catch (err) {
    // A SyntaxError is a browser that can't parse the reader (its regexes
    // need iOS 16.4); anything else, the file never arrived.
    console.error("Import: the sheet reader didn't load:", err);
    noteProblem(null, err && err.name === "SyntaxError" ? "no-reader" : "no-load");
  }
  if (reader) {
    for (const file of files) {
      const name = file.name || "sheet.pdf";
      let result;
      if (file.size > MAX_SHEET_BYTES) result = { ok: false, reason: "too-big" };
      else {
        try {
          result = reader.readSheet(new Uint8Array(await file.arrayBuffer()), name);
        } catch (err) {
          // Every reason a sheet can't be read is an answer, not a throw; a
          // throw is a bug. Said plainly, logged, and the next file still read.
          console.error(`Import: reading ${name} failed:`, err);
          result = { ok: false, reason: "bug" };
        }
      }
      if (result.ok) queueImport(result.assignment, name);
      else noteProblem(name, result.reason);
    }
  }
  showImports();
}

/* ------------------------------------------------------------ the picker -- */

function pickSheets() {
  document.getElementById("import-file").click();
}

document.getElementById("import-btn").addEventListener("click", pickSheets);
document.getElementById("import-file").addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = ""; // the same file picked again is a new import
  importFiles(files);
});

/** One line under the empty list's button: the way in this device has. */
function importHint() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
    return "On iPhone, save the attachment to Files first: Share → Save to Files.";
  }
  if (/Android/.test(ua)) {
    // Share -> Curbside exists only once the app is installed.
    return window.matchMedia("(display-mode: standalone)").matches
      ? "Or share the PDF to Curbside from your email." : "";
  }
  return "Or drop the PDF anywhere on this window.";
}

/* ----------------------------------------------------- the laptop's drop -- */

// Counted, because dragenter and dragleave fire for every element the drag
// crosses; the veil itself never takes events (pointer-events: none).
let dragDepth = 0;
let veilTimer = null;
const veil = document.getElementById("drop-veil");

function carriesFiles(e) {
  return Boolean(e.dataTransfer) && Array.from(e.dataTransfer.types || []).includes("Files");
}

function showVeil(on) {
  clearTimeout(veilTimer);
  veil.hidden = !on;
  if (!on) dragDepth = 0;
  // A drag that leaves the window fast can skip its last dragleave. dragover
  // keeps coming while it is over the page, so its silence ends the veil.
  else veilTimer = setTimeout(() => showVeil(false), 1000);
}

document.addEventListener("dragenter", (e) => {
  if (!carriesFiles(e) || !listCode) return;
  e.preventDefault();
  dragDepth++;
  showVeil(true);
});
document.addEventListener("dragover", (e) => {
  if (!carriesFiles(e)) return;
  // Always, so a file dropped before a list exists is not opened as a page.
  e.preventDefault();
  e.dataTransfer.dropEffect = listCode ? "copy" : "none";
  if (listCode) showVeil(true);
});
document.addEventListener("dragleave", (e) => {
  if (!carriesFiles(e)) return;
  dragDepth--;
  if (dragDepth <= 0) showVeil(false);
});
document.addEventListener("drop", (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  showVeil(false);
  if (listCode && !holdScreen) importFiles(Array.from(e.dataTransfer.files || []));
});

/* ------------------------------------------------- Android: Share -> app -- */

// Where the service worker leaves shared PDFs (sw.js, SHARE_CACHE): the share
// is a POST the SW answers, so the files wait there for the page it opens.
const SHARED_CACHE = "curbside-shared";

/**
 * Import whatever was shared to Curbside. Run on every launch with a list, so
 * a share the app was closed on is not lost; `arrived` says the app was opened
 * BY a share (/?shared=1), so arriving with nothing is worth a line.
 */
async function takeShared(arrived) {
  if (!listCode || !("caches" in window)) return;
  let cache, keys;
  try {
    cache = await caches.open(SHARED_CACHE);
    keys = await cache.keys();
  } catch (_) {
    return;
  }
  if (!keys.length) {
    if (arrived) {
      startImport();
      noteProblem(null, "nothing-shared");
      showImports();
    }
    return;
  }
  keys.sort((a, b) => a.url.localeCompare(b.url)); // in the order they were shared
  const files = [];
  for (const key of keys) {
    const res = await cache.match(key);
    if (!res) continue;
    const name = decodeURIComponent(res.headers.get("X-File-Name") || "shared.pdf");
    files.push(new File([await res.blob()], name, { type: res.headers.get("Content-Type") || "" }));
  }
  // Read before they're let go: importFiles says what became of each.
  await importFiles(files);
  await Promise.all(keys.map((key) => cache.delete(key)));
}
