// Fuego world: lava (crater lake + rivers), smoke plume, steam vents, embers, and volcanic flora.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// tileable Voronoi crust: glowing cracks between dark plates; `heat` adds molten cell centres
export function lavaTexture(canvasTex, rand, heat) {
  const S = 256, pts = Array.from({ length: 30 }, () => [rand() * S, rand() * S]);
  const RAMP = [[0, 12, 4, 3], [0.35, 90, 14, 4], [0.6, 220, 70, 10], [0.85, 255, 170, 40], [1, 255, 240, 170]];
  return canvasTex(S, S, (g) => {
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let f1 = 1e9, f2 = 1e9;
      for (const [px, py] of pts) for (let oy = -S; oy <= S; oy += S) for (let ox = -S; ox <= S; ox += S) {
        const d = (x - px - ox) ** 2 + (y - py - oy) ** 2;
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
      }
      const t = clamp(Math.exp(-(Math.sqrt(f2) - Math.sqrt(f1)) / 4) + heat * (1 - Math.sqrt(f1) / 40) + (Math.random() - 0.5) * 0.08, 0, 1);
      let i = 0;
      while (i < RAMP.length - 2 && t > RAMP[i + 1][0]) i++;
      const A = RAMP[i], B = RAMP[i + 1], u = (t - A[0]) / (B[0] - A[0]), o = (y * S + x) * 4;
      for (let c = 0; c < 3; c++) img.data[o + c] = A[c + 1] + (B[c + 1] - A[c + 1]) * u;
      img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, true);
}

function smokeTexture(canvasTex, rand) {
  return canvasTex(128, 128, (g, w) => {
    for (let i = 0; i < 14; i++) {
      const x = w / 2 + (rand() - 0.5) * w * 0.4, y = w / 2 + (rand() - 0.5) * w * 0.4, r = w * (0.18 + rand() * 0.2);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, w);
    }
  });
}

// rising billboard puffs; each sprite cycles through its life with its own phase and jitter
function smoke(scene, tex, rand, o) {
  const sprites = [];
  for (let i = 0; i < o.count; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: true, rotation: rand() * 6.28 }));
    sp.userData = { off: rand() * o.life, jx: (rand() - 0.5) * o.spread, jz: (rand() - 0.5) * o.spread, origin: o.origins[i % o.origins.length], spin: (rand() - 0.5) * 0.2 };
    scene.add(sp);
    sprites.push(sp);
  }
  const c0 = new THREE.Color(o.c0), c1 = new THREE.Color(o.c1);
  return (t, boost = 0) => { // boost 0..1 thickens, darkens and inflates the column (eruptions)
    for (const sp of sprites) {
      const d = sp.userData, age = (t + d.off) % o.life, u = age / o.life, grow = 1 + u * 3;
      sp.position.set(d.origin.x + d.jx * grow + o.wind.x * age, d.origin.y + o.rise * (1 + boost * 0.5) * age, d.origin.z + d.jz * grow + o.wind.z * age);
      sp.scale.setScalar((o.s0 + (o.s1 - o.s0) * Math.pow(u, 0.7)) * (1 + boost * 0.5));
      sp.material.opacity = Math.min(1, o.op * (1 + boost * 0.6)) * smooth(0, 0.1, u) * (1 - smooth(0.55, 1, u));
      sp.material.color.copy(c0).lerp(c1, smooth(0, 0.5, u)).multiplyScalar(1 - boost * 0.35);
      sp.material.rotation += d.spin * 0.016;
    }
  };
}

export function buildVolcanoFX({ scene, canvasTex, rand, rivers, crater, vents, getH, onEruption, onThunder }) {
  // lava lake in the crater
  const lakeTex = lavaTexture(canvasTex, rand, 0.55);
  lakeTex.repeat.set(7, 7);
  const lake = new THREE.Mesh(new THREE.CircleGeometry(crater.r, 72).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x120806, roughness: 0.8, emissive: 0xffffff, emissiveMap: lakeTex, emissiveIntensity: 4.5 }));
  lake.position.set(0, crater.y, 0);
  scene.add(lake);
  const glow = new THREE.PointLight(0xff5a1e, 3.5, 700, 0);
  glow.position.set(0, crater.y + 60, 0);
  scene.add(glow);

  // lava rivers: flat ribbons along the carved channels, crust flows downhill
  const riverTex = lavaTexture(canvasTex, rand, 0.12);
  const riverMat = new THREE.MeshStandardMaterial({ color: 0x120806, roughness: 0.9, emissive: 0xffffff, emissiveMap: riverTex, emissiveIntensity: 3.6, side: THREE.DoubleSide });
  const lavaPts = [];
  for (const pts of rivers) {
    const pos = [], uv = [], idx = [], A = 6;
    pts.forEach((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], tx = b.x - a.x, tz = b.z - a.z, l = Math.hypot(tx, tz) || 1, nx = -tz / l, nz = tx / l;
      for (let j = 0; j < A; j++) {
        const u = j / (A - 1), off = (u - 0.5) * 2 * p.w;
        pos.push(p.x + nx * off, p.y + 0.25 * (1 - (2 * u - 1) ** 2), p.z + nz * off); uv.push(u * 2, p.s / 28);
        if (i && j) { const c = i * A + j; idx.push(c - A - 1, c - A, c - 1, c - A, c, c - 1); }
      }
      if (i % 3 === 0) lavaPts.push(p);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    scene.add(new THREE.Mesh(geo, riverMat));
  }

  // smoke plume from the crater, glowing orange at its base; steam from roadside vents
  const smokeTex = smokeTexture(canvasTex, rand);
  const plume = smoke(scene, smokeTex, rand, { count: 70, origins: [V(0, crater.y + 20, 0)], life: 46, rise: 26, spread: 160, wind: V(9, 0, 4), s0: 160, s1: 760, op: 0.75, c0: 0xff8a4a, c1: 0x5d5552 });
  const steam = smoke(scene, smokeTex, rand, { count: vents.length * 16, origins: vents, life: 7, rise: 3.2, spread: 3, wind: V(0.8, 0, 0.4), s0: 3, s1: 16, op: 0.5, c0: 0xffffff, c1: 0xd8d4d0 });

  // embers drifting up from the lava
  const N = 2500, epos = new Float32Array(N * 3), vel = new Float32Array(N * 3), life = new Float32Array(N);
  const spawn = (i) => {
    const onLake = rand() < 0.4, p = onLake ? null : lavaPts[Math.floor(rand() * lavaPts.length)];
    const a = rand() * 6.28, r = Math.sqrt(rand()) * (onLake ? crater.r : p.w);
    epos[i * 3] = (onLake ? 0 : p.x) + Math.cos(a) * r; epos[i * 3 + 1] = (onLake ? crater.y : p.y) + 0.5; epos[i * 3 + 2] = (onLake ? 0 : p.z) + Math.sin(a) * r;
    vel[i * 3] = (rand() - 0.5) * 2; vel[i * 3 + 1] = 2 + rand() * 6; vel[i * 3 + 2] = (rand() - 0.5) * 2;
    life[i] = 2 + rand() * 7;
  };
  for (let i = 0; i < N; i++) { spawn(i); life[i] *= rand(); }
  const eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.BufferAttribute(epos, 3));
  const dot = canvasTex(32, 32, (g, w) => { const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); gr.addColorStop(0, '#fff'); gr.addColorStop(0.4, 'rgba(255,255,255,.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, w); });
  const embers = new THREE.Points(eg, new THREE.PointsMaterial({ map: dot, color: new THREE.Color(3, 1.1, 0.25), size: 1.1, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  embers.frustumCulled = false;
  scene.add(embers);

  // ---- eruptions: fountain, bombs with smoke trails, lightning in the plume, ashfall afterwards
  const CR = V(0, crater.y + 4, 0);
  const FN = 1400, fpos = new Float32Array(FN * 3).fill(-1e5), fvel = new Float32Array(FN * 3);
  const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
  const fountain = new THREE.Points(fg, new THREE.PointsMaterial({ map: dot, color: new THREE.Color(5, 1.8, 0.4), size: 7, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  fountain.frustumCulled = false; scene.add(fountain);
  let fNext = 0;
  const bombMat = new THREE.MeshStandardMaterial({ color: 0x1a0c08, emissive: 0xff6a1a, emissiveIntensity: 4, flatShading: true });
  const bombs = Array.from({ length: 12 }, () => { const m = new THREE.Mesh(new THREE.IcosahedronGeometry(2.6, 0), bombMat); m.visible = false; m.userData = { v: V(0, 0, 0), at: 0 }; scene.add(m); return m; });
  const trailTex = smokeTexture(canvasTex, rand);
  const trail = Array.from({ length: 240 }, () => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: trailTex, transparent: true, depthWrite: false, color: 0x3a3330 })); sp.visible = false; sp.userData = { age: 0, life: 1 }; scene.add(sp); return sp; });
  let trailI = 0;
  const puff = (p, size, life) => { const sp = trail[trailI++ % trail.length]; sp.position.copy(p); sp.visible = true; sp.userData = { age: 0, life, size }; };
  const boltPts = new Float32Array(33 * 3), bolt = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(boltPts, 3)), new THREE.LineBasicMaterial({ color: new THREE.Color(6, 6, 9) }));
  bolt.visible = false; bolt.frustumCulled = false; scene.add(bolt);
  let boltT = 0, boltNext = 0;
  const strike = () => {
    const a = V((rand() - 0.5) * 300, crater.y + 280 + rand() * 500, (rand() - 0.5) * 300).add(V(60, 0, 25)), b = a.clone().add(V((rand() - 0.5) * 320, -120 - rand() * 220, (rand() - 0.5) * 320));
    const pts = [a, b];
    for (let lvl = 0, off = 90; lvl < 5; lvl++, off *= 0.55) for (let i = pts.length - 1; i > 0; i--) pts.splice(i, 0, pts[i - 1].clone().lerp(pts[i], 0.5).add(V((rand() - 0.5) * off, (rand() - 0.5) * off, (rand() - 0.5) * off)));
    pts.forEach((q, i) => q.toArray(boltPts, i * 3));
    bolt.geometry.attributes.position.needsUpdate = true; bolt.visible = true; boltT = 0.13;
    onThunder?.(a);
  };
  const AN = 1600, apos = new Float32Array(AN * 3), ag = new THREE.BufferGeometry();
  for (let i = 0; i < AN; i++) { apos[i * 3] = (rand() - 0.5) * 120; apos[i * 3 + 1] = rand() * 40; apos[i * 3 + 2] = (rand() - 0.5) * 120; }
  ag.setAttribute('position', new THREE.BufferAttribute(apos, 3));
  const ashMat = new THREE.PointsMaterial({ color: 0x8a817c, size: 0.12, transparent: true, opacity: 0, depthWrite: false });
  const ash = new THREE.Points(ag, ashMat); ash.frustumCulled = false; scene.add(ash);
  let ashLevel = 0, eStart = -1e9, eNext = 35;
  const tmpV = V(0, 0, 0);

  const update = (dt, t, cam) => {
    riverTex.offset.y -= dt * 0.035;
    lakeTex.offset.set(Math.sin(t * 0.05) * 0.05, t * 0.004);
    if (t > eNext) { eStart = t; eNext = t + 55 + rand() * 60; onEruption?.(); }
    const e = t - eStart, I = smooth(0, 1.2, e) * (1 - smooth(9, 15, e));
    if (I > 0) ashLevel = Math.min(1, ashLevel + dt * 0.08); else ashLevel = Math.max(0, ashLevel - dt * 0.02);
    glow.color.setRGB(1, 0.35, 0.12);
    glow.intensity = (3.2 + Math.sin(t * 2.3) * 0.25 + Math.sin(t * 5.1) * 0.15) * (1 + I * 2.5);
    plume(t, I); steam(t);
    // fountain
    if (I > 0.15) for (fNext += dt * 520 * I; fNext >= 1; fNext--) {
      const i = Math.floor(rand() * FN), a = rand() * 6.28, r = rand() * 55;
      fpos[i * 3] = Math.cos(a) * r; fpos[i * 3 + 1] = CR.y; fpos[i * 3 + 2] = Math.sin(a) * r;
      fvel[i * 3] = (rand() - 0.5) * 40; fvel[i * 3 + 1] = 40 + rand() * 60; fvel[i * 3 + 2] = (rand() - 0.5) * 40;
    }
    for (let i = 0; i < FN; i++) {
      if (fpos[i * 3 + 1] < -1e4) continue;
      fvel[i * 3 + 1] -= 9.8 * dt;
      fpos[i * 3] += fvel[i * 3] * dt; fpos[i * 3 + 1] += fvel[i * 3 + 1] * dt; fpos[i * 3 + 2] += fvel[i * 3 + 2] * dt;
      if (fpos[i * 3 + 1] < CR.y - 40) fpos[i * 3 + 1] = -1e5;
    }
    fg.attributes.position.needsUpdate = true;
    // bombs: launched through the first seconds, trail smoke, burst on impact
    bombs.forEach((b, i) => {
      const d = b.userData;
      if (!b.visible && e > i * 0.4 && e < i * 0.4 + dt * 1.5) {
        const az = rand() * 6.28, el = 0.9 + rand() * 0.45, sp = 70 + rand() * 45;
        b.position.copy(CR); d.v.set(Math.cos(az) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(az) * Math.cos(el) * sp); b.visible = true; d.at = 0;
      }
      if (!b.visible) return;
      d.v.y -= 9.8 * dt; b.position.addScaledVector(d.v, dt); b.rotation.x += dt * 3; b.rotation.z += dt * 2;
      if ((d.at += dt) > 0.05) { d.at = 0; puff(b.position, 10, 6); }
      if (b.position.y < getH(b.position.x, b.position.z)) { for (let k = 0; k < 6; k++) puff(tmpV.copy(b.position).add(V((rand() - 0.5) * 20, rand() * 8, (rand() - 0.5) * 20)), 30, 9); b.visible = false; }
    });
    for (const sp of trail) {
      if (!sp.visible) continue;
      const d = sp.userData, u = (d.age += dt) / d.life;
      if (u >= 1) { sp.visible = false; continue; }
      sp.position.y += dt * 3; sp.scale.setScalar(d.size * (1 + u * 3)); sp.material.opacity = 0.75 * (1 - u);
    }
    // lightning while the column is thick
    if ((boltT -= dt) <= 0) bolt.visible = false;
    if (I > 0.5 && t > boltNext) { boltNext = t + 0.3 + rand() * 1.4; strike(); }
    if (bolt.visible) { glow.color.setRGB(0.75, 0.8, 1); glow.intensity = 60; }
    // ash drifting down around the camera after an eruption
    ashMat.opacity = ashLevel * 0.85;
    if (ashLevel > 0) {
      for (let i = 0; i < AN; i++) { // world-space flakes wrapped into a 120 m box around the camera
        const k = i * 3;
        apos[k + 1] -= dt * (1 + (i % 7) * 0.2); apos[k] += dt * (0.8 + Math.sin(t + i) * 0.5);
        if (apos[k] - cam.x > 60) apos[k] -= 120; else if (apos[k] - cam.x < -60) apos[k] += 120;
        if (apos[k + 2] - cam.z > 60) apos[k + 2] -= 120; else if (apos[k + 2] - cam.z < -60) apos[k + 2] += 120;
        if (apos[k + 1] < cam.y - 8) apos[k + 1] += 44; else if (apos[k + 1] > cam.y + 36) apos[k + 1] -= 44;
      }
      ag.attributes.position.needsUpdate = true;
    }
    for (let i = 0; i < N; i++) {
      if ((life[i] -= dt) <= 0) { spawn(i); continue; }
      vel[i * 3 + 1] *= 0.995;
      epos[i * 3] += (vel[i * 3] + 1.2) * dt; epos[i * 3 + 1] += vel[i * 3 + 1] * dt; epos[i * 3 + 2] += (vel[i * 3 + 2] + 0.5) * dt;
    }
    eg.attributes.position.needsUpdate = true;
    return I + (bolt.visible ? 0.15 : 0); // shake / rumble level
  };
  update.erupt = () => (eNext = 0);
  return update;
}

// ---------------------------------------------------------------- flora
export function palmGeometries(canvasTex) {
  const curve = new THREE.CatmullRomCurve3([V(0, 0, 0), V(0.15, 2.5, 0), V(0.6, 5, 0), V(1.3, 7.2, 0)]);
  const seg = 16, rad = 7, trunk = new THREE.TubeGeometry(curve, seg, 0.17, rad);
  const P = trunk.attributes.position, c = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i <= seg; i++) { curve.getPointAt(i / seg, c); for (let j = 0; j <= rad; j++) { const k = i * (rad + 1) + j; v.fromBufferAttribute(P, k).sub(c).multiplyScalar(1.25 - 0.55 * (i / seg)).add(c); P.setXYZ(k, v.x, v.y, v.z); } }
  trunk.computeVertexNormals();
  const bark = canvasTex(256, 32, (g, w, h) => { g.fillStyle = '#8a7558'; g.fillRect(0, 0, w, h); for (let x = 0; x < w; x += 9) { g.fillStyle = 'rgba(40,28,18,.55)'; g.fillRect(x, 0, 3, h); } }, true);
  const leaves = [];
  for (let k = 0; k < 11; k++) {
    const leaf = new THREE.PlaneGeometry(1.25, 4.6, 2, 10).translate(0, 2.3, 0), LP = leaf.attributes.position;
    for (let j = 0; j < LP.count; j++) {
      const x = LP.getX(j), l = LP.getY(j);
      LP.setXYZ(j, x, l * 0.55 - 2.6 * (l / 4.6) ** 2 + Math.abs(x) * 0.35, l);
    }
    leaf.rotateX(-0.15 + (k % 3) * 0.12).rotateY((k / 11) * Math.PI * 2 + (k % 2) * 0.2).translate(1.3, 7.2, 0);
    leaf.computeVertexNormals();
    leaves.push(leaf);
  }
  const frond = canvasTex(128, 512, (g, w, h) => {
    g.strokeStyle = '#eef7d8'; g.lineCap = 'round';
    for (let y = h * 0.03; y < h * 0.97; y += 7) {
      const len = 58 * Math.pow(1 - y / h, 0.25) * Math.min(1, (y / h) * 6);
      g.lineWidth = 5;
      for (const s of [-1, 1]) { g.beginPath(); g.moveTo(w / 2, y + 2); g.lineTo(w / 2 + s * len, y - len * 0.55); g.stroke(); }
    }
    g.lineWidth = 6; g.strokeStyle = '#f6f2d0'; g.beginPath(); g.moveTo(w / 2, h); g.lineTo(w / 2, 0); g.stroke();
  });
  return {
    trunk, trunkMat: new THREE.MeshStandardMaterial({ map: bark, roughness: 0.95 }),
    crown: mergeGeometries(leaves), crownMat: new THREE.MeshStandardMaterial({ map: frond, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75 }),
  };
}

export function deadTreeGeometry() {
  const parts = [new THREE.CylinderGeometry(0.09, 0.24, 5.2, 6).translate(0, 2.6, 0)];
  for (let k = 0; k < 5; k++) parts.push(new THREE.CylinderGeometry(0.025, 0.08, 1.6 + (k % 2) * 0.6, 5).translate(0, 0.8, 0).rotateZ(0.6 + (k % 3) * 0.25).rotateY(k * 1.9).translate(0, 2.2 + k * 0.6, 0));
  return mergeGeometries(parts);
}

export function spireGeometry(rand) {
  const g = new THREE.ConeGeometry(1, 1, 6, 4).translate(0, 0.5, 0), P = g.attributes.position;
  const ph = rand() * 100; // jitter keyed on position so the cone's seam vertices move together
  for (let i = 0; i < P.count; i++) { const x = P.getX(i), y = P.getY(i), z = P.getZ(i), j = 1 + 0.18 * Math.sin(x * 12.9 + y * 7.8 + z * 37.7 + ph); P.setXYZ(i, x * j, y, z * j); }
  g.computeVertexNormals();
  return g;
}
