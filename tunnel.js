// Tunnels and caverns: rock tubes swept along the route where it runs inside the terrain, with
// portal collars, ceiling lamps (a small pool of real lights follows the camera), and for lava
// worlds a glowing channel beside the road, veins in the walls, a cavern with a lavafall,
// stalactites and a shaft of daylight.
import * as THREE from 'three';
import { U, TRI_GLSL, WP_VERT } from './environment.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
function hash3(x, y, z) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1440670441)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise3(x, y, z) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z), u = x - X, v = y - Y, w = z - Z;
  const s = (t) => t * t * (3 - 2 * t), a = s(u), b = s(v), c = s(w);
  const L = (dx, dy, dz) => hash3(X + dx, Y + dy, Z + dz);
  return lerp(lerp(lerp(L(0, 0, 0), L(1, 0, 0), a), lerp(L(0, 1, 0), L(1, 1, 0), a), b), lerp(lerp(L(0, 0, 1), L(1, 0, 1), a), lerp(L(0, 1, 1), L(1, 1, 1), a), b), c);
}
const fbm3 = (x, y, z) => noise3(x, y, z) * 0.55 + noise3(x * 2.1, y * 2.1, z * 2.1) * 0.3 + noise3(x * 4.3, y * 4.3, z * 4.3) * 0.15;

export const ROAD_HALF = 6;
// cross-section of the tube at chamber factor ch (0 = tunnel, 1 = cavern)
export const tunnelSize = (ch) => ({ w: 12 + 16 * ch, h: 9 + 17 * ch });

export function buildTunnels({ scene, C, M, runs, chamber, lava, lavaMaps, rockMaps, canvasTex, rand }) {
  const NA = 24, NF = 8, P = NA + 1 + NF - 1;
  const pos = [], col = [], glow = [], idx = [], lamps = [], lavaLights = [], ceil = [];
  const color = new THREE.Color(), tmp = new THREE.Vector3();
  const BASALT = new THREE.Color(0x2c2623), RUST = new THREE.Color(0x4a2c20), ASH = new THREE.Color(0x58514c);
  const frame = (i) => { const k = ((i % M) + M) % M, p = C.PSI[k]; return { k, x: C.X[k], y: C.Y[k] - 0.8, z: C.Z[k], rx: -Math.cos(p), rz: Math.sin(p) }; };
  // outline point j of the ring at sample i: wall arch (displaced rock) then flat floor back across
  const point = (f, ch, j, out) => {
    const { w, h } = tunnelSize(ch);
    if (j <= NA) {
      const th = (j / NA) * Math.PI, ox = Math.cos(th), oy = Math.sin(th);
      out.set(f.x + f.rx * ox * w, f.y + oy * h, f.z + f.rz * ox * w);
      const d = (fbm3(out.x * 0.09, out.y * 0.09, out.z * 0.09) - 0.5) * (4 + 4 * ch) + (noise3(out.x * 0.35, out.y * 0.35, out.z * 0.35) - 0.5) * 1.2;
      const fl = Math.min(1, oy * 4); // keep the wall foot on the floor
      out.x += f.rx * ox * d * fl; out.y += oy * d * fl; out.z += f.rz * ox * d * fl;
      return th;
    }
    const t = (j - NA) / NF, ox = lerp(-1, 1, t) * w; // left -> right along the floor
    out.set(f.x + f.rx * ox, f.y, f.z + f.rz * ox);
    return -1;
  };
  for (const [start, len] of runs) {
    const base = pos.length / 3;
    for (let n = 0; n <= len; n++) {
      const i = start + n, f = frame(i), ch = chamber(f.k);
      for (let j = 0; j < P; j++) {
        const th = point(f, ch, j, tmp);
        pos.push(tmp.x, tmp.y, tmp.z);
        const m = fbm3(tmp.x * 0.05, tmp.y * 0.05, tmp.z * 0.05);
        color.copy(BASALT).lerp(RUST, clamp((m - 0.45) * 3, 0, 0.7)).lerp(ASH, th >= 0 ? clamp((Math.sin(th) - 0.7) * 2, 0, 0.4) : 0);
        if (th < 0) color.multiplyScalar(0.7);
        col.push(color.r, color.g, color.b);
        // thin glowing veins, strongest on the lava side and in the cavern
        const vein = Math.abs(noise3(tmp.x * 0.12, tmp.y * 0.12, tmp.z * 0.12) - 0.5);
        glow.push(lava && th >= 0 ? clamp(1 - vein / 0.012, 0, 1) * (0.3 + 0.7 * clamp(Math.cos(th) + ch, 0, 1)) : 0);
      }
      if (n) for (let j = 0; j < P; j++) { const a = base + (n - 1) * P + j, b = base + (n - 1) * P + ((j + 1) % P); idx.push(a, b, a + P, b, b + P, a + P); }
      if (n % 9 === 0 && ch < 0.3) { point(f, ch, NA / 2, tmp); lamps.push(new THREE.Vector3(f.x, Math.min(tmp.y, f.y + tunnelSize(ch).h) - 0.6, f.z)); }
      if (lava && n % 14 === 0) lavaLights.push(new THREE.Vector3(f.x + f.rx * (9 + 6 * ch), f.y + 1.2, f.z + f.rz * (9 + 6 * ch)));
      if (ch > 0.6) ceil.push({ f, ch });
    }
    // rock collars at both portals hide the seam with the hillside
    for (const [n, dir] of [[0, -1], [len, 1]]) {
      const f = frame(start + n), ch = chamber(f.k), b0 = pos.length / 3, tx = -f.rz * dir, tz = f.rx * dir; // tx,tz: along the route, outward
      for (let j = 0; j <= NA; j++) {
        point(f, ch, j, tmp); pos.push(tmp.x, tmp.y, tmp.z);
        const th = (j / NA) * Math.PI, ox = Math.cos(th), oy = Math.sin(th), r = 2.5 + noise3(j * 0.7, n, 1) * 2.5;
        pos.push(tmp.x + f.rx * ox * r - tx * 5, tmp.y + oy * r, tmp.z + f.rz * ox * r - tz * 5);
        for (let q = 0; q < 2; q++) { col.push(BASALT.r, BASALT.g, BASALT.b); glow.push(0); }
        if (j) { const a = b0 + (j - 1) * 2; idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1); }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('glow', new THREE.Float32BufferAttribute(glow, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // photo basalt projected triplanar (normal faces the viewer: walls are seen from inside), glowing veins on top
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide });
  rockMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uTime: U.time, tpA: { value: rockMaps.color }, tpN: { value: rockMaps.normal } });
    sh.vertexShader = 'attribute float glow; varying float vGlow; varying vec3 vRP; varying vec3 vWP; varying vec3 vWN;\n' + sh.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vGlow = glow; vRP = position;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>' + WP_VERT);
    sh.fragmentShader = 'uniform float uTime; uniform sampler2D tpA, tpN; varying float vGlow; varying vec3 vRP; varying vec3 vWP; varying vec3 vWN;' + TRI_GLSL + '\n' + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 tpNn = normalize(vWN) * (gl_FrontFacing ? 1.0 : -1.0), tpw = tpW(tpNn);
        diffuseColor.rgb *= tpTriA(tpA, vWP, 7.0, tpw) * 2.2;
        vec3 tpNrm = tpTriN(tpN, vWP, 7.0, tpNn, tpw);`)
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(tpNrm, 0.0)).xyz);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += vec3(1.0, 0.3, 0.05) * vGlow * vGlow * vGlow * (1.6 + 0.6 * sin(uTime * 1.7 + vRP.x * 0.2 + vRP.z * 0.13));');
  };
  rockMat.customProgramCacheKey = () => 'tunnel-rock';
  const rock = new THREE.Mesh(geo, rockMat);
  rock.castShadow = rock.receiveShadow = true;
  scene.add(rock);

  // ceiling lamps + a pool of lights that jump to the light sources nearest the camera
  const lampMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 0.18, 0.7), new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffd9a0, emissiveIntensity: 4 }), Math.max(1, lamps.length));
  const o = new THREE.Object3D();
  lamps.forEach((p, i) => { o.position.copy(p); o.updateMatrix(); lampMesh.setMatrixAt(i, o.matrix); });
  lampMesh.count = lamps.length;
  scene.add(lampMesh);
  const sources = [...lamps.map((p) => ({ p, c: 0xffc68a, i: 70 })), ...lavaLights.map((p) => ({ p, c: 0xff5a1a, i: 90 }))];
  const pool = Array.from({ length: 4 }, () => { const l = new THREE.PointLight(0xffffff, 0, 34, 1.6); scene.add(l); return l; });

  const fx = [];
  if (lava) {
    // lava channel beside the road (right-hand side), widening into a pool in the cavern
    const lt = lavaMaps.emission.clone(), lc = lavaMaps.color.clone();
    const lavaMat = new THREE.MeshStandardMaterial({ map: lc, roughness: 0.8, emissive: 0xffffff, emissiveMap: lt, emissiveIntensity: 2.6, side: THREE.DoubleSide });
    const lp = [], luv = [], li = [];
    for (const [start, len] of runs) {
      const b0 = lp.length / 3;
      for (let n = 0; n <= len; n++) {
        const f = frame(start + n), ch = chamber(f.k), w0 = ROAD_HALF + 2.2, w1 = w0 + 2.6 + 12 * ch, s = ((start + n) * C.L) / M;
        for (const w of [w0, w1]) { lp.push(f.x + f.rx * w, f.y + 0.25, f.z + f.rz * w); luv.push(w / 4, s / 4); } // 4 m tiles both ways
        if (n) { const a = b0 + (n - 1) * 2; li.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3)); lg.setAttribute('uv', new THREE.Float32BufferAttribute(luv, 2));
    lg.setIndex(li); lg.computeVertexNormals();
    scene.add(new THREE.Mesh(lg, lavaMat));
    fx.push((dt) => { lt.offset.y -= dt * 0.03; lc.offset.y = lt.offset.y; });

    // cavern set pieces around the chamber's centre
    const mid = ceil[Math.floor(ceil.length / 2)];
    if (mid) {
      const { f } = mid, { w, h } = tunnelSize(1), fwdX = -f.rz, fwdZ = f.rx;
      // lavafall pouring from a fissure in the far wall into the pool
      const ft = lavaMaps.emission.clone(); ft.repeat.set(1, 3);
      const fall = new THREE.Mesh(new THREE.PlaneGeometry(8, h + 2, 1, 8), new THREE.MeshStandardMaterial({ color: 0x120806, emissive: 0xffffff, emissiveMap: ft, emissiveIntensity: 4.5, side: THREE.DoubleSide }));
      const fx0 = f.x + f.rx * (w - 5) + fwdX * 30, fz0 = f.z + f.rz * (w - 5) + fwdZ * 30;
      fall.position.set(fx0, f.y + (h + 2) / 2 - 0.5, fz0);
      fall.lookAt(f.x + fwdX * 30, fall.position.y, f.z + fwdZ * 30);
      scene.add(fall);
      fx.push((dt) => (ft.offset.y += dt * 0.25));
      const glowTex = canvasTex(64, 64, (g, s) => { const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2); gr.addColorStop(0, 'rgba(255,140,40,.9)'); gr.addColorStop(1, 'rgba(255,60,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, s, s); });
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      halo.position.set(fx0, f.y + 2, fz0); halo.scale.set(26, 14, 1); scene.add(halo);
      const cavernLight = new THREE.PointLight(0xff6a24, 260, 120, 1.3);
      cavernLight.position.set(f.x + f.rx * (w - 9), f.y + 8, f.z + f.rz * (w - 9));
      scene.add(cavernLight);
      const fill = new THREE.PointLight(0xff4a14, 90, 70, 1.4); // bounce off the far wall
      fill.position.set(f.x - f.rx * (w - 6), f.y + 10, f.z - f.rz * (w - 6));
      scene.add(fill);
      fx.push((dt, t) => (cavernLight.intensity = 240 + Math.sin(t * 3.1) * 25 + Math.sin(t * 7.3) * 12));

      // shaft of daylight through a crack in the roof, with dust drifting in it
      const sx = f.x - fwdX * 45 - f.rx * 4, sz = f.z - fwdZ * 45 - f.rz * 4, top = f.y + h - 1.5;
      const shaftTex = canvasTex(8, 128, (g, W, H) => { const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, 'rgba(255,240,210,.55)'); gr.addColorStop(1, 'rgba(255,240,210,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, H); });
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 8, h, 24, 1, true).translate(0, -h / 2, 0),
        new THREE.MeshBasicMaterial({ map: shaftTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
      shaft.position.set(sx, top, sz); scene.add(shaft);
      const sky = new THREE.Mesh(new THREE.CircleGeometry(3, 20).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6, 5.4), fog: false }));
      sky.position.set(sx, top + 0.2, sz); scene.add(sky);
      const DN = 500, dp = new Float32Array(DN * 3), dseed = Array.from({ length: DN }, () => [rand() * 6.28, rand(), rand() * 6.28]);
      const dust = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(dp, 3)),
        new THREE.PointsMaterial({ color: 0xffe8c0, size: 0.07, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
      dust.frustumCulled = false; scene.add(dust);
      fx.push((dt, t) => {
        dseed.forEach(([a, r, ph], i) => {
          const y = ((r * h + t * 0.25 * (0.5 + r)) % h), rad = lerp(8, 2.5, y / h) * Math.sqrt((r * 7.3) % 1);
          dp[i * 3] = sx + Math.cos(a + t * 0.05) * rad; dp[i * 3 + 1] = top - h + y + Math.sin(t + ph) * 0.3; dp[i * 3 + 2] = sz + Math.sin(a + t * 0.05) * rad;
        });
        dust.geometry.attributes.position.needsUpdate = true;
      });
    }
    // stalactites from the cavern roof
    const stal = [];
    for (let n = 0; n < ceil.length; n += 2) {
      if (rand() > 0.55) continue;
      const { f, ch } = ceil[n], th = Math.PI * (0.25 + rand() * 0.5);
      point(f, ch, Math.round((th / Math.PI) * NA), tmp);
      stal.push({ p: tmp.clone(), r: 0.4 + rand() * 1.4, l: 2 + rand() * 7 });
    }
    const sm = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 7).translate(0, -0.5, 0).rotateX(Math.PI), new THREE.MeshStandardMaterial({ color: 0x2a2421, roughness: 0.9, flatShading: true }), Math.max(1, stal.length));
    stal.forEach((s, i) => { o.position.copy(s.p).add(new THREE.Vector3(0, 0.5, 0)); o.rotation.set(0, i, 0); o.scale.set(s.r, s.l, s.r); o.updateMatrix(); sm.setMatrixAt(i, o.matrix); });
    sm.count = stal.length; sm.castShadow = true;
    scene.add(sm);
  }

  const near = [];
  return (dt, t, cam) => {
    // light the nearest sources; a sorted top-4 pick is cheap for a few hundred candidates
    near.length = 0;
    for (const s of sources) { const d = s.p.distanceToSquared(cam); if (d < 70 * 70) near.push([d, s]); }
    near.sort((a, b) => a[0] - b[0]);
    pool.forEach((l, i) => {
      const s = near[i]?.[1];
      l.intensity = s ? s.i * (s.c === 0xff5a1a ? 0.85 + Math.sin(t * 4 + i) * 0.15 : 1) : 0;
      if (s) { l.position.copy(s.p); l.color.set(s.c); }
    });
    for (const f of fx) f(dt, t);
  };
}
