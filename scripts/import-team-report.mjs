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

const need = ['secured status', 'most recent season secured', 'program', 'team state province', 'team county', 'team city'];
const missing = need.filter((c) => !(c in (rows[0] ?? {})));
if (missing.length) throw new Error(`The report is missing these columns: ${missing.join(', ')}`);

// "2026 - 2027" in the report is the "2026-27" season here.
const seasonLabel = (s) => {
  const m = /^(\d{4})\s*-\s*(\d{4})$/.exec(s);
  return m ? `${m[1]}-${m[2].slice(2)}` : null;
};
const programOf = (p) => (/^FLL/i.test(p) ? 'fll' : /^FTC/i.test(p) ? 'ftc' : /^FRC/i.test(p) ? 'frc' : null);

// A team counts when it is secured (registered and paid) for the season in config/settings.json.
const counted = rows.filter((r) => r['secured status'] === 'Secured' && seasonLabel(r['most recent season secured']) === settings.season.label);
if (!counted.length) {
  const seasons = [...new Set(rows.filter((r) => r['secured status'] === 'Secured').map((r) => seasonLabel(r['most recent season secured'])))].filter(Boolean);
  throw new Error(`No secured teams for ${settings.season.label} in this report. It has secured teams for: ${seasons.join(', ') || 'no season'}. Set "season" in config/settings.json to match.`);
}

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
}

const reportDate = (await stat(path)).mtime.toLocaleDateString('en-CA');
const lines = [
  '# Team counts by county, made by scripts/import-team-report.mjs from the FIRST Team Status Report.',
  '# Counts only. Never commit the report itself: it holds personal data and this repository is public.',
  `# season: ${settings.season.label}`,
  `# report date: ${reportDate}`,
  '# counted: teams whose Secured Status is "Secured" for the season. FLL is Challenge, Explore and Future Edition together.',
  '# The "(unplaced)" row is teams with no usable county; they count toward the state total only.',
  'county,fll,ftc,frc',
  ...Object.keys(counties).sort().map((c) => `${c},${counties[c].fll},${counties[c].ftc},${counties[c].frc}`),
];
if (unplaced.fll + unplaced.ftc + unplaced.frc) lines.push(`(unplaced),${unplaced.fll},${unplaced.ftc},${unplaced.frc}`);
await writeFile(new URL('data/team-counts.csv', root), `${lines.join('\n')}\n`);

const total = (p) => Object.values(counties).reduce((n, c) => n + c[p], 0) + unplaced[p];
console.log(`Read ${rows.length} rows; counted ${counted.length} secured ${settings.season.label} teams: FLL ${total('fll')}, FTC ${total('ftc')}, FRC ${total('frc')} in ${Object.keys(counties).length} counties.`);
if (outOfState) console.log(`Left out ${outOfState} team(s) not in WI.`);
if (Object.keys(skipped).length) console.log('Programs not counted:', JSON.stringify(skipped));
if (unplacedCities.size) console.log(`No county for team(s) in: ${[...unplacedCities].join(', ')}. Add the city to data/city-counties.csv and run this again.`);
console.log('Wrote data/team-counts.csv. Now run: node scripts/build-data.mjs');
