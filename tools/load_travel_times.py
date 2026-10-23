"""Load the department's approved travel times into the app.

    python tools/load_travel_times.py "PT Master Travel Times - Primary Locations.xlsx"
    python tools/load_travel_times.py --show
    python tools/load_travel_times.py --undo     # put the displaced copy back

The table comes from HuB -- the one the manuals mean by "always consult HuB to
check for recommended combos and approved travel times". It is stored in KV
rather than committed, for two reasons:

  * this repository is public, and the matrix is the department's internal
    operational data. Nothing in it is personal, but publishing it is not a
    decision a tool should make quietly, and git history does not forget.

  * a table that changes when the department changes it should not need a code
    deploy. One PUT replaces it.

Precedence at import is unchanged:

    1. the assignment's own ETD-to-ETA gap    dispatch's plan for THIS run
    2. this table                             the department's standard
    3. nothing                                never a guess

Checked against times derived from real schedules: of the 25 pairs that could
be compared, 15 matched exactly. The rest differ by roughly a quarter hour,
which is the gap between what was scheduled on a given day and what the
standard allows -- which is why the document still wins when there is one.
"""
import argparse
import json
import os
import sys
import urllib.request

API = "https://flightwatch-worker.juanfe02agu.workers.dev"

# Writing the shared table needs the deployment's own token. Per-person data is
# protected by its list code; a table that is one table for everybody has no
# such code to hide behind, and the Worker's URL is in a public repository.
#
# The table itself is not confidential -- it is drive times between sites -- so
# this guards INTEGRITY, not secrecy. It feeds every leave-by the app computes,
# and the realistic accident is not an attacker but the wrong workbook.
#
#   wrangler secret put WRITE_TOKEN     (once, in worker/)
#   export CURBSIDE_WRITE_TOKEN=...     (same value, in your shell)
TOKEN_VAR = "CURBSIDE_WRITE_TOKEN"


def auth_headers():
    token = os.environ.get(TOKEN_VAR)
    if not token:
        raise SystemExit(
            "%s is not set.\n"
            "  The shared travel-time table needs the deployment's write token.\n"
            "  Set it once in Cloudflare:  cd worker && wrangler secret put WRITE_TOKEN\n"
            "  Then in this shell:         export %s=<that same value>"
            % (TOKEN_VAR, TOKEN_VAR))
    return {"Authorization": "Bearer " + token,
            "User-Agent": "flightwatch-import/1.0"}

# Sheet labels -> the site codes the assignments actually use. Row labels and
# column headers spell the same place differently ("Warwick" vs "WRK",
# "LGA - La Guardia" vs "LGA"), so both spellings map here.
SITE = {
    "Warwick": "WRK", "WRK": "WRK",
    "Fishkill": "FKL", "FKL": "FKL",
    "FKL (NCA)": "NCA",
    "Wallkill": "WKL", "WKL": "WKL",
    "Patterson": "PAT", "PAT": "PAT",
    "SWF - Stewart": "SWF", "SWF": "SWF",
    "HPN - Westchester": "HPN", "HPN": "HPN",
    "EWR - Newark": "EWR", "EWR": "EWR",
    "LGA - La Guardia": "LGA", "LGA": "LGA",
    "JFK - Kennedy": "JFK", "JFK": "JFK",
    "ALB - Albany": "ALB", "ALB": "ALB",
    "BDL - Bradley": "BDL", "BDL": "BDL",
    # Train stations. These are where the TD rows go, which is why supporting
    # trains got cheaper the moment this table arrived.
    "Penn Station (Manhattan)": "PENN", "Penn": "PENN",
    "Beacon Train Stn.": "BEACON", "Beacon": "BEACON",
    "Poughkeepsie Train Stn.": "POU",
}


def read_matrix(path):
    import openpyxl  # only needed when loading a spreadsheet

    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = [[("" if c is None else str(c).strip()) for c in r]
            for r in ws.iter_rows(values_only=True)]

    header = next((r for r in rows if "Site" in r), None)
    if not header:
        raise SystemExit("no header row containing 'Site' -- is this the right sheet?")
    start = header.index("Site") + 2  # skip the column-numbers column
    columns = [c for c in header[start:] if c]

    pairs, unknown = {}, set()
    for row in rows:
        label = row[header.index("Site")] if len(row) > header.index("Site") else ""
        if not label or label == "Site":
            continue
        origin = SITE.get(label)
        if origin is None:
            unknown.add(label)
            continue
        for name, value in zip(columns, row[start:start + len(columns)]):
            dest = SITE.get(name)
            if dest is None:
                unknown.add(name)
                continue
            if dest == origin or value == "":
                continue
            try:
                pairs[f"{origin}>{dest}"] = int(value)
            except ValueError:
                continue
    return pairs, sorted(unknown)


def put(table):
    headers = auth_headers()
    headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        f"{API}/api/travel-times", method="PUT",
        data=json.dumps(table).encode(), headers=headers)
    with urllib.request.urlopen(req) as r:
        return r.status, json.loads(r.read().decode())


def undo():
    """Swap the displaced copy back. A swap, not a one-way restore, so undoing
    an undo returns you to where you started."""
    req = urllib.request.Request(
        f"{API}/api/travel-times/undo", method="POST",
        data=b"", headers=auth_headers())
    with urllib.request.urlopen(req) as r:
        return r.status, json.loads(r.read().decode())


def get():
    # The table is the department's: read with the same token it is written with.
    req = urllib.request.Request(
        f"{API}/api/travel-times", headers=auth_headers())
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx", nargs="?", help="the HuB travel times workbook")
    ap.add_argument("--show", action="store_true", help="print what is stored")
    ap.add_argument("--dry-run", action="store_true", help="parse but do not upload")
    ap.add_argument("--undo", action="store_true",
                    help="put back the copy the last upload displaced")
    args = ap.parse_args()

    if args.undo:
        status, resp = undo()
        print(f"restored: HTTP {status}, {resp.get('pairs')} pairs "
              f"(from {resp.get('source') or 'unknown'})")
        return 0

    if args.show:
        table = get()
        pairs = table.get("pairs", {})
        print(f"{len(pairs)} pairs stored; source: {table.get('source') or 'unknown'}")
        for origin in ("WRK", "FKL"):
            out = {k.split(">")[1]: v for k, v in sorted(pairs.items())
                   if k.startswith(origin + ">")}
            if out:
                print(f"  from {origin}: " + "  ".join(f"{k}={v}" for k, v in out.items()))
        return 0

    if not args.xlsx:
        ap.error("give a workbook, or --show")

    pairs, unknown = read_matrix(args.xlsx)
    print(f"parsed {len(pairs)} pairs from {os.path.basename(args.xlsx)}")
    if unknown:
        # Named rather than silently dropped: an unmapped site is a hole in the
        # table, and a hole that nobody mentions is the kind that bites later.
        print(f"  NOT MAPPED to a site code, so skipped: {', '.join(unknown)}")
    for origin in ("WRK", "FKL"):
        got = {k.split(">")[1]: v for k, v in sorted(pairs.items())
               if k.startswith(origin + ">")}
        print(f"  from {origin}: " + "  ".join(f"{k}={v}" for k, v in got.items()))

    if args.dry_run:
        print("dry run -- nothing uploaded")
        return 0

    status, resp = put({"source": os.path.basename(args.xlsx), "pairs": pairs})
    print(f"uploaded: HTTP {status}, {resp.get('pairs')} pairs stored "
          f"(replaced {resp.get('replaced')})")
    print("  wrong file?  python tools/load_travel_times.py --undo")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
