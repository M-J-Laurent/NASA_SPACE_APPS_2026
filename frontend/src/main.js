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

async function loadBin(name) {
  const buf = await (await fetch(`/data/${name}.bin`)).arrayBuffer();
  return new Float32Array(buf);
}

function dataMissing(err) {
  document.body.insertAdjacentHTML('beforeend', `<div id="nodata"><div><h2>The data files were not found</h2>
    <p>This site is served from your own machine, so the processed data has to exist locally (<code>data/processed/</code>). A hosted version would serve it to every visitor, so visitors would not have to download anything.</p>
    <p>To build it locally, from the project folder run:</p>
    <pre>.venv\\Scripts\\python preprocessing\\download.py
.venv\\Scripts\\python preprocessing\\load_real.py
.venv\\Scripts\\python preprocessing\\load_earthdata.py
.venv\\Scripts\\python preprocessing\\pipeline.py</pre>
    <p>then reload this page. (<code>start.ps1</code> checks for this and prints the same steps. The Earthdata step needs a free NASA login.)</p>
    <p style="color:#93a0bd">Details: ${String(err)}</p></div></div>`);
}

async function init() {
  try {
    const r = await fetch('/data/manifest.json');
    if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status}`);
    manifest = await r.json();
  } catch (e) { dataMissing(e); return; }
  const { nlat, nlon, n_years } = manifest;
  const N = nlat * nlon;
  for (const v of manifest.variables) {
    const a = await loadBin(v.id);
    vars[v.id] = { ...v, slope: a.subarray(0, N), z: a.subarray(N, 2 * N), p: a.subarray(2 * N, 3 * N), filled: a.subarray(3 * N, 4 * N), annual: a.subarray(4 * N, 4 * N + n_years * N) };
  }
  [baseImg, maskImg] = await Promise.all([loadImg('/data/' + manifest.basemap_file), loadImg('/data/' + manifest.mask_file)]);
  prepareMask();
  prepareDomains();
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
  if (q.get('base') === 'plain') baseStyle = 'plain';
  buildUI();
  buildGlobe();
  if (q.get('spin') === '0') { controls.autoRotate = false; $('spin').checked = false; }
  if (q.get('lat')) camera.position.copy(toVec(+q.get('lat'), +q.get('lon') || 0, +q.get('dist') || 2.6));
  $('colorBy').value = colorBy; $('baseMap').value = baseStyle;
  setMode(vars[q.get('layer')] ? q.get('layer') : 'combined');
  if (q.get('demo')) runDemo(DEMOS[+q.get('demo') - 1]); // e.g. ?demo=2
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

function paint() {
  const v = mode === 'combined' ? null : vars[mode];
  for (let py = 0; py < TH; py++) {
    const lat = 90 - ((py + 0.5) / TH) * 180, row = (TH - 1 - py) * TW; // texture row 0 is the south pole
    for (let px = 0; px < TW; px++) {
      const lon = ((px + 0.5) / TW) * 360 - 180;
      const q = py * TW + px, o = (row + px) * 4;
      const ci = cellIndex(lat, lon);
      let col = null, a = 0, veil = 0, fillFlag = 0;
      if (v) {
        const inside = v.domain === 'land' ? maskMax[q] > 0 : v.domain === 'ocean' ? maskMin[q] < 255 : true;
        if (inside) {
          const e = v.eff[ci], isFilled = e >= 0 && v.filled[e] === 1;
          const s = e >= 0 ? sample(v.ext, lat, lon) : NaN;
          if (isNaN(s) || (!interp && isFilled)) veil = 1;
          else {
            const lp = sample(v.extLogP, lat, lon);
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
    b.onclick = () => { selected = null; setMode(id); if (userLoc) select(userLoc.lat, userLoc.lon); };
    L.appendChild(b);
  };
  mk('combined', '★ Combined: where is Earth changing most?', 'combined');
  for (const v of manifest.variables) mk(v.id, v.name);
  $('baseMap').onchange = (e) => { baseStyle = e.target.value; paint(); };
  $('colorBy').onchange = (e) => { colorBy = e.target.value; setMode(mode); };
  $('observedOnly').onchange = (e) => { interp = !e.target.checked; setMode(mode); };
  $('spin').onchange = (e) => { controls.autoRotate = e.target.checked; if (e.target.checked) anim = null; };
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
  if (places.length) showPlaces(places, { overview: showOv }); else showOverview();
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
    else html += `<div class="verdict none">Combined change score: <b>${s.toFixed(2)}</b> (0–1).<br>${combined.nsig[idx]} of ${combined.nvalid[idx]} variables show a significant trend.</div>`;
    if (combined.nfilled[idx] > 0) html += `<div class="interpbox">▨ <b>This zone includes interpolated data</b> (that is why it is striped): ${combined.nfilled[idx]} of ${combined.nvalid[idx]} variables here were estimated from surrounding cells rather than measured directly. They are marked “(interp.)” below.</div>`;
    html += '<table><tr><th>Variable</th><th class="num">Rate / yr</th><th class="num">p</th></tr>';
    for (const v of Object.values(vars)) {
      const j = v.eff[idx] >= 0 ? v.eff[idx] : idx, p = v.p[j];
      html += isNaN(p)
        ? `<tr><td>${v.name}</td><td class="num" colspan="2" style="color:#93a0bd">no data</td></tr>`
        : `<tr><td><span class="dot ${p < manifest.alpha ? 's' : 'n'}"></span>${v.name}${v.filled[j] === 1 ? ' <span class="interp" title="interpolated">(interp.)</span>' : ''}</td><td class="num">${v.slope[j] > 0 ? '+' : ''}${fmt(v.slope[j])} ${v.unit}</td><td class="num">${pTxt(p)}</td></tr>`;
    }
    html += '</table><p style="color:#93a0bd;font-size:12px">Green dot = significant (p &lt; 0.05). Pick a layer on the left to see its time series.</p></div>';
    return { html, draw };
  }

  const v = vars[mode], i = v.eff[idx] >= 0 ? v.eff[idx] : idx, p = v.p[i], slope = v.slope[i];
  if (isNaN(p)) return { html: html + `<div class="verdict none">No ${v.name.toLowerCase()} data at this location.</div></div>`, draw };
  const sig = p < manifest.alpha;
  const total = slope * (v.trend_years - 1);
  if (v.filled[i] === 1) html += `<div class="interpbox">▨ <b>This zone is interpolated</b> (that is why it is drawn with stripes). It has no direct ${v.name.toLowerCase()} measurement of its own, so its value is estimated from the surrounding cells by <a href="${WIKI}Inverse_distance_weighting" target="_blank" rel="noopener">inverse-distance weighting</a>. Treat it as less certain than observed cells.</div>`;
  html += `<div class="verdict ${sig ? 'sig' : 'nosig'}">${sig ? '<b>Significant trend.</b>' : '<b>Not significant.</b>'} ${v.name} is ${slope > 0 ? 'rising' : 'falling'} by about <b>${fmt(Math.abs(slope))} ${v.unit}/yr</b> (${total > 0 ? '+' : '−'}${fmt(Math.abs(total), 2)} over ${v.trend_years} years). <a href="${WIKI}Kendall_rank_correlation_coefficient" target="_blank" rel="noopener">Mann-Kendall</a> p = ${pTxt(p)} (Z = ${v.z[i].toFixed(2)}).${sig ? '' : ' This could be natural variability; a longer record might make it significant.'}</div>`;
  html += `<canvas class="chart" id="chart${k}" width="640" height="340"></canvas></div>`;
  return { html, draw: () => chart($(`chart${k}`), v, i, slope, sig) };
}

// Pin one or more places and show their details. opts: {fly, overview, dist}
function showPlaces(list, opts = {}) {
  places = list; selected = list[0] || null; showOv = !!opts.overview;
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
  if (list.length > 1 || mode !== 'combined') html += `<div style="color:#93a0bd;font-size:12px;margin-top:6px">Charts: yearly average with the fitted linear trend. Seasonal cycle removed for the trend test.</div>`;
  $('detail').innerHTML = html + (showOv ? '' : HINT_LOCAL);
  parts.forEach((x) => x.draw && x.draw());
}
const select = (lat, lon, fly = false) => showPlaces([{ lat, lon }], { fly });

function chart(c, v, idx, slope, sig) {
  const { nlat, nlon, n_years, start_year } = manifest, N = nlat * nlon;
  const ys = Array.from({ length: n_years }, (_, k) => v.annual[k * N + idx]);
  const k0 = ys.findIndex((y) => !isNaN(y)); // some layers only have a trend window starting later in the record
  const valid = ys.filter((y) => !isNaN(y));
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const trend = ys.map((_, k) => mean + slope * (k - (k0 + n_years - 1) / 2));
  const lo = Math.min(...valid, trend[k0], trend[n_years - 1]), hi = Math.max(...valid, trend[k0], trend[n_years - 1]), pad = (hi - lo) * 0.1 || 1;
  const g = c.getContext('2d'), W = c.width, H = c.height, m = { l: 56, r: 12, t: 12, b: 28 };
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

function overviewHTML() {
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
  return html;
}

function showOverview() {
  places = []; selected = null; showOv = false; markers.forEach((m) => (m.visible = false));
  anim = null; controls.autoRotate = $('spin').checked; // resume spinning if auto-rotate is on
  let html = overviewHTML();
  html += `<div class="tip">👆 <b>Click anywhere on the globe</b> to see the numbers, region and time series for that spot. Click off the globe to come back to this overview.</div>`;
  if (userLoc) html += `<div class="here">📍 Location access is on. <button class="demo" onclick="window.__home()">Show stats for where I am</button></div>`;
  else html += `<div class="hint">Tip: “Use my location” (bottom of the globe) shows these statistics for where you are.</div>`;
  $('detail').innerHTML = html;
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
