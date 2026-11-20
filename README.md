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
- **`data/team-counts.csv`**: team counts per county. Do not edit by hand; it is made from the FIRST Team Status Report (see "Updating team counts" below).

Region ids for the `scope` column: `milwaukee`, `woww`, `southshore`, `nel`, `foxvalley`, `cnw`, `north`, `sevenrivers`, `capital`, `driftless`.

## Where the numbers come from

`scripts/build-data.mjs` writes `site/data/data.json` from `data/team-counts.csv` (teams) and the public FIRST event search (events).

- A team counts when the report marks it Active, whether or not it has paid yet. The county is the one in the report.
- If `data/team-counts.csv` is deleted, the counts fall back to the public FIRST team search, which places teams by ZIP code.
- The season is set in `config/settings.json`. FIRST labels seasons differently by program: the 2026-27 school year is `2026` for FLL and FTC and `2027` for FRC.
- FLL counts Challenge, Explore and Future Edition together.
- Only events that have not ended are kept. Remote events with no location are not shown.
- If the search fails or a program's count drops by more than half, the refresh stops and the site keeps its previous data.

## Updating team counts

1. Download the Team Status Report from Tableau as a CSV. Save it outside this folder (for example in Downloads).
2. Run `node scripts/import-team-report.mjs "C:path	oeport.csv"`, then `node scripts/build-data.mjs`.
3. Commit `data/team-counts.csv`, `data/team-places.csv` and `site/data/data.json`.

## Team privacy

The report holds personal data: coach names, emails, phone numbers and addresses. This repository and its job logs are public, so:

- Never commit the report. The import script reads it where it is and writes only counts per county.
- The page shows numbers of teams per county and per city, and nothing else about a team: no team numbers, names, schools or addresses. A team circle on the map sits on the city, never on an address.
- Do not add team numbers or names to any file here.

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

Markers: translucent circles are teams (one per city and program, bigger for more teams); the outlined shapes are upcoming events. The checkboxes under the map switch teams and events on or off for each program.

Using the map: the first click opens a region and zooms to it; a click on a county inside the open region opens that county (its team counts and events). The buttons at the top right of the map zoom in, zoom out and show the whole state. With a mouse, drag to move the map when zoomed in, and hold Ctrl while scrolling to zoom. On a touch screen one finger scrolls the page and two fingers move and zoom the map.

Address options: add `?region=nel` to open on a region, and `?header=0` to hide the title when the Wix page already has one.

GitHub pauses scheduled jobs in repositories with no activity for 60 days; if the nightly refresh stops, re-enable it under the Actions tab.
