import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { feature, mesh } from 'topojson-client';
import world from 'world-atlas/countries-50m.json';
import * as P from './palette.js';
import { regionName } from './regions.js';

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
const LAND_RAMP = ramp(P.LAND_STOPS), OCEAN_RAMP = ramp(P.OCEAN_STOPS);
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
let mask; // Uint8 land fraction per texture pixel (0-255)
let elev = null; // Int16 elevation (m) per texture pixel, if available
let baseStyle = 'relief'; // 'relief' | 'plain'
const LAYER_COLORS = {};

const $ = (id) => document.getElementById(id);

async function loadBin(name) {
  const buf = await (await fetch(`/data/${name}.bin`)).arrayBuffer();
  return new Float32Array(buf);
}

async function init() {
  manifest = await (await fetch('/data/manifest.json')).json();
  const { nlat, nlon, n_years } = manifest;
  const N = nlat * nlon;
  for (const v of manifest.variables) {
    const a = await loadBin(v.id);
    vars[v.id] = { ...v, slope: a.subarray(0, N), z: a.subarray(N, 2 * N), p: a.subarray(2 * N, 3 * N), filled: a.subarray(3 * N, 4 * N), annual: a.subarray(4 * N, 4 * N + n_years * N) };
  }
  mask = new Uint8Array(await (await fetch('/data/landmask.bin')).arrayBuffer());
  TW = manifest.mask_w; TH = manifest.mask_h;
  canvas.width = TW; canvas.height = TH;
  if (manifest.has_elevation) elev = new Int16Array(await (await fetch('/data/elevation.bin')).arrayBuffer());
  prepareDomains();
  prepareBorders();
  const c = await loadBin('combined');
  combined = { score: c.subarray(0, N), nsig: c.subarray(N, 2 * N), nvalid: c.subarray(2 * N, 3 * N), scoreObs: c.subarray(3 * N, 4 * N), nvalidObs: c.subarray(4 * N, 5 * N), nfilled: c.subarray(5 * N, 6 * N) };
  // stretch combined score between its 2nd and 98th percentile so hot-spots stand out
  const vals = Array.from(combined.score).filter((x) => !isNaN(x)).sort((a, b) => a - b);
  combined.lo = vals[Math.floor(vals.length * 0.02)];
  combined.hi = vals[Math.floor(vals.length * 0.98)];

  $('banner').hidden = !manifest.synthetic;
  $('method').innerHTML = methodHTML();
  const q = new URLSearchParams(location.search); // optional: ?layer=temp&colorBy=sig&base=plain&lat=20&lon=30&spin=0
  if (q.get('colorBy')) { colorBy = q.get('colorBy'); }
  if (q.get('base')) { baseStyle = q.get('base'); }
  buildUI();
  buildGlobe();
  if (q.get('spin') === '0') { controls.autoRotate = false; $('spin').checked = false; }
  if (q.get('lat')) camera.position.copy(toVec(+q.get('lat'), +q.get('lon') || 0, 2.6));
  $('colorBy').value = colorBy; $('baseMap').value = baseStyle;
  setMode(vars[q.get('layer')] ? q.get('layer') : 'combined');
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

// ---------- texture ----------
let TW = 2048, TH = 1024;
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
let texture;

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
      landFrac[i * nlon + j] += mask[py * TW + px] / 255; cnt[i * nlon + j]++;
    }
  }
  for (let c = 0; c < N; c++) landFrac[c] /= cnt[c] || 1;
  for (const v of Object.values(vars)) {
    const eff = new Int32Array(N).fill(-1), ext = new Float32Array(N).fill(NaN), extLogP = new Float32Array(N).fill(NaN);
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
      ext[c] = v.slope[eff[c]]; extLogP[c] = -Math.log10(Math.max(v.p[eff[c]], 1e-12));
    }
    v.eff = eff; v.ext = ext; v.extLogP = extLogP;
  }
}

const mix = (a, b, t) => a.map((x, k) => x * (1 - t) + b[k] * t);

// ---------- base map: hypsometric tint + hillshade + contour lines (or plain) ----------
const baseCache = {};
function buildBase(style) {
  if (baseCache[style]) return baseCache[style];
  const n = TW * TH, out = new Uint8ClampedArray(n * 3);
  const relief = style === 'relief' && elev;
  let E, lvl;
  if (relief) {
    E = new Float32Array(n); lvl = new Int8Array(n);
    for (let q = 0; q < n; q++) {
      let e = elev[q]; const land = mask[q] >= 128;
      if (land && e <= 0) e = 1; else if (!land && e >= 0) e = -1; // keep the coast consistent with the land mask
      E[q] = e;
      let k = 1;
      if (e >= 0) { for (const t of P.LAND_CONTOURS) if (e >= t) k++; lvl[q] = k; }
      else { for (const t of P.OCEAN_CONTOURS) if (-e >= t) k++; lvl[q] = -k; }
    }
  }
  const az = (P.SUN_AZIMUTH_DEG * Math.PI) / 180, alt = (P.SUN_ALTITUDE_DEG * Math.PI) / 180;
  const Lx = Math.cos(alt) * Math.sin(az), Ly = Math.cos(alt) * Math.cos(az), Lz = Math.sin(alt);
  const dy = (111320 * 180) / TH;
  for (let py = 0; py < TH; py++) {
    const lat = 90 - ((py + 0.5) / TH) * 180;
    const dx = Math.max(0.05, Math.cos((lat * Math.PI) / 180)) * ((111320 * 360) / TW);
    for (let px = 0; px < TW; px++) {
      const q = py * TW + px, landA = mask[q] / 255;
      let col;
      if (!relief) col = mix(P.PLAIN_OCEAN, P.PLAIN_LAND, landA);
      else {
        const e = E[q];
        col = mix(OCEAN_RAMP(Math.max(-e, 0)), LAND_RAMP(Math.max(e, 0)), landA);
        const ve = P.VERTICAL_EXAGGERATION_OCEAN + (P.VERTICAL_EXAGGERATION_LAND - P.VERTICAL_EXAGGERATION_OCEAN) * landA;
        const st = P.SHADE_STRENGTH_OCEAN + (P.SHADE_STRENGTH_LAND - P.SHADE_STRENGTH_OCEAN) * landA;
        const zE = (E[px < TW - 1 ? q + 1 : q] - E[px > 0 ? q - 1 : q]) / (2 * dx);
        const zN = (E[py > 0 ? q - TW : q] - E[py < TH - 1 ? q + TW : q]) / (2 * dy);
        const nx = -ve * zE, ny = -ve * zN, norm = Math.sqrt(nx * nx + ny * ny + 1);
        const f = Math.max(0, (nx * Lx + ny * Ly + Lz) / norm) / Lz;
        const k = 1 + st * (f - 1);
        col = col.map((c) => c * k);
        const l = lvl[q];
        if ((px < TW - 1 && l !== lvl[q + 1]) || (py < TH - 1 && l !== lvl[q + TW])) {
          col = mix(col, [0, 0, 0], P.CONTOUR_DARKEN_OCEAN + (P.CONTOUR_DARKEN_LAND - P.CONTOUR_DARKEN_OCEAN) * landA);
        }
      }
      out[q * 3] = col[0]; out[q * 3 + 1] = col[1]; out[q * 3 + 2] = col[2];
    }
  }
  return (baseCache[style] = out);
}

let bordersCanvas;
function prepareBorders() {
  bordersCanvas = document.createElement('canvas');
  bordersCanvas.width = TW; bordersCanvas.height = TH;
  const b = bordersCanvas.getContext('2d');
  b.strokeStyle = P.BORDER_STYLE; b.lineWidth = 1; b.beginPath();
  for (const line of mesh(world, world.objects.countries).coordinates) {
    let prev = null;
    for (const [lon, lat] of line) {
      const x = ((lon + 180) / 360) * TW, y = ((90 - lat) / 180) * TH;
      if (prev === null || Math.abs(x - prev) > TW / 2) b.moveTo(x, y); else b.lineTo(x, y);
      prev = x;
    }
  }
  b.stroke();
}

function paint() {
  const img = ctx.createImageData(TW, TH), d = img.data;
  const base = buildBase(baseStyle);
  const v = mode === 'combined' ? null : vars[mode];
  const WHITE = [255, 255, 255];
  for (let py = 0; py < TH; py++) {
    const lat = 90 - ((py + 0.5) / TH) * 180;
    for (let px = 0; px < TW; px++) {
      const lon = ((px + 0.5) / TW) * 360 - 180;
      const q = py * TW + px, o = q * 4;
      let r = base[q * 3], g = base[q * 3 + 1], b = base[q * 3 + 2];
      const ci = cellIndex(lat, lon);
      let col = null, a = 0, veil = 0;
      if (v) {
        const landA = mask[q] / 255;
        const inA = v.domain === 'land' ? landA : v.domain === 'ocean' ? 1 - landA : 1;
        if (inA > 0) {
          const e = v.eff[ci], isFilled = e >= 0 && v.filled[e] === 1;
          const s = e >= 0 ? sample(v.ext, lat, lon) : NaN;
          if (isNaN(s) || (!interp && isFilled)) veil = inA;
          else {
            const lp = sample(v.extLogP, lat, lon);
            if (colorBy === 'sig') { col = SIGRAMP(lp / 3); a = P.OVERLAY_ALPHA * inA; }
            else {
              col = DIVERGING(0.5 + (0.5 * s) / v.slope_p98);
              a = P.OVERLAY_ALPHA * inA * (colorBy === 'fade' ? sigWeight(lp) : 1); // not significant -> see-through
            }
            if (isFilled && ((px + py) >> 2) % 2 === 0) col = mix(col, WHITE, 0.3); // striped = interpolated
          }
        }
      } else {
        const sc = sample(interp ? combined.score : combined.scoreObs, lat, lon);
        if (isNaN(sc)) veil = 1;
        else {
          col = SEQUENTIAL((sc - combined.lo) / (combined.hi - combined.lo)); a = P.OVERLAY_ALPHA;
          if (interp && combined.nfilled[ci] > 0 && ((px + py) >> 2) % 2 === 0) col = mix(col, WHITE, 0.3);
        }
      }
      if (veil > 0) { // real gap: grey out and darken the map underneath
        const lum = 0.3 * r + 0.59 * g + 0.11 * b, k = 1 - P.NO_DATA_DARKEN * veil, ds = P.NO_DATA_DESATURATE * veil;
        r = (r + (lum - r) * ds) * k; g = (g + (lum - g) * ds) * k; b = (b + (lum - b) * ds) * k;
      } else if (col) {
        r = r * (1 - a) + col[0] * a; g = g * (1 - a) + col[1] * a; b = b * (1 - a) + col[2] * a;
      }
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.drawImage(bordersCanvas, 0, 0);
  if (texture) texture.needsUpdate = true;
}

// ---------- globe ----------
let scene, camera, renderer, controls, globe, marker, userMarker, anim = null;
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

  texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  globe = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 64), new THREE.MeshBasicMaterial({ map: texture }));
  scene.add(globe);

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

  marker = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffb454 }));
  marker.visible = false;
  scene.add(marker);
  userMarker = new THREE.Mesh(new THREE.SphereGeometry(0.014, 16, 16), new THREE.MeshBasicMaterial({ color: 0x38e1ff }));
  userMarker.visible = false;
  scene.add(userMarker);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.4;
  controls.maxDistance = 6;
  controls.autoRotateSpeed = 0.5;
  controls.autoRotate = $('spin').checked;

  // click (not drag) to select
  const ray = new THREE.Raycaster();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
    const hit = ray.intersectObject(globe)[0];
    if (hit) select(hit.uv.y * 180 - 90, hit.uv.x * 360 - 180);
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

function flyTo(lat, lon, dist = 2.4) {
  const target = toVec(lat, lon, dist);
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
    b.onclick = () => { selected = null; setMode(id); if (userLoc) select(userLoc.lat, userLoc.lon); };
    L.appendChild(b);
  };
  mk('combined', '★ Combined: where is Earth changing most?', 'combined');
  for (const v of manifest.variables) mk(v.id, v.name);
  $('baseMap').onchange = (e) => { baseStyle = e.target.value; paint(); };
  $('colorBy').onchange = (e) => { colorBy = e.target.value; setMode(mode); };
  $('observedOnly').onchange = (e) => { interp = !e.target.checked; setMode(mode); };
  $('spin').onchange = (e) => { controls.autoRotate = e.target.checked; };
  $('close').onclick = showOverview;
  $('locate').onclick = locate;
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
  document.querySelectorAll('.layer').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  paint();
  if (id === 'combined') {
    $('about').innerHTML = `<b>Combined change score</b><br>For each place, every variable's trend strength is ranked from 0 to 1, then averaged across the variables measured there. Bright = many/strong trends; dark = little change. Direction is ignored, so a warming place and a drying place both count as "changing".`;
    legend(SEQUENTIAL, 'Less change', 'More change', 'Combined change score');
  } else {
    const v = vars[id];
    $('about').innerHTML = `<b>${v.name}</b> (${v.unit})<br>${v.about}<br><span style="color:#93a0bd">Source: ${v.source}. ${v.pct_significant.toFixed(0)}% of mapped cells have a significant trend.</span>`;
    if (colorBy === 'sig') legend(SIGRAMP, 'p = 1 (no evidence of a trend)', 'p ≤ 0.001 (very strong)', 'Significance of the trend');
    else legend(DIVERGING, `−${v.slope_p98.toPrecision(2)} ${v.unit}/yr`, `+${v.slope_p98.toPrecision(2)} ${v.unit}/yr`,
      colorBy === 'fade' ? 'Rate of change: falling → rising (see-through where the trend is not significant)' : 'Rate of change (falling → rising)');
  }
  interpNotice();
  if (selected) select(selected.lat, selected.lon, false); else showOverview();
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
    ${wl('Statistical_significance', 'statistically significant')}. The faded colour scale shades smoothly from p = 0.1 (not significant) to p = 0.01 (strongly significant).</p>
    <p><b>Combined score.</b> Each variable's trend strength is converted to a ${wl('Percentile_rank', 'percentile rank')} so different units can be averaged;
    the score is the mean over variables measured at that place (at least 2). Temperature is land-only and sea surface temperature ocean-only so the oceans aren't counted twice.</p>
    <p><b>Interpolation.</b> Small holes (up to ${manifest.max_hole} cells) surrounded by data are filled by ${wl('Inverse_distance_weighting', 'inverse-distance weighting')}; larger gaps are never filled.</p>
    <p><b>Data.</b> NASA GISS GISTEMP, NOAA GPCP and ERSST, and NASA MERRA-2 (an ${wl('Atmospheric_reanalysis', 'atmospheric reanalysis')}).</p>`;
}

// ---------- detail panel ----------
const fmt = (x, d = 3) => (Math.abs(x) < 0.001 && x !== 0 ? x.toExponential(1) : x.toFixed(d));
const pTxt = (p) => (p < 0.001 ? '<0.001' : p.toFixed(3));

function select(lat, lon, fly = false) {
  selected = { lat, lon };
  const idx = cellIndex(lat, lon);
  marker.position.copy(toVec(lat, lon, R * 1.005)); marker.visible = true;
  if (fly) flyTo(lat, lon);
  const ns = lat >= 0 ? 'N' : 'S', ew = lon >= 0 ? 'E' : 'W';
  const reg = regionName(lat, lon);
  const nav = `<button class="back" onclick="window.__overview()">← Global overview</button>${userLoc ? ` · <button class="back" onclick="window.__home()">📍 My location</button>` : ''}`;
  let html = `${nav}<div class="region">${reg.name}</div><h3>${mode === 'combined' ? 'Everything here' : vars[mode].name}</h3><div class="coord">${Math.abs(lat).toFixed(1)}°${ns}, ${Math.abs(lon).toFixed(1)}°${ew}</div>`;

  if (mode === 'combined') {
    const s = combined.score[idx];
    if (isNaN(s)) html += `<div class="verdict none">Not enough data here (need at least 2 variables).</div>`;
    else html += `<div class="verdict none">Combined change score: <b>${s.toFixed(2)}</b> (0–1).<br>${combined.nsig[idx]} of ${combined.nvalid[idx]} variables show a significant trend.</div>`;
    html += '<table><tr><th>Variable</th><th class="num">Rate / yr</th><th class="num">p</th></tr>';
    for (const v of Object.values(vars)) {
      const j = v.eff[idx] >= 0 ? v.eff[idx] : idx, p = v.p[j];
      html += isNaN(p)
        ? `<tr><td>${v.name}</td><td class="num" colspan="2" style="color:#93a0bd">no data</td></tr>`
        : `<tr><td><span class="dot ${p < manifest.alpha ? 's' : 'n'}"></span>${v.name}${v.filled[j] === 1 ? ' <span class="interp" title="interpolated">(interp.)</span>' : ''}</td><td class="num">${v.slope[j] > 0 ? '+' : ''}${fmt(v.slope[j])} ${v.unit}</td><td class="num">${pTxt(p)}</td></tr>`;
    }
    html += '</table><p style="color:#93a0bd;font-size:12px">Green dot = significant (p &lt; 0.05). Pick a layer on the left to see its time series.</p>';
    $('detail').innerHTML = html + HINT_LOCAL;
    return;
  }

  const v = vars[mode], i = v.eff[idx] >= 0 ? v.eff[idx] : idx, p = v.p[i], slope = v.slope[i];
  if (isNaN(p)) { $('detail').innerHTML = html + `<div class="verdict none">No ${v.name.toLowerCase()} data at this location.</div>` + HINT_LOCAL; return; }
  const sig = p < manifest.alpha;
  const total = slope * (v.trend_years - 1);
  if (v.filled[i] === 1) html += '<div class="interp" style="margin-bottom:6px">⚠ Interpolated cell: estimated from neighbouring cells, not directly observed.</div>';
  html += `<div class="verdict ${sig ? 'sig' : 'nosig'}">${sig ? '<b>Significant trend.</b>' : '<b>Not significant.</b>'} ${v.name} is ${slope > 0 ? 'rising' : 'falling'} by about <b>${fmt(Math.abs(slope))} ${v.unit}/yr</b> (${total > 0 ? '+' : '−'}${fmt(Math.abs(total), 2)} over ${v.trend_years} years). <a href="${WIKI}Kendall_rank_correlation_coefficient" target="_blank" rel="noopener">Mann-Kendall</a> p = ${pTxt(p)} (Z = ${v.z[i].toFixed(2)}).${sig ? '' : ' This could be natural variability; a longer record might make it significant.'}</div>`;
  html += `<canvas id="chart" width="640" height="340"></canvas><div style="color:#93a0bd;font-size:12px;margin-top:6px">Yearly average with the fitted linear trend. Seasonal cycle removed for the trend test.</div>`;
  $('detail').innerHTML = html + HINT_LOCAL;
  chart(v, i, slope, sig);
}

function chart(v, idx, slope, sig) {
  const { nlat, nlon, n_years, start_year } = manifest, N = nlat * nlon;
  const ys = Array.from({ length: n_years }, (_, k) => v.annual[k * N + idx]);
  const k0 = ys.findIndex((y) => !isNaN(y)); // some layers only have a trend window starting later in the record
  const valid = ys.filter((y) => !isNaN(y));
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const trend = ys.map((_, k) => mean + slope * (k - (k0 + n_years - 1) / 2));
  const lo = Math.min(...valid, trend[k0], trend[n_years - 1]), hi = Math.max(...valid, trend[k0], trend[n_years - 1]), pad = (hi - lo) * 0.1 || 1;
  const c = $('chart'), g = c.getContext('2d'), W = c.width, H = c.height, m = { l: 56, r: 12, t: 12, b: 28 };
  const X = (k) => m.l + (k / (n_years - 1)) * (W - m.l - m.r);
  const Y = (y) => H - m.b - ((y - (lo - pad)) / (hi - lo + 2 * pad)) * (H - m.t - m.b);
  g.fillStyle = '#93a0bd'; g.font = '16px system-ui'; g.strokeStyle = '#26324f';
  for (let i = 0; i <= 4; i++) {
    const y = lo - pad + ((hi - lo + 2 * pad) * i) / 4;
    g.beginPath(); g.moveTo(m.l, Y(y)); g.lineTo(W - m.r, Y(y)); g.stroke();
    g.fillText(y.toPrecision(3), 4, Y(y) + 5);
  }
  for (let k = 0; k < n_years; k += 5) g.fillText(start_year + k, X(k) - 18, H - 8);
  g.strokeStyle = '#6fa8dc'; g.lineWidth = 2; g.beginPath();
  ys.forEach((y, k) => (k === k0 ? g.moveTo(X(k), Y(y)) : k > k0 && g.lineTo(X(k), Y(y)))); g.stroke();
  g.strokeStyle = sig ? '#4ade80' : '#d6c64a'; g.setLineDash(sig ? [] : [8, 6]); g.lineWidth = 3;
  g.beginPath(); g.moveTo(X(k0), Y(trend[k0])); g.lineTo(X(n_years - 1), Y(trend[n_years - 1])); g.stroke(); g.setLineDash([]);
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
        w += cw; nsig += cw * combined.nsig[c]; nvalid += cw * combined.nvalid[c]; if (combined.nsig[c] > 0) sig += cw;
      } else {
        const v = vars[id];
        if (isNaN(v.slope[c])) continue;
        w += cw; abs += cw * Math.abs(v.slope[c]); signed += cw * v.slope[c];
        if (v.p[c] < manifest.alpha) { sig += cw; if (v.slope[c] > 0) up += cw; else down += cw; }
      }
    }
  }
  return (globalCache[id] = { abs: abs / w, signed: signed / w, sig: sig / w, up: up / (sig || 1), down: down / (sig || 1), nsig: nsig / w, nvalid: nvalid / w });
}

function showOverview() {
  selected = null; marker.visible = false;
  anim = null; controls.autoRotate = $('spin').checked; // resume spinning if auto-rotate is on
  let html;
  const g = globalStats(mode);
  const pct = (x) => `${(100 * x).toFixed(0)}%`;
  if (mode === 'combined') {
    html = `<div class="region">Whole planet</div><h3>Global overview: everything</h3>
      <div class="big">${g.nsig.toFixed(1)} <span style="font-size:14px;font-weight:400">of ${g.nvalid.toFixed(1)} variables</span></div>
      <div class="hint" style="margin:0 0 8px">show a significant trend at the average place on Earth (area-weighted).</div>
      <div class="stat"><span>Area with at least one significant trend</span><b>${pct(g.sig)}</b></div>`;
  } else {
    const v = vars[mode];
    html = `<div class="region">Whole planet</div><h3>Global overview: ${v.name}</h3>
      <div class="big">${fmt(g.abs)} <span style="font-size:14px;font-weight:400">${v.unit}/yr</span></div>
      <div class="hint" style="margin:0 0 8px">average size of the rate of change (absolute value, area-weighted over ${v.domain === 'land' ? 'land' : v.domain === 'ocean' ? 'ocean' : 'all'} cells). Direction is ignored, so rises and falls both count.</div>
      <div class="stat"><span>Typical change over ${v.trend_years} years</span><b>±${fmt(g.abs * (v.trend_years - 1), 2)} ${v.unit}</b></div>
      <div class="stat"><span>Net average rate (rises minus falls)</span><b>${g.signed > 0 ? '+' : ''}${fmt(g.signed)} ${v.unit}/yr</b></div>
      <div class="stat"><span>Area with a significant trend</span><b>${pct(g.sig)}</b></div>
      <div class="stat"><span>…of which rising / falling</span><b>${pct(g.up)} / ${pct(g.down)}</b></div>`;
  }
  html += `<div class="tip">👆 <b>Click anywhere on the globe</b> to see the numbers, region and time series for that spot. Click off the globe to come back to this overview.</div>`;
  if (userLoc) html += `<div class="here">📍 Location access is on. <button class="demo" onclick="window.__home()">Show stats for where I am</button></div>`;
  else html += `<div class="hint">Tip: “Use my location” (left) shows these statistics for where you are.</div>`;
  $('detail').innerHTML = html;
}

function locate() {
  const note = $('locNote');
  if (!navigator.geolocation) { note.textContent = 'Your browser does not support location.'; return; }
  note.textContent = 'Asking your browser for permission…';
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
const DEMOS = [
  { title: '1. Arctic warming', mode: 'temp', lat: 80, lon: 70, text: 'The Arctic (here the Barents/Kara Sea region) is warming several times faster than the global average. Click a bright red cell and read the chart: the trend line climbs steeply and the test says it is significant.' },
  { title: '2. Same ocean, opposite trends (rainfall)', mode: 'precip', lat: -7, lon: 151, text: 'Rainfall is rising in the western tropical Pacific (red) and falling in the eastern tropical Pacific (blue). Click both: the trends point in opposite directions, linked to shifts in Pacific wind patterns. Short records are sensitive to El Niño/La Niña, so treat it as a lead to investigate.' },
  { title: '3. An ocean hot spot', mode: 'sst', lat: 39, lon: 167, text: 'East of Japan, where the warm Kuroshio current meets cooler water, the sea surface is warming much faster than most of the ocean.' },
  { title: '4. Put it together', mode: 'combined', lat: 40, lon: -50, text: 'The combined layer ranks places by how much of the Earth system is trending at once, regardless of direction or units. Bright areas have strong trends in several variables.' },
];
function runDemo(d) {
  setMode(d.mode);
  select(d.lat, d.lon, true);
  const s = $('story');
  s.hidden = false; s.innerHTML = `<b>${d.title}</b><br>${d.text}`;
  clearTimeout(runDemo.t);
  runDemo.t = setTimeout(() => (s.hidden = true), 14000);
}

init();
