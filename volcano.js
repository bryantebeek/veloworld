// Fuego world: lava (crater lake + rivers), smoke plume, steam vents, embers, and volcanic flora.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// tileable Voronoi crust: glowing cracks between dark plates; `heat` adds molten cell centres
function lavaTexture(canvasTex, rand, heat) {
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
  return (t) => {
    for (const sp of sprites) {
      const d = sp.userData, age = (t + d.off) % o.life, u = age / o.life, grow = 1 + u * 3;
      sp.position.set(d.origin.x + d.jx * grow + o.wind.x * age, d.origin.y + o.rise * age, d.origin.z + d.jz * grow + o.wind.z * age);
      sp.scale.setScalar(o.s0 + (o.s1 - o.s0) * Math.pow(u, 0.7));
      sp.material.opacity = o.op * smooth(0, 0.1, u) * (1 - smooth(0.55, 1, u));
      sp.material.color.copy(c0).lerp(c1, smooth(0, 0.5, u));
      sp.material.rotation += d.spin * 0.016;
    }
  };
}

export function buildVolcanoFX({ scene, canvasTex, rand, rivers, crater, vents }) {
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

  return (dt, t) => {
    riverTex.offset.y -= dt * 0.035;
    lakeTex.offset.set(Math.sin(t * 0.05) * 0.05, t * 0.004);
    glow.intensity = 3.2 + Math.sin(t * 2.3) * 0.25 + Math.sin(t * 5.1) * 0.15;
    plume(t); steam(t);
    for (let i = 0; i < N; i++) {
      if ((life[i] -= dt) <= 0) { spawn(i); continue; }
      vel[i * 3 + 1] *= 0.995;
      epos[i * 3] += (vel[i * 3] + 1.2) * dt; epos[i * 3 + 1] += vel[i * 3 + 1] * dt; epos[i * 3 + 2] += (vel[i * 3 + 2] + 0.5) * dt;
    }
    eg.attributes.position.needsUpdate = true;
  };
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
