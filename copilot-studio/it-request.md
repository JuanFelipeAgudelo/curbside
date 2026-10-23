# What to ask IT for

Curbside today runs on Cloudflare for one driver. Rebuilt in the department's Microsoft 365 for every
driver, it needs the items below. Each says why, and what changes if the answer is no. Facts about
Copilot Studio were checked on Microsoft Learn on 2026-10-23; the product changes quickly, so check
again before relying on a number.

| # | Ask | Why | If no |
|---|---|---|---|
| 1 | **A Power Platform environment with Dataverse, and Dataverse search turned on** | Runs, changes and flights live in Dataverse tables (`data-model.md`). Uploaded knowledge files need Dataverse search ([Learn](https://learn.microsoft.com/en-us/microsoft-copilot-studio/knowledge-add-file-upload)). | No rebuild: there is nowhere to keep runs per driver. |
| 2 | **Copilot Credits** for the agent, and a decision on how the scheduled flight checks are billed | The flight checker runs every 20 minutes. As an **agent flow** it uses Copilot Credits (13 per 100 actions); as a **Power Automate cloud flow** it uses Power Automate licensing instead, no credits ([Learn](https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-messages-management)). Reading a sheet with AI costs 8 credits a page. Answers cost 2 credits each (none for users with a Microsoft 365 Copilot licence, in an agent they are signed in to). | The agent and flows stop when credits run out (agent flows are blocked; agents disabled at 125%). |
| 3 | **Data loss prevention (DLP) policy allowing the HTTP connector and custom connectors** in that environment | The flight data service is called over HTTP; the Azure Function (item 4) sits behind a custom connector. | No flight checks from an outside service; no Azure Function. |
| 4 | **An Azure Functions app (Node.js 20 or later)**, with a key the custom connector uses | Runs the app's own, tested code unchanged: the sheet reader, the two clocks, the alert wording, the check plan, the change targeting (`azure-functions.md`). Exact, and the cheapest to keep right. | Read sheets with AI instead (approximate: the driver confirms each one), and rebuild the clocks, alerts and change targeting as flows from `rules/` (more work, more to test). |
| 5 | **Flight data**: the department's own source, or a paid AeroDataBox plan (RapidAPI) with a **department-owned key** | Today's free plan is 200 lookups a month for everyone; 20 drivers need roughly 1,200–1,800 (`rules/flight-checks.md`). The key must not be a person's. | No flight checks: the runs work as converted sheets, with no delays, no clocks from live times, no alerts. |
| 6 | **Teams: the Workflows app allowed**, and messages from a flow to drivers ("Post message in a chat or channel" as the Flow bot) | Alerts reach drivers as Teams messages ([connector](https://learn.microsoft.com/en-us/connectors/teams/)). Flow bot posts are throttled (about 25 per 5 minutes per connection). | Alerts by e-mail instead (slower to notice at the wheel). |
| 7 | **Two Entra groups: "Curbside drivers" and "Curbside dispatch"** | Sign-in replaces today's list codes; the groups map to Dataverse security roles (`data-model.md`, "Roles"). | Roles assigned user by user. |
| 8 | **Approval to store passengers' names, phone numbers, flights and appointments in Dataverse**, and the retention | Today runs are deleted 7 days after they end (choice of 2, 7, 14, 30). Whether PDFs are kept at all, and where. | Nothing can be stored; the rebuild cannot start. |
| 9 | **Power Apps licences for drivers** (Premium, because the app uses Dataverse), if a Power App is wanted | A chat agent cannot show the visual itinerary (the rail of stops, Right Now, the clocks at a glance) or work offline. A Power App over the same tables can. | Teams agent only: questions and alerts, no itinerary screen. |
| 10 | **Which Copilot Studio harness**: the standard harness (topics, agent flows, prompt actions; predictable) or the GitHub Copilot harness (reasons step by step, runs a Python sandbox with skills; usage-based billing) ([Learn](https://learn.microsoft.com/en-us/microsoft-copilot-studio/harnesses-overview)) | The standard harness fits a rule-bound agent. The GitHub Copilot harness is needed only for reading sheets with the Python reader as a skill (`reading-the-sheet.md`, way B). | Standard harness. |

## Also to decide (the department, not IT)

- **Who imports sheets**: dispatch for everyone at once (each sheet's driver name assigns it), or each
  driver their own, or both. The kit works either way.
- **Who keeps places, airlines and car lots** (approves drivers' suggestions): dispatch, or one admin.
- **Retention**: one setting for the department, or per driver.
- **The pilot**: two drivers beside today's app for two weeks, comparing every clock and alert.

## What this costs to run, roughly

Not a quote; re-check prices. The agent: ~2 credits an answer (none for Microsoft 365 Copilot users).
The checker as an agent flow: 72 runs a day (every 20 minutes) of 10–30 actions each is
21,600–64,800 actions a month, about 2,800–8,400 credits; as a Power Automate cloud flow, no
credits (Power Automate licensing instead). Sheets read with AI: 8 credits a page, about one page a run. Flight data: the
plan bought in item 5. Azure Functions on the consumption plan: likely within the free grant at
this volume.
