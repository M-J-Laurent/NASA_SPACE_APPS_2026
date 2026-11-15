// Offline "what place is this?" lookup: countries (world-atlas), US states (us-atlas), and rough ocean/sea names.
import { feature } from 'topojson-client';
import { geoContains } from 'd3-geo';
import world from 'world-atlas/countries-50m.json';
import usStates from 'us-atlas/states-10m.json';

const countries = feature(world, world.objects.countries).features;
const states = feature(usStates, usStates.objects.states).features;

// [name, south, north, west, east] checked in order, so small seas come before the big oceans
const SEAS = [
  ['the Mediterranean Sea', 30, 46, -6, 36], ['the Black Sea', 41, 47, 28, 41.5], ['the Baltic Sea', 54, 66, 10, 30],
  ['the North Sea', 51, 61, -4, 9], ['the Caribbean Sea', 9, 22, -88, -60], ['the Gulf of Mexico', 18, 30.5, -98, -81],
  ['the Red Sea', 13, 28, 32, 43.5], ['the Persian Gulf', 24, 30, 48, 57], ['the Arabian Sea', 8, 25, 50, 75],
  ['the Bay of Bengal', 5, 22, 80, 100], ['the South China Sea', 0, 22, 105, 120], ['the Sea of Japan', 35, 50, 127, 141],
  ['Hudson Bay', 51, 64, -95, -78], ['the Bering Sea', 53, 66, 162, 180], ['the Coral Sea', -25, -10, 145, 165],
];

function oceanName(lat, lon) {
  for (const [n, s, N, w, e] of SEAS) if (lat >= s && lat <= N && lon >= w && lon <= e) return n;
  if (lat > 66.5) return 'the Arctic Ocean';
  if (lat < -60) return 'the Southern Ocean';
  const ns = lat >= 0 ? 'North' : 'South';
  if (lon >= -60 && lon <= 20) return `the ${ns} Atlantic Ocean`;
  if (lon > 20 && lon <= 147 && lat > -60) return 'the Indian Ocean';
  if (lon >= -70 && lon < -60 && lat < -35) return 'the South Atlantic Ocean';
  return `the ${ns} Pacific Ocean`;
}

/** Returns {name, kind} e.g. {name: 'California, United States', kind: 'land'} or {name: 'the North Pacific Ocean', kind: 'ocean'}. */
export function regionName(lat, lon) {
  const pt = [lon, lat];
  const c = countries.find((f) => geoContains(f, pt));
  if (!c) return { name: oceanName(lat, lon), kind: 'ocean' };
  const cn = c.properties.name;
  if (cn === 'United States of America') {
    const s = states.find((f) => geoContains(f, pt));
    return { name: s ? `${s.properties.name}, USA` : 'USA', kind: 'land' };
  }
  return { name: cn, kind: 'land' };
}
