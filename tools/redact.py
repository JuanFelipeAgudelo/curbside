"""Turn real assignment PDFs into committable test fixtures.

    python tools/redact.py "<pdf dir>" --names <map>   # regenerate tools/fixtures/
    python tools/redact.py --check --names <map>       # verify no PII slipped through
    python tools/redact.py --scrub <files> --names <map>   # replace names in docs/code
    python tools/redact.py --history-expressions <out> --names <map>

`<map>` is the private name list (see NAMES IN PROSE below); it may also come
from the CURBSIDE_PII_NAMES environment variable.

The real documents carry passenger names, mobile numbers, hospital destinations
and internal email addresses, so they can never be committed. The parser still
needs to be pinned against real structure, because every bug it has had came
from structure rather than content: a timestamp wrapping mid-value, an empty
parking cell, a passenger row printed twice, a codeshare split across lines.

So fixtures are the *layout-extracted text* with identities replaced, saved as
`.txt`. The reader takes a `.txt` as already-extracted text (`readText` in
public/importer/index.js), so the tests need neither a PDF nor the originals.
Regenerating asks the app's own reader for each PDF's text, through node
(`node tools/import.mjs <pdf> --text`): the fixtures are what the parser is
really given. After regenerating: `node tools/golden.mjs`, and read the diff.

THE ONE RULE THAT MATTERS
-------------------------
Layout text is column-sensitive: the parser reads Origin and Destination by
splitting on runs of two-plus spaces, and decides a parking cell is empty by
whether anything follows the label on that line. So every replacement is padded
or truncated to **exactly the length of what it replaced**. A fake name one
character longer would shift a column and quietly stop reproducing the very bug
the fixture exists to pin.

WHAT IS KEPT, AND WHY
---------------------
NAMES IN PROSE
--------------
NAME_CELL finds "Last, First" in a name column. Dispatch's notes also name
people in running text -- "copy <staff member>", "family member of <passenger>",
"take the <family>s to the lobby" -- and no pattern tells a surname from a
place there. Those come from a list kept OUTSIDE the repo, because the list is
itself the PII: one `real==>fake` per line, git filter-repo's --replace-text
format, so the history rewrite uses the very same map. In a fixture every
replacement is fitted to the width of what it replaced.

Facility names (NYP Allen, NYU Langone) stay. They are drive-time keys and
operational structure, and once every passenger name and phone number is gone
they identify nobody. Sites, airports, flight numbers, times and airline strings
all stay -- they are the structure under test.
"""
import argparse
import glob
import hashlib
import os
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")


def layout_text(pdf):
    """A PDF's layout text as the app's reader extracts it (public/importer/).
    Bytes decoded here, not text mode: a newline must stay what it was."""
    r = subprocess.run(["node", os.path.join(HERE, "import.mjs"), pdf, "--text"],
                       capture_output=True, check=False)
    if r.returncode != 0:
        raise RuntimeError("the reader could not read it")
    return r.stdout.decode("utf-8")

# Stable fake identities. Same input always yields the same fake, so a
# regenerated fixture set produces a clean diff rather than noise.
# Ordinary surnames and given names, deliberately unremarkable. An earlier pool
# (Stallybrass, Ravensworth, Thorncroft) read as invented, which snags the eye
# in a fixture diff and looks wrong if a screen is ever shown to anyone. Short
# entries come first so a narrow cell still gets a whole name rather than a
# truncated one.
SURNAMES = ["Best", "Cole", "Diaz", "Ford", "Grant", "Hale", "Ibarra", "Jonas",
            "Keller", "Lucas", "Mendez", "Novak", "Owens", "Pratt", "Quinn",
            "Reyes", "Sutton", "Tanaka", "Vargas", "Warner", "Alvarez",
            "Brennan", "Okafor", "Whitaker", "Sandoval", "Donnelly"]
GIVENS = ["Ana", "Ben", "Cruz", "Dana", "Eli", "Faye", "Gil", "Hana", "Ivan",
          "Jude", "Kira", "Leon", "Mara", "Nils", "Omar", "Pia", "Rosa",
          "Sam", "Tess", "Vera", "Marcus", "Daniela", "Theo", "Noor"]


def _pick(pool, seed):
    h = int(hashlib.sha256(seed.strip().lower().encode()).hexdigest(), 16)
    return pool[h % len(pool)]


def fit(replacement, original):
    """Same-length replacement. Pad with spaces if short, truncate if long --
    but never leave a trailing comma or space inside the name itself, because a
    mangled 'Ostrowski, ' is re-matched by the next pass, which then reads the
    NEXT COLUMN as the given name and pads the real cell away. That bug cost a
    fixture its Origin cell before this rstrip existed."""
    n = len(original)
    if len(replacement) > n:
        replacement = replacement[:n].rstrip(" ,.-")
    return replacement + " " * (n - len(replacement))


def fake_person(original):
    """'Whitaker, Dennis' -> 'Harkaway, Bruno', in exactly the same width.

    Candidates are tried shortest-first so a narrow cell still gets a plausible
    whole name rather than a truncated one."""
    txt = original.strip()
    width = len(txt)
    if "," in txt:
        last, first = (p.strip() for p in txt.split(",", 1))
        seed_a, seed_b, sep = last, (first or last), ", "
    else:
        seed_a, seed_b, sep = txt, txt, " "
    # Rotate each pool from its seeded position, so the choice is stable per
    # input but we can still fall back to a shorter entry that fits.
    def rotated(pool, seed):
        i = int(hashlib.sha256(seed.strip().lower().encode()).hexdigest(), 16) % len(pool)
        return pool[i:] + pool[:i]

    surnames = rotated(SURNAMES, seed_a)
    givens = rotated(GIVENS, seed_b)
    for cand in (f"{s}{sep}{g}" for s in surnames for g in givens):
        if len(cand) <= width:
            return fit(cand, original)
    return fit(f"{surnames[0]}{sep}{givens[0]}", original)


# A person's name in the left column of a passenger row, after "Driver", or in
# the assistant table. One pattern covers all three -- two overlapping patterns
# is what let a half-redacted name get re-matched.
# `,[ ]{1,2}` and not `,\s+`: a greedy run of spaces reaches across the gap into
# the Origin column, and then "LGA" reads as a given name.
NAME_CELL = re.compile(r"(?<=\s)([A-Z][A-Za-z'\-]+,[ ]{1,2}[A-Z][A-Za-z'\-.]*(?:[ ][A-Z][A-Za-z'\-.]*)?)(?=[ ]{2,}|[ ]*$)")
DRIVER_LINE = re.compile(r"(Driver[ ]{2,})([A-Z][A-Za-z'\-]+,[ ]{1,2}[^\n]*?)([ ]*$)", re.M)
# Tight on purpose. A loose class like [\d\-\(\). ]{8,} spans the gap BETWEEN
# columns and swallows whatever is next -- it ate a vehicle id ("Branch (72398)")
# and a flight number ("UA 1503") on the first run. So: anchored on the "+", and
# never more than ONE separator between digit groups. A column gap in this
# layout is always two or more spaces, which is what keeps the match inside its
# own cell.
#
# The first version of this only understood North American shapes -- a 3-3-4
# grouping behind a 1-2 digit country code. Every foreign number in the corpus
# has a different shape (3-digit country codes, 2-4-4, pairs, and one run with
# no separators at all), so ten real mobile numbers were published. The rule now
# is structural rather than format-specific: a "+" and then digits.
PHONE = re.compile(
    r"\+\d{1,3}(?:[ \-.]?\d{1,10}){1,7}"            # any international shape
    r"|\(\d{3}\) ?\d{3}[\-\. ]\d{4}"             # (555) 010-0000
    r"|\b\d{3}[\-\.]\d{3}[\-\.]\d{4}\b")         # 555-010-0000
EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")


NAMES_ENV = "CURBSIDE_PII_NAMES"


def load_names(path):
    """[(real, fake)] from a filter-repo style map; comments and blanks skipped."""
    pairs = []
    if not path:
        return pairs
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line or line.startswith("#") or "==>" not in line:
                continue
            real, fake = line.split("==>", 1)
            if real:
                pairs.append((real, fake))
    return pairs


def scrub_names(text, names, keep_width):
    """Every listed name replaced, in the map's order (longest first there).
    `keep_width` fits each fake to the real one's width, for column layout."""
    for real, fake in names:
        text = text.replace(real, fit(fake, real) if keep_width else fake)
    return text


def masked(name):
    """A name as a log may show it: first and last letter only."""
    return f"{name[0]}...{name[-1]}" if len(name) > 2 else "..."


def redact(text, names=()):
    out = text

    def _name(m):
        return fake_person(m.group(1))

    out = DRIVER_LINE.sub(lambda m: m.group(1) + fake_person(m.group(2)) + m.group(3), out)
    out = NAME_CELL.sub(_name, out)
    # Phone and email are replaced with same-length filler so the Information
    # column keeps its geometry.
    out = PHONE.sub(lambda m: fit("+1 555-0100-000", m.group(0)), out)
    out = EMAIL.sub(lambda m: fit("redacted@example.invalid", m.group(0)), out)
    return scrub_names(out, names, keep_width=True)


# The fixtures worth keeping: one per structural fact the parser has been wrong
# about, plus the ordinary cases. Keyed by in-document assignment number.
WANTED = {
    "369736": "combo-and-double-printed-rows",
    "375126": "timestamp-wraps-mid-value",
    "373621": "dispatch-shift-no-vehicle",
    "334184": "notes-are-a-timed-itinerary",
    "366222": "shuttle-with-notes-and-steps",
    "348400": "departure-with-inline-iata",
    "350568": "excluded-ho-and-non-flight",
    "352711": "airline-name-needs-table",
    "353328": "notes-multi-paragraph-with-email",
    "361028": "date-rollover-disagrees-with-end",
    "356385": "non-flight-pickup-drop-off",
    "340343": "row-endpoints-beat-enclosing-stop",
    "366824": "all-rows-excluded-must-still-appear",
    "341156": "action-with-no-location",
    "339460": "shuttle-with-named-passenger-rows",
}

# The check must not be written from the same mental model as the redactor, or
# it validates the redactor's blind spot and reports clean. The first version
# looked only for "+1" numbers in the one format PHONE already handled, so it
# passed while ten international numbers sat in the fixtures.
#
# So this is deliberately structural and over-broad: ANY run of digits behind a
# "+" is a leak unless every digit is zero or it is the 555 placeholder. It does
# not need to know what a phone number looks like -- that was the mistake.
def _is_placeholder(text):
    return bool(re.fullmatch(r"\+1 555-0100-\d+", text)) or not re.search(r"[1-9]", text)


LEAK = [
    ("phone", re.compile(r"\+\d{1,3}(?:[ \-.]?\d{1,10}){1,7}")),
    ("email", re.compile(r"[A-Za-z0-9._%+\-]+@(?!example\.invalid)[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")),
]


def tracked_text_files():
    """Every text file git tracks, fixtures included: names hide in docs and
    code comments as well (a hospital patient's name sat in a spec)."""
    import subprocess
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    names = subprocess.run(["git", "ls-files"], cwd=root, capture_output=True,
                           text=True, check=True).stdout.split()
    out = []
    for n in names:
        if n.endswith(("package-lock.json", ".png", ".ico", ".pdf", ".woff2")):
            continue
        out.append(os.path.join(root, n))
    return out


def history_expressions(names, out_path):
    """The --replace-text file for `git filter-repo`: the name map, then every
    real phone number any commit on any branch ever added, each mapped to the
    placeholder at its own width. Written outside the repo; it holds the PII."""
    import subprocess
    log = subprocess.run(["git", "log", "--all", "-p", "--no-color", "--format=", "--",
                          ".", ":!**/package-lock.json"],
                         capture_output=True, text=True, encoding="utf-8",
                         errors="replace", check=True).stdout
    phones = set()
    for line in log.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            for hit in LEAK[0][1].findall(line):
                # --check may be over-broad; a rewrite of every commit may not.
                # "+15 domestic" and "+2026-09-25" are text, and replacing them
                # would corrupt history. A phone number has 9+ digits and is
                # not one of the reserved 555 fakes the tests use.
                digits = re.sub(r"\D", "", hit)
                # 555-0100..0199 is reserved for fiction under any area code
                # ("+18455550142" in the messages tests was once rewritten).
                fictional = re.search(r"55501\d\d$", digits) is not None
                if (_is_placeholder(hit) or len(digits) < 9 or hit.startswith("+1 555") or fictional
                        or re.fullmatch(r"\+\d{4}-\d{2}-\d{2}", hit)):
                    continue
                phones.add(hit)
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        for real, fake in names:
            fh.write(f"{real}==>{fake}\n")
        # Longest first, so a number is never half-replaced by a shorter one.
        for hit in sorted(phones, key=len, reverse=True):
            fh.write(f"{hit}==>{fit('+1 555-0100-000', hit)}\n")
    print(f"{len(names)} names and {len(phones)} phone numbers written to {out_path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdfdir", nargs="?")
    ap.add_argument("--check", action="store_true",
                    help="scan the fixtures, and with --names every tracked file, for PII")
    ap.add_argument("--names", default=os.environ.get(NAMES_ENV),
                    help=f"the private name map (default: ${NAMES_ENV})")
    ap.add_argument("--scrub", nargs="+", metavar="FILE",
                    help="replace the listed names in these files, in place")
    ap.add_argument("--history-expressions", metavar="OUT",
                    help="write a git filter-repo --replace-text file")
    args = ap.parse_args()
    names = load_names(args.names)

    if args.history_expressions:
        history_expressions(names, args.history_expressions)
        return 0

    if args.scrub:
        if not names:
            print("--scrub needs --names")
            return 2
        for f in args.scrub:
            body = open(f, encoding="utf-8").read()
            is_fixture = os.path.abspath(f).startswith(FIXTURES)
            new = scrub_names(body, names, keep_width=is_fixture)
            if new != body:
                with open(f, "w", encoding="utf-8", newline="") as fh:
                    fh.write(new)
                print(f"  scrubbed {os.path.relpath(f)}")
        return 0

    if args.check:
        bad = 0
        if names:
            for f in tracked_text_files():
                try:
                    body = open(f, encoding="utf-8").read()
                except (UnicodeDecodeError, FileNotFoundError):
                    continue
                for real, _ in names:
                    if real in body:
                        print(f"  LEAK name in {os.path.relpath(f)}: {masked(real)}")
                        bad += 1
        else:
            print(f"  names not checked: no --names or ${NAMES_ENV}")
        for f in sorted(glob.glob(os.path.join(FIXTURES, "*.txt"))):
            body = open(f, encoding="utf-8").read()
            for label, rx in LEAK:
                for hit in rx.findall(body):
                    # The pattern is deliberately over-broad, so the decision
                    # about what is SAFE lives here, in one place, stated as a
                    # whitelist: all-zero, or the 555 placeholder. Anything the
                    # redactor failed to touch trips it, whatever its shape.
                    if _is_placeholder(hit):
                        continue
                    print(f"  LEAK {label} in {os.path.basename(f)}: {hit!r}")
                    bad += 1
        print("clean" if not bad else f"{bad} suspected leaks")
        return 0 if not bad else 1

    if not args.pdfdir:
        ap.error("a PDF directory is needed to regenerate the fixtures")
    os.makedirs(FIXTURES, exist_ok=True)
    seen = {}
    skipped = 0
    for p in sorted(glob.glob(os.path.join(args.pdfdir, "*.pdf"))):
        try:
            text = layout_text(p)
        except Exception:  # noqa: BLE001 -- counted, not named: a file's name can carry one
            skipped += 1
            continue
        m = re.search(r"Assignment number\s+(\d+)", text)
        if not m or m.group(1) not in WANTED:
            continue
        num = m.group(1)
        # Several files can hold the same assignment; keep the longest, which is
        # the one with the most structure to test against.
        if num in seen and len(seen[num]) >= len(text):
            continue
        seen[num] = text

    for num, text in sorted(seen.items()):
        name = f"{num}-{WANTED[num]}.txt"
        with open(os.path.join(FIXTURES, name), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(redact(text, names))
        print(f"  wrote {name}")

    missing = sorted(set(WANTED) - set(seen))
    if missing:
        print(f"  NOT FOUND in that directory: {', '.join(missing)}")
    if skipped:
        print(f"  {skipped} PDF(s) the reader could not read were skipped (node on the PATH?)")
    print(f"{len(seen)} fixtures written to {FIXTURES}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
