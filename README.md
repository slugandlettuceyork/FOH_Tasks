# FOH Tasks — S&L York

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/slugandlettuceyork/FOH_Tasks)

**Setting up your own copy for a different site?** Click the button
above. It'll ask you to sign in (or create a free account) with GitHub,
then automatically makes your own copy of this repo and a linked Netlify
site for it — no manual repo-linking needed. Once it's deployed:

1. Open the site, go to the **Admin** tab, and change the PIN from the
   default `4321` first thing.
2. Edit the task lists, close-down checklist and order sheet products to
   match your own site — everything's editable from Admin, no code needed.
3. Set the **week calendar** (an anchor Monday's date + its week number)
   to match your own odd/even week rota.
4. If you want your own logo instead of the placeholder one, that's the
   one thing that does need a small code change — replace the three files
   in `public/icons/` with your own (192×192, 512×512, and a 180×180
   `apple-touch-icon`), same filenames.

Each deployed copy gets its own separate, isolated data store
automatically (Netlify Blobs are scoped per-site) — nothing you enter in
one site's Admin tab affects any other deployment.

---

Front of House daily tasks, cleaning checklist, close-down sign-off and
order sheet app. Companion app to Kitchen Tasks, same overall approach but
without the PIN-based role system — staff just tick and initial. A single
4-digit PIN protects the **Admin** tab, where task lists, the close-down
checklist and the order sheet's product/par list can be edited.

## How it works

- **Today's Tasks** — auto-detects the day of week and whether it's an odd
  or even rota week (calculated from one anchor Monday + week number set in
  Admin), and shows that day's task sections. Tick + initial each item.
- **Close Down** — one fixed nightly checklist (same every day), tick +
  initial per item.
- **Order Sheet** — par levels are admin-set; anyone can fill in "need to
  order" quantities. "Clear all" resets it after the weekly order is placed.
- **Admin** — 4-digit PIN gate. Edit daily task sections/items per
  odd/even week and day, edit the close-down list, edit the order sheet's
  product list, change the admin PIN, and set/adjust the week-number anchor.

## Tech

- Static single-page app (`public/index.html` + `public/app.js`), no build
  step, no framework.
- Shared data storage via a Netlify Function (`netlify/functions/data.mjs`)
  backed by **Netlify Blobs** — this is what lets every tablet/device see
  the same sign-offs and admin edits.
- No `SITE_KEY`/multi-tenant separation yet — single site = single shared
  dataset, same as Kitchen Tasks was before that was added.

## Deploying

1. Push to GitHub (this repo).
2. In Netlify: **Add new site → Import an existing project** → pick this
   repo. Build settings are already set via `netlify.toml`
   (publish = `public`, functions = `netlify/functions`) — no build command
   needed.
3. Deploy. First load seeds the default task lists (parsed from the
   original ODD/EVEN week spreadsheets) into Netlify Blobs automatically.
4. Default admin PIN is **4321** — change it immediately from the Admin tab
   once the site is live.

## Week calculator

Set once in Admin → Week calendar: an anchor **Monday's date** and its
**week number (1–52)**. Every other date's week number/parity is derived
from that, wrapping at 52. Currently seeded as Monday 31 Aug 2026 = Week 49
(odd), matching what was live at build time — recheck this after deploying
if time has passed.
