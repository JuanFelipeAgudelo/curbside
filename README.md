# FlightWatch

Track a flight number and get pushed a notification when its status changes (departure or arrival side).

## Stack
- **Frontend:** static PWA, served as static assets by the Worker `curbside`
- **Backend:** Cloudflare Worker — cron polls AeroDataBox every 5 min, diffs status, stores state in Workers KV
- **Notifications:** Web Push straight to the installed app (VAPID, `worker/src/webpush.ts`, since v66), and
  [ntfy.sh](https://ntfy.sh) as a second way — ntfy's free service often refuses a Worker's shared address
- **Flight data:** [AeroDataBox](https://aerodatabox.com/) via RapidAPI (free tier)
- **Multi-tenancy:** private per-person lists — first visit generates a random list
  code + ntfy topic, stored in the browser's `localStorage`. No accounts, but also
  no recovery if you clear storage or switch devices without copying your code
  (see `docs/spec-per-user-lists.md`).

No webhooks, no credit-based alerts — just a cheap poll and a push.

## Setup

1. **Accounts**
   - GitHub account
   - Cloudflare account
   - RapidAPI account → subscribe to AeroDataBox (free tier), grab API key
   - Install the [ntfy app](https://ntfy.sh) on your phone — each visitor gets their
     own auto-generated topic shown in the app's settings strip, to subscribe to

2. **Local tools**
   ```
   npm install -g wrangler
   wrangler login
   ```

3. **Install deps**
   ```
   cd worker
   npm install
   ```

4. **Create KV namespace**
   ```
   wrangler kv namespace create FLIGHT_DATA
   ```
   Copy the returned `id` into `worker/wrangler.toml` under `kv_namespaces`.
   Then `wrangler kv namespace create FLIGHT_DATA --preview` and copy its
   `preview_id` beside it: `wrangler dev --remote` uses that one, so testing
   never touches production data.

5. **Set secrets**
   ```
   wrangler secret put AERODATABOX_KEY
   node tools/vapid.mjs --put          # the Web Push key pair, from the repository root
   ```

6. **Run locally**
   ```
   wrangler dev
   ```

7. **Deploy**
   ```
   wrangler deploy
   ```
   The frontend is `public/` uploaded as the Worker `curbside` (static assets only,
   no script, KV or cron; Cloudflare folded Pages into Workers):
   ```
   cd worker && npx wrangler deploy --config ../wrangler.curbside.toml
   ```
   Don't use `wrangler pages project create` from `worker/`: wrangler 4.133 turns it
   into a Workers deploy of the API's own config (KV binding, cron and all).

## Project structure

```
FlightWatch/
├── public/              # PWA frontend (static assets, Worker `curbside`)
│   ├── index.html
│   ├── app.js
│   ├── manifest.json
│   └── sw.js
└── worker/              # Cloudflare Worker (cron + API)
    ├── src/
    │   ├── index.ts     # fetch handler (REST API) + scheduled handler (cron)
    │   ├── aerodatabox.ts
    │   └── ntfy.ts
    ├── wrangler.toml
    ├── package.json
    └── tsconfig.json
```
