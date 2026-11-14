import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { feature, mesh } from 'topojson-client';
import world from 'world-atlas/countries-110m.json';

// ---------- colour maps ----------
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const ramp = (stops) => {
  const s = stops.map(([t, c]) => [t, hex(c)]);
  return (t) => {
    t = Math.min(1, Math.max(0, t));
    for (let i = 1; i < s.length; i++) {
      if (t <= s[i][0]) {
        const f = (t - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
        return s[i - 1][1].map((v, k) => v + (s[i][1][k] - v) * f);
      }
    }
    return s[s.length - 1][1];
  };
};
// diverging (falling -> rising), t in 0..1 with 0.5 = no change
const DIVERGING = ramp([[0, '#1f5fa8'], [0.25, '#6fa8dc'], [0.5, '#eeeae2'], [0.75, '#f0a060'], [1, '#b2182b']]);
// sequential (little change -> a lot of change)
const SEQUENTIAL = ramp([[0, '#1b1440'], [0.4, '#6a2c91'], [0.7, '#e0527e'], [1, '#ffe08a']]);
const NO_DATA = [38, 44, 60];
const FADE = [92, 100, 118];

// ---------- state ----------
let manifest, vars = {}, combined;
let mode = 'combined';
let sigOnly = true;
let selected = null; // {lat, lon}
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
    vars[v.id] = { ...v, slope: a.subarray(0, N), z: a.subarray(N, 2 * N), p: a.subarray(2 * N, 3 * N), annual: a.subarray(3 * N, 3 * N + n_years * N) };
  }
  const c = await loadBin('combined');
  combined = { score: c.subarray(0, N), nsig: c.subarray(N, 2 * N), nvalid: c.subarray(2 * N, 3 * N) };
  // stretch combined score between its 2nd and 98th percentile so hot-spots stand out
  const vals = Array.from(combined.score).filter((x) => !isNaN(x)).sort((a, b) => a - b);
  combined.lo = vals[Math.floor(vals.length * 0.02)];
  combined.hi = vals[Math.floor(vals.length * 0.98)];

  $('banner').hidden = !manifest.synthetic;
  $('method').textContent = `${manifest.method.trend} ${manifest.method.combined}`;
  buildUI();
  buildGlobe();
  setMode('combined');
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
const TW = 1440, TH = 720;
const canvas = document.createElement('canvas');
canvas.width = TW; canvas.height = TH;
const ctx = canvas.getContext('2d');
let texture;

function paint() {
  const img = ctx.createImageData(TW, TH);
  const v = mode === 'combined' ? null : vars[mode];
  for (let py = 0; py < TH; py++) {
    const lat = 90 - ((py + 0.5) / TH) * 180;
    for (let px = 0; px < TW; px++) {
      const lon = ((px + 0.5) / TW) * 360 - 180;
      let col = NO_DATA;
      if (v) {
        const s = sample(v.slope, lat, lon);
        if (!isNaN(s)) {
          col = DIVERGING(0.5 + (0.5 * s) / v.slope_p98);
          if (sigOnly) {
            const p = v.p[cellIndex(lat, lon)];
            if (p >= manifest.alpha) col = col.map((c, k) => c * 0.3 + FADE[k] * 0.7);
          }
        }
      } else {
        const s = sample(combined.score, lat, lon);
        if (!isNaN(s)) col = SEQUENTIAL((s - combined.lo) / (combined.hi - combined.lo));
      }
      const o = (py * TW + px) * 4;
      img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // coastlines / borders
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const m = mesh(world, world.objects.countries);
  for (const line of m.coordinates) {
    let prev = null;
    for (const [lon, lat] of line) {
      const x = ((lon + 180) / 360) * TW, y = ((90 - lat) / 180) * TH;
      if (!prev || Math.abs(x - prev) > TW / 2) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      prev = x;
    }
  }
  ctx.stroke();
  if (texture) texture.needsUpdate = true;
}

// ---------- globe ----------
let scene, camera, renderer, controls, globe, marker, anim = null;
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
    b.onclick = () => setMode(id);
    L.appendChild(b);
  };
  mk('combined', '★ Combined: where is Earth changing most?', 'combined');
  for (const v of manifest.variables) mk(v.id, v.name);
  $('sigOnly').onchange = (e) => { sigOnly = e.target.checked; paint(); };
  $('spin').onchange = (e) => { controls.autoRotate = e.target.checked; };
  $('close').onclick = () => { $('right').hidden = true; marker.visible = false; selected = null; };

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
    legend(DIVERGING, `−${v.slope_p98.toPrecision(2)} ${v.unit}/yr`, `+${v.slope_p98.toPrecision(2)} ${v.unit}/yr`, 'Rate of change (falling → rising)');
  }
  if (selected) select(selected.lat, selected.lon, false);
}

function legend(fn, lo, hi, title) {
  const el = $('legend');
  el.innerHTML = `<div>${title}</div><canvas width="256" height="1"></canvas><div class="ends"><span>${lo}</span><span>${hi}</span></div>`;
  const c = el.querySelector('canvas').getContext('2d');
  for (let x = 0; x < 256; x++) { const [r, g, b] = fn(x / 255); c.fillStyle = `rgb(${r},${g},${b})`; c.fillRect(x, 0, 1, 1); }
}

// ---------- detail panel ----------
const fmt = (x, d = 3) => (Math.abs(x) < 0.001 && x !== 0 ? x.toExponential(1) : x.toFixed(d));
const pTxt = (p) => (p < 0.001 ? '<0.001' : p.toFixed(3));

function select(lat, lon, fly = false) {
  selected = { lat, lon };
  const idx = cellIndex(lat, lon);
  marker.position.copy(toVec(lat, lon, R * 1.005)); marker.visible = true;
  if (fly) flyTo(lat, lon);
  $('right').hidden = false;
  const ns = lat >= 0 ? 'N' : 'S', ew = lon >= 0 ? 'E' : 'W';
  let html = `<h3>${mode === 'combined' ? 'Everything here' : vars[mode].name}</h3><div class="coord">${Math.abs(lat).toFixed(1)}°${ns}, ${Math.abs(lon).toFixed(1)}°${ew}</div>`;

  if (mode === 'combined') {
    const s = combined.score[idx];
    if (isNaN(s)) html += `<div class="verdict none">Not enough data here (need at least 2 variables).</div>`;
    else html += `<div class="verdict none">Combined change score: <b>${s.toFixed(2)}</b> (0–1).<br>${combined.nsig[idx]} of ${combined.nvalid[idx]} variables show a significant trend.</div>`;
    html += '<table><tr><th>Variable</th><th class="num">Rate / yr</th><th class="num">p</th></tr>';
    for (const v of Object.values(vars)) {
      const p = v.p[idx];
      html += isNaN(p)
        ? `<tr><td>${v.name}</td><td class="num" colspan="2" style="color:#93a0bd">no data</td></tr>`
        : `<tr><td><span class="dot ${p < manifest.alpha ? 's' : 'n'}"></span>${v.name}</td><td class="num">${v.slope[idx] > 0 ? '+' : ''}${fmt(v.slope[idx])} ${v.unit}</td><td class="num">${pTxt(p)}</td></tr>`;
    }
    html += '</table><p style="color:#93a0bd;font-size:12px">Green dot = significant (p &lt; 0.05). Pick a layer on the left to see its time series.</p>';
    $('detail').innerHTML = html;
    return;
  }

  const v = vars[mode], p = v.p[idx], slope = v.slope[idx];
  if (isNaN(p)) { $('detail').innerHTML = html + `<div class="verdict none">No ${v.name.toLowerCase()} data at this location.</div>`; return; }
  const sig = p < manifest.alpha;
  const total = slope * (manifest.n_years - 1);
  html += `<div class="verdict ${sig ? 'sig' : 'nosig'}">${sig ? '<b>Significant trend.</b>' : '<b>Not significant.</b>'} ${v.name} is ${slope > 0 ? 'rising' : 'falling'} by about <b>${fmt(Math.abs(slope))} ${v.unit}/yr</b> (${total > 0 ? '+' : '−'}${fmt(Math.abs(total), 2)} over ${manifest.n_years} years). Mann-Kendall p = ${pTxt(p)}, Z = ${v.z[idx].toFixed(2)}.${sig ? '' : ' This could be natural variability; a longer record might make it significant.'}</div>`;
  html += `<canvas id="chart" width="640" height="340"></canvas><div style="color:#93a0bd;font-size:12px;margin-top:6px">Yearly average with the fitted linear trend. Seasonal cycle removed for the trend test.</div>`;
  $('detail').innerHTML = html;
  chart(v, idx, slope, sig);
}

function chart(v, idx, slope, sig) {
  const { nlat, nlon, n_years, start_year } = manifest, N = nlat * nlon;
  const ys = Array.from({ length: n_years }, (_, k) => v.annual[k * N + idx]);
  const mean = ys.reduce((a, b) => a + b, 0) / n_years;
  const trend = ys.map((_, k) => mean + slope * (k - (n_years - 1) / 2));
  const lo = Math.min(...ys, ...trend), hi = Math.max(...ys, ...trend), pad = (hi - lo) * 0.1 || 1;
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
  ys.forEach((y, k) => (k ? g.lineTo(X(k), Y(y)) : g.moveTo(X(k), Y(y)))); g.stroke();
  g.strokeStyle = sig ? '#4ade80' : '#d6c64a'; g.setLineDash(sig ? [] : [8, 6]); g.lineWidth = 3;
  g.beginPath(); g.moveTo(X(0), Y(trend[0])); g.lineTo(X(n_years - 1), Y(trend[n_years - 1])); g.stroke(); g.setLineDash([]);
}

// ---------- guided demos ----------
const DEMOS = [
  { title: '1. Arctic warming', mode: 'temp', lat: 78, lon: 20, text: 'Temperature is rising fastest near the Arctic. The significant (bright red) cells show where warming stands out from natural year-to-year noise.' },
  { title: '2. Two places, opposite trends (aerosols)', mode: 'aod', lat: 28, lon: 82, text: 'Aerosols are increasing over South Asia but decreasing over Europe and East Asia: the same variable can trend in opposite directions in different regions. Click both to compare.' },
  { title: '3. Amazon browning, Siberia greening', mode: 'ndvi', lat: -5, lon: -62, text: 'Vegetation greenness is falling in the Amazon basin while northern high latitudes green up.' },
  { title: '4. Put it together', mode: 'combined', lat: 40, lon: -50, text: 'The combined layer ranks places by how much of the Earth system is changing at once, regardless of direction or units.' },
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
