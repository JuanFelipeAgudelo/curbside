/**
 * Dispatch's PDF -> the assignment the app stores. One entry point for the
 * app (step 3) and the laptop (tools/import.mjs), so both read a sheet the
 * same way.
 *
 * Every module here was ported from a Python importer and pypdf 6.18.1, and
 * read every real sheet exactly as they did, text and run, before the Python
 * went (2026-10-04; it is in git at the tag python-importer-last). What holds
 * the reader now: golden answers for the fixtures (tools/fixtures/*.json),
 * pypdf's own text for the synthetic PDFs (tools/pdf-fixtures/), and a
 * snapshot of the real sheets kept outside the repo (tools/corpus.mjs). See
 * docs/spec-curbside.md, "Importing a sheet".
 */
import { PdfError, PdfFile, PdfTooBig, UnsupportedPdf } from "./pdf-reader.js";
import { documentText } from "./pdf-text.js";
import { buildAssignment, parseText, SheetError } from "./sheet.js";
import { strip } from "./python.js";

export { documentText, PdfFile, parseText, buildAssignment };

/**
 * readSheet(bytes, fileName) ->
 *   { ok: true, assignment, text }
 *   { ok: false, reason, detail }  reason is one of:
 *     "not-pdf"      the bytes aren't a PDF this reader can open
 *     "unsupported"  a PDF feature dispatch's sheets never use (encryption, ...)
 *     "picture"      no text at all: a scan or a photo, not dispatch's PDF
 *     "not-a-sheet"  text, but no assignment header
 *     "unreadable"   an assignment whose date or time can't be read
 *     "too-big"      it inflates to more than a sheet could be (pdf-reader.js)
 * Errors that aren't one of these are bugs, and are thrown.
 * `limits` is the reader's (PdfFile): the tests set a small budget.
 */
export function readSheet(bytes, fileName = "sheet.pdf", limits = undefined) {
  let text;
  try {
    text = documentText(new PdfFile(bytes, limits));
  } catch (e) {
    if (e instanceof PdfTooBig) return { ok: false, reason: "too-big", detail: e.message };
    if (e instanceof UnsupportedPdf) return { ok: false, reason: "unsupported", detail: e.message };
    if (e instanceof PdfError) return { ok: false, reason: "not-pdf", detail: e.message };
    throw e;
  }
  return readText(text, fileName);
}

/** The same, from layout text already extracted (the laptop's .txt fixtures). */
export function readText(text, fileName = "sheet.txt") {
  if (!strip(text)) return { ok: false, reason: "picture", detail: "no text in this PDF" };
  let doc;
  try {
    doc = parseText(text, fileName);
    if (!doc) return { ok: false, reason: "not-a-sheet", detail: "no assignment number" };
    return { ok: true, assignment: buildAssignment(doc), text };
  } catch (e) {
    if (e instanceof SheetError) return { ok: false, reason: "unreadable", detail: e.message };
    throw e;
  }
}
