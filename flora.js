// Game-style vegetation: bark-textured trunks + alpha-tested leaf cards. Card normals point away from
// the crown centre so a crown shades like a soft volume instead of a pile of flat quads.
import * as THREE from 'three';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// leaf-cluster card texture composed from the CC0 leaf atlas (3×2 leaves) plus twigs
export function leafClusterTexture(atlas, rand) {
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), img = atlas.image, cw = img.width / 3, ch = img.height / 2;
  g.strokeStyle = '#4a3a28'; g.lineCap = 'round';
  for (let i = 0; i < 9; i++) { const a = rand() * 6.28; g.lineWidth = 3 + rand() * 3; g.beginPath(); g.moveTo(S / 2, S / 2); g.lineTo(S / 2 + Math.cos(a) * S * 0.42, S / 2 + Math.sin(a) * S * 0.42); g.stroke(); }
  for (let i = 0; i < 70; i++) {
    const a = rand() * 6.28, r = Math.sqrt(rand()) * S * 0.4, k = (rand() * 6) | 0, sz = S * (0.12 + rand() * 0.07);
    g.save(); g.translate(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r); g.rotate(a + Math.PI / 2 + (rand() - 0.5) * 0.9);
    g.globalAlpha = 1; g.filter = `brightness(${0.75 + rand() * 0.45})`;
    g.drawImage(img, (k % 3) * cw, ((k / 3) | 0) * ch, cw, ch, -sz / 2, -sz, sz, sz * 1.15);
    g.restore();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// fine conifer branch card, drawn: a stem with dense needles
export function needleTexture(rand) {
  const W = 256, H = 512, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.lineCap = 'round';
  for (let y = H * 0.04; y < H * 0.98; y += 3) {
    const len = 95 * Math.pow(1 - y / H, 0.6) * Math.min(1, (y / H) * 5) + 10;
    for (const s of [-1, 1]) {
      const v = (90 + rand() * 80) | 0;
      g.strokeStyle = `rgb(${(v * 0.55) | 0},${v},${(v * 0.5) | 0})`; g.lineWidth = 2 + rand() * 1.5;
      g.beginPath(); g.moveTo(W / 2, y); g.lineTo(W / 2 + s * len * (0.8 + rand() * 0.3), y - len * 0.35); g.stroke();
    }
  }
  g.strokeStyle = '#5a4630'; g.lineWidth = 6; g.beginPath(); g.moveTo(W / 2, H); g.lineTo(W / 2, 0); g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// accumulate quads/tubes into one geometry with two groups: 0 = bark, 1 = foliage
function builder() {
  const P = [[], []], N = [[], []], UV = [[], []];
  const quad = (grp, c, ax, ay, nrm) => { // centre, half-axes, normal
    const pts = [c.clone().sub(ax).sub(ay), c.clone().add(ax).sub(ay), c.clone().add(ax).add(ay), c.clone().sub(ax).add(ay)], uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (const i of [0, 1, 2, 0, 2, 3]) { P[grp].push(...pts[i].toArray()); N[grp].push(...nrm.toArray()); UV[grp].push(...uv[i]); }
  };
  const tube = (a, b, r0, r1, seg = 7, vScale = 1) => {
    const d = b.clone().sub(a), len = d.length(), q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.normalize());
    for (let j = 0; j < seg; j++) {
      const t0 = (j / seg) * Math.PI * 2, t1 = ((j + 1) / seg) * Math.PI * 2, ring = (t, r, y) => V(Math.cos(t) * r, y, Math.sin(t) * r).applyQuaternion(q).add(a);
      const n = (t) => V(Math.cos(t), 0, Math.sin(t)).applyQuaternion(q);
      const v = [[ring(t0, r0, 0), n(t0), j / seg, 0], [ring(t1, r0, 0), n(t1), (j + 1) / seg, 0], [ring(t1, r1, len), n(t1), (j + 1) / seg, len * vScale], [ring(t0, r1, len), n(t0), j / seg, len * vScale]];
      for (const i of [0, 2, 1, 0, 3, 2]) { P[0].push(...v[i][0].toArray()); N[0].push(...v[i][1].toArray()); UV[0].push(v[i][2], v[i][3]); }
    }
  };
  const build = () => {
    const g = new THREE.BufferGeometry(), cat = (k) => [...k[0], ...k[1]];
    g.setAttribute('position', new THREE.Float32BufferAttribute(cat(P), 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(cat(N), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(cat(UV), 2));
    g.addGroup(0, P[0].length / 3, 0); g.addGroup(P[0].length / 3, P[1].length / 3, 1);
    return g;
  };
  return { quad, tube, build };
}

// random card on a crown ellipsoid; normal blends outward direction with the card plane
function crownCards(b, rand, n, centre, rad, size) {
  for (let i = 0; i < n; i++) {
    const u = rand() * 2 - 1, a = rand() * 6.28, s = Math.sqrt(1 - u * u), dir = V(Math.cos(a) * s, u * 0.85 + 0.1, Math.sin(a) * s).normalize();
    const c = centre.clone().add(V(dir.x * rad.x, dir.y * rad.y, dir.z * rad.z).multiplyScalar(0.55 + rand() * 0.45));
    const sz = size * (0.75 + rand() * 0.5), tan = V(-dir.z, 0, dir.x).normalize();
    if (tan.lengthSq() < 0.01) tan.set(1, 0, 0);
    const bit = new THREE.Vector3().crossVectors(dir, tan).normalize(), rot = rand() * 6.28;
    const ax = tan.clone().multiplyScalar(Math.cos(rot)).addScaledVector(bit, Math.sin(rot)).multiplyScalar(sz);
    const ay = bit.clone().multiplyScalar(Math.cos(rot)).addScaledVector(tan, -Math.sin(rot)).multiplyScalar(sz);
    b.quad(1, c, ax, ay, dir.clone().add(V(0, 0.35, 0)).normalize());
  }
}

export function broadleafGeometry(rand) {
  const b = builder(), top = V(0, 3.4, 0);
  b.tube(V(0, -0.3, 0), top, 0.24, 0.13, 8, 0.6);
  for (let k = 0; k < 5; k++) { const a = k * 1.3 + rand(), end = V(Math.cos(a) * 1.6, 4.6 + rand(), Math.sin(a) * 1.6); b.tube(V(0, 2.4 + k * 0.25, 0), end, 0.09, 0.03, 5, 0.6); }
  crownCards(b, rand, 46, V(0, 4.7, 0), V(2.4, 2.0, 2.4), 1.15);
  return b.build();
}

export function pineGeometry(rand) {
  const b = builder();
  b.tube(V(0, -0.3, 0), V(0, 9.5, 0), 0.22, 0.05, 7, 0.6);
  for (let tier = 0; tier < 9; tier++) {
    const y = 1.6 + tier * 0.95, len = 2.6 * (1 - tier / 10) + 0.4, n = 7 - (tier > 5 ? 2 : 0);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 6.28 + tier * 0.7 + rand() * 0.4, out = V(Math.cos(a), 0, Math.sin(a)), droop = -0.35 - rand() * 0.2;
      const c = V(0, y, 0).addScaledVector(out, len * 0.5).add(V(0, droop * len * 0.5, 0)), along = out.clone().add(V(0, droop, 0)).normalize();
      const side = V(-out.z, 0, out.x).multiplyScalar(len * 0.3);
      b.quad(1, c, side, along.multiplyScalar(len * 0.55), out.clone().add(V(0, 0.6, 0)).normalize());
    }
  }
  b.quad(1, V(0, 10.2, 0), V(0.35, 0, 0), V(0, 0.9, 0), V(0, 1, 0));
  return b.build();
}

export function bushGeometry(rand) {
  const b = builder();
  b.tube(V(0, 0, 0), V(0, 0.4, 0), 0.05, 0.04, 4, 1);
  crownCards(b, rand, 14, V(0, 0.65, 0), V(1, 0.7, 1), 0.65);
  return b.build();
}

// irregular boulder: subdivided icosahedron pushed around by low-frequency noise
export function rockGeometry(seed) {
  const g = new THREE.IcosahedronGeometry(1, 2), P = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i);
    const n = Math.sin(v.x * 3.1 + seed) * Math.sin(v.y * 2.7 + seed * 2) * Math.sin(v.z * 3.3 + seed * 3) * 0.22 + Math.sin(v.x * 7 + v.z * 5 + seed) * 0.05;
    v.multiplyScalar(1 + n); v.y = v.y < 0 ? v.y * 0.6 : v.y; P.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}
