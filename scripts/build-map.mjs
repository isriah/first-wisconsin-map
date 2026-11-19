// Builds the map geometry. Run once, or again after editing config/regions.json:
//   node scripts/build-map.mjs [path-to-counties-10m.json]
// Writes site/data/map.json (projected shapes for the page) and
// data/geo/wi-counties.json (lon/lat outlines used to place teams and events).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { decodeArcs, project, simplify, ringCentroid } from './lib/geo.mjs';

const root = new URL('..', import.meta.url);
const regionsCfg = JSON.parse(await readFile(new URL('config/regions.json', root), 'utf8'));
const settings = JSON.parse(await readFile(new URL('config/settings.json', root), 'utf8'));

const WIDTH = 600;
const PAD = 6;
const TOLERANCE = 0.35; // px
// Short labels for counties too small to fit their name, and manual label nudges (px).
const ABBR = { Milwaukee: 'Milw.', Ozaukee: 'Ozk.', Washington: 'Wash.', Kewaunee: 'Kew.', Manitowoc: 'Manit.', Sheboygan: 'Sheb.', Calumet: 'Calu.', Winnebago: 'Winneb.', Marquette: 'Marq.', 'Green Lake': 'Gr. Lake', Menominee: 'Menom.', Trempealeau: 'Trempeal.', Jefferson: 'Jeff.' };
const NUDGE = { Door: [4, -6], Pepin: [2, 2], Bayfield: [0, 6], Ashland: [2, 8], Douglas: [0, 4], Kenosha: [0, 1], Crawford: [2, 0], Pierce: [4, 0], 'La Crosse': [-2, 4], Vernon: [4, 0], Buffalo: [-2, -4], Menominee: [-2, -1], Florence: [0, -2], Marinette: [-4, 0], Iron: [-2, 6] };

const topo = process.argv[2]
  ? JSON.parse(await readFile(process.argv[2], 'utf8'))
  : await (await fetch(settings.source.counties)).json();

const countyArea = {};
const countyRegion = {};
for (const region of regionsCfg.regions) {
  for (const area of region.areas) {
    for (const c of area.counties) {
      if (countyArea[c]) throw new Error(`County listed twice in config/regions.json: ${c}`);
      countyArea[c] = area.id;
      countyRegion[c] = region.id;
    }
  }
}

const geoms = topo.objects.counties.geometries.filter((g) => String(g.id).startsWith(regionsCfg.state.fips));
const names = new Set(geoms.map((g) => g.properties.name));
const missing = [...names].filter((n) => !countyArea[n]);
const unknown = Object.keys(countyArea).filter((n) => !names.has(n));
if (missing.length || unknown.length) {
  throw new Error(`config/regions.json does not match the county list. Unassigned: ${missing.join(', ') || 'none'}. Unknown: ${unknown.join(', ') || 'none'}.`);
}

const arcs = decodeArcs(topo);
const polysOf = (g) => (g.type === 'MultiPolygon' ? g.arcs : [g.arcs]);
const arcIndex = (i) => (i >= 0 ? i : ~i);

// Which counties use each arc (shared arcs are borders between two counties).
const users = new Map();
for (const g of geoms) {
  for (const poly of polysOf(g)) for (const ring of poly) for (const i of ring) {
    const k = arcIndex(i);
    if (!users.has(k)) users.set(k, new Set());
    users.get(k).add(g.properties.name);
  }
}

// Fit the projected state into the SVG width.
const projected = new Map([...users.keys()].map((k) => [k, arcs[k].map(([lon, lat]) => project(lon, lat))]));
let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
for (const pts of projected.values()) for (const [x, y] of pts) {
  minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
}
const k = (WIDTH - 2 * PAD) / (maxx - minx);
const height = Math.round((maxy - miny) * k + 2 * PAD);
const fit = { minx, miny, k, pad: PAD };
const r1 = (n) => Math.round(n * 10) / 10;

// Simplify per arc so neighbouring counties still share identical borders.
const simple = new Map();
for (const [key, pts] of projected) {
  const px = pts.map(([x, y]) => [(x - minx) * k + PAD, (y - miny) * k + PAD]);
  let s = simplify(px, TOLERANCE);
  const closed = px[0][0] === px.at(-1)[0] && px[0][1] === px.at(-1)[1];
  if (closed && s.length < 4) s = px;
  const out = [];
  for (const [x, y] of s) {
    const q = [r1(x), r1(y)];
    if (!out.length || out.at(-1)[0] !== q[0] || out.at(-1)[1] !== q[1]) out.push(q);
  }
  simple.set(key, out);
}
const arcPts = (i, table) => (i >= 0 ? table.get(i) ?? arcs[i] : [...(table.get(~i) ?? arcs[~i])].reverse());
const ringOf = (ring, table) => {
  const out = [];
  for (const i of ring) for (const p of arcPts(i, table)) {
    if (!out.length || out.at(-1)[0] !== p[0] || out.at(-1)[1] !== p[1]) out.push(p);
  }
  if (out.length > 1 && out[0][0] === out.at(-1)[0] && out[0][1] === out.at(-1)[1]) out.pop();
  return out;
};
const fmt = (n) => String(r1(n));
const pathOf = (pts, close) => {
  let d = `M${fmt(pts[0][0])},${fmt(pts[0][1])}`;
  if (pts.length > 1) d += 'l' + pts.slice(1).map((p, i) => `${fmt(p[0] - pts[i][0])},${fmt(p[1] - pts[i][1])}`).join(' ');
  return d + (close ? 'z' : '');
};

const counties = {};
const lonLat = {};
const rawArcs = new Map([...users.keys()].map((key) => [key, arcs[key]]));
for (const g of geoms) {
  const name = g.properties.name;
  const rings = polysOf(g)
    .map((poly) => ringOf(poly[0], simple))
    .filter((r) => r.length >= 3)
    .map((r) => ({ r, ...ringCentroid(r) }))
    .sort((a, b) => b.area - a.area);
  const kept = [rings[0], ...rings.slice(1).filter((x) => x.area >= 5)];
  const [dx, dy] = NUDGE[name] ?? [0, 0];
  counties[name] = {
    d: kept.map((x) => pathOf(x.r, true)).join(''),
    x: Math.round(rings[0].x) + dx,
    y: Math.round(rings[0].y) + dy,
    label: ABBR[name] ?? name,
    area: countyArea[name],
    region: countyRegion[name],
  };
  lonLat[name] = polysOf(g).map((poly) => poly.map((ring) => ringOf(ring, rawArcs).map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)])));
}

// Borders between regions, drawn as one thick line layer.
let mesh = '';
for (const [key, set] of users) {
  if (set.size !== 2) continue;
  const [a, b] = [...set];
  if (countyRegion[a] !== countyRegion[b] && simple.get(key).length >= 2) mesh += pathOf(simple.get(key), false);
}

await mkdir(new URL('site/data/', root), { recursive: true });
await mkdir(new URL('data/geo/', root), { recursive: true });
await writeFile(new URL('site/data/map.json', root), JSON.stringify({ viewBox: [0, 0, WIDTH, height], fit, regions: regionsCfg.regions, counties, mesh }));
await writeFile(new URL('data/geo/wi-counties.json', root), JSON.stringify(lonLat));
console.log(`Map built: ${Object.keys(counties).length} counties, ${regionsCfg.regions.length} regions, viewBox ${WIDTH}x${height}.`);
