// Turns a FIRST "Team Status Report" export (Tableau) into data/team-counts.csv.
//
//   node scripts/import-team-report.mjs "C:\path\to\List PII-Team Status Report.csv"
//
// The report holds personal data (coach names, emails, phone numbers, addresses). This script
// reads only the program, status, season, county and city columns, writes nothing but counts
// per county, and never copies the report. Keep the report itself out of this folder: the
// repository is public.
import { readFile, writeFile, stat } from 'node:fs/promises';
import { parseCsv } from './lib/csv.mjs';
import { locateCounty } from './lib/geo.mjs';

const root = new URL('..', import.meta.url);
const readJson = async (p) => JSON.parse(await readFile(new URL(p, root), 'utf8'));
const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/import-team-report.mjs "<path to the Team Status Report export>"');
  process.exit(1);
}

const settings = await readJson('config/settings.json');
const map = await readJson('site/data/map.json');
const countyKey = Object.fromEntries(Object.keys(map.counties).map((c) => [c.toLowerCase(), c]));
const findCounty = (name) => countyKey[String(name ?? '').replace(/\s+county$/i, '').trim().toLowerCase()] ?? null;
const cityCounties = new Map(
  parseCsv(await readFile(new URL('data/city-counties.csv', root), 'utf8')).map((r) => [r.city.toLowerCase(), findCounty(r.county)]),
);

// Tableau exports are UTF-16 with tabs; a "crosstab to CSV" download can be UTF-8 with commas.
const bytes = await readFile(path);
const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString('utf16le') : bytes.toString('utf8');
const firstLine = text.slice(0, text.indexOf('\n'));
const rows = parseCsv(text, firstLine.includes('\t') ? '\t' : ',');

const need = ['active team', 'secured status', 'most recent season secured', 'program', 'team state province', 'team county', 'team city'];
const missing = need.filter((c) => !(c in (rows[0] ?? {})));
if (missing.length) throw new Error(`The report is missing these columns: ${missing.join(', ')}`);

// "2026 - 2027" in the report is the "2026-27" season here.
const seasonLabel = (s) => {
  const m = /^(\d{4})\s*-\s*(\d{4})$/.exec(s);
  return m ? `${m[1]}-${m[2].slice(2)}` : null;
};
const programOf = (p) => (/^FLL/i.test(p) ? 'fll' : /^FTC/i.test(p) ? 'ftc' : /^FRC/i.test(p) ? 'frc' : null);

// A team counts when the report marks it Active, whether or not it has paid yet.
// The report covers one season; the secured teams tell us which, and it must match config/settings.json.
const counted = rows.filter((r) => r['active team'] === 'Active');
const inSeason = rows.some((r) => r['secured status'] === 'Secured' && seasonLabel(r['most recent season secured']) === settings.season.label);
if (!counted.length || !inSeason) {
  const seasons = [...new Set(rows.filter((r) => r['secured status'] === 'Secured').map((r) => seasonLabel(r['most recent season secured'])))].filter(Boolean);
  throw new Error(`This report does not look like the ${settings.season.label} season. It has secured teams for: ${seasons.join(', ') || 'no season'}. Set "season" in config/settings.json to match.`);
}

const cityKey = (s) => s.toLowerCase().replace(/,\s*wi(sconsin)?$/i, '').replace(/\s+/g, ' ').trim();
const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const places = new Map(); // "city|county" -> counts; the finest location that is ever written out
const counties = {};
const unplaced = { fll: 0, ftc: 0, frc: 0 };
const unplacedCities = new Set();
const skipped = {};
let outOfState = 0;
for (const r of counted) {
  const program = programOf(r.program);
  if (!program) {
    skipped[r.program] = (skipped[r.program] ?? 0) + 1;
    continue;
  }
  if (r['team state province'] !== 'WI') {
    outOfState++;
    continue;
  }
  const county = findCounty(r['team county']) ?? cityCounties.get(r['team city'].toLowerCase()) ?? null;
  if (!county) {
    unplaced[program]++;
    unplacedCities.add(r['team city'] || '(no city)');
    continue;
  }
  counties[county] ??= { fll: 0, ftc: 0, frc: 0 };
  counties[county][program]++;
  const city = cityKey(r['team city']);
  if (city) {
    const key = `${city}|${county}`;
    if (!places.has(key)) places.set(key, { city, county, fll: 0, ftc: 0, frc: 0 });
    places.get(key)[program]++;
  }
}

// Where each city is. The coordinates come from the public FIRST team search (it publishes a ZIP code
// centre for every team), asked only for "all Wisconsin teams": nothing from the report is sent anywhere.
// A city gets the middle of the points seen for it, rounded to about a kilometre.
const outlines = await readJson('data/geo/wi-counties.json');
const seen = new Map();
try {
  const year = settings.season.frcYear;
  for (let y = year - 5; y <= year; y++) {
    const res = await fetch(`${settings.source.teams}?size=5000&q=${encodeURIComponent(`team_stateprov:WI AND profile_year:${y} AND countryCode:US`)}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`FIRST search returned ${res.status}`);
    for (const h of (await res.json()).hits.hits) {
      const loc = h._source.location?.[0];
      const county = loc && h._source.team_city ? locateCounty(outlines, loc.lon, loc.lat) : null;
      if (!county) continue;
      const key = `${cityKey(h._source.team_city)}|${county}`;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push([loc.lon, loc.lat]);
    }
  }
} catch (err) {
  console.log(`Could not look up city locations (${err.message}). Team markers will sit at the middle of each county.`);
}
const middle = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let approximate = 0;
for (const p of places.values()) {
  const pts = seen.get(`${p.city}|${p.county}`);
  if (pts) {
    p.lon = middle(pts.map((x) => x[0])).toFixed(2);
    p.lat = middle(pts.map((x) => x[1])).toFixed(2);
  } else approximate++;
}
const placeLines = [
  '# Teams per city, made by scripts/import-team-report.mjs. City is the finest location kept: no team numbers,',
  '# names, schools or addresses. A row with no lon/lat is drawn at the middle of its county.',
  'city,county,lon,lat,fll,ftc,frc',
  ...[...places.values()].sort((a, b) => a.county.localeCompare(b.county) || a.city.localeCompare(b.city))
    .map((p) => `${titleCase(p.city)},${p.county},${p.lon ?? ''},${p.lat ?? ''},${p.fll},${p.ftc},${p.frc}`),
];
await writeFile(new URL('data/team-places.csv', root), `${placeLines.join('\n')}\n`);

const reportDate = (await stat(path)).mtime.toLocaleDateString('en-CA');
const lines = [
  '# Team counts by county, made by scripts/import-team-report.mjs from the FIRST Team Status Report.',
  '# Counts only. Never commit the report itself: it holds personal data and this repository is public.',
  `# season: ${settings.season.label}`,
  `# report date: ${reportDate}`,
  '# counted: teams the report marks Active, paid or not. FLL is Challenge, Explore and Future Edition together.',
  '# The "(unplaced)" row is teams with no usable county; they count toward the state total only.',
  'county,fll,ftc,frc',
  ...Object.keys(counties).sort().map((c) => `${c},${counties[c].fll},${counties[c].ftc},${counties[c].frc}`),
];
if (unplaced.fll + unplaced.ftc + unplaced.frc) lines.push(`(unplaced),${unplaced.fll},${unplaced.ftc},${unplaced.frc}`);
await writeFile(new URL('data/team-counts.csv', root), `${lines.join('\n')}\n`);

const total = (p) => Object.values(counties).reduce((n, c) => n + c[p], 0) + unplaced[p];
console.log(`Read ${rows.length} rows; counted ${counted.length} active ${settings.season.label} teams: FLL ${total('fll')}, FTC ${total('ftc')}, FRC ${total('frc')} in ${Object.keys(counties).length} counties.`);
if (outOfState) console.log(`Left out ${outOfState} team(s) not in WI.`);
if (Object.keys(skipped).length) console.log('Programs not counted:', JSON.stringify(skipped));
if (unplacedCities.size) console.log(`No county for team(s) in: ${[...unplacedCities].join(', ')}. Add the city to data/city-counties.csv and run this again.`);
console.log(`${places.size} cities; ${approximate} could not be located and will be drawn at the middle of their county.`);
console.log('Wrote data/team-counts.csv and data/team-places.csv. Now run: node scripts/build-data.mjs');
