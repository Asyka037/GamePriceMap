/**
 * One-off generator: rasterize world landmass + tracked countries into a
 * pixel grid for the site's PixelWorldMap (run again only to change grid
 * size or the tracked-country set).
 *
 * Source: johan/world.geo.json (Natural Earth derived, public domain).
 * Output: site/src/lib/worldgrid.json
 *   { cols, rows, land: [[row,col,len]...], countries: {CC: [[row,col,len]...]},
 *     centroids: {CC: {x,y}} }
 *
 * Usage: node scripts/build-worldgrid.mjs [--preview]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson } from './lib/http.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site', 'src', 'lib', 'worldgrid.data.mjs');

const COLS = 80;
const ROWS = 40;
const LAT_MAX = 84;   // skip high arctic
const LAT_MIN = -58;  // skip antarctica

// tracked ISO2 -> world.geo.json ISO3 ids
const TRACKED = {
  US: 'USA', CA: 'CAN', MX: 'MEX', CO: 'COL', BR: 'BRA', AR: 'ARG',
  GB: 'GBR', NO: 'NOR', DK: 'DNK', DE: 'DEU', PL: 'POL', CH: 'CHE',
  UA: 'UKR', TR: 'TUR', GE: 'GEO', ZA: 'ZAF', KZ: 'KAZ', PK: 'PAK',
  IN: 'IND', CN: 'CHN', KR: 'KOR', JP: 'JPN', AU: 'AUS', NZ: 'NZL',
};

const geo = await fetchJson('https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json', { label: 'world geojson', timeoutMs: 60000 });

function polygons(feature) {
  const g = feature.geometry;
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(lon, lat, poly) {
  if (!inRing(lon, lat, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) if (inRing(lon, lat, poly[h])) return false;
  return true;
}

// precompute per-feature polygon list + bboxes
const features = geo.features.map((f) => {
  const polys = polygons(f).map((poly) => {
    let minX = 180, maxX = -180, minY = 90, maxY = -90;
    for (const [x, y] of poly[0]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { poly, minX, maxX, minY, maxY };
  });
  return { id: f.id, polys };
});
const iso3ToCc = Object.fromEntries(Object.entries(TRACKED).map(([cc, iso3]) => [iso3, cc]));

// rasterize
const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(null)); // null=sea, ''=land, 'CC'=tracked
for (let r = 0; r < ROWS; r++) {
  const lat = LAT_MAX - ((r + 0.5) / ROWS) * (LAT_MAX - LAT_MIN);
  for (let c = 0; c < COLS; c++) {
    const lon = -180 + ((c + 0.5) / COLS) * 360;
    for (const f of features) {
      let hit = false;
      for (const { poly, minX, maxX, minY, maxY } of f.polys) {
        if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
        if (inPolygon(lon, lat, poly)) { hit = true; break; }
      }
      if (hit) {
        grid[r][c] = iso3ToCc[f.id] ?? '';
        break;
      }
    }
  }
}

// tiny-country guarantee: ensure every tracked country has >=1 cell (use its
// largest polygon's bbox center snapped to nearest cell)
for (const [cc, iso3] of Object.entries(TRACKED)) {
  if (grid.some((row) => row.includes(cc))) continue;
  const f = features.find((x) => x.id === iso3);
  const big = [...f.polys].sort((a, b) => (b.maxX - b.minX) * (b.maxY - b.minY) - (a.maxX - a.minX) * (a.maxY - a.minY))[0];
  const lon = (big.minX + big.maxX) / 2;
  const lat = (big.minY + big.maxY) / 2;
  const r = Math.min(ROWS - 1, Math.max(0, Math.round(((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * ROWS - 0.5)));
  const c = Math.min(COLS - 1, Math.max(0, Math.round(((lon + 180) / 360) * COLS - 0.5)));
  grid[r][c] = cc;
  console.warn(`  ${cc}: no raster cell at ${COLS}x${ROWS}, forced cell at ${r},${c}`);
}

// run-length encode
function runs(predicate) {
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    let start = -1;
    for (let c = 0; c <= COLS; c++) {
      const on = c < COLS && predicate(grid[r][c]);
      if (on && start === -1) start = c;
      if (!on && start !== -1) {
        out.push([r, start, c - start]);
        start = -1;
      }
    }
  }
  return out;
}

const land = runs((v) => v === '');
const countries = {};
const centroids = {};

/**
 * Centroid of the LARGEST connected component, not all cells — otherwise
 * Alaska drags the US anchor to the Canadian border and the comparison
 * line points at the wrong place.
 */
function mainBlobCentroid(cc) {
  const cells = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (grid[r][c] === cc) cells.push(`${r},${c}`);
  const unseen = new Set(cells);
  let best = [];
  while (unseen.size) {
    const start = unseen.values().next().value;
    unseen.delete(start);
    const blob = [start];
    const queue = [start];
    while (queue.length) {
      const [r, c] = queue.pop().split(',').map(Number);
      for (const key of [`${r - 1},${c}`, `${r + 1},${c}`, `${r},${c - 1}`, `${r},${c + 1}`]) {
        if (unseen.delete(key)) { blob.push(key); queue.push(key); }
      }
    }
    if (blob.length > best.length) best = blob;
  }
  let sx = 0, sy = 0;
  for (const key of best) {
    const [r, c] = key.split(',').map(Number);
    sx += c + 0.5;
    sy += r + 0.5;
  }
  return { x: Math.round((sx / best.length) * 100) / 100, y: Math.round((sy / best.length) * 100) / 100 };
}

for (const cc of Object.keys(TRACKED)) {
  countries[cc] = runs((v) => v === cc);
  centroids[cc] = mainBlobCentroid(cc);
}

fs.writeFileSync(OUT, '// generated by scripts/build-worldgrid.mjs — do not edit\nexport default ' + JSON.stringify({ cols: COLS, rows: ROWS, land, countries, centroids }) + ';\n');
const cellCount = land.length + Object.values(countries).flat().length;
console.log(`worldgrid.data.mjs: ${COLS}x${ROWS}, land runs ${land.length}, country runs ${Object.values(countries).flat().length}, total rects ~${cellCount}`);

if (process.argv.includes('--preview')) {
  for (let r = 0; r < ROWS; r++) {
    let line = '';
    for (let c = 0; c < COLS; c++) {
      const v = grid[r][c];
      line += v === null ? '·' : v === '' ? '█' : v[0];
    }
    console.log(line);
  }
}
