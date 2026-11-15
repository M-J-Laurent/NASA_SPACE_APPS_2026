import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { feature, mesh } from 'topojson-client';
import world from 'world-atlas/countries-50m.json';
import * as P from './palette.js';
import { regionName, regionFeatures, regionList, initRegions, countryByName, stateBorderLines } from './regions.js';
import { circleGeometry, cellsInside, domainCells, regionalSeries, trendOf } from './regionstats.js';
import { geoCentroid } from 'd3-geo';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// ---------- colour maps (all tunable in palette.js) ----------
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const ramp = (stops) => {
  const s = stops.map(([t, c]) => [t, hex(c)]);
  const first = s[0][0], last = s[s.length - 1][0];
  return (t) => {
    t = Math.min(last, Math.max(first, t));
    for (let i = 1; i < s.length; i++) {
      if (t <= s[i][0]) {
        const f = (t - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
        return s[i - 1][1].map((v, k) => v + (s[i][1][k] - v) * f);
      }
    }
    return s[s.length - 1][1];
  };
};
const DIVERGING = ramp(P.DIVERGING_STOPS);     // t in 0..1, 0.5 = no change
const SIGRAMP = ramp(P.SIGNIFICANCE_STOPS);    // t = -log10(p) / 3
const SEQUENTIAL = ramp(P.SEQUENTIAL_STOPS);
const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
// 0 where p >= SIG_P_HIGH (no evidence), 1 where p <= SIG_P_LOW, smooth in between. logp = -log10(p)
const sigWeight = (logp) => smooth((logp + Math.log10(P.SIG_P_HIGH)) / (Math.log10(P.SIG_P_HIGH) - Math.log10(P.SIG_P_LOW)));

// ---------- state ----------
let manifest, vars = {}, combined;
let mode = 'combined';
let colorBy = 'fade'; // 'fade' | 'rate' | 'sig'
let interp = true; // show interpolated cells (default); false = observed data only
let selected = null; // {lat, lon}; null = global overview
let userLoc = null; // {lat, lon} if the visitor allowed location access (kept in memory only)
let baseStyle = 'satellite'; // 'satellite' | 'plain'
let baseImg, maskImg; // pre-rendered 8192x4096 base map and 4096x2048 land mask (built in preprocessing/basemap.py)
const LAYER_COLORS = {};

const $ = (id) => document.getElementById(id);

const DATA_FORMAT = 2; // must match "format" in manifest.json (written by preprocessing/pipeline.py)
async function loadBin(name, expectedFloats) {
  // ?v= makes the URL change whenever the data is rebuilt, and no-cache forces revalidation, so a stale cached copy is never used
  const r = await fetch(`/data/${name}.bin?v=${manifest.data_version || 0}`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${name}.bin: HTTP ${r.status}`);
  const a = new Float32Array(await r.arrayBuffer());
  if (expectedFloats && a.length !== expectedFloats) throw new Error(`${name}.bin has ${a.length} values but ${expectedFloats} were expected: the data files are out of date`);
  return a;
}

function dataMissing(err) {
  document.body.insertAdjacentHTML('beforeend', `<div id="nodata"><div><h2>The data files are missing or out of date</h2>
    <p>This site is served from your own machine, so the processed data has to exist locally (<code>data/processed/</code>). A hosted version would serve it to every visitor, so visitors would not have to download anything.</p>
    <p>To build it locally, from the project folder run:</p>
    <pre>.venv\\Scripts\\python preprocessing\\download.py
.venv\\Scripts\\python preprocessing\\load_real.py
.venv\\Scripts\\python preprocessing\\load_earthdata.py
.venv\\Scripts\\python preprocessing\\pipeline.py</pre>
    <p>then reload this page with Ctrl+F5 (a normal reload can keep an old copy). (<code>start.ps1</code> checks for this and prints the same steps. The Earthdata step needs a free NASA login.)</p>
    <p style="color:#93a0bd">Details: ${String(err)}</p></div></div>`);
}

async function init() {
  try { await initApp(); } catch (e) { console.error(e); dataMissing(e); } // any failure while loading data: say so instead of showing a dead page
}

async function initApp() {
  try {
    const r = await fetch('/data/manifest.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status}`);
    manifest = await r.json();
    if (manifest.format !== DATA_FORMAT) throw new Error(`data format ${manifest.format ?? 1}, but this version of the site needs format ${DATA_FORMAT}: re-run preprocessing/pipeline.py`);
  } catch (e) { dataMissing(e); return; }
  const { nlat, nlon, n_years } = manifest;
  const N = nlat * nlon;
  for (const v of manifest.variables) {
    const a = await loadBin(v.id, (5 + n_years) * N);
    vars[v.id] = { ...v, t0: manifest.start_year + n_years - v.trend_years, slope: a.subarray(0, N), z: a.subarray(N, 2 * N), p: a.subarray(2 * N, 3 * N), filled: a.subarray(3 * N, 4 * N), annual: a.subarray(4 * N, 4 * N + n_years * N), q: a.subarray(4 * N + n_years * N, 5 * N + n_years * N) };
  }
  [baseImg, maskImg] = await Promise.all([loadImg('/data/' + manifest.basemap_file), loadImg('/data/' + manifest.mask_file)]);
  prepareMask();
  prepareDomains();
  const marine = await fetch('/data/marine.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  initRegions(marine); regionsAll = regionList();
  const c = await loadBin('combined', 7 * N);
  combined = { score: c.subarray(0, N), nsig: c.subarray(N, 2 * N), nvalid: c.subarray(2 * N, 3 * N), scoreObs: c.subarray(3 * N, 4 * N), nvalidObs: c.subarray(4 * N, 5 * N), nfilled: c.subarray(5 * N, 6 * N), nsigRaw: c.subarray(6 * N, 7 * N) };
  // stretch combined score between its 2nd and 98th percentile so hot-spots stand out
  const vals = Array.from(combined.score).filter((x) => !isNaN(x)).sort((a, b) => a - b);
  combined.lo = vals[Math.floor(vals.length * 0.02)];
  combined.hi = vals[Math.floor(vals.length * 0.98)];

  $('banner').hidden = !manifest.synthetic;
  $('method').innerHTML = methodHTML();
  const q = new URLSearchParams(location.search); // optional: ?layer=temp&colorBy=sig&base=plain&lat=20&lon=30&spin=0
  if (q.get('colorBy')) { colorBy = q.get('colorBy'); }
  if (q.get('base') === 'plain') baseStyle = 'plain';
  buildUI();
  buildGlobe();
  if (q.get('spin') === '0') { controls.autoRotate = false; $('spin').checked = false; }
  if (q.get('lat')) camera.position.copy(toVec(+q.get('lat'), +q.get('lon') || 0, +q.get('dist') || 2.6));
  $('colorBy').value = colorBy; $('baseMap').value = baseStyle;
  setMode(vars[q.get('layer')] ? q.get('layer') : 'combined');
  if (q.get('demo')) runDemo(DEMOS[+q.get('demo') - 1]); // e.g. ?demo=2
  if (q.get('menu')) { if (q.get('lat')) select(+q.get('lat'), +q.get('lon') || 0); window.__regionMenu(); }
  if (q.get('tool') === 'region') setTool('region');
  if (q.get('region') && q.get('lat')) { select(+q.get('lat'), +q.get('lon') || 0); regionKind = q.get('region') === 'circle' ? 'circle' : 'auto'; regionKm = +q.get('km') || 1000; window.__region(); } // e.g. ?region=country&lat=40&lon=-3
}

// ---------- grid sampling ----------
function sample(arr, lat, lon) {
  const { nlat, nlon, res } = manifest;
  const fi = (lat + 90) / res - 0.5, fj = (lon + 180) / res - 0.5;
  const i0 = Math.floor(fi), j0 = Math.floor(fj);
  const ti = fi - i0, tj = fj - j0;
  let sum = 0, wsum = 0, nearest = NaN, best = -1;
  for (let di = 0; di < 2; di++) {
    for (let dj = 0; dj < 2; dj++) {
      const i = Math.min(nlat - 1, Math.max(0, i0 + di));
      const j = (((j0 + dj) % nlon) + nlon) % nlon;
      const w = (di ? ti : 1 - ti) * (dj ? tj : 1 - tj);
      const v = arr[i * nlon + j];
      if (w > best) { best = w; nearest = v; }
      if (!isNaN(v)) { sum += v * w; wsum += w; }
    }
  }
  if (isNaN(nearest)) return NaN;      // nearest cell has no data: stay honest, leave a gap
  return sum / wsum;                    // bilinear over valid neighbours
}
const cellIndex = (lat, lon) => {
  const { nlat, nlon, res } = manifest;
  const i = Math.min(nlat - 1, Math.max(0, Math.floor((lat + 90) / res)));
  const j = Math.min(nlon - 1, Math.max(0, Math.floor((lon + 180) / res)));
  return i * nlon + j;
};

// ---------- overlay: data colours only (the base map is a pre-rendered image; the GPU composites them) ----------
const TW = 2048, TH = 1024; // overlay resolution: plenty for a 2-degree data grid, and cheap to repaint
const overlayData = new Uint8Array(TW * TH * 4), veilData = new Uint8Array(TW * TH * 2);
const tlSn = new Float32Array(TW * TH), tlA = new Uint8Array(TW * TH); // timeline cache: slope / typical slope, and opacity, per pixel
let overlayTex, veilTex, globeMat;
const loadImg = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });

// Land mask statistics per overlay pixel, derived from the high-res mask: mean land fraction, and a 3x3-dilated max/min,
// so data colours reach just past the coast and the shader then clips them exactly to the real coastline.
let maskMean, maskMax, maskMin;
function prepareMask() {
  const MW = maskImg.width, MH = maskImg.height, f = MW / TW;
  const c = document.createElement('canvas'); c.width = MW; c.height = MH;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(maskImg, 0, 0);
  const px = g.getImageData(0, 0, MW, MH).data;
  maskMean = new Float32Array(TW * TH); const mx = new Uint8Array(TW * TH), mn = new Uint8Array(TW * TH).fill(255);
  for (let y = 0; y < MH; y++) {
    const ty = Math.floor(y / f);
    for (let x = 0; x < MW; x++) {
      const v = px[(y * MW + x) * 4], t = ty * TW + Math.floor(x / f);
      maskMean[t] += v; if (v > mx[t]) mx[t] = v; if (v < mn[t]) mn[t] = v;
    }
  }
  for (let t = 0; t < TW * TH; t++) maskMean[t] /= f * f * 255;
  maskMax = new Uint8Array(TW * TH); maskMin = new Uint8Array(TW * TH);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
    let hi = 0, lo = 255;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = Math.min(TH - 1, Math.max(0, y + dy)), xx = (x + dx + TW) % TW, t = yy * TW + xx;
      if (mx[t] > hi) hi = mx[t]; if (mn[t] < lo) lo = mn[t];
    }
    maskMax[y * TW + x] = hi; maskMin[y * TW + x] = lo;
  }
}

// Coastline fitting: land-only / ocean-only layers are clipped to the real coastline (high-res mask).
// Cells that are mostly outside a layer's domain but contain a sliver of it (e.g. a coastal "ocean" cell with some land)
// borrow the value of the nearest valid neighbour, so the colour reaches the coast without leaving blocky gaps.
const NEAR = [];
for (let di = -3; di <= 3; di++) for (let dj = -3; dj <= 3; dj++) if ((di || dj) && Math.hypot(di, dj) <= 3) NEAR.push([di, dj]);
NEAR.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));

function prepareDomains() {
  const { nlat, nlon, res } = manifest;
  const N = nlat * nlon, landFrac = new Float32Array(N), cnt = new Float32Array(N);
  for (let py = 0; py < TH; py++) {
    const i = Math.min(nlat - 1, Math.floor(((90 - ((py + 0.5) / TH) * 180) + 90) / res));
    for (let px = 0; px < TW; px++) {
      const j = Math.min(nlon - 1, Math.floor((((px + 0.5) / TW) * 360) / res));
      landFrac[i * nlon + j] += maskMean[py * TW + px]; cnt[i * nlon + j]++;
    }
  }
  for (let c = 0; c < N; c++) landFrac[c] /= cnt[c] || 1;
  for (const v of Object.values(vars)) {
    const eff = new Int32Array(N).fill(-1), ext = new Float32Array(N).fill(NaN), extLogP = new Float32Array(N).fill(NaN), extLogQ = new Float32Array(N).fill(NaN);
    for (let i = 0; i < nlat; i++) {
      for (let j = 0; j < nlon; j++) {
        const c = i * nlon + j;
        if (!isNaN(v.slope[c])) { eff[c] = c; continue; }
        const inFrac = v.domain === 'land' ? landFrac[c] : v.domain === 'ocean' ? 1 - landFrac[c] : 1;
        if (inFrac <= 0.02 || inFrac >= 0.5) continue; // true data gap, or no domain pixels here
        for (const [di, dj] of NEAR) { // nearest valid cell within ~3 cells (6 degrees)
          const ii = i + di, jj = (j + dj + nlon) % nlon;
          if (ii < 0 || ii >= nlat) continue;
          const n = ii * nlon + jj;
          if (!isNaN(v.slope[n])) { eff[c] = n; break; }
        }
      }
    }
    for (let c = 0; c < N; c++) {
      if (eff[c] < 0) continue;
      ext[c] = v.slope[eff[c]]; extLogP[c] = -Math.log10(Math.max(v.p[eff[c]], 1e-12)); extLogQ[c] = -Math.log10(Math.max(v.q[eff[c]], 1e-12));
    }
    v.eff = eff; v.ext = ext; v.extLogP = extLogP; v.extLogQ = extLogQ;
  }
}

const mix = (a, b, t) => a.map((x, k) => x * (1 - t) + b[k] * t);

function paint() {
  const v = mode === 'combined' ? null : vars[mode];
  for (let py = 0; py < TH; py++) {
    const lat = 90 - ((py + 0.5) / TH) * 180, row = (TH - 1 - py) * TW; // texture row 0 is the south pole
    for (let px = 0; px < TW; px++) {
      const lon = ((px + 0.5) / TW) * 360 - 180;
      const q = py * TW + px, o = (row + px) * 4;
      const ci = cellIndex(lat, lon);
      tlA[q] = 0;
      let col = null, a = 0, veil = 0, fillFlag = 0;
      if (v) {
        const inside = v.domain === 'land' ? maskMax[q] > 0 : v.domain === 'ocean' ? maskMin[q] < 255 : true;
        if (inside) {
          const e = v.eff[ci], isFilled = e >= 0 && v.filled[e] === 1;
          const s = e >= 0 ? sample(v.ext, lat, lon) : NaN;
          if (isNaN(s) || (!interp && isFilled)) veil = 1;
          else {
            const lp = sample(corrected ? v.extLogQ : v.extLogP, lat, lon);
            tlSn[q] = s / v.slope_p98; tlA[q] = Math.round(P.OVERLAY_ALPHA * (colorBy === 'rate' ? 1 : sigWeight(lp)) * 255);
            if (colorBy === 'sig') { col = SIGRAMP(lp / 3); a = P.OVERLAY_ALPHA; }
            else {
              col = DIVERGING(0.5 + (0.5 * s) / v.slope_p98);
              a = P.OVERLAY_ALPHA * (colorBy === 'fade' ? sigWeight(lp) : 1); // not significant -> see-through
            }
            if (isFilled) fillFlag = 1; // drawn striped by the shader
          }
        }
      } else {
        const sc = sample(interp ? combined.score : combined.scoreObs, lat, lon);
        if (isNaN(sc)) veil = 1;
        else {
          col = SEQUENTIAL((sc - combined.lo) / (combined.hi - combined.lo)); a = P.OVERLAY_ALPHA;
          if (interp && combined.nfilled[ci] > 0) fillFlag = 1;
        }
      }
      if (col) { overlayData[o] = col[0] * a; overlayData[o + 1] = col[1] * a; overlayData[o + 2] = col[2] * a; overlayData[o + 3] = a * 255; } // premultiplied
      else { overlayData[o] = overlayData[o + 1] = overlayData[o + 2] = overlayData[o + 3] = 0; }
      veilData[(row + px) * 2] = veil * 255; veilData[(row + px) * 2 + 1] = fillFlag * 255;
    }
  }
  if (overlayTex) {
    overlayTex.needsUpdate = true; veilTex.needsUpdate = true;
    const u = globeMat.uniforms;
    u.uDomain.value = !v ? 0 : v.domain === 'land' ? 1 : v.domain === 'ocean' ? -1 : 0;
    u.uPlain.value = baseStyle === 'plain' ? 1 : 0;
  }
  applyTimeline(); // no-op unless the timeline is on
}

// ---------- globe ----------
let scene, camera, renderer, controls, globe, userMarker, anim = null;
const markers = []; // one pin per selected place
const R = 1;

const toVec = (lat, lon, r = R) => {
  const phi = ((lon + 180) / 360) * 2 * Math.PI, th = ((90 - lat) * Math.PI) / 180;
  return new THREE.Vector3(-Math.cos(phi) * Math.sin(th) * r, Math.cos(th) * r, Math.sin(phi) * Math.sin(th) * r);
};

function buildGlobe() {
  const el = $('globe');
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 100);
  camera.position.copy(toVec(20, 20, 3.2));
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  el.appendChild(renderer.domElement);

  const imgTex = (img, aniso) => { const t = new THREE.Texture(img); t.colorSpace = THREE.NoColorSpace; t.anisotropy = aniso; t.needsUpdate = true; return t; };
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const dataTex = (arr, fmt) => { const t = new THREE.DataTexture(arr, TW, TH, fmt); t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true; return t; };
  overlayTex = dataTex(overlayData, THREE.RGBAFormat); veilTex = dataTex(veilData, THREE.RGFormat); // veil: R = no data, G = interpolated
  const rgb = (a) => new THREE.Vector3(a[0] / 255, a[1] / 255, a[2] / 255);
  globeMat = new THREE.ShaderMaterial({
    uniforms: {
      uBase: { value: imgTex(baseImg, maxAniso) }, uMask: { value: imgTex(maskImg, maxAniso) }, uOverlay: { value: overlayTex }, uVeil: { value: veilTex },
      uDomain: { value: 0 }, uPlain: { value: 0 }, uGamma: { value: P.SAT_BRIGHTNESS_GAMMA }, uSat: { value: P.SAT_SATURATION },
      uVeilDark: { value: P.NO_DATA_DARKEN }, uVeilDesat: { value: P.NO_DATA_DESATURATE }, uPlainLand: { value: rgb(P.PLAIN_LAND) }, uPlainOcean: { value: rgb(P.PLAIN_OCEAN) },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D uBase, uMask, uOverlay, uVeil;
      uniform float uDomain, uPlain, uGamma, uSat, uVeilDark, uVeilDesat;
      uniform vec3 uPlainLand, uPlainOcean;
      void main(){
        vec3 c = texture2D(uBase, vUv).rgb;
        float m = texture2D(uMask, vUv).r;
        if (uPlain > 0.5) c = mix(uPlainOcean, uPlainLand, m);
        else { // brighten / saturate the satellite land colours (ocean untouched)
          float l = dot(c, vec3(.3,.59,.11));
          vec3 adj = pow(max(vec3(l) + (c - vec3(l)) * uSat, 0.), vec3(uGamma));
          c = mix(c, adj, m);
        }
        float w = uDomain > 0.5 ? m : (uDomain < -0.5 ? 1. - m : 1.);   // clip land-only / ocean-only data to the true coastline
        vec2 vf = texture2D(uVeil, vUv).rg;
        float v = vf.r * w;                                              // no data: grey out and darken
        float lum = dot(c, vec3(.3,.59,.11));
        c = (c + (vec3(lum) - c) * uVeilDesat * v) * (1. - uVeilDark * v);
        vec4 o = texture2D(uOverlay, vUv);                               // premultiplied data colour
        if (vf.g > 0.5) { // interpolated: diagonal stripes fixed to the ground, equal width everywhere (equal-area sinusoidal coordinates: no stretching at the poles)
          float la = (vUv.y - .5) * 3.14159265, lo = (vUv.x - .5) * 6.2831853;
          float t = (lo * cos(la) + la) / .026, f = fract(t), aa = clamp(fwidth(t), 0., .5);
          float s = 1. - smoothstep(.5 - aa, .5 + aa, f);
          s = mix(s, .5, clamp(aa * 2., 0., 1.));
          o.rgb = mix(o.rgb, vec3(o.a), .3 * s);
        }
        c = c * (1. - o.a * w) + o.rgb * w;
        gl_FragColor = vec4(c, 1.);
      }`,
  });
  globe = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 64), globeMat);
  scene.add(globe);

  // country borders as crisp vector lines (sharp at any zoom, unlike a texture)
  const pts = [];
  for (const line of mesh(world, world.objects.countries).coordinates) {
    for (let k = 1; k < line.length; k++) {
      const a = toVec(line[k - 1][1], line[k - 1][0], R * 1.0007), b = toVec(line[k][1], line[k][0], R * 1.0007);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(bg, new THREE.LineBasicMaterial({ color: P.BORDER_COLOR, transparent: true, opacity: P.BORDER_OPACITY, depthWrite: false })));

  // atmosphere rim
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(R * 1.03, 64, 32), new THREE.ShaderMaterial({
    transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: 'varying vec3 n; void main(){ n = normalize(normalMatrix*normal); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: 'varying vec3 n; void main(){ float i = pow(0.62 - dot(n, vec3(0.,0.,1.)), 3.); gl_FragColor = vec4(0.35,0.6,1.0,1.0)*i; }',
  })));

  // stars
  const sp = new Float32Array(1500 * 3);
  for (let i = 0; i < sp.length; i += 3) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(30 + Math.random() * 20);
    sp.set([v.x, v.y, v.z], i);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ size: 0.08, color: 0x9fb2d8 })));

  userMarker = new THREE.Mesh(new THREE.SphereGeometry(0.014, 16, 16), new THREE.MeshBasicMaterial({ color: 0x38e1ff }));
  userMarker.visible = false;
  scene.add(userMarker);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.4;
  controls.maxDistance = 6;
  controls.autoRotateSpeed = 0.5;
  controls.autoRotate = $('spin').checked;
  controls.addEventListener('start', () => { anim = null; controls.autoRotate = $('spin').checked; }); // dragging resumes spinning

  // click (not drag) to select
  const ray = new THREE.Raycaster();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
    const hit = ray.intersectObject(globe)[0];
    if (hit) { const la = hit.uv.y * 180 - 90, lo = hit.uv.x * 360 - 180; if (clickTool === 'region') regionAt(la, lo); else select(la, lo); }
    else showOverview(); // clicked off the globe
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  renderer.setAnimationLoop(() => {
    if (anim) stepAnim();
    controls.update();
    renderer.render(scene, camera);
  });
}

function flyTo(lat, lon, dist = 2.4, dir = null) {
  const target = dir ? dir.clone().multiplyScalar(dist) : toVec(lat, lon, dist);
  anim = { from: camera.position.clone(), to: target, t: 0 };
  controls.autoRotate = false;
}
function stepAnim() {
  anim.t = Math.min(1, anim.t + 0.02);
  const e = anim.t * anim.t * (3 - 2 * anim.t);
  const d = anim.from.length() + (anim.to.length() - anim.from.length()) * e;
  camera.position.copy(anim.from).normalize().lerp(anim.to.clone().normalize(), e).normalize().multiplyScalar(d);
  if (anim.t >= 1) anim = null;
}

// ---------- UI ----------
function buildUI() {
  const L = $('layers');
  const mk = (id, label, cls = '') => {
    const b = document.createElement('button');
    b.className = `layer ${cls}`; b.textContent = label; b.dataset.id = id;
    b.onclick = () => { if (!region) selected = null; setMode(id); if (userLoc && !region) select(userLoc.lat, userLoc.lon); }; // a region stays while you switch layers
    L.appendChild(b);
  };
  mk('combined', '★ Combined: where is Earth changing most?', 'combined');
  for (const v of manifest.variables) mk(v.id, v.name);
  $('baseMap').onchange = (e) => { baseStyle = e.target.value; paint(); };
  $('sigMode').onchange = (e) => { corrected = e.target.value === 'fdr'; for (const k of Object.keys(globalCache)) delete globalCache[k]; setMode(mode); };
  $('colorBy').onchange = (e) => { colorBy = e.target.value; setMode(mode); };
  $('observedOnly').onchange = (e) => { interp = !e.target.checked; setMode(mode); };
  $('spin').onchange = (e) => { controls.autoRotate = e.target.checked; if (e.target.checked) anim = null; };
  $('close').onclick = showOverview;
  $('locate').onclick = locate;
  buildTimelineUI();
  $('toolPoint').onclick = () => { setTool('point'); closeRegionMenu(); };
  $('toolRegion').onclick = () => { setTool('region'); closeRegionMenu(); };
  $('regionType').onclick = () => { const m = $('regionMenu'); if (m.hidden) openRegionMenu(); else closeRegionMenu(); };
  $('gear').onclick = () => { const o = $('settings').hidden; $('settings').hidden = !o; $('gear').setAttribute('aria-expanded', o); };
  $('search').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase(); let n = 0;
    document.querySelectorAll('#layers .layer').forEach((b) => { const ok = b.classList.contains('combined') || b.textContent.toLowerCase().includes(q); b.hidden = !ok; if (ok && !b.classList.contains('combined')) n++; });
    $('noMatch').hidden = n > 0 || !q;
  };

  for (const d of DEMOS) {
    const b = document.createElement('button');
    b.className = 'demo'; b.textContent = d.title;
    b.onclick = () => runDemo(d);
    $('demos').appendChild(b);
  }
}

function setMode(id) {
  mode = id;
  if (timeline.on && id === 'combined') { timeline.on = false; timeline.playing = false; $('tlBtn').classList.remove('on'); $('timeline').hidden = true; } // the timeline needs a single layer
  document.querySelectorAll('.layer').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  paint();
  if (id === 'combined') {
    $('about').innerHTML = `<b>Combined change score</b><br>For each place, every variable's trend strength is ranked from 0 to 1, then averaged across the variables measured there. Bright = many/strong trends; dark = little change. Direction is ignored, so a warming place and a drying place both count as "changing".`;
    legend(SEQUENTIAL, 'Less change', 'More change', 'Combined change score');
  } else {
    const v = vars[id];
    $('about').innerHTML = `<b>${v.name}</b> (${v.unit})<br>${v.about}<br><span style="color:#93a0bd">Source: ${v.source}. ${(corrected ? v.pct_significant_fdr : v.pct_significant).toFixed(0)}% of mapped cells have a significant trend${corrected ? ' (after correction for testing many places)' : ''}.</span>`;
    if (colorBy === 'sig') legend(SIGRAMP, `${corrected ? 'q' : 'p'} = 1 (no evidence of a trend)`, `${corrected ? 'q' : 'p'} ≤ 0.001 (very strong)`, corrected ? 'Significance of the trend (adjusted for testing many places)' : 'Significance of the trend (uncorrected p)');
    else legend(DIVERGING, `−${v.slope_p98.toPrecision(2)} ${v.unit}/yr`, `+${v.slope_p98.toPrecision(2)} ${v.unit}/yr`,
      colorBy === 'fade' ? 'Rate of change: falling → rising (see-through where the trend is not significant)' : 'Rate of change (falling → rising)');
  }
  if (timeline.on && id !== 'combined') timelineLegend();
  interpNotice();
  if (region) showRegion(); else if (places.length) showPlaces(places, { overview: showOv }); else showOverview();
}

function interpNotice() {
  const el = $('interpWarn');
  let n, total, label;
  if (mode === 'combined') {
    n = 0; total = 0;
    for (let c = 0; c < combined.score.length; c++) if (!isNaN(combined.score[c])) { total++; if (combined.nfilled[c] > 0) n++; }
    label = 'combined cells';
  } else { n = vars[mode].n_filled; total = vars[mode].n_cells; label = 'cells in this layer'; }
  el.hidden = false;
  if (!interp) {
    el.className = 'off';
    el.innerHTML = `Showing <b>observed data only</b>. ${n} ${label} that would be interpolated are shown as gaps.`;
  } else if (n > 0) {
    el.className = '';
    el.innerHTML = `⚠ <b>${n} of ${total}</b> ${label} (${((100 * n) / total).toFixed(1)}%) are <b>interpolated</b> from neighbouring cells (shown striped). Gaps larger than ${manifest.max_hole} cells are never filled. Tick &ldquo;Observed data only&rdquo; to see true gaps.`;
  } else {
    el.className = '';
    el.innerHTML = 'No interpolated cells in this layer.';
  }
}

function legend(fn, lo, hi, title) {
  const el = $('legend');
  el.innerHTML = `<div>${title}</div><canvas width="256" height="1"></canvas><div class="ends"><span>${lo}</span><span>${hi}</span></div>`;
  const c = el.querySelector('canvas').getContext('2d');
  for (let x = 0; x < 256; x++) { const [r, g, b] = fn(x / 255); c.fillStyle = `rgb(${r},${g},${b})`; c.fillRect(x, 0, 1, 1); }
}

// ---------- explanations (details live on Wikipedia) ----------
const WIKI = 'https://en.wikipedia.org/wiki/';
const wl = (slug, text) => `<a href="${WIKI}${slug}" target="_blank" rel="noopener">${text}</a>`;
function methodHTML() {
  return `
    <p><b>Rate of change.</b> The ${wl('Seasonality', 'seasonal cycle')} is removed from the monthly data, then the rate is the
    ${wl('Theil%E2%80%93Sen_estimator', 'Theil-Sen slope')} (a robust line fit), in units per year.</p>
    <p><b>Is it significant?</b> A ${wl('Kendall_rank_correlation_coefficient', 'Mann-Kendall trend test')} with the Hamed-Rao correction for
    ${wl('Autocorrelation', 'autocorrelation')} gives a ${wl('P-value', 'p-value')}. Below ${manifest.alpha} the trend is called
    ${wl('Statistical_significance', 'statistically significant')}. Because thousands of cells are tested, about 1 in 20 would look significant by chance, so the p-values are also adjusted for the ${wl('False_discovery_rate', 'false discovery rate')} (Benjamini-Hochberg, giving a q-value; see ${wl('Multiple_comparisons_problem', 'the multiple comparisons problem')}). “Significant” on the map and in the tables means q &lt; ${manifest.alpha}; switch to plain p in Settings to compare. The faded colour scale shades smoothly from p = 0.1 (not significant) to p = 0.01 (strongly significant).</p>
    <p><b>Combined score.</b> Each variable's trend strength is converted to a ${wl('Percentile_rank', 'percentile rank')} so different units can be averaged;
    the score is the mean over variables measured at that place (at least 2). Temperature is land-only and sea surface temperature ocean-only so the oceans aren't counted twice.</p>
    <p><b>Interpolation.</b> Small holes (up to ${manifest.max_hole} cells) surrounded by data are filled by ${wl('Inverse_distance_weighting', 'inverse-distance weighting')}; larger gaps are never filled.</p>
    <p><b>Timeline and projection.</b> The timeline animates the trend building up since the start of the record. Years after ${lastObs()} extend each place's straight-line trend forward, with the 95% confidence range widening as it goes. This is <i>not</i> a forecast: it shows what would happen if the recent rate simply continued. Real trends can speed up, slow down or reverse, 30 years is a short record, and natural cycles such as ${wl('El_Ni%C3%B1o%E2%80%93Southern_Oscillation', 'El Niño')} add variation, so the look-ahead is capped at 25 years. See ${wl('Extrapolation', 'extrapolation')}.</p>
    <p><b>Data.</b> NASA GISS GISTEMP, NOAA GPCP and ERSST, and NASA MERRA-2 (an ${wl('Atmospheric_reanalysis', 'atmospheric reanalysis')}).</p>`;
}

// ---------- significance (corrected for testing thousands of cells, or plain p) and the trend table / combined chart ----------
let corrected = true; // true: a cell is significant when its false-discovery-rate adjusted p (q) < 0.05; false: plain p < 0.05
const sigVal = (v, c) => (corrected ? v.q[c] : v.p[c]);
const isSig = (v, c) => sigVal(v, c) < manifest.alpha;
const nSigAt = (c) => (corrected ? combined.nsig[c] : combined.nsigRaw[c]);
const VAR_COLORS = ['#f4a261', '#2ec4b6', '#e9c46a', '#8ab4ff', '#e76f51', '#b5e48c', '#d291bc', '#90e0ef', '#ffd166'];
const varColor = (id) => VAR_COLORS[Object.keys(vars).indexOf(id) % VAR_COLORS.length];

// rows: [{v, slope, rateHtml, sv (the p or q shown), sig, filled}]  -> a table sorted by strength of evidence, non-significant rows greyed
function trendTable(rows, sigHeader) {
  rows = [...rows].sort((a, b) => a.sv - b.sv);
  let html = `<table class="tt"><tr><th>Variable</th><th class="num">Rate / yr</th><th title="size of the trend relative to the 98th-percentile trend of that variable">Size</th><th class="num">${sigHeader}</th></tr>`;
  for (const r of rows) {
    const dir = r.sig ? (r.slope > 0 ? 'up' : 'dn') : 'na', w = Math.min(100, (Math.abs(r.slope) / r.v.slope_p98) * 100);
    html += `<tr class="${r.sig ? '' : 'dim'}"><td><span class="sw" style="background:${varColor(r.v.id)}"></span>${r.v.name}${r.filled ? ' <span class="interp" title="interpolated">(interp.)</span>' : ''}</td>
      <td class="num ${dir}">${r.rateHtml}</td><td><span class="rb"><i class="${dir}" style="width:${w}%"></i></span></td><td class="num">${pTxt(r.sv)}</td></tr>`;
  }
  return html + '</table>';
}
const emptyRows = (names) => names.map((n) => `<tr class="dim"><td>${n}</td><td class="num" colspan="3" style="color:#93a0bd">no data</td></tr>`).join('');

// One chart for all variables at a place or region: each yearly series is standardised (0 = its own average, 1 = one standard
// deviation) so different units share an axis. Significant trends are bold and coloured; the rest are thin and faint.
function multiChart(c, series) {
  const { n_years, start_year } = manifest;
  const z = series.map((s) => {
    const v = s.ys.filter((y) => !isNaN(y)), m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
    return { ...s, z: s.ys.map((y) => (y - m) / sd) };
  });
  const all = z.flatMap((s) => s.z.filter((y) => !isNaN(y)));
  const lim = Math.max(2, Math.ceil(Math.max(...all.map(Math.abs)) * 2) / 2);
  const g = c.getContext('2d'), W = c.width, H = c.height, m = { l: 40, r: 12, t: 12, b: 28 };
  const X = (k) => m.l + (k / (n_years - 1)) * (W - m.l - m.r), Y = (y) => m.t + ((lim - y) / (2 * lim)) * (H - m.t - m.b);
  g.fillStyle = '#93a0bd'; g.font = '16px system-ui'; g.strokeStyle = '#26324f'; g.lineWidth = 1;
  for (const y of [-lim, 0, lim]) { g.beginPath(); g.moveTo(m.l, Y(y)); g.lineTo(W - m.r, Y(y)); g.stroke(); g.fillText((y > 0 ? '+' : '') + y, 6, Y(y) + 5); }
  for (let k = 0; k < n_years; k += 5) g.fillText(start_year + k, X(k) - 18, H - 8);
  for (const pass of [false, true]) { // faint ones underneath, significant ones on top
    for (const s of z) {
      if (s.sig !== pass) continue;
      g.strokeStyle = s.color; g.globalAlpha = s.sig ? 1 : 0.4; g.lineWidth = s.sig ? 3 : 1.5; g.beginPath();
      let pen = false;
      s.z.forEach((y, k) => { if (isNaN(y)) return; if (!pen) { g.moveTo(X(k), Y(y)); pen = true; } else g.lineTo(X(k), Y(y)); });
      g.stroke();
    }
  }
  g.globalAlpha = 1;
}
const MULTI_CAPTION = `<div class="hint">All variables on one scale (each standardised: 0 = its own average, ±1 = one standard deviation). Bold, coloured lines have a significant trend; thin faint lines do not. Colours match the table.</div>`;

// ---------- detail panel ----------
const fmt = (x, d = 3) => (Math.abs(x) < 0.001 && x !== 0 ? x.toExponential(1) : x.toFixed(d));
const pTxt = (p) => (p < 0.001 ? '<0.001' : p.toFixed(3));

const MARKER_COLORS = ['#ffb454', '#a3e635'];
let places = [], showOv = false; // places currently pinned on the globe; showOv = keep the global overview above them

// One pinned place: region name, coordinates, verdict, chart. Returns {html, draw}.
function placeHTML(lat, lon, k) {
  const idx = cellIndex(lat, lon), ns = lat >= 0 ? 'N' : 'S', ew = lon >= 0 ? 'E' : 'W';
  const reg = regionName(lat, lon);
  const dot = places.length > 1 ? `<span class="dot" style="background:${MARKER_COLORS[k % MARKER_COLORS.length]}"></span>` : '';
  let html = `<div class="place"><div class="region">${dot}${reg.name}</div><div class="coord">${Math.abs(lat).toFixed(1)}°${ns}, ${Math.abs(lon).toFixed(1)}°${ew}</div>`;
  let draw = null;

  if (mode === 'combined') {
    const s = combined.score[idx];
    if (isNaN(s)) html += `<div class="verdict none">Not enough data here (need at least 2 variables).</div>`;
    else html += `<div class="verdict none">Combined change score: <b>${s.toFixed(2)}</b> (0–1).<br>${nSigAt(idx)} of ${combined.nvalid[idx]} variables show a significant trend${corrected ? ' (after correction)' : ''}.</div>`;
    if (combined.nfilled[idx] > 0) html += `<div class="interpbox">▨ <b>This zone includes interpolated data</b> (that is why it is striped): ${combined.nfilled[idx]} of ${combined.nvalid[idx]} variables here were estimated from surrounding cells rather than measured directly. They are marked “(interp.)” below.</div>`;
    const rows = [], miss = [], series = [];
    for (const v of Object.values(vars)) {
      const j = v.eff[idx] >= 0 ? v.eff[idx] : idx;
      if (isNaN(v.p[j])) { miss.push(v.name); continue; }
      const sig = isSig(v, j);
      rows.push({ v, slope: v.slope[j], rateHtml: `${v.slope[j] > 0 ? '+' : ''}${fmt(v.slope[j])} ${v.unit}`, sv: sigVal(v, j), sig, filled: v.filled[j] === 1 });
      const { nlat, nlon, n_years } = manifest, N = nlat * nlon;
      series.push({ name: v.name, color: varColor(v.id), sig, ys: Array.from({ length: n_years }, (_, k) => v.annual[k * N + j]) });
    }
    html += `<canvas class="chart" id="mchart${k}" width="640" height="340"></canvas>${MULTI_CAPTION}`;
    html += trendTable(rows, corrected ? 'q' : 'p').replace('</table>', emptyRows(miss) + '</table>');
    html += `<p style="color:#93a0bd;font-size:12px">${corrected ? 'q = p-value adjusted for testing thousands of places' : 'p = plain p-value'}; colour = significant, grey = not. Pick a layer on the left for one variable's detail.</p></div>`;
    draw = () => multiChart($(`mchart${k}`), series);
    return { html, draw };
  }

  const v = vars[mode], i = v.eff[idx] >= 0 ? v.eff[idx] : idx, p = v.p[i], slope = v.slope[i];
  if (isNaN(p)) return { html: html + `<div class="verdict none">No ${v.name.toLowerCase()} data at this location.</div></div>`, draw };
  const sig = isSig(v, i);
  const total = slope * (v.trend_years - 1);
  if (v.filled[i] === 1) html += `<div class="interpbox">▨ <b>This zone is interpolated</b> (that is why it is drawn with stripes). It has no direct ${v.name.toLowerCase()} measurement of its own, so its value is estimated from the surrounding cells by <a href="${WIKI}Inverse_distance_weighting" target="_blank" rel="noopener">inverse-distance weighting</a>. Treat it as less certain than observed cells.</div>`;
  html += `<div class="verdict ${sig ? 'sig' : 'nosig'}">${sig ? '<b>Significant trend.</b>' : '<b>Not significant.</b>'} ${v.name} is ${slope > 0 ? 'rising' : 'falling'} by about <b>${fmt(Math.abs(slope))} ${v.unit}/yr</b> (${total > 0 ? '+' : '−'}${fmt(Math.abs(total), 2)} over ${v.trend_years} years). <a href="${WIKI}Kendall_rank_correlation_coefficient" target="_blank" rel="noopener">Mann-Kendall</a> p = ${pTxt(p)}${corrected ? `; after correcting for testing many places (<a href="${WIKI}False_discovery_rate" target="_blank" rel="noopener">false discovery rate</a>) q = ${pTxt(v.q[i])}` : ''} (Z = ${v.z[i].toFixed(2)}).${sig ? '' : ' This could be natural variability; a longer record might make it significant.'}</div>`;
  html += `<canvas class="chart" id="chart${k}" width="640" height="340"></canvas>${lookBox(`look${k}`, v, slope, cellSlopeCI(slope, v.z[i]))}</div>`;
  return { html, draw: () => chart($(`chart${k}`), v, i, slope, sig) };
}

// Pin one or more places and show their details. opts: {fly, overview, dist}
function showPlaces(list, opts = {}) {
  chartHooks.clear(); lookHooks.length = 0;
  places = list; selected = list[0] || null; showOv = !!opts.overview;
  region = null; setRegionLine(null); showStateLines(false);
  while (markers.length < list.length) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 16), new THREE.MeshBasicMaterial({ color: MARKER_COLORS[markers.length % MARKER_COLORS.length] }));
    scene.add(m); markers.push(m);
  }
  markers.forEach((m, k) => { m.visible = k < list.length; if (k < list.length) m.position.copy(toVec(list[k].lat, list[k].lon, R * 1.005)); });
  if (opts.fly) {
    const vs = list.map((p) => toVec(p.lat, p.lon, 1));
    const mid = vs.reduce((a, b) => a.add(b), new THREE.Vector3()).normalize();
    // pull back until every pin sits in the middle of the screen, clear of the side panels
    const cam = new THREE.PerspectiveCamera(camera.fov, camera.aspect, 0.1, 100);
    let dist = 2.4;
    for (; dist < 6; dist += 0.1) {
      cam.position.copy(mid).multiplyScalar(dist); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      if (vs.every((v) => { const n = v.clone().project(cam); return v.dot(mid) > 0.2 && Math.abs(n.x) < 0.42 && Math.abs(n.y) < 0.75; })) break;
    }
    flyTo(Math.asin(mid.y) * 180 / Math.PI, 0, dist, mid);
  }
  const nav = `<button class="back" onclick="window.__overview()">← Global overview</button>${userLoc ? ` · <button class="back" onclick="window.__home()">📍 My location</button>` : ''}`;
  const parts = list.map((p, k) => placeHTML(p.lat, p.lon, k));
  const head = mode === 'combined' ? 'Everything here' : vars[mode].name;
  let html = showOv ? overviewHTML() + '<hr>' : nav;
  html += `<h3>${list.length > 1 ? head + ': compare' : head}</h3>` + parts.map((x) => x.html).join('');
  if (list.length === 1 && !showOv) html += regionBoxHTML();
  if (list.length > 1 || mode !== 'combined') html += `<div style="color:#93a0bd;font-size:12px;margin-top:6px">Charts: yearly average with the fitted linear trend. Seasonal cycle removed for the trend test.</div>`;
  $('detail').innerHTML = html + (showOv ? '' : HINT_LOCAL);
  parts.forEach((x) => x.draw && x.draw());
  if (showOv && overviewDraw) overviewDraw();
}
const select = (lat, lon, fly = false) => showPlaces([{ lat, lon }], { fly });

function chart(c, v, idx, slope, sig) {
  const { nlat, nlon, n_years } = manifest, N = nlat * nlon;
  chartSeries(c, Array.from({ length: n_years }, (_, k) => v.annual[k * N + idx]), slope, sig, timeline.on ? cellSlopeCI(slope, v.z[idx]) : null);
}

// ci = {lo, hi} slopes of the 95% confidence band; icpt = Theil-Sen intercept (per year index) if known.
// While the timeline is on, the axis, trend line and band extend into the future (dashed, shaded), with a marker at the slider's year.
function chartSeries(c, ys, slope, sig, ci = null, icpt = null) {
  chartHooks.set(c, () => chartSeries(c, ys, slope, sig, ci, icpt));
  const { n_years, start_year } = manifest;
  const Hz = timeline.on ? timeline.horizon : 0, nK = n_years + Hz;
  const k0 = ys.findIndex((y) => !isNaN(y)); // some layers only have a trend window starting later in the record
  const valid = ys.filter((y) => !isNaN(y));
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const kmid = ys.reduce((a, y, k) => a + (isNaN(y) ? 0 : k), 0) / valid.length;
  const at = (sl, k) => (icpt !== null ? icpt + slope * kmid + sl * (k - kmid) : mean + sl * (k - (k0 + n_years - 1) / 2));
  const lines = [slope, ...(ci ? [ci.lo, ci.hi] : [])];
  const ends = lines.flatMap((sl) => [at(sl, k0), at(sl, nK - 1)]);
  const lo = Math.min(...valid, ...ends), hi = Math.max(...valid, ...ends), pad = (hi - lo) * 0.1 || 1;
  const g = c.getContext('2d'), W = c.width, H = c.height, m = { l: 56, r: 12, t: 12, b: 28 };
  g.clearRect(0, 0, W, H);
  const X = (k) => m.l + (k / (nK - 1)) * (W - m.l - m.r);
  const Y = (y) => H - m.b - ((y - (lo - pad)) / (hi - lo + 2 * pad)) * (H - m.t - m.b);
  g.setLineDash([]); g.lineWidth = 1;
  if (Hz) { // the future part of the axis
    g.fillStyle = 'rgba(255,200,110,0.08)'; g.fillRect(X(n_years - 1), m.t, W - m.r - X(n_years - 1), H - m.t - m.b);
    g.fillStyle = 'rgba(255,214,150,0.8)'; g.font = '14px system-ui'; g.fillText('if the trend continued', X(n_years - 1) + 6, m.t + 14);
  }
  g.fillStyle = '#93a0bd'; g.font = '16px system-ui'; g.strokeStyle = '#26324f';
  for (let i = 0; i <= 4; i++) {
    const y = lo - pad + ((hi - lo + 2 * pad) * i) / 4;
    g.beginPath(); g.moveTo(m.l, Y(y)); g.lineTo(W - m.r, Y(y)); g.stroke();
    g.fillText(y.toPrecision(3), 4, Y(y) + 5);
  }
  for (let k = 0; k < nK; k += nK > 40 ? 10 : 5) g.fillText(start_year + k, X(k) - 18, H - 8);
  if (ci) { // confidence band: lines of slope ci.lo and ci.hi through the centre of the data, widening into the future
    g.fillStyle = sig ? 'rgba(74,222,128,0.18)' : 'rgba(214,198,74,0.18)';
    g.beginPath(); g.moveTo(X(k0), Y(at(ci.lo, k0))); g.lineTo(X(nK - 1), Y(at(ci.lo, nK - 1)));
    g.lineTo(X(nK - 1), Y(at(ci.hi, nK - 1))); g.lineTo(X(k0), Y(at(ci.hi, k0))); g.closePath(); g.fill();
  }
  g.strokeStyle = '#6fa8dc'; g.lineWidth = 2; g.beginPath();
  ys.forEach((y, k) => (k === k0 ? g.moveTo(X(k), Y(y)) : k > k0 && !isNaN(y) && g.lineTo(X(k), Y(y)))); g.stroke();
  g.strokeStyle = sig ? '#4ade80' : '#d6c64a'; g.setLineDash(sig ? [] : [8, 6]); g.lineWidth = 3;
  g.beginPath(); g.moveTo(X(k0), Y(at(slope, k0))); g.lineTo(X(n_years - 1), Y(at(slope, n_years - 1))); g.stroke();
  if (Hz) { g.setLineDash([3, 5]); g.beginPath(); g.moveTo(X(n_years - 1), Y(at(slope, n_years - 1))); g.lineTo(X(nK - 1), Y(at(slope, nK - 1))); g.stroke(); }
  g.setLineDash([]);
  if (timeline.on) { // slider marker
    const kk = Math.min(nK - 1, Math.max(0, timeline.year - start_year)), x = X(kk);
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(x, m.t); g.lineTo(x, H - m.b); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#fff'; g.beginPath(); g.arc(x, Y(at(slope, kk)), 5, 0, 7); g.fill();
  }
}

// ---------- timeline: watch the trend build up year by year, and (clearly labelled) extend it into the future ----------
// The projection is a straight-line extension of each place's 1996-2025 trend. It is NOT a forecast: real trends can speed up,
// slow down or reverse, 30 years is a short record, and uncertainty grows the further we extend. The horizon is capped at
// 25 years, a bit less than the length of the record, which is about as far as a straight-line extension is reasonable.
const timeline = { on: false, year: 0, horizon: 25, playing: false, last: 0 };
const lastObs = () => manifest.start_year + manifest.n_years - 1;
const endYear = () => lastObs() + timeline.horizon;
const chartHooks = new Map(); // canvas -> redraw function (so charts follow the slider)
const lookHooks = [];         // functions that refresh the "looking ahead" boxes
const fmtSigned = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${fmt(Math.abs(x), 3)}`;
const rerenderPanel = () => { if (region) showRegion(); else if (places.length) showPlaces(places, { overview: showOv }); else showOverview(); };

// Text box under a chart: what the trend line implies at the slider's year
function lookBox(key, v, slope, ci) {
  const render = () => {
    const Y = Math.round(timeline.year), L = lastObs(), t0 = v.t0;
    if (Y <= L) return `<b>${Y}</b> · the trend line implies a change of about <b>${fmtSigned(slope * Math.max(0, Y - t0))} ${v.unit}</b> since ${t0}.`;
    const d = Y - L, lo = ci.lo * d, hi = ci.hi * d, c = slope * d;
    const spans = lo < 0 && hi > 0;
    return `If the ${t0}–${L} trend simply continued, by <b>${Y}</b> ${v.name.toLowerCase()} would be about <b>${fmtSigned(c)} ${v.unit}</b> ${c > 0 ? 'higher' : 'lower'} than in ${L}
      (95% range ${fmtSigned(lo)} to ${fmtSigned(hi)}${spans ? ', which includes no change' : ''}).
      <div class="hint">A straight-line extension, not a forecast: real trends can speed up, slow down or reverse, and natural variability (such as El Niño) adds more.</div>`;
  };
  lookHooks.push(() => { const el = $(key); if (el) el.innerHTML = render(); });
  return `<div class="look" id="${key}" ${timeline.on ? '' : 'hidden'}>${render()}</div>`;
}
// 95% interval of a single cell's trend, recovered from its Mann-Kendall Z (slope / standard error is about Z)
const cellSlopeCI = (slope, z) => { const se = Math.abs(slope) / Math.max(Math.abs(z), 0.3); return { lo: slope - 1.96 * se, hi: slope + 1.96 * se }; };

// ---- map: colour = change since the start of the trend window implied by the trend, scaled by the elapsed fraction ----
const DLUT = new Uint8Array(256 * 3);
function applyTimeline() {
  const v = mode === 'combined' ? null : vars[mode];
  if (!timeline.on || !v || !overlayTex) return;
  if (!DLUT[3]) for (let i = 0; i < 256; i++) DLUT.set(DIVERGING(i / 255).map(Math.round), i * 3);
  const f = Math.max(0, timeline.year - v.t0) / Math.max(1, endYear() - v.t0);
  for (let py = 0; py < TH; py++) {
    const row = (TH - 1 - py) * TW;
    for (let px = 0; px < TW; px++) {
      const q = py * TW + px, a = tlA[q], o = (row + px) * 4;
      if (!a) { overlayData[o] = overlayData[o + 1] = overlayData[o + 2] = overlayData[o + 3] = 0; continue; }
      let t = tlSn[q] * f; t = t > 1 ? 1 : t < -1 ? -1 : t;
      const i = ((127.5 + 127.5 * t) | 0) * 3;
      overlayData[o] = (DLUT[i] * a) / 255; overlayData[o + 1] = (DLUT[i + 1] * a) / 255; overlayData[o + 2] = (DLUT[i + 2] * a) / 255; overlayData[o + 3] = a;
    }
  }
  overlayTex.needsUpdate = true;
}
function timelineLegend() {
  const v = vars[mode], S = v.slope_p98 * Math.max(1, endYear() - v.t0), Y = Math.round(timeline.year);
  legend(DIVERGING, `−${S.toPrecision(2)} ${v.unit}`, `+${S.toPrecision(2)} ${v.unit}`,
    `${v.name}: change since ${v.t0} implied by the trend, in ${Y}${Y > lastObs() ? ' (if it continued)' : ''}`);
}
function timelineFrame() { // slider moved or animation tick
  const Y = Math.round(timeline.year), fut = Y > lastObs();
  $('tlSlider').value = timeline.year; $('tlYear').textContent = Y;
  const b = $('tlBadge'); b.textContent = fut ? 'If the trend continued · not a forecast' : 'Observed trend'; b.className = fut ? 'proj' : 'obs';
  applyTimeline(); if (mode !== 'combined') timelineLegend();
  chartHooks.forEach((fn, c) => { if (c.isConnected) fn(); else chartHooks.delete(c); });
  lookHooks.forEach((fn) => fn());
}
function setTimeline(on) {
  if (on && mode === 'combined') { const n = $('locNote'); n.hidden = false; n.textContent = 'The timeline works on one layer at a time: pick a layer on the left first.'; return; }
  timeline.on = on; if (!on) timeline.playing = false;
  $('tlBtn').classList.toggle('on', on); $('timeline').hidden = !on; $('tlPlay').textContent = '▶';
  if (on) { timeline.year = lastObs(); $('tlSlider').min = manifest.start_year; $('tlSlider').max = endYear(); }
  setMode(mode); // repaints the map, legend and panel in the right style
  if (on) timelineFrame();
}
function tlAnimate(ts) {
  if (!timeline.playing) return;
  if (!timeline.last) timeline.last = ts;
  timeline.year = Math.min(endYear(), timeline.year + ((ts - timeline.last) / 1000) * 3); // 3 years per second
  timeline.last = ts;
  timelineFrame();
  if (timeline.year >= endYear()) { timeline.playing = false; $('tlPlay').textContent = '▶'; return; }
  requestAnimationFrame(tlAnimate);
}
function buildTimelineUI() {
  const L = lastObs();
  $('tlHorizon').innerHTML = [[0, `No projection (to ${L})`], [10, `Look ahead to ${L + 10}`], [25, `Look ahead to ${L + 25}`]].map(([h, t]) => `<option value="${h}" ${h === 25 ? 'selected' : ''}>${t}</option>`).join('');
  $('tlBtn').onclick = () => setTimeline(!timeline.on);
  $('tlPlay').onclick = () => {
    if (timeline.playing) { timeline.playing = false; $('tlPlay').textContent = '▶'; return; }
    if (timeline.year >= endYear() - 0.01) timeline.year = manifest.start_year;
    timeline.playing = true; timeline.last = 0; $('tlPlay').textContent = '⏸'; requestAnimationFrame(tlAnimate);
  };
  $('tlSlider').oninput = (e) => { timeline.playing = false; $('tlPlay').textContent = '▶'; timeline.year = +e.target.value; timelineFrame(); };
  $('tlHorizon').onchange = (e) => {
    timeline.horizon = +e.target.value; $('tlSlider').max = endYear(); timeline.year = Math.min(timeline.year, endYear());
    setMode(mode); timelineFrame();
  };
}

// ---------- region analysis: a whole country / body of water / circle instead of a single cell ----------
let region = null, regionLine = null, stateLines = null;
const USA = 'United States of America';

const regionMats = []; // fat-line materials need the canvas size
addEventListener('resize', () => regionMats.forEach((m) => m.resolution.set(innerWidth, innerHeight)));

// Outline of the selected region: a bright line over a dark halo, so it reads on any colour. Long edges are subdivided so they hug the globe.
function setRegionLine(geometry) {
  if (regionLine) { scene.remove(regionLine); regionLine.children.forEach((l) => { l.geometry.dispose(); regionMats.splice(regionMats.indexOf(l.material), 1); }); regionLine = null; }
  if (!geometry) return;
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates, pts = [];
  const push = (a, b) => { pts.push(a.x, a.y, a.z, b.x, b.y, b.z); };
  for (const poly of polys) for (const ring of poly) {
    for (let k = 1; k < ring.length; k++) {
      const [lo0, la0] = ring[k - 1], [lo1, la1] = ring[k];
      if (Math.abs(lo1 - lo0) > 180) continue; // jump across the dateline
      // Polygons are cut open at the 180° meridian and at the poles in the 2D data: those cut edges are not real borders, so skip them
      if ((Math.abs(lo0) >= 179.5 && Math.abs(lo1) >= 179.5 && Math.abs(la1 - la0) > 0.5) || (Math.abs(la0) >= 89.9 && Math.abs(la1) >= 89.9)) continue; // (a cut edge runs along the meridian; real coast near 180° is short)
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(lo1 - lo0), Math.abs(la1 - la0)) / 2));
      for (let s = 0; s < n; s++) push(toVec(la0 + ((la1 - la0) * s) / n, lo0 + ((lo1 - lo0) * s) / n, R * 1.0015), toVec(la0 + ((la1 - la0) * (s + 1)) / n, lo0 + ((lo1 - lo0) * (s + 1)) / n, R * 1.0015));
    }
  }
  regionLine = new THREE.Group();
  for (const [color, width, opacity] of [[0x000000, 6, 0.55], [0xffd27a, 3, 1]]) {
    const g = new LineSegmentsGeometry(); g.setPositions(pts);
    const m = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthWrite: false });
    m.resolution.set(innerWidth, innerHeight); regionMats.push(m);
    regionLine.add(new LineSegments2(g, m));
  }
  scene.add(regionLine);
}

// US state borders: drawn while the United States (or one of its states) is selected, to show that states can be clicked
function showStateLines(on) {
  if (on && !stateLines) {
    const pts = [];
    for (const line of stateBorderLines()) for (let k = 1; k < line.length; k++) {
      const a = toVec(line[k - 1][1], line[k - 1][0], R * 1.001), b = toVec(line[k][1], line[k][0], R * 1.001);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new LineSegmentsGeometry(); g.setPositions(pts);
    const m = new LineMaterial({ color: 0xffffff, linewidth: 1.6, transparent: true, opacity: 0.8, depthWrite: false });
    m.resolution.set(innerWidth, innerHeight); regionMats.push(m);
    stateLines = new LineSegments2(g, m); scene.add(stateLines);
  }
  if (stateLines) stateLines.visible = on;
}

// Small shortcut under a selected spot; the click tool at the bottom of the globe is the main control
function regionBoxHTML() {
  return `<div class="regionbox"><button class="rbtn" onclick="window.__region()">▦ Analyse this ${regionKind === 'circle' ? regionKm + ' km circle' : 'country or water body'}</button> <span class="hint">or switch the click tool to “▦ Region” to do it with every click</span></div>`;
}

// ---------- click tool: "Point" (default) selects a single grid cell; "Region" turns every click into a whole-region analysis ----------
let regionsAll = [];
let clickTool = 'point', regionKind = 'auto', regionKm = 1000; // regionKind: 'auto' (country / body of water) | 'circle'
const KIND_LABEL = () => (regionKind === 'auto' ? 'Country / water' : `${regionKm} km circle`);
function anchorPoint() { return selected || (region && region.center) || userLoc || null; }

function runRegion({ geometry, name, center, kind, radiusKm }, fly = true) {
  const inside = cellsInside(geometry, manifest, maskMean, TW, TH);
  region = { name, geometry, center, kind, radiusKm, ...inside };
  places = []; selected = null; showOv = false;
  markers.forEach((m, k) => { m.visible = k === 0 && kind === 'circle'; if (m.visible) m.position.copy(toVec(center.lat, center.lon, R * 1.005)); });
  setRegionLine(geometry);
  showStateLines(name === USA || kind === 'state');
  if (fly) {
    if (kind === 'circle') flyTo(center.lat, center.lon, 2 + (radiusKm || 1000) / 1500);
    else { const c = inside.centre || center; flyTo(c.lat, c.lon, Math.min(4.6, 1.8 + Math.sqrt(inside.areaKm2) / 5000)); }
  }
  showRegion();
}

// Region under a click. Country or body of water by default; once the United States (or a state) is selected, clicking inside it picks a state.
function regionAt(lat, lon, fly = false) {
  const center = { lat, lon };
  if (regionKind === 'circle') return runRegion({ geometry: circleGeometry(lat, lon, regionKm), name: `${regionKm} km around ${regionName(lat, lon).name}`, center, kind: 'circle', radiusKm: regionKm }, fly);
  const f = regionFeatures(lat, lon), inUS = region && (region.name === USA || region.kind === 'state');
  if (f.state && inUS) return runRegion({ ...f.state, center }, fly);
  if (f.country) return runRegion({ ...f.country, center }, fly);
  if (f.water) return runRegion({ ...f.water, center }, fly);
  runRegion({ geometry: circleGeometry(lat, lon, regionKm), name: `${regionKm} km around ${regionName(lat, lon).name}`, center, kind: 'circle', radiusKm: regionKm }, fly); // nothing named here
}
window.__region = () => { const p = anchorPoint(); if (p) regionAt(p.lat, p.lon, true); }; // shortcut button under a selected spot
window.__usa = () => { const c = countryByName(USA); if (c) runRegion({ ...c, center: region ? region.center : { lat: 39, lon: -98 } }); };

window.__regionNamed = (name) => {
  const r = regionsAll.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  if (!r) return false;
  runRegion({ ...r, center: { lat: 0, lon: 0 } });
  closeRegionMenu();
  return true;
};
window.__clearRegion = () => { closeRegionMenu(); showOverview(); };

function setTool(t) {
  clickTool = t;
  $('toolPoint').classList.toggle('on', t === 'point'); $('toolRegion').classList.toggle('on', t === 'region');
  renderer.domElement.style.cursor = t === 'region' ? 'crosshair' : '';
  $('regionType').title = `Region type: ${KIND_LABEL()} (click to change, or search by name)`;
  const note = $('locNote');
  if (t === 'region') { note.hidden = false; note.textContent = regionKind === 'circle' ? `Region mode: click anywhere to analyse a ${regionKm} km circle around it. Switch back with “● Point”.` : 'Region mode: click a country or a sea/ocean to analyse all of it. Click the United States, then a state, to zoom in. Switch back with “● Point”.'; }
  else note.hidden = true;
}
function closeRegionMenu() { $('regionMenu').hidden = true; }
function openRegionMenu() {
  const menu = $('regionMenu');
  const opt = (k, km, label) => `<button class="rbtn ${regionKind === k && (k !== 'circle' || regionKm === km) ? 'sel2' : ''}" data-k="${k}" data-km="${km}">${label}</button>`;
  menu.innerHTML = `<div class="mtitle">What does a click select?</div>
    <div class="hint">In Region mode each click averages every grid cell inside the region, then re-runs the trend test on that average.</div>
    <div class="mhead">Region type</div>
    <div>${opt('auto', 0, '▦ Country / sea / ocean')}${opt('circle', 500, '◯ 500 km')}${opt('circle', 1000, '◯ 1000 km')}${opt('circle', 2000, '◯ 2000 km')}</div>
    <div class="hint" style="margin-top:6px">“Country / sea / ocean” outlines the country or named body of water you click. Click the United States first, then a state, to zoom in.</div>
    <label class="sel">…or pick one by name
      <input id="regionSearch" list="regionNames" placeholder="Start typing, e.g. Brazil, Baltic Sea or California" autocomplete="off" />
      <datalist id="regionNames">${regionsAll.map((r) => `<option value="${r.name}"></option>`).join('')}</datalist>
    </label>${region ? '<button class="rbtn" style="margin-top:8px" onclick="window.__clearRegion()">✕ Clear region</button>' : ''}`;
  menu.hidden = false;
  menu.querySelectorAll('button[data-k]').forEach((b) => (b.onclick = () => {
    regionKind = b.dataset.k; if (regionKind === 'circle') regionKm = +b.dataset.km;
    setTool('region'); closeRegionMenu();
    const p = anchorPoint(); if (p && (region || selected)) regionAt(p.lat, p.lon, false); // re-apply to the current spot
  }));
  const inp = $('regionSearch'), go = () => inp.value && window.__regionNamed(inp.value);
  inp.onchange = go; inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
}
window.__regionMenu = () => { setTool('region'); openRegionMenu(); };
document.addEventListener('click', (e) => { if (!e.target.closest('#regionMenu, #regionType, .regionbox')) closeRegionMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRegionMenu(); });

window.__csv = () => {
  if (!region || !region.csv) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([region.csv], { type: 'text/csv' }));
  a.download = `${region.name.replace(/[^a-z0-9]+/gi, '_')}_${mode}.csv`; a.click();
  URL.revokeObjectURL(a.href);
};

// regional-average trend for one variable (skips interpolated cells in "observed only" mode)
function layerCells(v) { // the part of the region this layer can speak for (land layers: land cells; ocean layers: sea cells)
  const l = domainCells(v, region, manifest);
  if (interp) return l;
  const cells = [], weights = [];
  l.cells.forEach((c, m) => { if (v.filled[c] !== 1) { cells.push(c); weights.push(l.weights[m]); } });
  return { cells, weights };
}
function regionTrend(v) {
  const list = layerCells(v), { ys, cellsUsed } = regionalSeries(v, list, manifest);
  return { ys, cellsUsed, tr: trendOf(ys), list };
}
const rate = (tr, unit) => `${tr.slope > 0 ? '+' : ''}${fmt(tr.slope)} <span style="color:#93a0bd">[${fmt(tr.lo)}, ${fmt(tr.hi)}]</span> ${unit}`;

function showRegion() {
  chartHooks.clear(); lookHooks.length = 0;
  const nav = `<button class="back" onclick="window.__overview()">← Global overview</button>${region.kind === 'state' ? ' · <button class="back" onclick="window.__usa()">▲ Whole United States</button>' : ''}`;
  const cellsN = region.cells.length;
  const what = { country: 'Country', state: 'US state', water: 'Body of water', circle: 'Circle' }[region.kind] || 'Region';
  let html = `${nav}<div class="region">Region analysis · ${what}</div><h3>${region.name}</h3>
    <div class="coord">${cellsN} grid cells (2° each) · about ${(region.areaKm2 / 1e6).toFixed(2)} million km²</div>`;
  if (region.name === USA) html += `<div class="interpbox">State borders are now drawn. <b>Click a state</b> with the Region tool to zoom in on it.</div>`;
  if (!cellsN) {
    $('detail').innerHTML = html + `<div class="verdict none">No grid-cell centres fall inside this region: it is smaller than the 2° data resolution. Pick a circle around it instead.</div>`;
    return;
  }
  if (cellsN < 4) html += `<div class="interpbox">Small region: only ${cellsN} grid cell${cellsN > 1 ? 's' : ''} (each about 220 km wide), so treat the result as indicative.</div>`;
  const ci95 = '<span style="color:#93a0bd">[95% confidence interval]</span>';
  region.csv = '';
  let draw = null;

  if (mode === 'combined') {
    let w = 0, sc = 0, nsig = 0;
    region.cells.forEach((c, m) => { if (!isNaN(combined.score[c])) { sc += combined.score[c] * region.weights[m]; w += region.weights[m]; } });
    html += w ? `<div class="verdict none">Average combined change score here: <b>${(sc / w).toFixed(2)}</b> (0–1; the planet-wide average is about 0.5).</div>` : '';
    const rows = [['variable', 'rate_per_year', 'ci_low', 'ci_high', 'p_value']], trows = [], miss = [], series = [];
    for (const v of Object.values(vars)) {
      const { ys, tr } = regionTrend(v);
      if (!tr) { miss.push(v.name); continue; }
      const sig = tr.p < manifest.alpha; if (sig) nsig++;
      trows.push({ v, slope: tr.slope, rateHtml: `<span title="95% confidence interval: ${fmt(tr.lo)} to ${fmt(tr.hi)} ${v.unit}/yr">${tr.slope > 0 ? '+' : ''}${fmt(tr.slope)} ${v.unit}</span>`, sv: tr.p, sig, filled: false });
      series.push({ name: v.name, color: varColor(v.id), sig, ys });
      rows.push([v.name, tr.slope, tr.lo, tr.hi, tr.p]);
    }
    html += `<canvas class="chart" id="rchart" width="640" height="340"></canvas>${MULTI_CAPTION}`;
    html += trendTable(trows, 'p').replace('</table>', emptyRows(miss) + '</table>');
    html += `<p style="color:#93a0bd;font-size:12px">Rate = regional average trend (hover for its 95% confidence interval); p = test of that single regional average (one test per variable, so no multiple-testing adjustment). Colour = significant (p &lt; ${manifest.alpha}), grey = not.</p>`;
    draw = () => multiChart($('rchart'), series);
    region.csv = rows.map((r) => r.join(',')).join('\n');
  } else {
    const v = vars[mode], { ys, cellsUsed, tr, list } = regionTrend(v);
    if (!tr) { $('detail').innerHTML = html + `<div class="verdict none">No ${v.name.toLowerCase()} data in this region${v.domain === 'land' ? ' (it is a land-only layer, and this region is mostly water)' : v.domain === 'ocean' ? ' (it is an ocean-only layer, and this region is mostly land)' : ''}.</div>`; return; }
    const sig = tr.p < manifest.alpha, total = tr.slope * (v.trend_years - 1);
    // how uniform is the picture inside the region?
    let up = 0, down = 0, none = 0;
    list.cells.forEach((c) => { if (isNaN(v.slope[c])) return; if (isSig(v, c)) { if (v.slope[c] > 0) up++; else down++; } else none++; });
    const tot = up + down + none;
    html += `<div class="verdict ${sig ? 'sig' : 'nosig'}">${sig ? '<b>Significant trend.</b>' : '<b>Not significant.</b>'} The regional average of ${v.name.toLowerCase()} is ${tr.slope > 0 ? 'rising' : 'falling'} by about <b>${rate(tr, v.unit)}</b> per year (${total > 0 ? '+' : '−'}${fmt(Math.abs(total), 2)} ${v.unit} over ${v.trend_years} years; interval = 95% confidence). <a href="${WIKI}Kendall_rank_correlation_coefficient" target="_blank" rel="noopener">Mann-Kendall</a> p = ${pTxt(tr.p)}, adjusted for <a href="${WIKI}Autocorrelation" target="_blank" rel="noopener">autocorrelation</a> (lag-1 = ${tr.r1.toFixed(2)}).${sig ? '' : ' Could be natural variability.'}</div>`;
    html += `<canvas class="chart" id="rchart" width="640" height="340"></canvas>${lookBox('lookR', v, tr.slope, { lo: tr.lo, hi: tr.hi })}`;
    html += `<div class="stat"><span>Cells with data</span><b>${cellsUsed}</b></div>
      <div class="stat"><span>Individually significant${corrected ? ' (corrected)' : ''}, rising</span><b>${up} (${tot ? Math.round((100 * up) / tot) : 0}%)</b></div>
      <div class="stat"><span>Individually significant, falling</span><b>${down} (${tot ? Math.round((100 * down) / tot) : 0}%)</b></div>
      <div class="stat"><span>No significant trend</span><b>${none} (${tot ? Math.round((100 * none) / tot) : 0}%)</b></div>
      <div class="hint">Yearly area-weighted regional mean (grey-blue line), Theil-Sen trend (green or dashed yellow) and its 95% confidence band. A region can be significant overall even when many of its cells are not.</div>`;
    region.csv = 'year,regional_mean,trend_fit\n' + ys.map((y, k) => (isNaN(y) ? null : `${manifest.start_year + k},${y},${tr.icpt + tr.slope * k}`)).filter(Boolean).join('\n');
    draw = () => chartSeries($('rchart'), ys, tr.slope, sig, { lo: tr.lo, hi: tr.hi }, tr.icpt);
  }
  html += `<button class="rbtn" onclick="window.__csv()">⬇ Download CSV</button>`;
  $('detail').innerHTML = html;
  if (draw) draw();
}

// ---------- global overview, region hints, user location ----------
const HINT_LOCAL = `<div class="tip">💡 Click another spot to compare. Click off the globe, or the × above, to return to the global overview.</div>`;
window.__overview = () => showOverview();
window.__home = () => userLoc && select(userLoc.lat, userLoc.lon, true);

const globalCache = {};
function globalStats(id) {
  if (globalCache[id]) return globalCache[id];
  const { nlat, nlon, res } = manifest;
  let w = 0, abs = 0, signed = 0, sig = 0, up = 0, down = 0, nsig = 0, nvalid = 0;
  for (let i = 0; i < nlat; i++) {
    const cw = Math.cos(((-90 + res * (i + 0.5)) * Math.PI) / 180);
    for (let j = 0; j < nlon; j++) {
      const c = i * nlon + j;
      if (id === 'combined') {
        if (isNaN(combined.score[c])) continue;
        w += cw; nsig += cw * nSigAt(c); nvalid += cw * combined.nvalid[c]; if (nSigAt(c) > 0) sig += cw;
      } else {
        const v = vars[id];
        if (isNaN(v.slope[c])) continue;
        w += cw; abs += cw * Math.abs(v.slope[c]); signed += cw * v.slope[c];
        if (isSig(v, c)) { sig += cw; if (v.slope[c] > 0) up += cw; else down += cw; }
      }
    }
  }
  return (globalCache[id] = { abs: abs / w, signed: signed / w, sig: sig / w, up: up / (sig || 1), down: down / (sig || 1), nsig: nsig / w, nvalid: nvalid / w });
}

// Global average of one variable over every cell with data (area-weighted), and its trend
const globalTrendCache = {};
function globalTrend(v) {
  const key = v.id + (interp ? 'i' : 'o');
  if (globalTrendCache[key]) return globalTrendCache[key];
  const { nlat, nlon, res } = manifest, cells = [], weights = [];
  for (let c = 0; c < nlat * nlon; c++) {
    if (isNaN(v.slope[c]) || (!interp && v.filled[c] === 1)) continue;
    cells.push(c); weights.push(Math.cos(((-90 + res * (Math.floor(c / nlon) + 0.5)) * Math.PI) / 180));
  }
  const { ys } = regionalSeries(v, { cells, weights }, manifest);
  return (globalTrendCache[key] = { ys, tr: trendOf(ys) });
}

let overviewDraw = null; // draws the overview's charts after its HTML is in the page
function overviewHTML() {
  let html;
  const g = globalStats(mode);
  const pct = (x) => `${(100 * x).toFixed(0)}%`;
  overviewDraw = null;
  if (mode === 'combined') {
    html = `<div class="region">Whole planet</div><h3>Global overview: everything</h3>
      <div class="big">${g.nsig.toFixed(1)} <span style="font-size:14px;font-weight:400">of ${g.nvalid.toFixed(1)} variables</span></div>
      <div class="hint" style="margin:0 0 8px">show a significant trend at the average place on Earth (area-weighted${corrected ? ', after correction' : ''}).</div>
      <div class="stat"><span>Area with at least one significant trend</span><b>${pct(g.sig)}</b></div>`;
    const trows = [], miss = [], series = [];
    for (const v of Object.values(vars)) {
      const { ys, tr } = globalTrend(v);
      if (!tr) { miss.push(v.name); continue; }
      const sig = tr.p < manifest.alpha;
      trows.push({ v, slope: tr.slope, rateHtml: `<span title="95% confidence interval: ${fmt(tr.lo)} to ${fmt(tr.hi)} ${v.unit}/yr">${tr.slope > 0 ? '+' : ''}${fmt(tr.slope)} ${v.unit}</span>`, sv: tr.p, sig, filled: false });
      series.push({ name: v.name, color: varColor(v.id), sig, ys });
    }
    html += `<canvas class="chart" id="gchart" width="640" height="340"></canvas>${MULTI_CAPTION}`;
    html += trendTable(trows, 'p').replace('</table>', emptyRows(miss) + '</table>');
    html += `<p style="color:#93a0bd;font-size:12px">Global-average trend of each variable (land layers over land, ocean layers over sea). Hover a rate for its 95% confidence interval.</p>`;
    overviewDraw = () => multiChart($('gchart'), series);
  } else {
    const v = vars[mode], { ys, tr } = globalTrend(v);
    html = `<div class="region">Whole planet</div><h3>Global overview: ${v.name}</h3>
      <div class="big">${fmt(g.abs)} <span style="font-size:14px;font-weight:400">${v.unit}/yr</span></div>
      <div class="hint" style="margin:0 0 8px">average size of the rate of change (absolute value, area-weighted over ${v.domain === 'land' ? 'land' : v.domain === 'ocean' ? 'ocean' : 'all'} cells). Direction is ignored, so rises and falls both count.</div>`;
    if (tr) {
      const sig = tr.p < manifest.alpha, total = tr.slope * (v.trend_years - 1);
      html += `<div class="verdict ${sig ? 'sig' : 'nosig'}">The <b>global average</b> of ${v.name.toLowerCase()} is ${tr.slope > 0 ? 'rising' : 'falling'} by about <b>${rate(tr, v.unit)}</b> per year (${total > 0 ? '+' : '−'}${fmt(Math.abs(total), 2)} ${v.unit} over ${v.trend_years} years). p = ${pTxt(tr.p)}.</div>
        <canvas class="chart" id="gchart" width="640" height="340"></canvas>${lookBox('lookG', v, tr.slope, { lo: tr.lo, hi: tr.hi })}
        <div class="hint">Yearly area-weighted global mean, with its Theil-Sen trend and 95% confidence band. Local trends can differ a lot from this average (and cancel in it): click the globe to see a place.</div>`;
      overviewDraw = () => chartSeries($('gchart'), ys, tr.slope, sig, { lo: tr.lo, hi: tr.hi }, tr.icpt);
    }
    html += `<div class="stat"><span>Typical change over ${v.trend_years} years</span><b>±${fmt(g.abs * (v.trend_years - 1), 2)} ${v.unit}</b></div>
      <div class="stat"><span>Net average rate (rises minus falls)</span><b>${g.signed > 0 ? '+' : ''}${fmt(g.signed)} ${v.unit}/yr</b></div>
      <div class="stat"><span>Area with a significant trend${corrected ? ' (corrected)' : ''}</span><b>${pct(g.sig)}</b></div>
      <div class="stat"><span>…of which rising / falling</span><b>${pct(g.up)} / ${pct(g.down)}</b></div>`;
  }
  return html;
}

function showOverview() {
  chartHooks.clear(); lookHooks.length = 0;
  places = []; selected = null; showOv = false; region = null; setRegionLine(null); showStateLines(false); markers.forEach((m) => (m.visible = false));
  anim = null; controls.autoRotate = $('spin').checked; // resume spinning if auto-rotate is on
  let html = overviewHTML();
  html += `<div class="tip">👆 <b>Click anywhere on the globe</b> to see the numbers, region and time series for that spot. Click off the globe to come back to this overview.</div>`;
  if (userLoc) html += `<div class="here">📍 Location access is on. <button class="demo" onclick="window.__home()">Show stats for where I am</button></div>`;
  else html += `<div class="hint">Tip: “Use my location” (bottom of the globe) shows these statistics for where you are.</div>`;
  $('detail').innerHTML = html;
  if (overviewDraw) overviewDraw();
}

function locate() {
  const note = $('locNote');
  if (!navigator.geolocation) { note.textContent = 'Your browser does not support location.'; return; }
  note.hidden = false; note.textContent = 'Asking your browser for permission…';
  navigator.geolocation.getCurrentPosition((pos) => {
    userLoc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    userMarker.position.copy(toVec(userLoc.lat, userLoc.lon, R * 1.005)); userMarker.visible = true;
    note.textContent = `Located: ${regionName(userLoc.lat, userLoc.lon).name} (cyan dot). Statistics now default to your location.`;
    select(userLoc.lat, userLoc.lon, true);
  }, (err) => {
    note.textContent = err.code === 1 ? 'Permission denied. You can still click anywhere on the globe.' : 'Could not get your location.';
  }, { timeout: 15000 });
}

// ---------- guided demos ----------
// The place with the highest combined change score (needs a good number of variables so it is not a one-variable fluke)
function peakCombined() {
  const { nlat, nlon, res } = manifest;
  let best = -1, bi = -1;
  for (let c = 0; c < combined.score.length; c++) if (combined.nvalid[c] >= 6 && combined.score[c] > best) { best = combined.score[c]; bi = c; }
  return { lat: -90 + res * (Math.floor(bi / nlon) + 0.5), lon: -180 + res * ((bi % nlon) + 0.5), score: best };
}
const DEMOS = [
  { title: '1. Arctic warming', mode: 'temp', places: [{ lat: 80, lon: 70 }], text: () => 'The Arctic (here the Barents/Kara Sea region) is warming several times faster than the global average. Read the chart: the trend line climbs steeply and the test says it is significant.' },
  { title: '2. Opposite trends (rainfall)', mode: 'precip', places: [{ lat: -9, lon: 161 }, { lat: -11, lon: -143 }],
    text: () => 'Rainfall is rising in the western tropical Pacific (orange dot, red) and falling in the eastern tropical Pacific (green dot, blue). Both charts are in the panel: the trends point in opposite directions, consistent with a shift in tropical wind and rainfall patterns across the Pacific basin. Short records are sensitive to El Niño/La Niña, so treat it as a lead to investigate.' },
  { title: '3. An ocean hot spot', mode: 'sst', places: [{ lat: 39, lon: 167 }], text: () => 'East of Japan, where the warm Kuroshio current meets cooler water, the sea surface is warming much faster than most of the ocean.' },
  { title: '4. Put it together', mode: 'combined', overview: true,
    places: () => [peakCombined()],
    text: (p) => `The combined layer ranks places by how much of the Earth system is trending at once, regardless of direction or units. The dot marks the highest-scoring place on the map (${regionName(p[0].lat, p[0].lon).name}, score ${p[0].score.toFixed(2)}); the global overview stays above for comparison.` },
];
function runDemo(d) {
  setMode(d.mode);
  const ps = typeof d.places === 'function' ? d.places() : d.places;
  showPlaces(ps.map(({ lat, lon }) => ({ lat, lon })), { fly: true, overview: !!d.overview });
  const s = $('story');
  s.hidden = false; s.innerHTML = `<b>${d.title}</b><br>${d.text(ps)}`;
  clearTimeout(runDemo.t);
  runDemo.t = setTimeout(() => (s.hidden = true), 16000);
}

init();
