# flightwatch-worker

The Cloudflare Worker behind Curbside: the API the PWA talks to, and the cron
that polls AeroDataBox.

```bash
npm run typecheck        # tsc --noEmit
npx wrangler deploy      # ship it
npx wrangler tail        # live logs, including cron ticks
```

Requires **Node 22 or newer** (wrangler 4). Node 18 installs wrangler 4 fine and
then refuses to run it.

## Secrets

Set once, per deployment, with `wrangler secret put` — never in `wrangler.toml`.

| Secret | Guards |
|---|---|
| `AERODATABOX_KEY` | The RapidAPI key for flight lookups |
| `WRITE_TOKEN` | Writes to **shared** keys — today, the travel-time table |
| `VAPID_PUBLIC`, `VAPID_PRIVATE` | The Web Push key pair: alerts straight to the installed app (`src/webpush.ts`). Set both with `node tools/vapid.mjs --put`, from the repository root, once: a new pair ends every phone's subscription until its next launch. `--dev` writes a pair for `wrangler dev` to `.dev.vars` instead |
| `FEEDBACK_TOPIC` | The owner's list topic: whose phones hear about feedback and suggestions, and whose places and airlines every list gets |
| `NTFY_TOKEN` | Optional. An ntfy.sh access token, so ntfy counts pushes against its plan and not against Cloudflare's shared address |

A person's own data is protected by their list code, which is an unguessable
secret. Shared data is one table for everybody and so has no such code to hide
behind, and this Worker's URL sits in a public repository — "nobody knows the
address" was never a control.

What is being protected is **integrity, not secrecy**. The travel-time table is
drive times between sites; it is not confidential. But it feeds every leave-by
the app computes, so a bad table sends drivers at the wrong time, quietly. The
realistic accident is not an attacker, it is the wrong workbook.

```bash
cd worker && npx wrangler secret put WRITE_TOKEN   # paste any long random string
export CURBSIDE_WRITE_TOKEN=<that same value>      # for tools/load_travel_times.py
```

The check **fails closed**: with no `WRITE_TOKEN` configured, shared writes are
refused rather than waved through. An unset secret is exactly the state a fresh
deploy is in, and that is when an open endpoint would go unnoticed. So set the
secret *before* deploying, or uploads return `401` until you do.

Reads stay open. Gating them would cost the client real complexity to hide
something that is not sensitive.

### One step of undo

`PUT /api/travel-times` moves the copy it displaces to `travel-times:prev`
before writing. `POST /api/travel-times/undo` swaps them back — a swap, not a
one-way restore, so undoing an undo returns you to where you started.

```bash
python tools/load_travel_times.py --undo
```

One step deep on purpose: this is an undo for a wrong upload, not version
history.

## Development runs on its own KV

`wrangler dev --remote` binds `FLIGHT_DATA` to the **preview** namespace
(`preview_id` in `wrangler.toml`), never production's. Test lists, fixtures and
corrections live there; the driver's runs are never touched by testing. The
daily KV quota is still one pool for the whole account, so the budget rules
hold in dev too. Reach it from the CLI with `--preview`:

```bash
npx wrangler kv key list --binding FLIGHT_DATA --preview --remote
```

## Reading production KV — always pass `--remote`

**Wrangler 4 defaults every `kv key` command to a LOCAL stub.** Wrangler 3
defaulted to remote. There is no error and no prompt; the command succeeds
against a local store and prints a quiet `Resource location: local`.

```bash
# WRONG — reads a local stub, says nothing about production
npx wrangler kv key get "all-tracked-flights" --namespace-id <id> --text

# RIGHT
npx wrangler kv key get "all-tracked-flights" --namespace-id <id> --text --remote
```

This cost a session a wrong conclusion: production state was compared against a
local stub, the mismatch looked like data loss, and a bug was reported that did
not exist. If a KV reading ever looks surprising, **check for `--remote` before
believing it.**

`kv key put` also needs a non-empty value from the CLI, even though the Workers
runtime accepts `put(key, "")` happily.

## Key layout

| Key | Holds |
|---|---|
| `list:<code>` | one person's private list — jobs plus settings |
| `flight:<num>:<date>` | last known status for a flight, shared across lists |
| `flight:<num>:<date>:trackers` | which list codes track it, so cron can route pushes |
| `flight:<num>:<date>:history` | the change lines cron computed, for the detail screen |
| `flight:<num>:<date>:sched` | when cron should next spend a unit on it |
| `poll:<num>:<date>` | membership of the poll set — **one key per flight** |

`poll:` is listed by prefix rather than read as one array. It used to be a
single `all-tracked-flights` key rewritten by every add and remove: KV has no
compare-and-swap and eventually-consistent reads, so two adds close together
could both read the same array and the second write would silently drop the
first. The flight stayed on the user's list, showed the status from its add-time
fetch, and was never polled again — with nothing to surface the loss. A key per
flight removes the shared write entirely.

The retired key is migrated and deleted on the first cron tick that sees it.

## Quota

AeroDataBox bills in monthly **API units**. Polling follows an offset ladder
before the next leg event (6h / 3h / 2h / 45m / 15m) plus one post-event poll,
which is the only moment a baggage belt is knowable — roughly 12 units per
flight rather than the ~90 an unbounded 5-minute cron was spending.

A poll that throws backs off by evidence: a flight we have held a status for had
a blip and retries in 30 minutes; one we have never had a status for is not a
blip and backs off six hours.
