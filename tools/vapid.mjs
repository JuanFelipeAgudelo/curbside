// The Worker's Web Push key pair (VAPID; worker/src/webpush.ts): a P-256 pair
// made here and handed straight to where it is kept. The private key is never
// printed and never written anywhere but its destination.
//
//   node tools/vapid.mjs --put        make a pair and set the Worker's two secrets
//                                     (VAPID_PUBLIC, VAPID_PRIVATE), as wrangler's login
//   node tools/vapid.mjs --dev        write a pair for `wrangler dev` to worker/.dev.vars
//                                     (gitignored), never the deployed one
//
// --put refuses when the secrets are already set: a new pair ends every phone's
// subscription (each signs up again at its next launch, and gets no alert
// until then). --replace does it anyway.
//
// Run from the repository root.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const WRANGLER = "worker/node_modules/wrangler/bin/wrangler.js";
const CONFIG = "worker/wrangler.toml";
const DEV_VARS = "worker/.dev.vars";

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");

/** The public key as the 65-byte uncompressed point, the private key as its
 *  32-byte scalar: both base64url, the forms the Worker and a browser read. */
async function makePair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    VAPID_PUBLIC: b64u(await crypto.subtle.exportKey("raw", pair.publicKey)),
    VAPID_PRIVATE: (await crypto.subtle.exportKey("jwk", pair.privateKey)).d,
  };
}

function wrangler(args, input) {
  return spawnSync(process.execPath, [WRANGLER, ...args, "--config", CONFIG], {
    input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
}

const args = process.argv.slice(2);
if (!existsSync(WRANGLER) || !existsSync(CONFIG)) {
  console.error("Run from the repository root, after `npm install` in worker/.");
  process.exit(1);
}

if (args.includes("--dev")) {
  const keep = existsSync(DEV_VARS)
    ? readFileSync(DEV_VARS, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("VAPID_")) : [];
  const pair = await makePair();
  writeFileSync(DEV_VARS, [...keep, `VAPID_PUBLIC=${pair.VAPID_PUBLIC}`, `VAPID_PRIVATE=${pair.VAPID_PRIVATE}`, ""].join("\n"));
  console.log(`A dev pair is in ${DEV_VARS}; wrangler dev reads it.`);
} else if (args.includes("--put")) {
  const listed = wrangler(["secret", "list"]);
  if (listed.status !== 0) {
    console.error("Couldn't read the Worker's secrets (is wrangler logged in?).");
    process.exit(1);
  }
  const have = ["VAPID_PUBLIC", "VAPID_PRIVATE"].filter((name) => listed.stdout.includes(`"${name}"`));
  if (have.length && !args.includes("--replace")) {
    console.error(`${have.join(" and ")} already set. A new pair ends every phone's alerts until its next launch;`
      + " pass --replace to make one anyway.");
    process.exit(1);
  }
  const pair = await makePair();
  // The private half first: a public key with no private one would let phones
  // sign up for alerts the Worker cannot send.
  for (const name of ["VAPID_PRIVATE", "VAPID_PUBLIC"]) {
    const put = wrangler(["secret", "put", name], pair[name]);
    if (put.status !== 0) {
      // wrangler's own words, which never include what was piped in.
      console.error(`${name} was not set:\n${put.stderr.trim().split("\n").slice(-3).join("\n")}`);
      process.exit(1);
    }
    console.log(`${name} set.`);
  }
  console.log("Both secrets are set. The Worker uses them from its next request.");
} else {
  console.error("usage: node tools/vapid.mjs --put [--replace] | --dev");
  process.exit(1);
}
