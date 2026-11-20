// Refreshes site/data/data.json from the public FIRST team and event search plus the
// hand-edited files in data/. Runs nightly in GitHub Actions; run by hand with:
//   node scripts/build-data.mjs            (add --force to skip the sanity check)
import { readFile, writeFile } from 'node:fs/promises';
import { parseCsv } from './lib/csv.mjs';
import { locateCounty, toSvg } from './lib/geo.mjs';

const root = new URL('..', import.meta.url);
const readJson = async (p) => JSON.parse(await readFile(new URL(p, root), 'utf8'));
const readCsv = async (p) => parseCsv(await readFile(new URL(p, root), 'utf8'));
const force = process.argv.includes('--force');

const settings = await readJson('config/settings.json');
const regionsCfg = await readJson('config/regions.json');
const map = await readJson('site/data/map.json');
const outlines = await readJson('data/geo/wi-counties.json');
const PROGRAMS = ['fll', 'ftc', 'frc'];
const state = regionsCfg.state.abbr;

const scopes = new Set(['state']);
for (const r of regionsCfg.regions) {
  scopes.add(r.id);
  for (const a of r.areas) scopes.add(a.id);
}
const countyKey = Object.fromEntries(Object.keys(map.counties).map((c) => [c.toLowerCase(), c]));
const findCounty = (name) => countyKey[String(name ?? '').replace(/\s+county$/i, '').trim().toLowerCase()] ?? null;
const programOf = (table, type) => PROGRAMS.find((p) => table[p].includes(type)) ?? null;

async function search(url, query) {
  const res = await fetch(`${url}?size=5000&q=${encodeURIComponent(query)}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`FIRST search returned ${res.status} for ${query}`);
  const body = await res.json();
  const hits = body.hits.hits.map((h) => h._source);
  if (hits.length < body.hits.total.value) throw new Error(`FIRST search truncated: ${hits.length} of ${body.hits.total.value}`);
  return hits;
}

// ---- Teams -------------------------------------------------------------
const overrides = new Map();
for (const row of await readCsv('data/team-overrides.csv')) {
  const county = findCounty(row.county);
  if (!county) throw new Error(`data/team-overrides.csv: unknown county "${row.county}"`);
  overrides.set(`${row.program.toLowerCase()}:${row.team_number}`, county);
}
// Fallback by city when a team's ZIP code cannot be placed (for example a typo that points out of state).
// Keyed by city, not by team, so no team is identified in this public repository.
const cityCounties = new Map();
for (const row of await readCsv('data/city-counties.csv')) {
  const county = findCounty(row.county);
  if (!county) throw new Error(`data/city-counties.csv: unknown county "${row.county}"`);
  cityCounties.set(row.city.trim().toLowerCase(), county);
}

// When data/team-counts.csv exists (made by scripts/import-team-report.mjs) it is the source of the team
// counts, and the public team search is not used.
let reportText = '';
try {
  reportText = await readFile(new URL('data/team-counts.csv', root), 'utf8');
} catch {}
const reportRows = parseCsv(reportText);
const fromReport = reportRows.length > 0;
if (fromReport) {
  const season = /^#\s*season:\s*(\S+)/m.exec(reportText)?.[1];
  if (season !== settings.season.label) throw new Error(`data/team-counts.csv is for season ${season}, but config/settings.json says ${settings.season.label}.`);
}
const teams = fromReport
  ? { source: 'report', asOf: /^#\s*report date:\s*(\d{4}-\d{2}-\d{2})/m.exec(reportText)?.[1] ?? null }
  : { source: 'search', asOf: null };

const { fllFtcYear, frcYear } = settings.season;
const years = [...new Set([fllFtcYear, frcYear])];
const teamHits = fromReport ? [] : (await Promise.all(years.map((y) => search(settings.source.teams, `team_stateprov:${state} AND profile_year:${y} AND countryCode:US`)))).flat();

const counties = Object.fromEntries(Object.keys(map.counties).map((c) => [c, { fll: 0, ftc: 0, frc: 0 }]));
const totals = { fll: 0, ftc: 0, frc: 0 };
const unplaced = [];
const skippedTypes = {};
let unplacedCount = 0;
for (const row of reportRows) {
  const county = findCounty(row.county);
  if (!county && row.county !== '(unplaced)') throw new Error(`data/team-counts.csv: unknown county "${row.county}"`);
  for (const p of PROGRAMS) {
    const n = Number(row[p] || 0);
    if (!Number.isInteger(n) || n < 0) throw new Error(`data/team-counts.csv: ${row.county} ${p} must be a whole number`);
    totals[p] += n;
    if (county) counties[county][p] += n;
    else unplacedCount += n;
  }
}
for (const t of teamHits) {
  const program = programOf(settings.teamPrograms, t.team_type);
  if (!program) {
    skippedTypes[t.team_type] = (skippedTypes[t.team_type] ?? 0) + 1;
    continue;
  }
  if (t.profile_year !== (program === 'frc' ? frcYear : fllFtcYear)) continue;
  totals[program]++;
  const loc = t.location?.[0];
  const county = overrides.get(`${program}:${t.team_number_yearly}`) ?? (loc ? locateCounty(outlines, loc.lon, loc.lat) : null) ?? cityCounties.get((t.team_city ?? '').trim().toLowerCase()) ?? null;
  if (county) counties[county][program]++;
  else unplaced.push(`${program.toUpperCase()} ${t.team_number_yearly} (${t.team_city ?? '?'}, ${t.team_postalcode ?? '?'})`);
}

// Team markers: one per city, never finer. Only available when the counts come from the report.
const places = [];
if (fromReport) {
  let placeText = '';
  try {
    placeText = await readFile(new URL('data/team-places.csv', root), 'utf8');
  } catch {}
  for (const row of parseCsv(placeText)) {
    const county = findCounty(row.county);
    if (!county) throw new Error(`data/team-places.csv: unknown county "${row.county}"`);
    const located = row.lon !== '' && row.lat !== '';
    const [x, y] = located ? toSvg(map.fit, Number(row.lon), Number(row.lat)).map((n) => Math.round(n)) : [map.counties[county].x, map.counties[county].y];
    places.push({ city: row.city, county, x, y, fll: Number(row.fll || 0), ftc: Number(row.ftc || 0), frc: Number(row.frc || 0) });
  }
}

// ---- Events ------------------------------------------------------------
const today = new Date().toISOString().slice(0, 10);
const thisYear = Number(today.slice(0, 4));
const eventHits = (await Promise.all([thisYear - 1, thisYear, thisYear + 1].map((y) => search(settings.source.events, `event_stateprov:${state} AND event_season:${y} AND countryCode:US`)))).flat();
const sentence = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');
const httpUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '');

const events = [];
for (const e of eventHits) {
  const program = programOf(settings.eventPrograms, e.event_type);
  const start = (e.date_start ?? '').slice(0, 10);
  const end = (e.date_end ?? e.date_start ?? '').slice(0, 10);
  if (!program || !start || end < today) continue;
  const loc = e.location?.[0];
  const remote = /remote/i.test(e.event_city ?? '') || /remote/i.test(e.event_subtype ?? '');
  const county = loc && !remote ? locateCounty(outlines, loc.lon, loc.lat) : null;
  const xy = county ? toSvg(map.fit, loc.lon, loc.lat).map((n) => Math.round(n)) : null;
  events.push({
    program,
    name: e.event_name.replace(new RegExp(`^${state}-[^-]+-`), '').trim(),
    type: sentence(e.event_subtype),
    start,
    end,
    city: remote ? '' : e.event_city ?? '',
    venue: e.event_venue ?? '',
    county,
    region: county ? map.counties[county].region : null,
    x: xy?.[0] ?? null,
    y: xy?.[1] ?? null,
    url: httpUrl(e.event_web_url),
    source: 'first',
  });
}

for (const row of await readCsv('data/other-events.csv')) {
  const start = row.date;
  const end = row.end_date || row.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error(`data/other-events.csv: dates must be YYYY-MM-DD ("${row.name}")`);
  const county = findCounty(row.county);
  if (!county) throw new Error(`data/other-events.csv: unknown county "${row.county}" ("${row.name}")`);
  if (end < today) continue;
  const program = PROGRAMS.includes(row.program?.toLowerCase()) ? row.program.toLowerCase() : 'other';
  events.push({ program, name: row.name, type: row.type ?? '', start, end, city: row.city ?? '', venue: row.venue ?? '', county, region: map.counties[county].region, x: map.counties[county].x, y: map.counties[county].y, url: httpUrl(row.url), source: 'custom' });
}
events.sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));

// ---- Goals and champions ------------------------------------------------
const goals = {};
for (const row of await readCsv('data/goals.csv')) {
  if (!scopes.has(row.scope)) throw new Error(`data/goals.csv: unknown scope "${row.scope}"`);
  const g = {};
  for (const p of PROGRAMS) {
    if (row[p] === '' || row[p] === undefined) continue;
    const n = Number(row[p]);
    if (!Number.isInteger(n) || n < 0) throw new Error(`data/goals.csv: ${row.scope} ${p} must be a whole number`);
    g[p] = n;
  }
  if (Object.keys(g).length) goals[row.scope] = g;
}
const champions = {};
for (const row of await readCsv('data/champions.csv')) {
  if (!scopes.has(row.scope) || row.scope === 'state') throw new Error(`data/champions.csv: unknown scope "${row.scope}"`);
  if (row.name) champions[row.scope] = { name: row.name };
}

// ---- Sanity check, then write -------------------------------------------
let previous = null;
try {
  previous = await readJson('site/data/data.json');
} catch {}
if (!force) {
  for (const p of PROGRAMS) {
    const before = previous?.season?.label === settings.season.label ? previous.totals?.[p] ?? 0 : 0;
    if (totals[p] === 0 || totals[p] < before * 0.5) {
      throw new Error(`Sanity check failed: ${p.toUpperCase()} team count is ${totals[p]} (was ${before}). Keeping the existing data. Re-run with --force if this is real.`);
    }
  }
}

const data = { season: settings.season, teams, totals, counties, places, events, goals, champions };
const same = previous && JSON.stringify({ ...previous, generated: undefined }) === JSON.stringify({ ...data, generated: undefined });
if (!same) await writeFile(new URL('site/data/data.json', root), JSON.stringify({ generated: new Date().toISOString(), ...data }));

console.log(`Team counts from ${fromReport ? 'data/team-counts.csv' : 'the FIRST team search'}.`);
console.log(`Teams ${settings.season.label}: FLL ${totals.fll}, FTC ${totals.ftc}, FRC ${totals.frc}. Upcoming events: ${events.length}.`);
if (Object.keys(skippedTypes).length) console.log('Team types not counted:', JSON.stringify(skippedTypes));
// The nightly job's log is public, so team details are only printed on your own computer.
if (unplacedCount) console.log(`${unplacedCount} team(s) in the report have no county; they count toward the state total only.`);
if (unplaced.length) console.log(process.env.CI ? `${unplaced.length} team(s) not placed in a county. Run this script on your own computer to see which.` : `Not placed in a county (add the city to data/city-counties.csv):\n  ${unplaced.join('\n  ')}`);
console.log(same ? 'No changes.' : 'Wrote site/data/data.json.');
