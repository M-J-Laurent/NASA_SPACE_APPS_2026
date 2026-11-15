// Offline "what place is this?" lookup: countries (world-atlas), US states (us-atlas) and named oceans/seas (Natural Earth).
// Polygons are rasterised once into small id maps, so finding the region under a click is a single array lookup
// (a point-in-polygon search over ~200 shapes made every click laggy).
import { feature, mesh } from 'topojson-client';
import { geoPath, geoEquirectangular, geoArea } from 'd3-geo';
import world from 'world-atlas/countries-50m.json';
import usStates from 'us-atlas/states-10m.json';

const countries = feature(world, world.objects.countries).features;
const states = feature(usStates, usStates.objects.states).features;
let water = []; // named water bodies, biggest first so smaller ones are drawn (and picked) on top
let countryIds, stateIds, waterIds;

const MW = 2048, MH = 1024;
const proj = geoEquirectangular().scale(MW / (2 * Math.PI)).translate([MW / 2, MH / 2]);
const CODE = 1013; // spreads ids over the colour space so an anti-aliased edge pixel never looks like another id

function rasterIds(list) {
  const c = document.createElement('canvas'); c.width = MW; c.height = MH;
  const g = c.getContext('2d', { willReadFrequently: true }), path = geoPath(proj, g);
  list.forEach((f, i) => {
    const code = (i + 1) * CODE;
    g.fillStyle = `rgb(${(code >> 16) & 255},${(code >> 8) & 255},${code & 255})`;
    g.beginPath(); path(f.geometry); g.fill();
  });
  const px = g.getImageData(0, 0, MW, MH).data, ids = new Uint16Array(MW * MH);
  for (let q = 0; q < ids.length; q++) {
    if (px[q * 4 + 3] !== 255) continue; // empty or an anti-aliased edge pixel
    const code = (px[q * 4] << 16) | (px[q * 4 + 1] << 8) | px[q * 4 + 2];
    if (code % CODE === 0 && code / CODE <= list.length) ids[q] = code / CODE;
  }
  return ids;
}

/** Call once with the parsed marine.json (or null if it is missing). */
export function initRegions(marine) {
  water = ((marine && marine.features) || []).map((f) => ({ name: f.name, kind: 'water', geometry: f.geometry, area: geoArea(f.geometry) }))
    .sort((a, b) => b.area - a.area);
  countryIds = rasterIds(countries); stateIds = rasterIds(states); waterIds = rasterIds(water);
}

function idAt(ids, lat, lon) {
  const x0 = Math.min(MW - 1, Math.max(0, Math.floor(((lon + 180) / 360) * MW))), y0 = Math.min(MH - 1, Math.max(0, Math.floor(((90 - lat) / 180) * MH)));
  const v = ids[y0 * MW + x0];
  if (v) return v;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { // edge pixel: borrow a neighbour
    const x = (x0 + dx + MW) % MW, y = y0 + dy;
    if (y >= 0 && y < MH && ids[y * MW + x]) return ids[y * MW + x];
  }
  return 0;
}

const US = 'United States of America';

/** What is at this point: {country, state, water}, each {name, kind, geometry} or null. Water is only reported away from land. */
export function regionFeatures(lat, lon) {
  const ci = idAt(countryIds, lat, lon), si = idAt(stateIds, lat, lon), wi = idAt(waterIds, lat, lon);
  const c = ci ? countries[ci - 1] : null;
  const s = c && c.properties.name === US && si ? states[si - 1] : null;
  const w = !c && wi ? water[wi - 1] : null;
  return {
    country: c && { name: c.properties.name, kind: 'country', geometry: c.geometry },
    state: s && { name: `${s.properties.name}, USA`, kind: 'state', geometry: s.geometry },
    water: w && { name: w.name, kind: 'water', geometry: w.geometry },
  };
}

// rough fallback if the marine polygons are unavailable
function oceanName(lat, lon) {
  if (lat > 66.5) return 'the Arctic Ocean';
  if (lat < -60) return 'the Southern Ocean';
  const ns = lat >= 0 ? 'North' : 'South';
  if (lon >= -60 && lon <= 20) return `the ${ns} Atlantic Ocean`;
  if (lon > 20 && lon <= 147 && lat > -60) return 'the Indian Ocean';
  return `the ${ns} Pacific Ocean`;
}

/** {name, kind} e.g. {name: 'California, USA', kind: 'land'} or {name: 'North Pacific Ocean', kind: 'ocean'}. */
export function regionName(lat, lon) {
  const f = regionFeatures(lat, lon);
  if (f.state) return { name: f.state.name, kind: 'land' };
  if (f.country) return { name: f.country.name, kind: 'land' };
  if (f.water) return { name: f.water.name, kind: 'ocean' };
  return { name: oceanName(lat, lon), kind: 'ocean' };
}

export const countryByName = (name) => {
  const c = countries.find((x) => x.properties.name === name);
  return c && { name, kind: 'country', geometry: c.geometry };
};

/** Every country, US state and named water body, for the region picker. */
export function regionList() {
  return [
    ...countries.map((c) => ({ name: c.properties.name, kind: 'country', geometry: c.geometry })),
    ...states.map((s) => ({ name: `${s.properties.name}, USA`, kind: 'state', geometry: s.geometry })),
    ...water.map((w) => ({ name: w.name, kind: 'water', geometry: w.geometry })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/** US state borders as lines (arrays of [lon, lat]) to show that states can be picked. */
export const stateBorderLines = () => mesh(usStates, usStates.objects.states).coordinates;
