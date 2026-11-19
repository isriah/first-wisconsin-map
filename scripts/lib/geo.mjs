// Small geometry helpers shared by the map and data build scripts. No dependencies.

/** Decode every arc of a TopoJSON topology into [lon, lat] points. */
export function decodeArcs(topo) {
  const [sx, sy] = topo.transform.scale;
  const [tx, ty] = topo.transform.translate;
  return topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
}

/** Lambert conformal conic centred on Wisconsin. Returns unitless x (east) and y (down). */
const rad = (d) => (d * Math.PI) / 180;
const P1 = rad(43);
const P2 = rad(46.5);
const L0 = rad(-90);
const PH0 = rad(44.8);
const N = Math.log(Math.cos(P1) / Math.cos(P2)) / Math.log(Math.tan(Math.PI / 4 + P2 / 2) / Math.tan(Math.PI / 4 + P1 / 2));
const F = (Math.cos(P1) * Math.tan(Math.PI / 4 + P1 / 2) ** N) / N;
const RHO0 = F / Math.tan(Math.PI / 4 + PH0 / 2) ** N;

export function project(lon, lat) {
  const rho = F / Math.tan(Math.PI / 4 + rad(lat) / 2) ** N;
  const t = N * (rad(lon) - L0);
  return [rho * Math.sin(t), -(RHO0 - rho * Math.cos(t))];
}

/** Apply the fit stored in map.json to get SVG coordinates. */
export function toSvg(fit, lon, lat) {
  const [x, y] = project(lon, lat);
  return [(x - fit.minx) * fit.k + fit.pad, (y - fit.miny) * fit.k + fit.pad];
}

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Find the county containing a lon/lat point.
 * counties: { name: [ [outerRing, ...holes], ... ] } in lon/lat.
 * Points just outside every polygon (ZIP centroids on a shoreline) snap to the nearest
 * county if it is within maxSnapDeg degrees.
 */
export function locateCounty(counties, lon, lat, maxSnapDeg = 0.08) {
  for (const [name, polys] of Object.entries(counties)) {
    for (const poly of polys) {
      if (pointInRing(lon, lat, poly[0]) && !poly.slice(1).some((h) => pointInRing(lon, lat, h))) return name;
    }
  }
  let best = null;
  for (const [name, polys] of Object.entries(counties)) {
    for (const poly of polys) {
      for (const [x, y] of poly[0]) {
        const d = (x - lon) ** 2 + (y - lat) ** 2;
        if (!best || d < best.d) best = { d, name };
      }
    }
  }
  return best && Math.sqrt(best.d) <= maxSnapDeg ? best.name : null;
}

/** Douglas-Peucker simplification that always keeps both end points. */
export function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let max = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * (px - ax) - dx * (py - ay)) / len;
      if (d > max) {
        max = d;
        at = i;
      }
    }
    if (at >= 0 && max > tol) {
      keep[at] = true;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Area and centroid of a ring (shoelace). */
export function ringCentroid(ring) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const c = x0 * y1 - x1 * y0;
    a += c;
    cx += (x0 + x1) * c;
    cy += (y0 + y1) * c;
  }
  a /= 2;
  if (Math.abs(a) < 1e-9) return { area: 0, x: ring[0][0], y: ring[0][1] };
  return { area: Math.abs(a), x: cx / (6 * a), y: cy / (6 * a) };
}
