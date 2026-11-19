# FIRST in Wisconsin engagement map

An interactive map of Wisconsin's 72 counties grouped into regions, showing FLL, FTC and FRC team counts, goals, progress, upcoming events and a contact form for each region's champion. It is a static page (hosted on GitHub Pages and embedded in the Wix site) plus one small Cloudflare Worker that relays the contact form.

## What is where

| Folder | What it is |
| --- | --- |
| `site/` | The page itself. This folder is what gets published. |
| `data/` | The files you edit by hand: goals, champions, other events, team fixes. |
| `config/` | Region definitions and colors (`regions.json`), season and data sources (`settings.json`). |
| `scripts/` | The nightly data refresh, the one-time map build and a local preview server. |
| `worker/` | The Cloudflare Worker for the contact form. It has its own `README.md`. |
| `.github/workflows/` | The nightly refresh and deploy job. |

Nothing here needs `npm install`. You only need Node 20 or newer.

## Editing the data

All four files are plain CSV. Edit them on github.com or in a spreadsheet, save, and the site rebuilds itself.

- **`data/goals.csv`**: one row per region with the FLL, FTC and FRC goals. Leave a cell empty for "Goal not set". Progress is teams divided by goal. The statewide goal is the sum of the regions unless you fill in the `state` row.
- **`data/champions.csv`**: the champion's name for each region. Names only. Email addresses go in the Worker secret (see `worker/README.md`) so they are never public.
- **`data/other-events.csv`**: events you add yourself. Dates are `YYYY-MM-DD`; `county` decides which region the event belongs to and where its marker goes.
- **`data/team-overrides.csv`**: moves a team to the right county when the ZIP code lookup gets it wrong. The refresh prints any team it could not place.

Region ids for the `scope` column: `milwaukee`, `woww`, `southshore`, `nel`, `foxvalley`, `cnw`, `north`, `sevenrivers`, `capital`, `driftless`.

## Where the numbers come from

`scripts/build-data.mjs` reads the public FIRST team and event search (the one behind the team and event finder on firstinspires.org) and writes `site/data/data.json`.

- Teams are placed in a county by the location of their ZIP code, because FIRST does not publish a county. A few teams near county lines land next door; fix them in `data/team-overrides.csv`.
- The season is set in `config/settings.json`. FIRST labels seasons differently by program: the 2025-26 school year is `2025` for FLL and FTC and `2026` for FRC.
- FLL counts Challenge and Explore together. Change `teamPrograms` in `config/settings.json` to count them differently.
- Only events that have not ended are kept. Remote events with no location are not shown.
- If the search fails or a program's count drops by more than half, the refresh stops and the site keeps its previous data.

## Preview on your computer

```
node scripts/serve.mjs 5173 --mock
```

Open http://localhost:5173. With `--mock` the contact form talks to a pretend endpoint and sends nothing.

Other commands: `node scripts/build-data.mjs` refreshes the data now, `node scripts/build-map.mjs` rebuilds the shapes after you change `config/regions.json`, and `node --test worker/test/contact.test.mjs` runs the Worker tests.

## Going live

1. **GitHub.** Create a repository, push this folder to the `main` branch, then in Settings → Pages set Source to "GitHub Actions". The workflow publishes `site/` and refreshes the data every night.
2. **Cloudflare Worker.** Follow `worker/README.md`. When it is deployed, put its URL (ending in `/contact`) and the Turnstile site key into `site/config.js`, and add the GitHub Pages address to the Worker's `ALLOWED_ORIGINS`.
3. **Wix, desktop.** In the editor choose Add Elements → Embed Code → Embed a Site, paste the GitHub Pages address, and size the frame to about 1280 × 920. On wide frames the page fills whatever height you give it and the side panel scrolls inside.
4. **Wix, mobile.** In the mobile editor hide the desktop embed and add a second one about 390 wide and 1700 tall.

Address options: add `?region=nel` to open on a region, and `?header=0` to hide the title when the Wix page already has one.

GitHub pauses scheduled jobs in repositories with no activity for 60 days; if the nightly refresh stops, re-enable it under the Actions tab.
