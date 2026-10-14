import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { initBodies, createBody, poseBody } from './body.js';
import { buildVolcanoFX, palmGeometries, deadTreeGeometry, spireGeometry } from './volcano.js';
import { U, addWind, terrainMaterial, triplanar, loadTextures, GradeShader, seaDepthTexture, waterMaterial, makeGrass, makeBirds } from './environment.js';
import { leafClusterTexture, needleTexture, broadleafGeometry, pineGeometry, bushGeometry, rockGeometry } from './flora.js';
import { buildTunnels, tunnelSize } from './tunnel.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ============================================================ utils
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mod = (a, n) => ((a % n) + n) % n;
const nextFrame = () => new Promise(requestAnimationFrame);
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rand = mulberry32(20261014);
const rr = (a, b) => a + (b - a) * rand();
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const fmtTime = (t) => { t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60); return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
const fmtGap = (t) => { const a = Math.abs(t), s = t > 0 ? '+' : t < 0 ? '-' : ''; return a < 60 ? `${s}${a.toFixed(0)}s` : `${s}${Math.floor(a / 60)}:${String(Math.floor(a % 60)).padStart(2, '0')}`; };

// Perlin noise
const perm = new Uint8Array(512);
{
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
}
function grad(h, x, y) { switch (h & 7) { case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y; case 4: return x; case 5: return -x; case 6: return y; default: return -y; } }
function noise2(x, y) {
  const fx = Math.floor(x), fy = Math.floor(y), X = fx & 255, Y = fy & 255;
  x -= fx; y -= fy;
  const u = x * x * x * (x * (x * 6 - 15) + 10), v = y * y * y * (y * (y * 6 - 15) + 10);
  const a = perm[X] + Y, b = perm[X + 1] + Y;
  return lerp(lerp(grad(perm[a], x, y), grad(perm[b], x - 1, y), u), lerp(grad(perm[a + 1], x, y - 1), grad(perm[b + 1], x - 1, y - 1), u), v);
}
function fbm(x, y, o) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < o; i++) { s += a * noise2(x * f, y * f); f *= 2.03; a *= 0.5; } return s; }
function ridge(x, y) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < 5; i++) { const n = 1 - Math.abs(noise2(x * f, y * f)); s += a * n * n; f *= 2.1; a *= 0.5; } return s; }

// ============================================================ physics
const G = 9.81, RHO = 1.225, CRR = 0.004, BIKE_KG = 8, WHEEL_R = 0.335;
const resist = (v, grade, mass, cda, draft) => { const th = Math.atan(grade); return mass * G * (Math.sin(th) + CRR * Math.cos(th)) + 0.5 * RHO * cda * (1 - draft) * v * v; };
const powerFor = (r, v, grade, draft) => Math.max(0, v * resist(v, grade, r.mass + BIKE_KG, r.cda, draft));

// ============================================================ worlds
// A world defines the route (polar radius + elevation), terrain height and colouring, atmosphere and flora.
// layer compositing: paint layer i over the current weights with opacity a
const over = (w, i, a) => { if (a <= 0) return; a = Math.min(1, a); for (let k = 0; k < w.length; k++) w[k] *= 1 - a; w[i] += a; };
const rollers = (t) => 0.8 * Math.sin(t * Math.PI * 2 * 29) + 0.4 * Math.sin(t * Math.PI * 2 * 53 + 1);
const angDist = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const cone = (r) => 560 * Math.exp(-((r / 1000) ** 1.5)); // Fuego's volcano profile
const FUEGO_RP = 1250, FUEGO_CAVE = 175; // radius where the route enters the mountain; cavern floor height
const WORLD_CRATER_FLOOR = 640;
const WORLDS = {
  verde: (() => {
    const HV = [20, 24, 34, 28, 30, 52, 82, 112, 100, 72, 48, 54, 40, 30, 22, 20], n = HV.length; // periodic Catmull-Rom profile
    const G1 = new THREE.Color(0x3f7426), G2 = new THREE.Color(0x7fae43), DRY = new THREE.Color(0xa8a35e), ROCK = new THREE.Color(0x857e74),
      SNOW = new THREE.Color(0xf4f7fb), SAND = new THREE.Color(0xd8c690), VERGE = new THREE.Color(0x8f9a55);
    return {
      id: 'verde', name: 'Isla Verde', tagline: 'Virtual cycling · Isla Verde', points: 30, kom: [[0.18, 0.32], [0.38, 0.5]],
      radius: (a) => 1350 * (1 + 0.17 * Math.sin(3 * a + 0.5) + 0.11 * Math.cos(5 * a + 1.3) + 0.05 * Math.sin(9 * a + 2)),
      elev: (t) => {
        const f = (t % 1) * n, j = Math.floor(f), u = f - j, p0 = HV[(j - 1 + n) % n], p1 = HV[j % n], p2 = HV[(j + 1) % n], p3 = HV[(j + 2) % n];
        return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u) + rollers(t);
      },
      height: (x, z) => {
        const r = Math.hypot(x, z);
        let h = 16 + fbm(x / 700 + 3.1, z / 700 - 1.7, 4) * 48 + fbm(x / 140, z / 140, 3) * 6;
        h -= 42 * (1 - smooth(350, 1050, r)); // central lake
        const m = smooth(2050, 3100, r); // mountain ring
        if (m > 0) h += m * (160 + ridge(x / 1100, z / 1100) * 460);
        return h;
      },
      // layers: 0 grass, 1 soil, 2 cliff rock (triplanar), 3 beach sand, 4 snow; c = macro tint
      layers: [{ tex: 'grass004', scale: 3.5, tint: 0xc4dcae, rough: 0.95 }, { tex: 'ground037', scale: 4, tint: 0xd8d0c4, rough: 0.9 }, { tex: 'rock051', scale: 9, rough: 0.8 }, { tex: 'ground054', scale: 5, tint: 0xf3e6c8, rough: 0.9 }, { tex: 'snow015', scale: 6, rough: 0.55 }],
      color: (c, x, z, h, ny, d, lava, w) => {
        w.fill(0); w[0] = 1;
        over(w, 1, clamp(fbm(x / 160 + 4, z / 160, 3) * 2.2 - 0.25, 0, 0.8) + clamp(fbm(x / 25, z / 25, 2) * 2 - 0.35, 0, 0.5) + smooth(13, 8.5, d) * 0.7);
        over(w, 3, smooth(3.2, 0.9, h));
        over(w, 2, smooth(0.86, 0.66, ny));
        over(w, 4, smooth(310, 370, h + fbm(x / 80, z / 80, 2) * 50) * smooth(0.55, 0.78, ny));
        const dry = clamp(fbm(x / 420 + 9, z / 420, 2) * 2.2 + fbm(x / 45, z / 45, 2) * 0.8, 0, 0.75), v = 0.88 + fbm(x / 60, z / 60, 2) * 0.6 + fbm(x / 12, z / 12, 2) * 0.25;
        c.setRGB(v * (1 + dry * 0.35), v * (1 + dry * 0.1), v * (1 - dry * 0.45));
      },
      hdri: 'kloofendal_48d_partly_cloudy_puresky', skyYaw: 0, grassColor: 0x6c9a3a, foliage: [0x8fb85a, 0x5f8f38], needles: [0x4f7a3c, 0x36602e],
      grade: { sat: 1.12, con: 1.07, vig: 0.24, gain: [1, 1, 0.98], lift: [0, 0, 0.01] },
      sky: { elev: 36, azim: 205, turbidity: 2.6, rayleigh: 1.1, mie: 0.004, mieG: 0.86 },
      fog: [0xb9d2e6, 0.00014], exposure: 0.68, env: 1, hemi: [0xd8ecff, 0x56663a, 0.25], sun: [0xffffff, 3.2],
      water: 0x175d84, verge: 0x8e9468, mini: [[0, '#2b6f9a'], [0.35, '#3c6a35'], [1, '#2b3b2a']],
      sea: { deep: 0x0f4d73, shallow: 0x3fb8b0 }, sprint: [0.915, 0.972], pu: [0.12, 0.63],
      birds: { color: 0x2a2a2e, flocks: [[0, 70, 0, 300, 14, 0.05], [1500, 120, -900, 200, 10, -0.07], [-1300, 150, 1100, 180, 9, 0.06]] }, // x,y,z,radius,n,speed
    };
  })(),
  fuego: (() => {
    const BASALT = new THREE.Color(0x2a2523), RUST = new THREE.Color(0x5e3424), ASH = new THREE.Color(0x77706b), JUNGLE = new THREE.Color(0x2c5a1f),
      JUNGLE2 = new THREE.Color(0x4c7d27), DARK = new THREE.Color(0x1d1a19), SAND = new THREE.Color(0x1c1a1a), SCORCH = new THREE.Color(0x140b08),
      EMBER = new THREE.Color(0x6a1d08), VERGE = new THREE.Color(0x3d3631), tmp = new THREE.Color();
    return {
      id: 'fuego', name: 'Fuego', tagline: 'Virtual cycling · Fuego volcano', points: 48, kom: [[0.6, 0.9], [0.8, 1]],
      // the lap starts in a cavern deep inside the volcano (bearing 0): tunnel out, descend to the coast,
      // ride around the island, then climb back up the flank and through the mountain to the finish
      radius: (a) => { const d = angDist(a, 0); return 1880 + 70 * Math.sin(3 * a + 1) + 40 * Math.sin(7 * a) - 1380 * Math.exp(-((d / (d < 0 ? 0.85 : 0.7)) ** 2)); },
      // outside the mountain the road hugs the (later smoothed) ground; inside it follows the tunnel profile
      elev: (t, x, z) => {
        const r = Math.hypot(x, z);
        return r >= FUEGO_RP ? Math.max(14, WORLDS.fuego.height(x, z) + 1.5) : lerp(cone(FUEGO_RP), FUEGO_CAVE, smooth(FUEGO_RP, 600, r));
      },
      smoothElev: 70, tunnels: true, chamber: 150,
      height: (x, z) => {
        const r = Math.hypot(x, z), a = Math.atan2(z, x);
        let h = cone(r) + 320 * Math.exp(-((r / 560) ** 2)); // steep upper cone; negligible where the road runs
        const flank = smooth(250, 650, r) * (1 - smooth(1800, 2400, r)); // radial erosion gullies
        h += (ridge(Math.cos(a) * 8 + r / 700, Math.sin(a) * 8 - r / 900) - 0.45) * 60 * flank;
        h += fbm(x / 450 + 5, z / 450, 4) * 26 + fbm(x / 90, z / 90, 3) * 4;
        if (r < 340) h += (WORLD_CRATER_FLOOR + fbm(x / 60, z / 60, 2) * 8 - h) * smooth(310, 175, r); // crater
        return h - smooth(2150, 2750, r) * 110; // island edge drops into the sea
      },
      // layers: 0 jungle grass, 1 volcanic soil, 2 basalt (triplanar), 3 black sand, 4 ash
      layers: [{ tex: 'grass004', scale: 3.5, tint: 0xa6c48c, rough: 0.95 }, { tex: 'ground037', scale: 4, tint: 0x8c6c5a, rough: 0.92 }, { tex: 'rock058', scale: 8, tint: 0xc8aa98, rough: 0.75 }, { tex: 'ground054', scale: 5, tint: 0x3c3836, rough: 0.85 }, { tex: 'ground054', scale: 7, tint: 0x8a8380, rough: 0.95 }],
      color: (c, x, z, h, ny, d, lava, w) => {
        w.fill(0); w[1] = 1;
        over(w, 0, smooth(120, 45, h + fbm(x / 160, z / 160, 3) * 60) * smooth(2.5, 7, h) * clamp(0.55 + fbm(x / 230, z / 230, 3) * 1.8, 0, 1));
        over(w, 4, smooth(150, 330, h + fbm(x / 90, z / 90, 2) * 50) * 0.85);
        over(w, 3, smooth(4, 0.8, h));
        over(w, 2, smooth(0.84, 0.62, ny) + smooth(30, 6, lava) * 0.8);
        over(w, 1, smooth(13, 8.5, d) * 0.5);
        const v = 0.85 + fbm(x / 70, z / 70, 2) * 0.6 + fbm(x / 12, z / 12, 2) * 0.25, burn = smooth(45, 10, lava), glow = smooth(14, 4, lava);
        c.setRGB(v * (1 - burn * 0.6) + glow * 0.9, v * (1 - burn * 0.7) + glow * 0.15, v * (1 - burn * 0.75));
      },
      hdri: 'qwantani_sunset_puresky', skyYaw: 0, grassColor: 0x58802e, foliage: [0x5f9a3a, 0x3f7426], needles: [0x4a6a34, 0x34522a],
      grade: { sat: 1.08, con: 1.1, vig: 0.32, gain: [1.04, 0.99, 0.94], lift: [0.012, 0.004, 0] },
      rivers: [[2.3, 1580, 1], [3.2, 1640, 2], [4.05, 1560, 3]], // [bearing, end radius, seed]
      sea: { deep: 0x0a2d45, shallow: 0x2a8f8a }, sprint: [0.46, 0.51], pu: [0.24, 0.68],
      birds: { color: 0x1c1a1a, flocks: [[0, 80, 2150, 160, 10, 0.06], [-2150, 70, 0, 140, 9, -0.05], [0, 90, -2150, 170, 11, 0.05], [1600, 260, 900, 220, 8, -0.04]] },
      crater: { y: WORLD_CRATER_FLOOR + 3, r: 182 },
      sky: { elev: 7, azim: 250, turbidity: 10, rayleigh: 3, mie: 0.003, mieG: 0.8 },
      fog: [0x9c7a6c, 0.00022], exposure: 0.95, env: 1, hemi: [0xffc8a0, 0x3a2a24, 0.3], sun: [0xffffff, 3],
      water: 0x0d3550, verge: 0x6a5a50, bloom: [0.6, 0.45, 2.2], // [strength, radius, HDR threshold]
      mini: [[0, '#ff7a2a'], [0.08, '#7a2a12'], [0.16, '#3a302c'], [0.55, '#2e3a25'], [0.72, '#123a52'], [1, '#0b2a3d']],
    };
  })(),
};
const WORLD_ID = new URLSearchParams(location.search).get('map') === 'fuego' ? 'fuego' : 'verde';
const WORLD = WORLDS[WORLD_ID];

// ============================================================ course
const ROAD_W = 12, M = 4096;
const C = (() => {
  const N = WORLD.points, pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2, r = WORLD.radius(a);
    pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  curve.arcLengthDivisions = 10000;
  const sp = curve.getSpacedPoints(M);
  const X = new Float32Array(M + 1), Y = new Float32Array(M + 1), Z = new Float32Array(M + 1);
  const PSI = new Float64Array(M + 1), GR = new Float32Array(M + 1), K = new Float32Array(M + 1);
  let L = 0;
  for (let i = 0; i <= M; i++) { X[i] = sp[i].x; Z[i] = sp[i].z; if (i) L += Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]); }
  for (let i = 0; i <= M; i++) Y[i] = WORLD.elev((i % M) / M, X[i % M], Z[i % M]);
  if (WORLD.smoothElev) { // circular box blur, three passes ≈ gaussian over ±smoothElev samples
    const w = WORLD.smoothElev, tmp = new Float32Array(M);
    for (let pass = 0; pass < 3; pass++) {
      let acc = 0;
      for (let k = -w; k <= w; k++) acc += Y[mod(k, M)];
      for (let i = 0; i < M; i++) { tmp[i] = acc / (2 * w + 1); acc += Y[mod(i + w + 1, M)] - Y[mod(i - w, M)]; }
      Y.set(tmp); Y[M] = Y[0];
    }
  }
  // tunnels wherever the ground rises well above the road; short gaps are closed and stubs dropped
  const T = new Uint8Array(M + 1), Dp = new Float32Array(M + 1), runs = [];
  const runsOf = (v) => {
    const start = T.findIndex((x, i) => i < M && x !== T[(i - 1 + M) % M]), out = [];
    if (start < 0) return T[0] === v ? [[0, M]] : [];
    for (let n = 0; n < M;) { const i = (start + n) % M, val = T[i]; let len = 0; while (n + len < M && T[(i + len) % M] === val) len++; if (val === v) out.push([i, len]); n += len; }
    return out;
  };
  if (WORLD.tunnels) {
    for (let i = 0; i < M; i++) T[i] = WORLD.height(X[i], Z[i]) - Y[i] > 14 ? 1 : 0;
    for (const [i, len] of runsOf(0)) if (len < 30) for (let k = 0; k < len; k++) T[(i + k) % M] = 1;
    for (const [i, len] of runsOf(1)) if (len < 40) for (let k = 0; k < len; k++) T[(i + k) % M] = 0;
    for (const [i, len] of runsOf(1)) { runs.push([i - 3, len + 6]); for (let k = 0; k < len; k++) Dp[(i + k) % M] = (Math.min(k, len - 1 - k) * L) / M; }
    T[M] = T[0]; Dp[M] = Dp[0];
  }
  const chamber = (i) => (T[i] && WORLD.chamber ? smooth(WORLD.chamber + 80, WORLD.chamber, (Math.min(i, M - i) * L) / M) : 0);
  for (let i = 0; i <= M; i++) {
    const a = i % M;
    let p = Math.atan2(X[a + 1] - X[a], Z[a + 1] - Z[a]);
    if (i) { while (p - PSI[i - 1] > Math.PI) p -= 2 * Math.PI; while (p - PSI[i - 1] < -Math.PI) p += 2 * Math.PI; }
    PSI[i] = p;
  }
  const wind = PSI[M] - PSI[0], ds = L / M, w = 8;
  const psiAt = (j) => (j < 0 ? PSI[j + M] - wind : j > M ? PSI[j - M] + wind : PSI[j]);
  for (let i = 0; i <= M; i++) {
    K[i] = (psiAt(i + w) - psiAt(i - w)) / (2 * w * ds);
    GR[i] = (Y[mod(i + w, M)] - Y[mod(i - w, M)]) / (2 * w * ds);
  }
  const [[s0, s1], [e0, e1]] = WORLD.kom;
  let kS = Math.floor(M * s0), kE = Math.floor(M * e0);
  for (let i = kS; i < M * s1; i++) if (!T[i] && Y[i] < Y[kS]) kS = i;
  for (let i = kE; i < M * e1; i++) if (!T[i] && (T[kE] || Y[i] > Y[kE])) kE = i;
  const at = (s, o) => {
    const f = (mod(s, L) / L) * M, i = Math.min(M - 1, f | 0), u = f - i;
    o.x = lerp(X[i], X[i + 1], u); o.y = lerp(Y[i], Y[i + 1], u); o.z = lerp(Z[i], Z[i + 1], u);
    o.psi = lerp(PSI[i], PSI[i + 1], u); o.grade = lerp(GR[i], GR[i + 1], u); o.k = lerp(K[i], K[i + 1], u);
    return o;
  };
  return { X, Y, Z, PSI, GR, K, L, at, T, D: Dp, runs, chamber, komS: (kS / M) * L, komE: (kE / M) * L };
})();
const L = C.L;
const SEGS = [
  { id: 'kom', name: 'KOM', icon: '⛰', start: C.komS, end: C.komE, color: '#e3242b', best: [] },
  { id: 'sprint', name: 'SPRINT', icon: '⚡', start: WORLD.sprint[0] * L, end: WORLD.sprint[1] * L, color: '#18c26b', best: [] },
];
const PU_ARCHES = WORLD.pu.map((f) => f * L);
const POWERUPS = {
  feather: { icon: '🪶', name: 'FEATHERWEIGHT', dur: 15, desc: '-9 kg for 15s' },
  aero: { icon: '💨', name: 'AERO BOOST', dur: 15, desc: '-25% drag for 15s' },
  draft: { icon: '🌀', name: 'DRAFT BOOST', dur: 30, desc: '+50% draft for 30s' },
};

// ============================================================ renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
const TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0 || new URLSearchParams(location.search).has('touch');
if (TOUCH) document.body.classList.add('touch');
const buzz = (p) => navigator.vibrate?.(p); // haptics (Android; iOS Safari has no vibration API)
const FS_OK = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const LOW = new URLSearchParams(location.search).get('quality') === 'low'; // weak GPUs / software renderers: no grass, bloom or big shadow maps
renderer.setPixelRatio(Math.min(devicePixelRatio, TOUCH ? 1.5 : 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = WORLD.exposure;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('app').appendChild(renderer.domElement);
const labels = new CSS2DRenderer();
labels.setSize(innerWidth, innerHeight);
labels.domElement.id = 'labels';
$('app').appendChild(labels.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 15000);
const ANISO = renderer.capabilities.getMaxAnisotropy();

function canvasTex(w, h, draw, repeat = false, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// sky, sun, fog: an HDRI photo sky lights everything; sun direction, sun tint and haze colour are measured from it
const sunDir = new THREE.Vector3(0, 1, 0);
scene.fog = new THREE.FogExp2(...WORLD.fog);
const hemi = new THREE.HemisphereLight(...WORLD.hemi);
scene.add(hemi);
const sun = new THREE.DirectionalLight(...WORLD.sun);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(LOW ? 1024 : TOUCH ? 2048 : 4096);
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 10, far: 900 });
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
async function setupSky() {
  const hdr = await new RGBELoader().loadAsync(`assets/hdri/${WORLD.hdri}.hdr`);
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const { data, width: w, height: h } = hdr.image, half = (i) => THREE.DataUtils.fromHalfFloat(data[i]);
  let best = -1, bi = 0;
  for (let y = 0; y < h / 2; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, l = half(i) + half(i + 1) + half(i + 2); if (l > best) { best = l; bi = i; } }
  const px = (bi / 4) % w, py = Math.floor(bi / 4 / w), phi = ((px + 0.5) / w - 0.5) * Math.PI * 2, th = (0.5 - (py + 0.5) / h) * Math.PI;
  sunDir.set(Math.cos(th) * Math.cos(phi), Math.sin(th), Math.cos(th) * Math.sin(phi)).applyAxisAngle(UP, WORLD.skyYaw);
  const m = Math.max(half(bi), half(bi + 1), half(bi + 2));
  sun.color.setRGB(half(bi) / m, half(bi + 1) / m, half(bi + 2) / m).lerp(new THREE.Color(1, 1, 1), 0.35);
  const fog = [0, 0, 0], row = Math.floor(h / 2) - 3; // average sky colour just above the horizon becomes the haze
  for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) fog[c] += half((row * w + x) * 4 + c) / w;
  scene.fog.color.setRGB(...fog.map((v) => Math.min(v * 0.9, 1.4)));
  FOG_BASE.copy(scene.fog.color);
  scene.background = hdr;
  scene.backgroundRotation.y = scene.environmentRotation.y = WORLD.skyYaw;
  scene.environment = new THREE.PMREMGenerator(renderer).fromEquirectangular(hdr).texture;
  scene.environmentIntensity = WORLD.env;
}
// post: MSAA half-float render, optional bloom, tone mapping, then a display-space colour grade
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio(), { type: THREE.HalfFloatType, samples: LOW ? 0 : 4 }));
composer.addPass(new RenderPass(scene, camera));
if (!LOW) composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), ...(WORLD.bloom ?? [0.18, 0.4, 3])));
composer.addPass(new OutputPass());
{
  const grade = new ShaderPass(GradeShader), g = WORLD.grade, u = grade.uniforms;
  u.uSat.value = g.sat; u.uCon.value = g.con; u.uVig.value = g.vig; u.uGain.value.set(...g.gain); u.uLift.value.set(...g.lift);
  composer.addPass(grade);
}
let TX = null; // loaded photo textures (assets/tex), keyed by file stem

// ============================================================ terrain
const T_SIZE = 6400, T_SEG = 640, CELL = T_SIZE / T_SEG, TN = T_SEG + 1, HALF = T_SIZE / 2, ROAD_R = 150;
const tH = new Float32Array(TN * TN), rD = new Float32Array(TN * TN).fill(1e12), rE = new Float32Array(TN * TN), rI = new Int32Array(TN * TN);
const natH = (x, z) => WORLD.height(x, z);
// lava rivers: from the crater lake through a breach in the rim, down the flank; surface only ever descends
const RIVERS = (WORLD.rivers || []).map(([a0, rEnd, seed]) => {
  const pts = [];
  let y = WORLD.crater.y - 1;
  for (let r = WORLD.crater.r - 10; r <= rEnd; r += 6) {
    const a = a0 + 0.1 * Math.sin(r / 170 + seed) + 0.05 * Math.sin(r / 61 + seed * 2), x = Math.cos(a) * r, z = Math.sin(a) * r;
    y = Math.min(y - 0.02, natH(x, z) - 2.5);
    pts.push({ x, z, y, w: (7 + r / 140) * (1 + 1.6 * smooth(rEnd - 220, rEnd, r)), s: r });
  }
  return pts;
});
const lD = RIVERS.length ? new Float32Array(TN * TN).fill(1e12) : null, lE = lD && new Float32Array(TN * TN), lW = lD && new Float32Array(TN * TN);
const lavaDist = (x, z) => {
  if (!lD) return 1e6;
  const ix = Math.round((x + HALF) / CELL), iz = Math.round((z + HALF) / CELL);
  return ix < 0 || iz < 0 || ix >= TN || iz >= TN ? 1e6 : Math.max(0, Math.sqrt(lD[iz * TN + ix]) - lW[iz * TN + ix]);
};
function getH(x, z) {
  const fx = clamp((x + HALF) / CELL, 0, T_SEG - 1e-3), fz = clamp((z + HALF) / CELL, 0, T_SEG - 1e-3);
  const ix = fx | 0, iz = fz | 0, u = fx - ix, v = fz - iz, k = iz * TN + ix;
  return lerp(lerp(tH[k], tH[k + 1], u), lerp(tH[k + TN], tH[k + TN + 1], u), v);
}
const cellOf = (x, z) => { const ix = Math.round((x + HALF) / CELL), iz = Math.round((z + HALF) / CELL); return ix < 0 || iz < 0 || ix >= TN || iz >= TN ? -1 : iz * TN + ix; };
const roadDist = (x, z) => { const k = cellOf(x, z); return k < 0 ? 1e6 : Math.sqrt(rD[k]); };
// course sample index if (x,z) is inside a tunnel (within 30 m of its road), else -1
const tunnelAt = (x, z) => { const k = cellOf(x, z); return k >= 0 && rD[k] < 900 && C.T[rI[k]] ? rI[k] : -1; };
const groundAt = (x, z) => { const i = tunnelAt(x, z); return i >= 0 ? C.Y[i] - 0.8 : getH(x, z); };

const grassTint = new Uint8Array(TN * TN * 4);
function buildTerrain() {
  const RC = Math.ceil(ROAD_R / CELL);
  for (let i = 0; i < M; i++) {
    const cx = Math.round((C.X[i] + HALF) / CELL), cz = Math.round((C.Z[i] + HALF) / CELL);
    for (let gz = Math.max(0, cz - RC); gz <= Math.min(T_SEG, cz + RC); gz++) {
      for (let gx = Math.max(0, cx - RC); gx <= Math.min(T_SEG, cx + RC); gx++) {
        const k = gz * TN + gx, dx = gx * CELL - HALF - C.X[i], dz = gz * CELL - HALF - C.Z[i], d = dx * dx + dz * dz;
        if (d < rD[k]) { rD[k] = d; rE[k] = C.Y[i]; rI[k] = i; }
      }
    }
  }
  for (const pts of RIVERS) for (const p of pts) {
    const R = p.w + 40, rc = Math.ceil(R / CELL), cx = Math.round((p.x + HALF) / CELL), cz = Math.round((p.z + HALF) / CELL);
    for (let gz = cz - rc; gz <= cz + rc; gz++) for (let gx = cx - rc; gx <= cx + rc; gx++) {
      const k = gz * TN + gx, dx = gx * CELL - HALF - p.x, dz = gz * CELL - HALF - p.z, d = dx * dx + dz * dz;
      if (d < lD[k]) { lD[k] = d; lE[k] = p.y; lW[k] = p.w; }
    }
  }
  for (let iz = 0; iz < TN; iz++) for (let ix = 0; ix < TN; ix++) {
    const k = iz * TN + ix, d = Math.sqrt(rD[k]);
    let h = natH(ix * CELL - HALF, iz * CELL - HALF);
    if (d < ROAD_R) {
      const i = rI[k];
      if (C.T[i]) { // rock over the tunnel: a rounded, rough ridge rather than a flat plateau
        const ts = tunnelSize(C.chamber(i)), p = clamp(1 - (d / (ts.w + 50)) ** 2, 0, 1), x = ix * CELL - HALF, z = iz * CELL - HALF;
        h = Math.max(h, rE[k] + (ts.h + 6) * Math.sqrt(p) + fbm(x / 35, z / 35, 3) * 6 * p);
      }
      else h = lerp(rE[k] - 0.7, h, smooth(9, ROAD_R * 0.9, d));
    }
    if (lD && lD[k] < 1e11) { // carve the lava channel with raised levees
      const ld = Math.sqrt(lD[k]), w = lW[k], bed = lE[k] - 1.4;
      h = ld < w ? bed : lerp(bed, h + 3 * Math.exp(-(((ld - w - 6) / 6) ** 2)), smooth(w, w + 32, ld));
    }
    tH[k] = h;
  }
  const geo = new THREE.PlaneGeometry(T_SIZE, T_SIZE, T_SEG, T_SEG).rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let k = 0; k < pos.count; k++) {
    const ix = Math.round((pos.getX(k) + HALF) / CELL), iz = Math.round((pos.getZ(k) + HALF) / CELL);
    pos.setY(k, tH[iz * TN + ix]);
  }
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal, col = new Float32Array(pos.count * 3), sa = new Float32Array(pos.count * 4), sb = new Float32Array(pos.count), c = new THREE.Color(), w = new Float32Array(5);
  const gc = new THREE.Color(WORLD.grassColor);
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k), z = pos.getZ(k), h = pos.getY(k), ny = nrm.getY(k), d = roadDist(x, z);
    WORLD.color(c, x, z, h, ny, d, lavaDist(x, z), w);
    col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    sa.set(w.subarray(0, 4), k * 4); sb[k] = w[4];
    // grass blades where the grass layer dominates, off the road, not too steep, above the waterline
    const g = cellOf(x, z) * 4, dens = smooth(0.35, 0.8, w[0]) * smooth(8, 11, d) * smooth(1.5, 2.5, h) * smooth(0.78, 0.9, ny);
    grassTint[g] = clamp(gc.r * c.r, 0, 1) * 255; grassTint[g + 1] = clamp(gc.g * c.g, 0, 1) * 255; grassTint[g + 2] = clamp(gc.b * c.b, 0, 1) * 255; grassTint[g + 3] = dens * 255;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('splatA', new THREE.BufferAttribute(sa, 4));
  geo.setAttribute('splatB', new THREE.BufferAttribute(sb, 1));
  const mesh = new THREE.Mesh(geo, terrainMaterial(TX, WORLD.layers));
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// ============================================================ road
function buildRoad() {
  // painted lines as their own thin ribbons (sharp at any distance); dashes come from an alpha-tested texture
  const dash = canvasTex(4, 64, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h * 0.45); }, true);
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xeeeee6, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -4 });
  const dashMat = new THREE.MeshStandardMaterial({ color: 0xeeeee6, roughness: 0.55, map: dash, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -4 });
  for (const [lat, wd, mat] of [[-ROAD_W / 2 + 0.45, 0.2, lineMat], [ROAD_W / 2 - 0.45, 0.2, lineMat], [0, 0.14, dashMat]]) {
    const lp = [], luv = [], li = [];
    for (let i = 0; i <= M; i++) {
      const p = C.PSI[i], rx = -Math.cos(p), rz = Math.sin(p), v = (i * L) / M / 12;
      for (const o of [lat - wd / 2, lat + wd / 2]) { lp.push(C.X[i] + rx * o, C.Y[i] + 0.06, C.Z[i] + rz * o); luv.push(0.5, v); }
      if (i < M) { const a2 = i * 2; li.push(a2, a2 + 1, a2 + 2, a2 + 1, a2 + 3, a2 + 2); }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3)); lg.setAttribute('uv', new THREE.Float32BufferAttribute(luv, 2));
    lg.setIndex(li); lg.computeVertexNormals();
    const m = new THREE.Mesh(lg, mat); m.receiveShadow = true; scene.add(m);
  }
  const tex = TX.asphalt033_color;
  for (const t of [TX.asphalt033_color, TX.asphalt033_normal]) t.repeat.set(4, 5.33); // ~3 m tiles
  const pos = [], uv = [], idx = [], vpos = [], vidx = [];
  for (let i = 0; i <= M; i++) {
    const p = C.PSI[i], rx = -Math.cos(p), rz = Math.sin(p), x = C.X[i], y = C.Y[i], z = C.Z[i], v = (i * L) / M / 16;
    pos.push(x - rx * ROAD_W / 2, y + 0.05, z - rz * ROAD_W / 2, x + rx * ROAD_W / 2, y + 0.05, z + rz * ROAD_W / 2);
    uv.push(0, v, 1, v);
    const e = ROAD_W / 2, o = ROAD_W / 2 + 3.2;
    vpos.push(x - rx * o, y - 0.9, z - rz * o, x - rx * e, y + 0.02, z - rz * e, x + rx * e, y + 0.02, z + rz * e, x + rx * o, y - 0.9, z + rz * o);
    if (i < M) {
      const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      const b = i * 4; vidx.push(b, b + 1, b + 4, b + 1, b + 5, b + 4, b + 2, b + 3, b + 6, b + 3, b + 7, b + 6);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx); geo.computeVertexNormals();
  const road = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, normalMap: TX.asphalt033_normal, color: 0x8a8a8a, roughness: 0.88 }));
  road.receiveShadow = true;
  const vg = new THREE.BufferGeometry();
  vg.setAttribute('position', new THREE.Float32BufferAttribute(vpos, 3));
  vg.setIndex(vidx); vg.computeVertexNormals();
  const verge = new THREE.Mesh(vg, triplanar(new THREE.MeshStandardMaterial({ color: WORLD.verge, roughness: 1 }), TX.ground037_color, TX.ground037_normal, 4, 'verge'));
  verge.receiveShadow = true;
  scene.add(road, verge);
}

// ============================================================ water, vegetation, props
let waterTex;
function buildWater() {
  const S = 256, hgt = new Float32Array(S * S), waves = Array.from({ length: 10 }, () => [Math.round(rr(-6, 6)), Math.round(rr(-6, 6)), rr(0, 6.28), rr(0.3, 1)]);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let h = 0; for (const [kx, ky, ph, a] of waves) h += a * Math.sin((2 * Math.PI * (kx * x + ky * y)) / S + ph);
    hgt[y * S + x] = h;
  }
  waterTex = canvasTex(S, S, (g) => {
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = hgt[y * S + ((x + 1) % S)] - hgt[y * S + ((x - 1 + S) % S)], dy = hgt[((y + 1) % S) * S + x] - hgt[((y - 1 + S) % S) * S + x];
      const n = new THREE.Vector3(-dx, -dy, 4).normalize(), o = (y * S + x) * 4;
      img.data[o] = (n.x * 0.5 + 0.5) * 255; img.data[o + 1] = (n.y * 0.5 + 0.5) * 255; img.data[o + 2] = (n.z * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, true, false);
  waterTex.repeat.set(500, 500);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(T_SIZE * 2, T_SIZE * 2).rotateX(-Math.PI / 2),
    waterMaterial(waterTex, seaDepthTexture(tH, TN), { ...WORLD.sea, half: HALF, size: T_SIZE }));
  water.receiveShadow = true;
  scene.add(water);
}

function instanced(geo, mat, list, shadow = true, tint = true) {
  const m = new THREE.InstancedMesh(geo, mat, list.length), o = new THREE.Object3D(), c = new THREE.Color();
  list.forEach((t, i) => {
    o.position.set(t.x, t.y, t.z); o.rotation.set(t.rx || 0, t.ry || 0, 0); o.scale.set(t.sx ?? t.s, t.sy ?? t.s, t.sz ?? t.s); o.updateMatrix();
    m.setMatrixAt(i, o.matrix); if (tint && t.c != null) m.setColorAt(i, c.set(t.c));
  });
  m.castShadow = shadow; m.receiveShadow = true;
  scene.add(m);
  return m;
}

// shared foliage materials: bark (PBR), leaf-cluster and needle cards (alpha-tested, wind, per-tree tint)
function foliageKit() {
  const bark = addWind(new THREE.MeshStandardMaterial({ map: TX.bark014_color, normalMap: TX.bark014_normal, roughness: 0.95 }), 0.004, 'bark', 0);
  const leaves = addWind(new THREE.MeshStandardMaterial({ map: leafClusterTexture(TX.leafset009, rand), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75 }), 0.004, 'leaves', 0.5, { tints: WORLD.foliage, noFlip: true });
  const needles = addWind(new THREE.MeshStandardMaterial({ map: needleTexture(rand), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.8 }), 0.004, 'needles', 0.3, { tints: WORLD.needles, noFlip: true });
  return { bark, leaves, needles };
}
const rockMaterial = (tex) => triplanar(new THREE.MeshStandardMaterial({ roughness: 0.85 }), TX[`${tex}_color`], TX[`${tex}_normal`], 6, tex);
// three boulder shapes so scattered rocks don't repeat
function rockVariants(list, mat) {
  for (let v = 0; v < 3; v++) instanced(rockGeometry(v * 7.3 + 1), mat, list.filter((_, i) => i % 3 === v));
}
function buildVegetation() { if (WORLD.id === 'fuego') plantFuego(); else plantVerde(); }

function plantFuego() {
  const palms = [], jungle = [], dead = [], bushes = [], rocks = [], spires = [];
  for (let n = 0; n < 120000 && (palms.length < 1500 || jungle.length < 3200 || dead.length < 900); n++) {
    const x = rr(-2750, 2750), z = rr(-2750, 2750), d = roadDist(x, z), lava = lavaDist(x, z);
    if (d < 12 || lava < 22) continue;
    const h = getH(x, z), ry = rr(0, 6.28), dens = fbm(x / 380 + 4, z / 380 - 3, 3);
    if (h < 1.2) continue;
    if (h < 45 && (h < 12 || dens > -0.05)) { if (palms.length < 1500) palms.push({ x, y: h - 0.2, z, s: rr(0.8, 1.3), ry, c: pick([0x6f9a3a, 0x5d8a30, 0x84a842, 0x4f7a2a]) }); }
    else if (h < 120 && dens > -0.12) { if (jungle.length < 3200) jungle.push({ x, y: h - 0.3, z, s: rr(1.5, 2.6), ry, c: pick([0x2f6a25, 0x3f7a2a, 0x2a5a20, 0x4f8a2f, 0x36702a]) }); }
    else if (h >= 100 && h < 420 && (dens > 0.05 || lava < 150) && dead.length < 900) dead.push({ x, y: h - 0.2, z, s: rr(0.7, 1.3), ry, c: pick([0x2a2422, 0x3a302a, 0x1f1a18]) });
  }
  for (let n = 0; n < 12000 && bushes.length < 2600; n++) {
    const x = rr(-2500, 2500), z = rr(-2500, 2500), d = roadDist(x, z), h = getH(x, z);
    if (d < 8.5 || d > 320 || h < 2 || h > 130 || lavaDist(x, z) < 20) continue;
    bushes.push({ x, y: h - 0.1, z, s: rr(0.5, 1.5), sy: rr(0.4, 0.9), ry: rr(0, 6), c: pick([0x2c5a20, 0x3a6a26, 0x46762c]) });
  }
  for (let n = 0; n < 20000 && rocks.length < 3800; n++) {
    const x = rr(-2800, 2800), z = rr(-2800, 2800), d = roadDist(x, z), h = getH(x, z);
    if (d < 10 || h < 0.3 || lavaDist(x, z) < 8) continue;
    const s = rr(0.4, d > 150 ? 3 + h / 60 : 2.2);
    rocks.push({ x, y: h - s * 0.3, z, s, sy: s * rr(0.5, 0.9), sx: s * rr(0.8, 1.5), ry: rr(0, 6), rx: rr(-0.3, 0.3), c: pick([0x2d2826, 0x3a3330, 0x4a2e24, 0x24201f]) });
  }
  for (let n = 0; n < 8000 && spires.length < 260; n++) {
    const x = rr(-2000, 2000), z = rr(-2000, 2000), d = roadDist(x, z), h = getH(x, z);
    if (d < 40 || h < 130 || h > 640 || lavaDist(x, z) < 15) continue;
    const s = rr(3, 9);
    spires.push({ x, y: h - 1, z, s, sy: s * rr(2.2, 4.5), ry: rr(0, 6), rx: rr(-0.12, 0.12), c: pick([0x2a2524, 0x342d2a, 0x231f1e]) });
  }
  const palm = palmGeometries(canvasTex), F = foliageKit(), rockMat = rockMaterial('rock058');
  palm.trunkMat.map = TX.bark012_color; palm.trunkMat.normalMap = TX.bark012_normal;
  addWind(palm.trunkMat, 0.0035, 'palm-trunk', 0); addWind(palm.crownMat, 0.0035, 'palm-crown', 0.4, { tints: [0x9ccf5a, 0x6f9a38], noFlip: true });
  instanced(palm.trunk, palm.trunkMat, palms, true, false);
  instanced(palm.crown, palm.crownMat, palms, true, false);
  instanced(broadleafGeometry(rand), [F.bark, F.leaves], jungle.map((t) => ({ ...t, s: t.s * 0.55 })), true, false);
  instanced(deadTreeGeometry(), new THREE.MeshStandardMaterial({ map: TX.bark014_color, normalMap: TX.bark014_normal, color: 0x3a302a, roughness: 1 }), dead, true, false);
  instanced(bushGeometry(rand), [F.bark, F.leaves], bushes, true, false);
  rockVariants(rocks, rockMat);
  instanced(spireGeometry(rand), rockMat, spires);
}

function plantVerde() {
  const pines = [], broad = [], bushes = [], rocks = [];
  for (let n = 0; n < 60000 && (pines.length < 6000 || broad.length < 3800); n++) {
    const x = rr(-HALF + 40, HALF - 40), z = rr(-HALF + 40, HALF - 40), d = roadDist(x, z);
    if (d < 13) continue;
    const h = getH(x, z);
    if (h < 1.8 || h > 330) continue;
    if (fbm(x / 520 + 7, z / 520 + 2, 3) < -0.04 && rand() < 0.88) continue;
    const s = rr(0.8, 1.35) * (d < 40 ? 0.85 : 1), ry = rr(0, 6.28);
    if (h > 90 ? rand() < 0.85 : rand() < 0.4) { if (pines.length < 6000) pines.push({ x, y: h - 0.3, z, s: s * rr(2.2, 3.4), ry, c: pick([0x2c5527, 0x335f2b, 0x264a22, 0x3b6a30]) }); }
    else if (broad.length < 3800) broad.push({ x, y: h - 0.3, z, s: s * rr(1.6, 2.6), ry, c: pick([0x4a7f2a, 0x5b8f32, 0x3f6f25, 0x6e9a35, 0x8a9a35, rand() < 0.15 ? 0xc0892a : 0x557f2c]) });
  }
  for (let n = 0; n < 9000 && bushes.length < 2600; n++) {
    const x = rr(-2400, 2400), z = rr(-2400, 2400), d = roadDist(x, z), h = getH(x, z);
    if (d < 8.5 || d > 300 || h < 1.5) continue;
    bushes.push({ x, y: h - 0.1, z, s: rr(0.5, 1.4), sy: rr(0.4, 0.9), ry: rr(0, 6), c: pick([0x3c6a26, 0x4a7a2c, 0x5e8a34]) });
  }
  for (let n = 0; n < 9000 && rocks.length < 1200; n++) {
    const x = rr(-HALF, HALF), z = rr(-HALF, HALF), d = roadDist(x, z), h = getH(x, z);
    if (d < 10 || h < 0.5 || (d > 200 && Math.hypot(x, z) < 2000)) continue;
    const s = rr(0.4, d > 200 ? 9 : 2.2);
    rocks.push({ x, y: h - s * 0.3, z, s, sy: s * rr(0.5, 0.9), sx: s * rr(0.8, 1.4), ry: rr(0, 6), rx: rr(-0.3, 0.3), c: pick([0x8a857c, 0x7a756d, 0x9b958a]) });
  }
  const F = foliageKit();
  instanced(pineGeometry(rand), [F.bark, F.needles], pines.map((t) => ({ ...t, s: t.s * 0.42 })), true, false);
  instanced(broadleafGeometry(rand), [F.bark, F.leaves], broad.map((t) => ({ ...t, s: t.s * 0.55 })), true, false);
  instanced(bushGeometry(rand), [F.bark, F.leaves], bushes, true, false);
  rockVariants(rocks, rockMaterial('rock051'));
}

function bannerTex(text, bg, pill, fg, pattern) {
  return canvasTex(1024, 160, (g, w, h) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    if (pattern === 'dots') { g.fillStyle = '#e3242b'; for (let y = 20; y < h; y += 40) for (let x = ((y / 40) % 2) * 20 + 10; x < w; x += 40) { g.beginPath(); g.arc(x, y, 11, 0, 7); g.fill(); } }
    if (pattern === 'check') { const s = h / 4; g.fillStyle = '#111'; for (let y = 0; y < 4; y++) for (let x = 0; x * s < w; x++) if ((x + y) % 2) g.fillRect(x * s, y * s, s, s); }
    if (pattern === 'stripes') { g.fillStyle = 'rgba(255,255,255,.18)'; for (let x = -h; x < w; x += 60) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 30, h); g.lineTo(x + 30 + h, 0); g.lineTo(x + h, 0); g.fill(); } }
    g.font = 'italic 800 104px "Barlow Condensed", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const tw = g.measureText(text).width + 90;
    g.fillStyle = pill; g.beginPath(); g.roundRect(w / 2 - tw / 2, 16, tw, h - 32, 28); g.fill();
    g.fillStyle = fg; g.fillText(text, w / 2, h / 2 + 6);
  });
}

const tmpP = {};
function placeOnRoad(obj, s, lat = 0, dy = 0) {
  C.at(s, tmpP);
  obj.position.set(tmpP.x - Math.cos(tmpP.psi) * lat, tmpP.y + dy, tmpP.z + Math.sin(tmpP.psi) * lat);
  obj.rotation.set(0, tmpP.psi, 0);
  return obj;
}

function buildArches() {
  const STYLE = {
    finish: ['#ffffff', '#fc6719', '#ffffff', 'check', 0xfc6719, 'VELOWORLD'],
    kom: ['#ffffff', '#e3242b', '#ffffff', 'dots', 0xe3242b, 'KOM'],
    komS: ['#ffffff', '#e3242b', '#ffffff', 'dots', 0xe3242b, 'KOM START'],
    sprint: ['#18c26b', '#ffffff', '#0c7a43', 'stripes', 0x18c26b, 'SPRINT'],
    sprintS: ['#18c26b', '#ffffff', '#0c7a43', 'stripes', 0x18c26b, 'SPRINT START'],
    pu: ['#1e63d6', '#ffffff', '#1e63d6', 'stripes', 0x1e63d6, 'POWER UP'],
  };
  const pillarGeo = new THREE.CapsuleGeometry(0.55, 6.2, 6, 16), half = ROAD_W / 2 + 1.3;
  const add = (s, key) => {
    const [bg, pill, fg, pat, col, text] = STYLE[key];
    const tex = bannerTex(text, bg, pill, fg, pat);
    const front = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }), side = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5 });
    const g = placeOnRoad(new THREE.Group(), s);
    for (const sx of [-1, 1]) { const p = new THREE.Mesh(pillarGeo, side); p.position.set(sx * half, 3.1, 0); p.castShadow = true; g.add(p); }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 1.4, 1.9, 0.9), [side, side, side, side, front, front]);
    beam.position.y = 6.7; beam.castShadow = true; g.add(beam);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W, 1.2).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({
      map: canvasTex(256, 32, (c, w, h) => { c.fillStyle = bg; c.fillRect(0, 0, w, h); c.fillStyle = key.startsWith('kom') ? '#e3242b' : key === 'finish' ? '#111' : '#ffffff';
        for (let y = 0; y < 2; y++) for (let x = 0; x < 16; x++) if ((x + y) % 2) c.fillRect(x * 16, y * 16, 16, 16); }), roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 }));
    line.position.y = 0.07; line.receiveShadow = true; g.add(line);
    scene.add(g);
  };
  add(0, 'finish');
  add(SEGS[0].start, 'komS'); add(SEGS[0].end, 'kom');
  add(SEGS[1].start, 'sprintS'); add(SEGS[1].end, 'sprint');
  PU_ARCHES.forEach((s) => add(s, 'pu'));
}

// crowd barriers + spectators near the KOM and finish
let crowd;
function buildCrowd() {
  const panels = [], backs = [], tex = bannerTex('VELOWORLD', '#fc6719', '#ffffff', '#fc6719', 'stripes'), tex2 = bannerTex('KOM', '#ffffff', '#e3242b', '#ffffff', 'dots');
  const barrier = (s0, s1, list) => {
    for (let s = s0; s < s1; s += 2.3) for (const side of [-1, 1]) {
      C.at(s, tmpP);
      const lat = side * (ROAD_W / 2 + 0.6), x = tmpP.x - Math.cos(tmpP.psi) * lat, z = tmpP.z + Math.sin(tmpP.psi) * lat, ry = tmpP.psi + (side > 0 ? Math.PI / 2 : -Math.PI / 2);
      list.push({ x, y: tmpP.y + 0.5, z, s: 1, ry }); backs.push({ x: x - Math.cos(tmpP.psi) * side * 0.08, y: tmpP.y + 0.5, z: z + Math.sin(tmpP.psi) * side * 0.08, s: 1, ry }); // backing sits behind the banner
    }
  };
  const fin = [], kom = [];
  barrier(L - 160, L + 30, fin); barrier(SEGS[0].end - 120, SEGS[0].end + 20, kom);
  const pg = new THREE.PlaneGeometry(2.2, 1);
  instanced(pg, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }), fin, false);
  instanced(pg, new THREE.MeshStandardMaterial({ map: tex2, roughness: 0.6 }), kom, false);
  instanced(new THREE.BoxGeometry(2.2, 1, 0.06), new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.6 }), backs);

  const spots = [];
  const addPeople = (s0, s1, n) => {
    for (let i = 0; i < n; i++) {
      const s = rr(s0, s1), side = rand() < 0.5 ? -1 : 1, lat = side * (ROAD_W / 2 + 1.5 + rand() * 4);
      C.at(s, tmpP);
      const x = tmpP.x - Math.cos(tmpP.psi) * lat, z = tmpP.z + Math.sin(tmpP.psi) * lat;
      spots.push({ x, z, y: groundAt(x, z), ry: tmpP.psi + (side > 0 ? -Math.PI / 2 : Math.PI / 2) + rr(-0.5, 0.5), ph: rand() * 6.28, h: rr(0.9, 1.1), c: pick([0xe3242b, 0xfc6719, 0x1e63d6, 0xffd400, 0xffffff, 0x18c26b, 0x222222, 0xff5ea8]), skin: pick([0xf1c7a5, 0xd9a07a, 0x9a6440, 0x6e4529]), s });
    }
  };
  addPeople(SEGS[0].end - 110, SEGS[0].end + 15, 160);
  addPeople(L - 150, L + 20, 140);
  // low-poly fan, origin at the feet, facing +Z: dark trousers, shirt-coloured torso and raised arms; skin is a second mesh
  const part = (geo, shade, m) => { geo.applyMatrix4(m); const n = geo.attributes.position.count; geo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(shade), 3)); return geo; };
  const T = (x, y, z, rz = 0, sx = 1, sz = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, rz)), new THREE.Vector3(sx, 1, sz));
  const cloth = mergeGeometries([
    part(new THREE.CapsuleGeometry(0.08, 0.72, 3, 8), 0.22, T(0.1, 0.45, 0)), part(new THREE.CapsuleGeometry(0.08, 0.72, 3, 8), 0.22, T(-0.1, 0.45, 0)),
    part(new THREE.CapsuleGeometry(0.17, 0.36, 4, 10), 1, T(0, 1.13, 0, 0, 1.2, 0.72)),
    part(new THREE.CapsuleGeometry(0.052, 0.5, 3, 6), 1, T(0.31, 1.58, 0, -0.55)), part(new THREE.CapsuleGeometry(0.052, 0.5, 3, 6), 1, T(-0.31, 1.58, 0, 0.55)),
  ]);
  const skinGeo = mergeGeometries([new THREE.SphereGeometry(0.11, 12, 9).translate(0, 1.6, 0.01), new THREE.SphereGeometry(0.045, 6, 5).translate(0.46, 1.86, 0), new THREE.SphereGeometry(0.045, 6, 5).translate(-0.46, 1.86, 0)]);
  const body = new THREE.InstancedMesh(cloth, new THREE.MeshStandardMaterial({ roughness: 0.85, vertexColors: true }), spots.length);
  const head = new THREE.InstancedMesh(skinGeo, new THREE.MeshStandardMaterial({ roughness: 0.6 }), spots.length);
  const c = new THREE.Color();
  spots.forEach((p, i) => { body.setColorAt(i, c.set(p.c)); head.setColorAt(i, c.set(p.skin)); });
  body.castShadow = head.castShadow = true;
  scene.add(body, head);
  crowd = { spots, body, head, o: new THREE.Object3D() };
}
function updateCrowd(t) {
  const { spots, body, head, o } = crowd;
  const near = (s) => player && Math.abs(mod(player.dist - s + L / 2, L) - L / 2) < 120 ? 1 : 0.25;
  spots.forEach((p, i) => {
    const j = Math.max(0, Math.sin(t * 9 + p.ph)) * 0.3 * near(p.s);
    o.position.set(p.x, p.y + j, p.z); o.rotation.set(0, p.ry, Math.sin(t * 3 + p.ph) * 0.06); o.scale.setScalar(p.h); o.updateMatrix();
    body.setMatrixAt(i, o.matrix); head.setMatrixAt(i, o.matrix);
  });
  body.instanceMatrix.needsUpdate = head.instanceMatrix.needsUpdate = true;
}

// ============================================================ riders
const UP = new THREE.Vector3(0, 1, 0);
const GEO = {};
function tube(a, b, r, rb = r, seg = 8) {
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  return new THREE.CylinderGeometry(r, rb, len, seg).applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()), new THREE.Vector3(1, 1, 1)));
}
function buildRiderGeo() {
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const BB = v(0, 0.28, -0.1), ST = v(0, 0.8, -0.24), HT = v(0, 0.86, 0.36), HB = v(0, 0.7, 0.4);
  GEO.frame = mergeGeometries([
    tube(BB, ST, 0.02), tube(BB, HB, 0.027), tube(ST, HT, 0.019), tube(HB, HT, 0.029),
    ...[1, -1].flatMap((s) => [
      tube(v(s * 0.04, 0.28, -0.1), v(s * 0.06, WHEEL_R, -0.5), 0.011),
      tube(v(s * 0.03, 0.78, -0.25), v(s * 0.06, WHEEL_R, -0.5), 0.01),
      tube(v(s * 0.03, 0.7, 0.4), v(s * 0.05, WHEEL_R, 0.5), 0.014, 0.011),
    ]),
  ]);
  const bar = v(0, 0.9, 0.45);
  GEO.cockpit = mergeGeometries([
    tube(ST, v(0, 0.93, -0.28), 0.013),
    new THREE.BoxGeometry(0.12, 0.04, 0.27).translate(0, 0.95, -0.28),
    tube(HT, bar, 0.016), tube(v(0.21, 0.9, 0.45), v(-0.21, 0.9, 0.45), 0.013),
    ...[1, -1].flatMap((s) => [tube(v(s * 0.21, 0.9, 0.45), v(s * 0.21, 0.87, 0.53), 0.013), tube(v(s * 0.21, 0.87, 0.53), v(s * 0.21, 0.78, 0.5), 0.013), tube(v(s * 0.21, 0.78, 0.5), v(s * 0.21, 0.76, 0.42), 0.013)]),
    new THREE.TorusGeometry(0.1, 0.008, 4, 28).rotateY(Math.PI / 2).translate(-0.07, 0.28, -0.1),
    new THREE.CylinderGeometry(0.1, 0.1, 0.004, 28).rotateZ(Math.PI / 2).translate(-0.07, 0.28, -0.1),
  ]);
  GEO.wheel = mergeGeometries([
    new THREE.TorusGeometry(WHEEL_R, 0.016, 8, 48), new THREE.TorusGeometry(0.3, 0.012, 4, 48),
    new THREE.RingGeometry(0.265, 0.322, 48).translate(0, 0, 0.009), new THREE.RingGeometry(0.265, 0.322, 48).rotateY(Math.PI).translate(0, 0, -0.009),
    new THREE.CylinderGeometry(0.025, 0.025, 0.1, 12).rotateX(Math.PI / 2),
  ]).rotateY(Math.PI / 2);
  const spokes = [];
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; spokes.push(tube(v(Math.cos(a) * 0.02, Math.sin(a) * 0.02, i % 2 ? 0.02 : -0.02), v(Math.cos(a) * 0.27, Math.sin(a) * 0.27, 0), 0.0022, 0.0022, 3)); }
  GEO.spokes = mergeGeometries(spokes).rotateY(Math.PI / 2);
  GEO.crank = new THREE.CylinderGeometry(1, 1, 1, 6);
  initBodies(canvasTex, TEAMS);
}

const TEAMS = [ // [primary, secondary, name printed on the jersey]
  ['#fc6719', '#ffffff', 'VELOWORLD'], ['#e3242b', '#111111', 'ROSSO'], ['#1e63d6', '#ffd400', 'AZURE'], ['#11a36b', '#ffffff', 'VERDE'], ['#151515', '#ff2d55', 'NOIR'],
  ['#f4f4f4', '#1e63d6', 'BLANC'], ['#7a2be2', '#21e6c1', 'NEBULA'], ['#ffd400', '#151515', 'SOLARIS'], ['#00a7e1', '#0a2a4a', 'GLACIER'], ['#ff5ea8', '#262626', 'FLAMINGO'], ['#0b3d2e', '#c8ff3d', 'FOREST'],
];
const MAT = {
  black: new THREE.MeshStandardMaterial({ color: 0x16171b, roughness: 0.45, metalness: 0.3 }),
  tire: new THREE.MeshStandardMaterial({ color: 0x101012, roughness: 0.7 }),
  silver: new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.25, metalness: 0.9 }),
};
const frames = new Map();
const frameMat = (i) => frames.get(i) ?? frames.set(i, new THREE.MeshPhysicalMaterial({ color: TEAMS[i][0], roughness: 0.25, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06 })).get(i);

const BOT_NAMES = [
  ['L. Andersen', 'DK'], ['M. Rossi', 'IT'], ['J. Kowalski', 'PL'], ['T. Nakamura', 'JP'], ['S. Dubois', 'FR'], ['K. Müller', 'DE'], ['A. García', 'ES'], ['B. van Dijk', 'NL'],
  ['R. Silva', 'BR'], ['C. O’Brien', 'IE'], ['P. Novák', 'CZ'], ['E. Johansson', 'SE'], ['D. Smith', 'GB'], ['H. Kim', 'KR'], ['F. Moreau', 'FR'], ['G. Bianchi', 'IT'],
  ['N. Petrov', 'BG'], ['O. Hansen', 'NO'], ['I. Costa', 'PT'], ['W. Jones', 'AU'], ['Y. Tanaka', 'JP'], ['Z. Kovač', 'HR'], ['V. Horvat', 'SI'], ['U. Schmidt', 'AT'],
  ['Q. Leroy', 'BE'], ['X. Li', 'CN'], ['T. Becker', 'DE'], ['M. Fischer', 'CH'], ['A. López', 'MX'], ['J. Miller', 'US'], ['S. Brown', 'CA'], ['R. Murphy', 'NZ'],
  ['E. Virtanen', 'FI'], ['L. Janssens', 'BE'], ['P. Mertens', 'NL'], ['C. Ferrari', 'IT'], ['D. Nowak', 'PL'], ['K. Sato', 'JP'], ['M. Dlamini', 'ZA'], ['A. Okafor', 'NG'],
];

const riders = [];
let player = null;

function createRider(cfg) {
  const g = new THREE.Group();
  const add = (geo, mat, parent = g) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; parent.add(m); return m; };
  add(GEO.frame, frameMat(cfg.team)); add(GEO.cockpit, MAT.black);
  const wheels = [-0.5, 0.5].map((z) => { const w = new THREE.Group(); w.position.set(0, WHEEL_R, z); add(GEO.wheel, MAT.tire, w); add(GEO.spokes, MAT.silver, w); g.add(w); return w; });
  const cranks = [0, 1].map(() => add(GEO.crank, MAT.black));
  const body = createBody({ mass: cfg.mass, team: cfg.team, skin: cfg.skin ?? Math.floor(rand() * 5), shoe: cfg.shoe ?? Math.floor(rand() * 3), teamSocks: rand() < 0.4 });
  g.add(body.mesh);
  scene.add(g);
  const r = {
    name: cfg.name, cc: cfg.cc, isPlayer: !!cfg.isPlayer, mass: cfg.mass, ftp: cfg.ftp, w0: cfg.w0 ?? 20000,
    effort: cfg.effort ?? 0.75, aggr: cfg.aggr ?? 1, pref: cfg.lat ?? 0, phase: rand() * 100,
    cda: 0.32 * Math.pow(cfg.mass / 75, 0.33), group: g, wheels, cranks, body,
    dist: cfg.dist, prevDist: cfg.dist, lat: cfg.lat ?? 0, latTarget: cfg.lat ?? 0, v: cfg.v ?? 0, power: 0, crank: rand() * 6.28, cad: 0, stand: 0,
    draft: 0, hr: 72, segStart: {}, passT: 0, attackT: 0, nextAttack: rr(30, 200), attackPow: 1.3, pos: C.at(cfg.dist, {}), finishTime: null,
    puHeld: null, puActive: null, puT: 0, lead: null, block: null, follow: false, wantPass: false,
  };
  r.wbal = r.w0;
  if (!r.isPlayer) {
    const el = document.createElement('div');
    el.className = 'tag';
    el.innerHTML = `<i>${cfg.cc}</i>${cfg.name}<b></b>`;
    r.label = new CSS2DObject(el);
    r.label.position.set(0, 2.15, 0);
    r.labelW = el.querySelector('b');
    g.add(r.label);
  }
  riders.push(r);
  return r;
}

const _B = new THREE.Vector3(), _W = new THREE.Vector3(), _d = new THREE.Vector3();
function limb(m, a, b, rad) {
  _d.subVectors(b, a);
  const len = _d.length();
  m.position.addVectors(a, b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, _d.divideScalar(len));
  m.scale.set(rad, len, rad);
}
function poseRider(r) {
  const J = poseBody(r.body, r.stand, r.crank);
  J.legs.forEach((l, i) => limb(r.cranks[i], _B.set(l.side * 0.08, 0.28, -0.1), _W.set(l.side * 0.1, l.ball.y - 0.03, l.ball.z)));
}

function placeRider(r, dt, camPos) {
  const p = C.at(r.dist, r.pos), g = r.group;
  g.position.set(p.x - Math.cos(p.psi) * r.lat, p.y + 0.05, p.z + Math.sin(p.psi) * r.lat);
  const lean = clamp((-r.v * r.v * p.k) / G, -0.4, 0.4), rock = Math.sin(r.crank) * 0.13 * r.stand;
  g.rotation.set(-Math.atan(p.grade), p.psi, lean + rock, 'YXZ');
  for (const w of r.wheels) w.rotation.x += (r.v / WHEEL_R) * dt;
  const d2 = g.position.distanceToSquared(camPos);
  if (d2 < 260 * 260) poseRider(r);
  if (r.label) {
    r.label.visible = d2 < 75 * 75 && game.state !== 'menu';
    if (r.label.visible) r.label.element.style.opacity = String(clamp(1.6 - Math.sqrt(d2) / 50, 0.25, 1));
  }
}

// ============================================================ simulation
const game = { tf: 0, shake: 0, state: 'loading', time: 0, race: false, laps: 0, raceDist: 0, cam: 0, paused: false, finished: false, countdown: 0, energy: 0, rideTime: 0, elev: 0, hudT: 0, rideOnT: 40, muted: false, hideHelp: false };
const input = { target: 200, manualT: 0, sprint: false };
const BT = { power: null, powerAt: 0, cad: null, hr: null, hrAt: 0, cp: null, lastGrade: 1e9, busy: false, crank: null, lastSend: 0 };

function neighbors() {
  const s = riders.slice().sort((a, b) => a.dist - b.dist);
  for (let i = 0; i < s.length; i++) {
    const r = s[i];
    let draft = 0, pack = 0;
    r.lead = r.block = null;
    for (let j = i + 1; j < s.length; j++) {
      const o = s[j], gap = o.dist - r.dist;
      if (gap > 22) break;
      const dl = Math.abs(o.lat - r.lat);
      if (gap < 15 && !r.lead) r.lead = o;
      if (gap < 3.2 && dl < 0.8 && !r.block) r.block = o;
      if (gap > 0.8 && gap < 12 && dl < 1.3) draft = Math.max(draft, 0.35 * (1 - clamp((gap - 2.2) / 9.8, 0, 1)) * (1 - (dl / 1.3) ** 2));
      if (dl < 2.5) pack++;
    }
    r.draft = Math.min(0.5, draft + (draft > 0 ? Math.min(0.1, (pack - 1) * 0.015) : 0));
  }
}

function freeLane(r) {
  for (const c of [r.lat + 1.1, r.lat - 1.1, r.lat + 2.2, r.lat - 2.2]) {
    if (Math.abs(c) > 4.6) continue;
    if (!riders.some((o) => o !== r && o.dist - r.dist > -2.5 && o.dist - r.dist < 7 && Math.abs(o.lat - c) < 0.85)) return c;
  }
  return null;
}

function laneLogic(r, dt) {
  if (r.passT > 0) { r.passT -= dt; return; }
  const wantPass = r.isPlayer ? r.block && r.v > r.block.v - 0.3 : r.wantPass;
  if (r.block && wantPass) { const c = freeLane(r); if (c != null) { r.latTarget = c; r.passT = 2.5; return; } }
  if (r.lead && (r.isPlayer || r.follow)) {
    if (r.lead.dist - r.dist > 3 || Math.abs(r.lead.lat - r.lat) < 0.8) r.latTarget = r.lead.lat;
  } else if (!r.isPlayer) r.latTarget += (r.pref - r.latTarget) * Math.min(1, dt * 0.2);
}

function botPower(r, dt) {
  const g = r.pos.grade;
  let P = r.ftp * r.effort * (1 + clamp(g * 5, -0.8, 0.35)) * (1 + 0.06 * Math.sin(game.time * 0.13 + r.phase));
  if (g < -0.04) P *= 0.4;
  let sprint = false;
  if (r.attackT > 0) { r.attackT -= dt; P = r.ftp * r.attackPow; }
  else if ((r.nextAttack -= dt) <= 0) {
    r.nextAttack = rr(45, 220) / r.aggr;
    if (r.wbal > 0.75 * r.w0 && rand() < (game.race ? 0.75 : 0.45)) { r.attackT = rr(8, 25); r.attackPow = rr(1.2, 1.55); }
  }
  if (game.race && r.finishTime == null) {
    const rem = game.raceDist - r.dist;
    if (rem > 0 && rem < 320 + r.aggr * 120) { P = r.ftp * 1.9; sprint = true; }
    else if (rem > 0 && rem < 2000) P = Math.max(P, r.ftp * (0.92 + 0.12 * r.aggr));
  }
  if (r.finishTime != null) P = r.ftp * 0.5;
  r.follow = false; r.wantPass = true;
  const a = r.lead;
  if (a && !sprint && r.attackT <= 0) {
    const gap = a.dist - r.dist, need = powerFor(r, a.v, g, Math.max(r.draft, 0.25)), limit = r.ftp * (r.wbal > 0.3 * r.w0 ? 1.35 : 0.95);
    if (P < need * 1.2 && need < limit) {
      r.follow = true; r.wantPass = false;
      P = clamp(need + (gap - 2.3) * 30 + (a.v - r.v) * 160, 0, limit);
    }
  }
  if (r.wbal < 0.05 * r.w0) { P = Math.min(P, r.ftp * 0.85); r.attackT = 0; }
  return Math.max(0, P);
}

function playerPower() {
  const P = BT.power != null && performance.now() - BT.powerAt < 3000 ? BT.power : input.target;
  return input.sprint && player.wbal > 0 ? Math.max(P, player.ftp * 1.7) : P;
}

const crossed = (r, x) => Math.floor((r.dist - x) / L) > Math.floor((r.prevDist - x) / L);

function stepRider(r, dt) {
  C.at(r.dist, r.pos);
  const g = r.pos.grade;
  let P = r.isPlayer ? playerPower() : botPower(r, dt);
  if (r.wbal <= 0) P = Math.min(P, r.ftp * 0.9);
  r.power += (P - r.power) * Math.min(1, dt * (r.isPlayer ? 6 : 2.5));
  const Pw = r.power;
  r.wbal = Pw > r.ftp ? Math.max(0, r.wbal - (Pw - r.ftp) * dt) : Math.min(r.w0, r.wbal + (r.ftp - Pw) * dt * 0.35);
  const pu = r.puActive, mass = r.mass + BIKE_KG - (pu === 'feather' ? 9 : 0), cda = r.cda * (pu === 'aero' ? 0.75 : 1);
  const draft = Math.min(0.55, r.draft * (pu === 'draft' ? 1.5 : 1));
  r.v = Math.max(0, r.v + ((Pw / Math.max(r.v, 1.2) - resist(r.v, g, mass, cda, draft)) / (mass * 1.04)) * dt);
  r.prevDist = r.dist;
  r.dist += r.v * dt;
  if (r.isPlayer && input.manualT > 0) input.manualT -= dt; else laneLogic(r, dt);
  r.latTarget = clamp(r.latTarget, -4.6, 4.6);
  r.lat += clamp(r.latTarget - r.lat, -1.3 * dt, 1.3 * dt);
  const btCad = r.isPlayer && BT.cad != null && performance.now() - BT.powerAt < 3000 ? BT.cad : null;
  const cadT = Pw > 15 ? btCad ?? clamp(80 + (Pw / r.ftp) * 12 - g * 80, 62, 118) : 0;
  r.cad += (cadT - r.cad) * Math.min(1, dt * 3);
  r.crank += (r.cad / 60) * Math.PI * 2 * dt;
  r.stand += ((Pw > r.ftp * 1.3 || (g > 0.07 && Pw > r.ftp * 0.95) ? 1 : 0) - r.stand) * Math.min(1, dt * 3);
  r.hr += (60 + 118 * clamp(Pw / r.ftp, 0, 1.25) + (1 - r.wbal / r.w0) * 12 - r.hr) * (dt / 15);
  if (r.puActive && (r.puT -= dt) <= 0) r.puActive = null;

  for (const sg of SEGS) {
    if (crossed(r, sg.start)) r.segStart[sg.id] = game.time;
    if (crossed(r, sg.end) && r.segStart[sg.id] != null) {
      const t = game.time - r.segStart[sg.id];
      r.segStart[sg.id] = null;
      sg.best.push({ name: r.name, t, me: r.isPlayer });
      sg.best.sort((a, b) => a.t - b.t);
      if (r.isPlayer) {
        const rank = sg.best.findIndex((b) => b.me && b.t === t) + 1;
        toast(`${sg.icon} ${sg.name} · ${fmtTime(t)}.${String(Math.floor((t % 1) * 10))} · #${rank} of ${sg.best.length}`, sg.id === 'kom' ? 'red' : 'green', 4500);
        if (rank === 1) toast(`🏆 NEW ${sg.name} LEADER`, 'orange', 4500);
        chime([660, 880, 1320]);
      }
    }
  }
  if (game.race && r.finishTime == null && r.dist >= game.raceDist) {
    r.finishTime = game.time;
    if (r.isPlayer) finishRace();
  }
  if (r.isPlayer) {
    for (const s of PU_ARCHES) if (crossed(r, s) && !r.puHeld && !r.puActive) {
      r.puHeld = pick(Object.keys(POWERUPS));
      toast(`${POWERUPS[r.puHeld].icon} ${POWERUPS[r.puHeld].name} — press SPACE`, 'blue');
      chime([880, 1175]);
    }
    if (crossed(r, 0) && r.dist > 1) { const lap = Math.floor(r.dist / L) + 1; if (!game.race || lap <= game.laps) toast(`LAP ${lap}${game.race ? ' / ' + game.laps : ''}`, 'orange'); }
    if (r.wbal <= 0 && !r.bonked) { r.bonked = true; toast('🥵 Out of matches — recover below FTP', 'red'); }
    if (r.wbal > 0.3 * r.w0) r.bonked = false;
  }
}

function update(dt) {
  if (game.state === 'countdown') {
    game.countdown -= dt;
    const c = $('countdown');
    if (game.countdown > 0) c.textContent = Math.ceil(game.countdown);
    else { c.textContent = 'GO!'; c.className = 'go'; game.state = 'ride'; chime([1046]); setTimeout(() => (c.textContent = ''), 900); }
    if (Math.ceil(game.countdown) !== Math.ceil(game.countdown + dt) && game.countdown > 0) chime([523]);
    return;
  }
  if (game.state !== 'ride') return;
  game.time += dt;
  neighbors();
  const y0 = player.pos.y;
  for (const r of riders) stepRider(r, dt);
  if (player.pos.y > y0) game.elev += player.pos.y - y0;
  game.energy += player.power * dt;
  game.rideTime += dt;
  if ((game.rideOnT -= dt) <= 0) {
    game.rideOnT = rr(35, 90);
    const near = riders.filter((r) => r !== player && Math.abs(r.dist - player.dist) < 60);
    if (near.length) { const r = pick(near); toast(`👍 Ride On! from ${r.name}`, '', 3000); }
  }
  if (BT.cp && performance.now() - BT.lastSend > 1500) sendGrade(player.pos.grade);
}

// ============================================================ camera
const CAMS = ['CHASE CAM', 'CLOSE CAM', 'SIDE CAM', 'FRONT CAM', 'HELICOPTER', 'CINEMATIC'];
const camPos = new THREE.Vector3(0, 60, 0), camLook = new THREE.Vector3(), _cp = new THREE.Vector3(), _cl = new THREE.Vector3();
function updateCamera(dt, t) {
  if (game.state === 'menu' || !player) {
    const s = t * 22, p = C.at(s, {}), q = C.at(s + 90, {}), i = Math.floor((mod(s, L) / L) * M), inside = C.T[i] ? 1 - C.chamber(i) * 0.6 : 0;
    _cp.set(p.x - Math.cos(p.psi) * lerp(26, 3, inside), p.y + lerp(16, 4, inside), p.z + Math.sin(p.psi) * lerp(26, 3, inside));
    _cl.set(q.x, q.y + 4, q.z);
  } else {
    const b = player.group.position, psi = player.pos.psi, fx = Math.sin(psi), fz = Math.cos(psi), rx = -Math.cos(psi), rz = Math.sin(psi);
    const back = (d, h) => _cp.set(b.x - fx * d, b.y + h, b.z - fz * d), ahead = (d, h) => _cl.set(b.x + fx * d, b.y + h, b.z + fz * d);
    switch (game.cam) {
      case 0: back(5.6, 2.3); ahead(6, 1.1); break;
      case 1: back(2.8, 1.55); ahead(4, 1.15); break;
      case 2: _cp.set(b.x + rx * 4.2 + fx * 0.6, b.y + 1.2, b.z + rz * 4.2 + fz * 0.6); _cl.set(b.x, b.y + 0.95, b.z); break;
      case 3: ahead(5, 1.35); _cl.set(b.x, b.y + 1.1, b.z); break;
      case 4: back(24, 30); ahead(12, 0); break;
      case 5: { const a = t * 0.18; _cp.set(b.x + Math.cos(a) * 9, b.y + 2.6 + Math.sin(t * 0.3), b.z + Math.sin(a) * 9); _cl.set(b.x, b.y + 1, b.z); break; }
    }
  }
  const k = 1 - Math.exp(-dt * (game.cam === 0 ? 4.5 : 7));
  camPos.lerp(_cp, k); camLook.lerp(_cl, k);
  const ti = tunnelAt(camPos.x, camPos.z);
  if (ti >= 0) camPos.y = clamp(camPos.y, C.Y[ti] + 0.6, C.Y[ti] + tunnelSize(C.chamber(ti)).h - 3);
  else camPos.y = Math.max(camPos.y, getH(camPos.x, camPos.z) + 0.8);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  const fov = 60 + (player ? clamp(player.v * 0.45, 0, 14) : 0);
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * k; camera.updateProjectionMatrix(); }
}

// ============================================================ HUD
const toast = (html, cls = '', ms = 3000) => {
  const el = document.createElement('div');
  el.className = 'toast ' + cls; el.innerHTML = html; el.style.setProperty('--d', ms - 400 + 'ms');
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
};
const gradeColor = (g) => (g > 0.08 ? '#ff5a5f' : g > 0.05 ? '#ffa53d' : g > 0.02 ? '#ffd84d' : g < -0.02 ? '#5ac8ff' : '#7ee07a');

const prof = { c: $('profile'), bg: document.createElement('canvas'), y: null };
function initProfile() {
  const c = prof.c, dpr = Math.min(devicePixelRatio, 2);
  c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  const W = c.width, H = c.height, g = (prof.bg.width = W, prof.bg.height = H, prof.bg.getContext('2d'));
  let lo = Infinity, hi = -Infinity;
  for (const y of C.Y) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
  prof.y = (h) => H - 8 * dpr - ((h - lo) / (hi - lo)) * (H - 30 * dpr);
  for (const sg of SEGS) {
    const x0 = (sg.start / L) * W, x1 = (sg.end / L) * W;
    g.fillStyle = sg.color + '30'; g.fillRect(x0, 0, x1 - x0, H);
    g.fillStyle = sg.color; g.font = `700 ${11 * dpr}px "Barlow Condensed"`; g.fillText(sg.name, x0 + 4 * dpr, 13 * dpr);
  }
  for (let x = 0; x < W; x++) {
    const i = Math.floor((x / W) * M), y = prof.y(C.Y[i]);
    g.fillStyle = gradeColor(C.GR[i]) + 'b0'; g.fillRect(x, y, 1, H - y);
  }
  g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 1.5 * dpr; g.beginPath();
  for (let x = 0; x < W; x++) g.lineTo(x, prof.y(C.Y[Math.floor((x / W) * M)]));
  g.stroke();
  g.fillStyle = '#fff';
  for (const s of PU_ARCHES) g.fillRect((s / L) * W - dpr, 0, 2 * dpr, H);
  g.fillStyle = 'rgba(0,0,0,.45)';
  for (let x = 0; x < W; x++) if (C.T[Math.floor((x / W) * M)]) g.fillRect(x, 0, 1, H);
}
function drawProfile() {
  const c = prof.c, g = c.getContext('2d'), W = c.width, dpr = W / c.clientWidth;
  g.clearRect(0, 0, W, c.height); g.drawImage(prof.bg, 0, 0);
  for (const r of riders) if (r !== player) { g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.arc((mod(r.dist, L) / L) * W, prof.y(r.pos.y), 2.4 * dpr, 0, 7); g.fill(); }
  const x = (mod(player.dist, L) / L) * W, y = prof.y(player.pos.y);
  g.fillStyle = 'rgba(252,103,25,.35)'; g.fillRect(x - dpr, 0, 2 * dpr, c.height);
  g.fillStyle = '#fc6719'; g.strokeStyle = '#fff'; g.lineWidth = 2 * dpr; g.beginPath(); g.arc(x, y, 6 * dpr, 0, 7); g.fill(); g.stroke();
}

const mm = { c: $('minimap'), bg: document.createElement('canvas') };
function initMinimap() {
  const W = mm.c.width, pad = 26;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < M; i++) { x0 = Math.min(x0, C.X[i]); x1 = Math.max(x1, C.X[i]); z0 = Math.min(z0, C.Z[i]); z1 = Math.max(z1, C.Z[i]); }
  const s = (W - pad * 2) / Math.max(x1 - x0, z1 - z0), ox = (x0 + x1) / 2, oz = (z0 + z1) / 2;
  mm.p = (x, z) => [W / 2 + (x - ox) * s, W / 2 + (z - oz) * s];
  mm.bg.width = mm.bg.height = W;
  const g = mm.bg.getContext('2d');
  const grd = g.createRadialGradient(W / 2, W / 2, 10, W / 2, W / 2, W / 1.4); for (const [o, col] of WORLD.mini) grd.addColorStop(o, col);
  g.fillStyle = grd; g.fillRect(0, 0, W, W);
  const path = (i0, i1, col, w) => { g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); for (let i = i0; i <= i1; i++) g.lineTo(...mm.p(C.X[mod(i, M)], C.Z[mod(i, M)])); g.stroke(); };
  path(0, M, 'rgba(0,0,0,.5)', 14); path(0, M, '#e9ecef', 7);
  g.setLineDash([6, 6]); for (const [i, len] of C.runs) path(i, i + len, '#3a3530', 7); g.setLineDash([]);
  for (const sg of SEGS) path(Math.floor((sg.start / L) * M), Math.floor((sg.end / L) * M), sg.color, 7);
  const [sx, sz] = mm.p(C.X[0], C.Z[0]); g.fillStyle = '#fff'; g.strokeStyle = '#111'; g.lineWidth = 3; g.beginPath(); g.arc(sx, sz, 8, 0, 7); g.fill(); g.stroke();
}
function drawMinimap() {
  const g = mm.c.getContext('2d');
  g.drawImage(mm.bg, 0, 0);
  for (const r of riders) if (r !== player) { const [x, z] = mm.p(r.pos.x, r.pos.z); g.fillStyle = '#fff'; g.beginPath(); g.arc(x, z, 4, 0, 7); g.fill(); }
  const [x, z] = mm.p(player.pos.x, player.pos.z), a = player.pos.psi;
  g.save(); g.translate(x, z); g.rotate(-a); g.fillStyle = '#fc6719'; g.strokeStyle = '#fff'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(0, 14); g.lineTo(9, -9); g.lineTo(0, -4); g.lineTo(-9, -9); g.closePath(); g.fill(); g.stroke(); g.restore();
}

const riderRows = [];
function updateHUD() {
  const p = player, wkg = p.power / p.mass, ftpFrac = p.power / p.ftp;
  $('h-power').textContent = Math.round(p.power);
  $('h-power').style.color = ftpFrac > 1.2 ? '#ff5a5f' : ftpFrac > 0.9 ? '#ffa53d' : '#fff';
  $('h-wkg').textContent = wkg.toFixed(1);
  const hrFresh = BT.hr != null && performance.now() - BT.hrAt < 5000;
  $('h-hr').textContent = Math.round(hrFresh ? BT.hr : p.hr);
  $('h-cad').textContent = Math.round(p.cad);
  $('h-avg').textContent = Math.round(game.energy / Math.max(1, game.rideTime));
  $('h-kj').textContent = Math.round(game.energy / 1000);
  $('h-energy').style.width = (p.wbal / p.w0) * 100 + '%';
  const bt = BT.power != null && performance.now() - BT.powerAt < 3000;
  $('h-src').textContent = bt ? `⚡ ${BT.name || 'TRAINER'}` : `${TOUCH ? 'TOUCH' : 'KEYBOARD'} · TARGET ${input.target}W`;
  if (TOUCH) updateTouch(bt);
  const dr = p.draft * (p.puActive === 'draft' ? 1.5 : 1);
  $('h-draft').textContent = `DRAFT ${Math.round(dr * 100)}%`;
  $('h-draft').style.opacity = dr > 0.04 ? 1 : 0;
  $('h-speed').textContent = (p.v * 3.6).toFixed(1);
  $('h-dist').textContent = (Math.max(0, p.dist) / 1000).toFixed(2);
  $('h-time').textContent = fmtTime(game.rideTime);
  $('h-elev').textContent = Math.round(game.elev);
  const sorted = riders.slice().sort((a, b) => b.dist - a.dist), me = sorted.indexOf(p);
  if (game.race) { $('h-lap').textContent = `${me + 1}/${riders.length}`; $('h-laplbl').textContent = `pos · lap ${Math.min(game.laps, Math.floor(Math.max(0, p.dist) / L) + 1)}/${game.laps}`; }
  else { $('h-lap').textContent = Math.floor(Math.max(0, p.dist) / L) + 1; $('h-laplbl').textContent = 'lap'; }
  const gr = p.pos.grade;
  $('h-grade').textContent = (gr * 100).toFixed(1) + '%';
  $('h-grade').style.color = gradeColor(gr);

  // nearby riders
  const from = clamp(me - 4, 0, Math.max(0, sorted.length - 9)), list = sorted.slice(from, from + 9);
  const box = $('riders');
  if (!riderRows.length) { box.innerHTML = '<div class="hd">RIDERS NEARBY</div>'; for (let i = 0; i < 9; i++) { const d = document.createElement('div'); d.className = 'r'; d.innerHTML = '<span></span><span></span><span></span><span></span>'; box.appendChild(d); riderRows.push(d); } }
  riderRows.forEach((row, i) => {
    const r = list[i];
    row.style.display = r ? '' : 'none';
    if (!r) return;
    row.classList.toggle('me', r === p);
    const c = row.children;
    c[0].textContent = from + i + 1;
    c[1].textContent = r === p ? p.name : r.name;
    c[2].textContent = (r.power / r.mass).toFixed(1);
    c[3].textContent = r === p ? '' : fmtGap((r.dist - p.dist) / Math.max(p.v, 5));
  });

  // power-up
  const pu = $('pu');
  if (p.puActive) { const d = POWERUPS[p.puActive]; $('pu-icon').textContent = d.icon; $('pu-txt').textContent = d.name; pu.style.setProperty('--p', (p.puT / d.dur) * 100 + '%'); pu.classList.remove('ready'); }
  else if (p.puHeld) { $('pu-icon').textContent = POWERUPS[p.puHeld].icon; $('pu-txt').textContent = 'SPACE'; pu.style.setProperty('--p', '100%'); pu.classList.add('ready'); }
  else { $('pu-icon').textContent = ''; $('pu-txt').textContent = ''; pu.style.setProperty('--p', '0%'); pu.classList.remove('ready'); }

  // live segment
  const sg = SEGS.find((s) => p.segStart[s.id] != null);
  $('segment').classList.toggle('hidden', !sg);
  if (sg) {
    const len = sg.end - sg.start, done = clamp(mod(p.dist - sg.start, L), 0, len);
    $('segment').style.borderLeftColor = $('seg-bar').style.background = sg.color;
    $('seg-name').textContent = `${sg.icon} ${sg.name}`;
    $('seg-time').textContent = fmtTime(game.time - p.segStart[sg.id]);
    $('seg-bar').style.width = (done / len) * 100 + '%';
    $('seg-togo').textContent = `${Math.round(len - done)} m to go`;
    $('seg-lead').textContent = sg.best[0] ? `Leader ${sg.best[0].name} ${fmtTime(sg.best[0].t)}` : 'No times yet';
  }
  for (const r of riders) if (r.label && r.label.visible) r.labelW.textContent = (r.power / r.mass).toFixed(1);
}

function finishRace() {
  game.finished = true;
  chime([523, 659, 784, 1046]);
  toast('🏁 FINISHED!', 'orange', 4000);
  setTimeout(showResults, 2500);
}
function showResults() {
  const list = riders.slice().sort((a, b) => (a.finishTime ?? Infinity) - (b.finishTime ?? Infinity) || b.dist - a.dist);
  const pos = list.indexOf(player) + 1, sfx = pos === 1 ? 'st' : pos === 2 ? 'nd' : pos === 3 ? 'rd' : 'th';
  const rows = list.slice(0, 12).map((r, i) => `<tr class="${r === player ? 'me' : ''}"><td>${i + 1}</td><td>${r === player ? player.name : r.name}</td><td>${r.finishTime != null ? fmtTime(r.finishTime) : '+' + ((game.raceDist - r.dist) / 1000).toFixed(2) + ' km'}</td></tr>`).join('');
  const el = $('results');
  el.innerHTML = `<div class="panel"><h2>${pos}<span>${sfx}</span> PLACE</h2><div style="color:#aab4c4">${fmtTime(player.finishTime)} · avg ${Math.round(game.energy / game.rideTime)} W · ${Math.round(game.elev)} m climbed</div>
    <table>${rows}</table><button id="r-go">KEEP RIDING</button><button class="ghost" onclick="location.reload()">MAIN MENU</button></div>`;
  el.classList.remove('hidden');
  $('r-go').onclick = () => el.classList.add('hidden');
}

// ============================================================ audio
const audio = {};
function initAudio() {
  const ctx = (audio.ctx = new AudioContext()), buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  audio.master = ctx.createGain(); audio.master.connect(ctx.destination);
  const noise = (type, f, q, off) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; s.connect(fl).connect(g).connect(audio.master); s.start(0, off); return { fl, g }; };
  audio.wind = noise('bandpass', 500, 0.6, 0);
  audio.crowd = noise('bandpass', 1700, 1.2, 1);
  const osc = ctx.createOscillator(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
  osc.type = 'square'; hp.type = 'highpass'; hp.frequency.value = 1400; g.gain.value = 0;
  osc.connect(hp).connect(g).connect(audio.master); osc.start();
  audio.hub = { osc, g };
  audio.rumble = noise('lowpass', 70, 0.7, 0.5);
  audio.noiseBuf = buf;
  // cave reverb: synthetic decaying-noise impulse, faded in while inside a tunnel
  const ir = ctx.createBuffer(2, ctx.sampleRate * 2.4, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const ch = ir.getChannelData(c); for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, 3); }
  const conv = ctx.createConvolver(); conv.buffer = ir;
  audio.wet = ctx.createGain(); audio.wet.gain.value = 0;
  audio.master.connect(conv).connect(audio.wet).connect(ctx.destination);
}
function thunder(dist) {
  if (!audio.ctx || game.muted) return;
  const ctx = audio.ctx, t0 = ctx.currentTime + dist / 343, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = audio.noiseBuf; f.type = 'lowpass'; f.frequency.value = 260;
  const v = clamp(1.2 - dist / 4000, 0.15, 0.9);
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(v, t0 + 0.05); g.gain.exponentialRampToValueAtTime(0.001, t0 + 3.5);
  s.connect(f).connect(g).connect(audio.master); s.start(t0, Math.random()); s.stop(t0 + 3.6);
}
function updateAudio() {
  if (!audio.ctx || !player) return;
  const t = audio.ctx.currentTime, v = player.v;
  audio.master.gain.setTargetAtTime(game.muted || game.paused ? 0 : 1, t, 0.05);
  audio.wind.g.gain.setTargetAtTime(Math.min(0.32, (v / 15) ** 2 * 0.28), t, 0.15);
  audio.wind.fl.frequency.setTargetAtTime(280 + v * 55, t, 0.2);
  const coast = player.power < 10 && v > 2;
  audio.hub.g.gain.setTargetAtTime(coast ? 0.022 : 0, t, 0.08);
  audio.hub.osc.frequency.setTargetAtTime((v / (2 * Math.PI * WHEEL_R)) * 36, t, 0.1);
  const dCrowd = Math.min(...[SEGS[0].end, L].map((s) => Math.abs(mod(player.dist - s + L / 2 + 50, L) - L / 2)));
  audio.crowd.g.gain.setTargetAtTime(clamp(1 - dCrowd / 140, 0, 1) * 0.16, t, 0.3);
  audio.rumble.g.gain.setTargetAtTime(Math.min(0.9, game.shake * 0.8), t, 0.2);
  audio.wet.gain.setTargetAtTime(game.tf * 0.55, t, 0.3);
}
function chime(freqs) {
  buzz(freqs.length > 2 ? [25, 40, 25] : 14);
  if (!audio.ctx || game.muted) return;
  const t0 = audio.ctx.currentTime;
  freqs.forEach((f, i) => {
    const o = audio.ctx.createOscillator(), g = audio.ctx.createGain(), t = t0 + i * 0.09;
    o.type = 'triangle'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.015); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    o.connect(g).connect(audio.master); o.start(t); o.stop(t + 0.5);
  });
}

// ============================================================ bluetooth (FTMS / Cycling Power / HR)
async function connectTrainer() {
  const st = $('m-bt-status');
  try {
    const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: ['fitness_machine'] }, { services: ['cycling_power'] }], optionalServices: ['fitness_machine', 'cycling_power'] });
    st.textContent = 'Connecting…';
    const srv = await dev.gatt.connect();
    BT.name = (dev.name || 'TRAINER').toUpperCase();
    let ok = false;
    try {
      const svc = await srv.getPrimaryService('fitness_machine'), ch = await svc.getCharacteristic('indoor_bike_data');
      ch.addEventListener('characteristicvaluechanged', (e) => parseBikeData(e.target.value));
      await ch.startNotifications(); ok = true;
      try {
        const cp = await svc.getCharacteristic('fitness_machine_control_point');
        await cp.startNotifications();
        await cp.writeValueWithResponse(new Uint8Array([0x00])); // request control
        BT.cp = cp;
      } catch (e) { console.warn('FTMS control point unavailable', e); }
    } catch { /* not FTMS */ }
    if (!ok) {
      const ch = await (await srv.getPrimaryService('cycling_power')).getCharacteristic('cycling_power_measurement');
      ch.addEventListener('characteristicvaluechanged', (e) => parsePower(e.target.value));
      await ch.startNotifications();
    }
    st.textContent = `Connected: ${dev.name}${BT.cp ? ' · grade simulation on' : ''}`;
    $('m-trainer').classList.add('ok');
  } catch (e) { st.textContent = 'Trainer: ' + e.message; }
}
function parseBikeData(dv) {
  const f = dv.getUint16(0, true);
  let o = 2;
  if (!(f & 1)) o += 2; // instantaneous speed
  if (f & 2) o += 2;
  if (f & 4) { BT.cad = dv.getUint16(o, true) / 2; o += 2; }
  if (f & 8) o += 2;
  if (f & 16) o += 3;
  if (f & 32) o += 2;
  if (f & 64) { BT.power = dv.getInt16(o, true); BT.powerAt = performance.now(); o += 2; }
  if (f & 128) o += 2;
  if (f & 256) o += 5;
  if (f & 512) { BT.hr = dv.getUint8(o); BT.hrAt = performance.now(); }
}
function parsePower(dv) {
  const f = dv.getUint16(0, true);
  BT.power = dv.getInt16(2, true); BT.powerAt = performance.now();
  let o = 4;
  if (f & 1) o += 1; if (f & 4) o += 2; if (f & 16) o += 6;
  if (f & 32) {
    const revs = dv.getUint16(o, true), t = dv.getUint16(o + 2, true);
    if (BT.crank) { const dr = (revs - BT.crank.revs) & 0xffff, dtc = ((t - BT.crank.t) & 0xffff) / 1024; if (dtc > 0) BT.cad = (dr / dtc) * 60; else if (performance.now() - BT.crank.at > 2500) BT.cad = 0; }
    if (!BT.crank || ((t - BT.crank.t) & 0xffff)) BT.crank = { revs, t, at: performance.now() };
  }
}
async function sendGrade(grade) {
  BT.lastSend = performance.now();
  const g = Math.round(clamp(grade * 100 * 0.5, -10, 10) * 100); // 50% trainer difficulty, units of 0.01%
  if (BT.busy || Math.abs(g - BT.lastGrade) < 20) return;
  BT.busy = true;
  const b = new DataView(new ArrayBuffer(7));
  b.setUint8(0, 0x11); b.setInt16(1, 0, true); b.setInt16(3, g, true); b.setUint8(5, 40); b.setUint8(6, 51);
  try { await BT.cp.writeValueWithResponse(b.buffer); BT.lastGrade = g; } catch (e) { console.warn(e); }
  BT.busy = false;
}
async function connectHR() {
  const st = $('m-bt-status');
  try {
    const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
    const ch = await (await (await dev.gatt.connect()).getPrimaryService('heart_rate')).getCharacteristic('heart_rate_measurement');
    ch.addEventListener('characteristicvaluechanged', (e) => { const dv = e.target.value; BT.hr = dv.getUint8(0) & 1 ? dv.getUint16(1, true) : dv.getUint8(1); BT.hrAt = performance.now(); });
    await ch.startNotifications();
    st.textContent = `HR connected: ${dev.name}`;
    $('m-hrm').classList.add('ok');
  } catch (e) { st.textContent = 'HR: ' + e.message; }
}

// ============================================================ start / input
function startRide() {
  const name = $('m-name').value.trim() || 'You', mass = clamp(+$('m-weight').value || 75, 40, 150), ftp = clamp(+$('m-ftp').value || 250, 80, 500);
  const laps = +document.querySelector('#m-mode .on').dataset.laps, nBots = +$('m-bots').value;
  game.race = laps > 0; game.laps = laps; game.raceDist = laps * L;
  input.target = Math.round((ftp * 0.75) / 10) * 10;
  const names = BOT_NAMES.slice().sort(() => rand() - 0.5);
  const lanes = [-3, -1, 1, 3];
  player = createRider({ name, cc: '', isPlayer: true, mass, ftp, team: 0, shoe: 0, dist: -1 - 2.6, lat: game.race ? -1 : 0 });
  for (let i = 0; i < nBots; i++) {
    const m = rr(57, 88), wkg = rr(2.5, 4.7), [nm, cc] = names[i % names.length];
    let dist = 0, lat = 0, v = 0; // race grid is assigned below
    if (!game.race) {
      const grp = Math.floor(i / 5), base = grp === 0 ? 45 : 200 + ((grp * 977) % Math.floor(L - 400));
      dist = base + (i % 5) * 2.6; lat = rr(-3, 3); v = 9;
    }
    createRider({ name: nm, cc, mass: m, ftp: m * wkg, w0: rr(14000, 26000), effort: rr(0.62, 0.82), aggr: rr(0.4, 1.6), team: 1 + Math.floor(rand() * (TEAMS.length - 1)), dist, lat, v });
  }
  if (game.race) { // proper grid: 4 abreast, player front row
    riders.forEach((r, i) => { r.dist = r.prevDist = -1 - Math.floor(i / 4) * 2.6; r.lat = r.latTarget = r.pref = lanes[i % 4]; });
  }
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('touch').classList.remove('hidden');
  const zc = ['#8e9aae', '#3a8dde', '#3ddc84', '#ffd23f', '#fc6719', '#ff3d3d'], stops = [0, ...ZONES.map((z) => z / THROTTLE_MAX), 1];
  $('th-zones').style.background = `linear-gradient(0deg,${zc.map((c, i) => `${c} ${stops[i] * 100}% ${stops[i + 1] * 100}%`).join(',')})`;
  initProfile(); initMinimap();
  initAudio();
  keepAwake();
  if (TOUCH && FS_OK && document.body.classList.contains('compact')) act.fullscreen();
  game.state = 'countdown'; game.countdown = 3.99;
  camPos.copy(camera.position);
}

// power zones as fractions of FTP (Z1..Z6 boundaries) and the throttle's full-scale
const ZONES = [0.6, 0.76, 0.9, 1.05, 1.19], THROTTLE_MAX = 1.6;
const zoneOf = (w) => ZONES.filter((z) => w / player.ftp >= z).length;
const ZONE_COLORS = ['#c3cbd8', '#5aaeff', '#3ddc84', '#ffd23f', '#ff8a3d', '#ff4d4d'];

const act = {
  power: (d) => { input.target = clamp(input.target + d, 0, 1500); if (TOUCH) updateThrottle(); },
  steer: (d) => { player.latTarget = clamp(player.latTarget + d * 1.2, -4.6, 4.6); input.manualT = 4; },
  powerup: () => {
    if (!player.puHeld) return;
    player.puActive = player.puHeld; player.puT = POWERUPS[player.puHeld].dur;
    toast(`${POWERUPS[player.puHeld].icon} ${POWERUPS[player.puHeld].desc}`, 'blue'); player.puHeld = null; chime([1175, 1568]);
  },
  cam: (i = (game.cam + 1) % CAMS.length) => setCam(i),
  rideOn: () => {
    const near = riders.filter((r) => r !== player && Math.abs(r.dist - player.dist) < 40).sort((a, b) => Math.abs(a.dist - player.dist) - Math.abs(b.dist - player.dist))[0];
    if (near) { toast(`👍 You gave ${near.name} a Ride On`, 'orange'); chime([784, 988]); }
  },
  pause: () => { game.paused = !game.paused; $('pause').classList.toggle('hidden', !game.paused); if (game.paused) setSprint(false); },
  mute: () => { game.muted = !game.muted; $('t-mute').textContent = game.muted ? '🔇' : '🔊'; },
  fullscreen: () => {
    const d = document, el = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) return (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    Promise.resolve((el.requestFullscreen || el.webkitRequestFullscreen)?.call(el, { navigationUI: 'hide' }))
      .then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
  },
};
function setSprint(on) {
  if (input.sprint === on || !player) return;
  input.sprint = on;
  $('t-attack').classList.toggle('down', on);
  if (on) { buzz(30); if (player.wbal <= 0) toast('🥵 No matches left — recover first', 'red', 1600); }
}
addEventListener('keydown', (e) => {
  if (!player) return;
  const k = e.key.toLowerCase();
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
  const step = e.shiftKey ? 25 : 10;
  if (k === 'arrowup' || k === 'w') act.power(step);
  else if (k === 'arrowdown' || k === 's') act.power(-step);
  else if (k === 'arrowleft' || k === 'a') act.steer(-1);
  else if (k === 'arrowright' || k === 'd') act.steer(1);
  else if (k === ' ') act.powerup();
  else if (k === 'x') setSprint(true);
  else if (k >= '1' && k <= '6') act.cam(+k - 1);
  else if (k === 'c') act.cam();
  else if (k === 'r') act.rideOn();
  else if (k === 'p' || k === 'escape') act.pause();
  else if (k === 'm') act.mute();
  else if (k === 'f') act.fullscreen();
  else if (k === 'h') $('help').classList.toggle('hidden');
});
addEventListener('keyup', (e) => { if (e.key.toLowerCase() === 'x') setSprint(false); });

// touch buttons: tap fires once, holding a [data-hold] button auto-repeats
document.querySelectorAll('[data-act]').forEach((b) => {
  let t1, t2;
  const stop = () => { clearTimeout(t1); clearInterval(t2); b.classList.remove('down'); };
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!player) return;
    const fire = () => act[b.dataset.act](b.dataset.arg != null ? +b.dataset.arg : undefined);
    fire(); buzz(8); b.classList.add('down');
    if (b.hasAttribute('data-hold')) t1 = setTimeout(() => (t2 = setInterval(fire, 90)), 380);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, stop);
});
// attack: hold to sprint
const atk = $('t-attack');
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ } };
atk.addEventListener('pointerdown', (e) => { e.preventDefault(); capture(atk, e); setSprint(true); });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) atk.addEventListener(ev, () => setSprint(false));
// throttle: drag up/down relative to where you touched; tap above/below the knob for ±10 W
const th = $('throttle');
let drag = null;
th.addEventListener('pointerdown', (e) => {
  if (!player) return;
  capture(th, e);
  drag = { y: e.clientY, t: input.target, moved: false, rect: th.getBoundingClientRect() };
  th.classList.add('drag'); buzz(8);
});
th.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (Math.abs(e.clientY - drag.y) > 6) drag.moved = true;
  if (!drag.moved) return;
  const max = Math.round(player.ftp * THROTTLE_MAX), t = clamp(Math.round((drag.t + ((drag.y - e.clientY) / drag.rect.height) * max) / 5) * 5, 0, max);
  if (t === input.target) return;
  if (zoneOf(t) !== zoneOf(input.target)) buzz(12);
  input.target = t; updateThrottle();
});
const endDrag = () => {
  if (drag && !drag.moved) {
    const knob = $('th-knob').getBoundingClientRect();
    act.power(drag.y < knob.top + knob.height / 2 ? 10 : -10); buzz(8);
  }
  drag = null; th.classList.remove('drag');
};
th.addEventListener('pointerup', endDrag);
th.addEventListener('pointercancel', () => { drag = null; th.classList.remove('drag'); });
$('touch').addEventListener('contextmenu', (e) => e.preventDefault());

function updateThrottle(bt = false) {
  const w = bt ? BT.power : input.target, f = clamp(w / (player.ftp * THROTTLE_MAX), 0, 1), pos = `calc(26px + ${f} * (100% - 52px))`, z = zoneOf(w);
  $('th-knob').style.bottom = pos; $('th-fill').style.height = pos;
  $('t-target').textContent = Math.round(w);
  $('th-zone').textContent = 'Z' + (z + 1); $('th-zone').style.color = ZONE_COLORS[z];
  $('th-fill').style.background = `linear-gradient(0deg,${ZONE_COLORS[z]}99,${ZONE_COLORS[z]}22)`;
}
function updateTouch(bt) {
  th.classList.toggle('bt', bt);
  if (!drag) updateThrottle(bt);
  atk.style.setProperty('--e', (player.wbal / player.w0) * 100 + '%');
  atk.classList.toggle('empty', player.wbal <= 0);
  $('t-pu').classList.toggle('hidden', !player.puHeld);
  if (player.puHeld) $('t-pu').textContent = POWERUPS[player.puHeld].icon;
}

$('pause').addEventListener('pointerdown', () => game.paused && act.pause());
document.addEventListener('gesturestart', (e) => e.preventDefault()); // iOS pinch-zoom
// keep the screen on while riding; auto-pause when the app is backgrounded
const keepAwake = () => navigator.wakeLock?.request('screen').catch(() => {});
document.addEventListener('visibilitychange', () => {
  if (!player) return;
  if (document.hidden) { if (game.state === 'ride' && !game.paused) act.pause(); }
  else keepAwake();
});
// HUD is designed at ~1320x820 and zoomed down; phones get a compact layout designed at 844x390
const fitHud = () => {
  const s = Math.min(innerWidth / 1320, innerHeight / 820), compact = s < 0.62;
  document.body.classList.toggle('compact', compact);
  $('hud').style.zoom = compact ? Math.min(1, innerWidth / 844, innerHeight / 390) : Math.min(1, s);
  $('touch').style.zoom = clamp(innerHeight / 720, 0.7, 1);
};
fitHud();
addEventListener('wheel', (e) => { if (player && game.state === 'ride') act.power(e.deltaY < 0 ? 10 : -10); }, { passive: true });
function setCam(i) { game.cam = i; $('camname').textContent = CAMS[i]; }

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight); composer?.setSize(innerWidth, innerHeight);
  fitHud();
  if (player) initProfile();
});

// dynamic resolution: trade pixels for frame rate on slower GPUs (phones/tablets)
const perf = { t: 0, n: 0, max: renderer.getPixelRatio() };
function adaptResolution(raw) {
  if (raw > 0.25) return; // ignore hitches (tab switches etc.)
  perf.t += raw; perf.n++;
  if (perf.t < 2) return;
  const fps = perf.n / perf.t, pr = renderer.getPixelRatio();
  const next = fps < 45 ? Math.max(0.6, pr - 0.15) : fps > 57 ? Math.min(perf.max, pr + 0.1) : pr;
  if (next !== pr) { renderer.setPixelRatio(next); composer?.setPixelRatio(next); }
  perf.t = perf.n = 0;
}

// ============================================================ main loop
const clock = new THREE.Clock();
let elapsed = 0, volcanoFX = null, tunnelFX = null, birdsFX = null;
const FOG_BASE = new THREE.Color(WORLD.fog[0]), FOG_CAVE = new THREE.Color(0x1a1412);
function loop() {
  requestAnimationFrame(loop);
  const raw = clock.getDelta(), dt = Math.min(raw, 0.05);
  if (game.paused) return;
  adaptResolution(raw);
  elapsed += dt;
  update(dt);
  if (!game.camLock) updateCamera(dt, elapsed); // camLock: scripted screenshots position the camera themselves
  for (const r of riders) placeRider(r, game.state === 'ride' ? dt : 0, camPos);
  const focus = player ? player.group.position : camLook;
  sun.target.position.copy(focus);
  sun.position.copy(focus).addScaledVector(sunDir, 500);
  if (waterTex) waterTex.offset.set(elapsed * 0.0012, elapsed * 0.0008);
  if (crowd) updateCrowd(elapsed);
  U.time.value = elapsed; U.cam.value.copy(camera.position);
  birdsFX?.(elapsed);
  tunnelFX?.(dt, elapsed, camera.position);
  game.shake = volcanoFX?.(dt, elapsed, camera.position) ?? 0;
  // eye adaptation: dim ambient/sky light inside tunnels and let exposure catch up with a lag
  const ti = tunnelAt(camera.position.x, camera.position.z);
  game.tf += ((ti >= 0 ? smooth(3, 45, C.D[ti]) : 0) - game.tf) * Math.min(1, dt * 3);
  hemi.intensity = WORLD.hemi[2] * (1 - 0.93 * game.tf);
  scene.environmentIntensity = WORLD.env * (1 - 0.9 * game.tf);
  scene.fog.color.copy(FOG_BASE).lerp(FOG_CAVE, game.tf);
  renderer.toneMappingExposure += (WORLD.exposure * (1 + 0.9 * game.tf) - renderer.toneMappingExposure) * Math.min(1, dt * 1.2);
  if (game.shake > 0.01 && !game.camLock) { // eruption tremor, stronger inside the mountain
    const a = game.shake * 0.2 * (1 + game.tf) * clamp(1.4 - Math.hypot(camera.position.x, camera.position.z) / 3000, 0.25, 1);
    camera.position.x += (Math.random() - 0.5) * a; camera.position.y += (Math.random() - 0.5) * a; camera.position.z += (Math.random() - 0.5) * a;
  }
  if (player && (game.hudT -= dt) <= 0) { game.hudT = 0.1; updateHUD(); drawProfile(); drawMinimap(); }
  updateAudio();
  if (composer) composer.render(); else renderer.render(scene, camera);
  labels.render(scene, camera);
}

async function init() {
  const msg = (t) => { $('load-msg').textContent = t; return nextFrame(); };
  await document.fonts.load('italic 800 64px "Barlow Condensed"').catch(() => {});
  await msg('Loading sky and materials');
  [TX] = await Promise.all([
    loadTextures(['grass004_color.jpg', 'grass004_normal.jpg', 'ground037_color.jpg', 'ground037_normal.jpg', 'rock051_color.jpg', 'rock051_normal.jpg', 'rock058_color.jpg', 'rock058_normal.jpg',
      'ground054_color.jpg', 'ground054_normal.jpg', 'snow015_color.jpg', 'snow015_normal.jpg', 'asphalt033_color.jpg', 'asphalt033_normal.jpg', 'bark014_color.jpg', 'bark014_normal.jpg',
      'bark012_color.jpg', 'bark012_normal.jpg', 'lava001_color.jpg', 'lava001_emission.jpg', 'leafset009.png'], ANISO),
    setupSky(),
  ]);
  await msg(`Sculpting ${WORLD.name}`); buildTerrain();
  await msg('Paving roads'); buildRoad(); buildWater();
  await msg(WORLD.id === 'fuego' ? 'Igniting the volcano' : 'Planting forests'); buildVegetation();
  if (!LOW) scene.add(makeGrass({ heights: tH, tn: TN, cell: CELL, half: HALF, size: T_SIZE, tint: grassTint, grid: TOUCH ? 150 : 240, spacing: 0.5 }));
  birdsFX = makeBirds(scene, WORLD.birds.flocks.map(([x, y, z, r, n, speed]) => ({ c: new THREE.Vector3(x, y, z), r, n, speed })), WORLD.birds.color, rand);
  if (C.runs.length) { await msg('Boring tunnels'); tunnelFX = buildTunnels({ scene, C, M, runs: C.runs, chamber: C.chamber, lava: WORLD.id === 'fuego', lavaMaps: { color: TX.lava001_color, emission: TX.lava001_emission }, rockMaps: { color: TX.rock058_color, normal: TX.rock058_normal }, canvasTex, rand }); }
  if (WORLD.id === 'fuego') {
    const vents = [520, 380, 250, 120].map((back, i) => { C.at(SEGS[0].end - back, tmpP); const lat = (i % 2 ? -1 : 1) * (ROAD_W / 2 + 15), x = tmpP.x - Math.cos(tmpP.psi) * lat, z = tmpP.z + Math.sin(tmpP.psi) * lat; return new THREE.Vector3(x, getH(x, z), z); });
    volcanoFX = buildVolcanoFX({
      scene, canvasTex, rand, rivers: RIVERS, crater: WORLD.crater, vents, getH, lavaMaps: { color: TX.lava001_color, emission: TX.lava001_emission },
      onEruption: () => { if (game.state === 'ride') { toast('🌋 FUEGO IS ERUPTING', 'red', 4000); buzz([60, 40, 120]); } },
      onThunder: (p) => thunder(p.distanceTo(camera.position)),
    });
  }
  await msg('Building arches'); buildArches(); buildCrowd(); buildRiderGeo();
  await msg('Ready');
  game.state = 'menu';
  $('loading').classList.add('hidden');
  $('menu').classList.remove('hidden');
  loop();
}

document.querySelectorAll('#m-mode button').forEach((b) => (b.onclick = () => { document.querySelectorAll('#m-mode button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); }));
$('m-bots').oninput = (e) => ($('m-bots-v').textContent = e.target.value);
$('m-go').onclick = () => { saveSettings(); startRide(); };
// menu settings survive the reload that switching worlds needs
const SETTINGS = 'veloworld-settings';
function saveSettings() {
  localStorage.setItem(SETTINGS, JSON.stringify({ name: $('m-name').value, weight: $('m-weight').value, ftp: $('m-ftp').value, bots: $('m-bots').value, laps: document.querySelector('#m-mode .on').dataset.laps }));
}
try {
  const st = JSON.parse(localStorage.getItem(SETTINGS) || 'null');
  if (st) {
    Object.assign($('m-name'), { value: st.name }); $('m-weight').value = st.weight; $('m-ftp').value = st.ftp; $('m-bots').value = $('m-bots-v').textContent = st.bots;
    document.querySelectorAll('#m-mode button').forEach((b) => b.classList.toggle('on', b.dataset.laps === st.laps));
  }
} catch { /* corrupt settings: keep defaults */ }
$('m-tagline').textContent = WORLD.tagline;
document.querySelectorAll('#m-map button').forEach((b) => {
  b.classList.toggle('on', b.dataset.map === WORLD_ID);
  b.onclick = () => {
    if (b.dataset.map === WORLD_ID) return;
    saveSettings();
    const q = new URLSearchParams(location.search); q.set('map', b.dataset.map); location.search = q.toString();
  };
});
if (navigator.bluetooth) { $('m-trainer').onclick = connectTrainer; $('m-hrm').onclick = connectHR; }
else { $('m-trainer').disabled = $('m-hrm').disabled = true; $('m-bt-status').textContent = `Web Bluetooth not available in this browser — ${TOUCH ? 'touch' : 'keyboard'} controls.`; }
if (!FS_OK) $('t-fs').classList.add('hidden');
if (TOUCH && !FS_OK && !navigator.standalone && !matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches) $('m-install').classList.remove('hidden');
window.__game = {
  game, riders, C, update, input, act, setSprint, updateCamera, camera, getH, renderer, scene, get player() { return player; },
  erupt: () => volcanoFX?.erupt(),
  fastForward: (sec) => { for (let k = 0; k < sec / 0.05; k++) { elapsed += 0.05; U.time.value = elapsed; volcanoFX?.(0.05, elapsed, camera.position); } }, // world FX only
};
init();
