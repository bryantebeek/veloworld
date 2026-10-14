// Skinned cyclist bodies: one continuous mesh per rider, deformed by a flat 15-bone skeleton
// that is re-aimed every frame from pedalling IK. Geometry is swept tubes with sculpted
// cross-sections (muscle profiles) plus rigid parts (head, helmet, glasses, gloves, shoes).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

const LEG = [0.42, 0.41], ARM = [0.29, 0.25], REST_CRANK = 1.2;
// bones: 0 pelvis, 1 chest, 2 head, 3-5 thigh/shin/foot L, 6-8 R, 9-11 upper/fore/hand L, 12-14 R
const NB = 15;
const MI = { skin: 0, jersey: 1, shorts: 2, socks: 3, shoes: 4, gloves: 5, helmet: 6, lens: 7 };

// ---------------------------------------------------------------- pose
export function ik(H, P, L1, L2, bend, out) {
  const dz = P.z - H.z, dy = P.y - H.y, d = Math.hypot(dz, dy) || 1e-4, dd = clamp(d, 0.05, L1 + L2 - 1e-3);
  const uz = dz / d, uy = dy / d, a = Math.acos(clamp((L1 * L1 + dd * dd - L2 * L2) / (2 * L1 * dd), -1, 1)), ca = Math.cos(a) * L1, sa = Math.sin(a) * L1;
  return out.set(lerp(H.x, P.x, 0.5), H.y + uy * ca + bend * uz * sa, H.z + uz * ca - bend * uy * sa);
}
const footAngle = (th) => 0.2 + 0.12 * Math.cos(th - 0.6); // toe-down angle, "ankling" through the stroke

function makeJoints() {
  const v = () => new THREE.Vector3();
  return {
    H: v(), M: v(), S: v(), C: v(),
    legs: [1, -1].map((side) => ({ side, a: 0, hip: v(), knee: v(), ankle: v(), toe: v(), ball: v() })),
    arms: [1, -1].map((side) => ({ side, sh: v(), el: v(), wr: v(), tip: v() })),
  };
}

// joint positions in bike space (+Z forward, +Y up, +X rider's left); st = standing 0..1
function poseJoints(J, st, crank, sway) {
  const sx = sway * (0.008 + 0.03 * st);
  J.H.set(0, lerp(1.04, 1.07, st), lerp(-0.27, -0.12, st));
  J.S.set(sx, lerp(1.4, 1.43, st), lerp(0.2, 0.31, st));
  const dy = J.S.y - J.H.y, dz = J.S.z - J.H.z, l = Math.hypot(dy, dz);
  J.M.set(sx * 0.5, (J.H.y + J.S.y) / 2 + (dz / l) * 0.035, (J.H.z + J.S.z) / 2 - (dy / l) * 0.035); // rounded back
  J.C.set(sx * 1.2, J.S.y + 0.12, J.S.z + 0.11); // head centre
  for (const g of J.legs) {
    const th = crank + (g.side > 0 ? Math.PI : 0), a = (g.a = footAngle(th)), sa = Math.sin(a), ca = Math.cos(a);
    g.ball.set(g.side * 0.115, 0.31 + 0.17 * Math.cos(th), -0.1 + 0.17 * Math.sin(th));
    g.ankle.set(g.ball.x, g.ball.y + 0.13 * sa + 0.075 * ca, g.ball.z - 0.13 * ca + 0.075 * sa);
    g.toe.set(g.ball.x, g.ball.y - 0.06 * sa, g.ball.z + 0.06 * ca);
    g.hip.set(g.side * 0.095, J.H.y - 0.03, J.H.z + 0.02);
    ik(g.hip, g.ankle, LEG[0], LEG[1], 1, g.knee);
  }
  for (const g of J.arms) {
    g.sh.set(g.side * 0.175 + sx, J.S.y - 0.05, J.S.z - 0.01);
    g.wr.set(g.side * 0.21, 0.94, 0.47); g.tip.set(g.side * 0.21, 0.905, 0.58);
    ik(g.sh, g.wr, ARM[0], ARM[1], -1, g.el);
    g.el.x = g.side * 0.235;
  }
  return J;
}

const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4(), _dir = new THREE.Vector3();
function frameQuat(dir, q) {
  _y.copy(dir).normalize();
  _x.set(1, 0, 0).addScaledVector(_y, -_y.x).normalize();
  _z.crossVectors(_x, _y);
  return q.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}
function aim(bone, from, to) { bone.position.copy(from); frameQuat(_dir.subVectors(to, from), bone.quaternion); }
function applyPose(b, J) {
  aim(b[0], J.H, J.M); aim(b[1], J.M, J.S); aim(b[2], J.S, J.C);
  J.legs.forEach((g, i) => { const k = 3 + i * 3; aim(b[k], g.hip, g.knee); aim(b[k + 1], g.knee, g.ankle); aim(b[k + 2], g.ankle, g.toe); });
  J.arms.forEach((g, i) => { const k = 9 + i * 3; aim(b[k], g.sh, g.el); aim(b[k + 1], g.el, g.wr); aim(b[k + 2], g.wr, g.tip); });
}

// ---------------------------------------------------------------- geometry
function buildBody(k) {
  const J = poseJoints(makeJoints(), 0, REST_CRANK, 0);
  const pos = [], uv = [], si = [], sw = [], tris = Array.from({ length: 8 }, () => []), seams = [], fixedN = [];
  const vert = (p, u, v, w) => {
    pos.push(p.x, p.y, p.z); uv.push(u, v);
    si.push(w[0][0], w[1] ? w[1][0] : 0, 0, 0); sw.push(w[0][1], w[1] ? w[1][1] : 0, 0, 0);
    return pos.length / 3 - 1;
  };
  const lerpKeys = (keys, t) => {
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
    const A = keys[i], B = keys[i + 1], u = clamp((t - A[0]) / (B[0] - A[0]), 0, 1), e = u * u * (3 - 2 * u);
    return [1, 2, 3].map((j) => lerp(A[j], B[j], e) * k);
  };
  const blend = (b0, b1, t, t0, t1) => { const e = clamp((t - t0) / (t1 - t0), 0, 1); return e <= 0 ? [[b0, 1]] : e >= 1 ? [[b1, 1]] : [[b0, 1 - e], [b1, e]]; };
  const fractions = (pts) => { const d = [0]; for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + pts[i].distanceTo(pts[i - 1])); return d.map((x) => x / d[d.length - 1]); };

  // tube along pts; prof(t) -> { a: half-width, f: radius toward +ez, b: toward -ez, mat, w, v }. Ends are domed.
  const ex = new THREE.Vector3(), ez = new THREE.Vector3(), p = new THREE.Vector3();
  const CAP = [[0.12, 1], [0.55, 0.82], [0.85, 0.48]];
  function sweep(pts, n, seg, prof) {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const end = (t, dir) => {
      const pr = prof(t), tan = curve.getTangentAt(t), base = curve.getPointAt(t), r = Math.min(pr.a, pr.f, pr.b);
      return CAP.map(([s, o]) => ({ p: base.clone().addScaledVector(tan, dir * o * r), tan, pr, s }));
    };
    const rings = end(0, -1);
    for (let i = 0; i <= n; i++) { const t = i / n; rings.push({ p: curve.getPointAt(t), tan: curve.getTangentAt(t), pr: prof(t), s: 1 }); }
    rings.push(...end(1, 1).reverse());
    let prev = null;
    for (const R of rings) {
      ex.set(1, 0, 0).addScaledVector(R.tan, -R.tan.x).normalize();
      ez.crossVectors(R.tan, ex);
      const row = [];
      for (let j = 0; j <= seg; j++) {
        const phi = (j / seg) * Math.PI * 2, c = Math.cos(phi), s = Math.sin(phi);
        p.copy(R.p).addScaledVector(ex, c * R.pr.a * R.s).addScaledVector(ez, s * (s >= 0 ? R.pr.f : R.pr.b) * R.s);
        row.push(vert(p, j / seg, R.pr.v, R.pr.w));
      }
      seams.push([row[0], row[seg]]);
      if (prev) for (let j = 0; j < seg; j++) tris[prev.mat].push(prev.row[j], prev.row[j + 1], row[j], prev.row[j + 1], row[j + 1], row[j]);
      prev = { row, mat: R.pr.mat };
    }
  }
  // rigid part: geometry in bike space (after matrix m), keeps its own normals
  function append(geo, m, mat, w) {
    const P = geo.attributes.position, N = geo.attributes.normal, U = geo.attributes.uv, nm = new THREE.Matrix3().getNormalMatrix(m), base = pos.length / 3, v = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      vert(v.fromBufferAttribute(P, i).applyMatrix4(m), U ? U.getX(i) : 0, U ? U.getY(i) : 0, w);
      v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
      fixedN.push(base + i, v.x, v.y, v.z);
    }
    const I = geo.index ? geo.index.array : Array.from({ length: P.count }, (_, i) => i);
    for (const i of I) tris[mat].push(base + i);
  }
  // unit sphere -> ellipsoid with analytic (seam-free) normals; deform(x,y,z) may sculpt it further
  function ellipsoid(ws, hs, [a, b, c], deform, phi = [0, Math.PI * 2], theta = [0, Math.PI]) {
    const g = new THREE.SphereGeometry(1, ws, hs, phi[0], phi[1], theta[0], theta[1]);
    const P = g.attributes.position, N = g.attributes.normal;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      N.setXYZ(i, x / a, y / b, z / c);
      P.setXYZ(i, ...(deform ? deform(x, y, z) : [x * a, y * b, z * c]));
    }
    g.normalizeNormals();
    return g;
  }
  const at = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);

  // trunk: seat -> hips -> rounded back -> chest -> shoulders -> neck -> head
  const trunk = [J.H.clone().add(V(0, -0.075, -0.04)), J.H.clone(), J.M.clone(), J.M.clone().lerp(J.S, 0.5), J.S.clone(), J.S.clone().lerp(J.C, 0.5).add(V(0, -0.01, -0.01)), J.C.clone().add(V(0, -0.035, -0.02))];
  const [, tH, tM, tC, tS, tN] = fractions(trunk);
  const trunkKeys = [[0, 0.08, 0.055, 0.06], [tH, 0.165, 0.115, 0.1], [tM, 0.145, 0.095, 0.09], [tC, 0.178, 0.1, 0.125], [tS, 0.12, 0.07, 0.082], [tN, 0.056, 0.05, 0.058], [1, 0.05, 0.05, 0.05]];
  const tShort = tH + (tM - tH) * 0.35, tCollar = tS + 0.015;
  sweep(trunk, 36, 28, (t) => {
    const [a, f, b] = lerpKeys(trunkKeys, t), mat = t < tShort ? MI.shorts : t < tCollar ? MI.jersey : MI.skin;
    const w = t < tS ? blend(0, 1, t, tM - 0.08, tM + 0.08) : blend(1, 2, t, tS, tN + 0.04);
    return { a, f, b, mat, w, v: mat === MI.jersey ? ((t - tShort) / (tCollar - tShort)) * 0.8 : t * 2 };
  });

  // legs (ez points forward: f = quads/shin, b = hamstrings/calf)
  J.legs.forEach((g, i) => {
    const thigh = 3 + i * 3, shin = thigh + 1;
    const pts = [g.hip.clone().add(V(-g.side * 0.025, 0.06, -0.01)), g.hip.clone(), g.knee.clone(), g.ankle.clone()];
    const [, tHp, tK] = fractions(pts), T = (f) => tHp + f * (tK - tHp), S = (f) => tK + f * (1 - tK);
    const keys = [[0, 0.075, 0.075, 0.08], [tHp, 0.088, 0.088, 0.092], [T(0.25), 0.081, 0.088, 0.082], [T(0.6), 0.069, 0.076, 0.066], [T(0.9), 0.052, 0.056, 0.05],
      [tK, 0.048, 0.052, 0.046], [S(0.22), 0.046, 0.043, 0.063], [S(0.5), 0.04, 0.037, 0.05], [S(0.8), 0.029, 0.03, 0.032], [1, 0.028, 0.031, 0.031]];
    const tShorts = T(0.78), tSock = S(0.62);
    sweep(pts, 42, 22, (t) => {
      let [a, f, b] = lerpKeys(keys, t);
      if (t > tShorts - 0.025 && t <= tShorts) { a *= 1.045; f *= 1.045; b *= 1.045; } // leg gripper
      if (t >= tSock) { a += 0.0025; f += 0.0025; b += 0.0025; }
      const mat = t <= tShorts ? MI.shorts : t < tSock ? MI.skin : MI.socks;
      const w = t < tK - 0.1 ? blend(0, thigh, t, 0, tHp + 0.1) : blend(thigh, shin, t, tK - 0.05, tK + 0.05);
      return { a, f, b, mat, w, v: t * 3 };
    });
  });

  // arms (ez points up/forward: f = top of arm)
  J.arms.forEach((g, i) => {
    const upper = 9 + i * 3, fore = upper + 1;
    const pts = [g.sh.clone().add(V(-g.side * 0.035, 0.025, -0.01)), g.sh.clone(), g.el.clone(), g.wr.clone()];
    const [, tSh, tE] = fractions(pts), U = (f) => tSh + f * (tE - tSh), F = (f) => tE + f * (1 - tE);
    const keys = [[0, 0.05, 0.05, 0.05], [tSh, 0.064, 0.066, 0.058], [U(0.3), 0.053, 0.05, 0.053], [U(0.7), 0.046, 0.044, 0.049], [tE, 0.038, 0.036, 0.04], [F(0.25), 0.042, 0.04, 0.04], [1, 0.027, 0.022, 0.023]];
    const tSleeve = U(0.55);
    sweep(pts, 30, 18, (t) => {
      let [a, f, b] = lerpKeys(keys, t);
      if (t > tSleeve - 0.03 && t <= tSleeve) { a += 0.003; f += 0.003; b += 0.003; } // sleeve hem
      const mat = t <= tSleeve ? MI.jersey : MI.skin;
      const w = t < U(0.4) ? blend(1, upper, t, 0, tSh + 0.08) : blend(upper, fore, t, tE - 0.05, tE + 0.05);
      return { a, f, b, mat, w, v: mat === MI.jersey ? 1 - (t / tSleeve) * 0.16 : t };
    });
  });

  // head, ears
  const Cx = J.C.x, Cy = J.C.y, Cz = J.C.z, HEAD = [[2, 1]];
  append(ellipsoid(30, 22, [0.076, 0.1, 0.094], (x, y, z) => {
    let X = x * 0.076, Y = y * 0.1, Z = z * 0.094;
    if (y < 0) { const j = (-y) ** 1.5; X *= 1 - 0.3 * j; Z *= 1 - 0.08 * j; } // jaw / chin
    if (z > 0) Z += Math.exp(-((x / 0.16) ** 2) - ((y + 0.12) / 0.2) ** 2) * z ** 4 * 0.024; // nose
    return [X, Y, Z];
  }), at(Cx, Cy, Cz), MI.skin, HEAD);
  for (const s of [1, -1]) append(ellipsoid(10, 8, [0.012, 0.028, 0.02]), at(Cx + s * 0.074, Cy - 0.005, Cz - 0.012), MI.skin, HEAD);

  // aero road helmet with tapered tail, tilted forward
  const helmetM = new THREE.Matrix4().compose(V(Cx, Cy + 0.028, Cz - 0.01), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.18, 0, 0)), V(1, 1, 1));
  append(ellipsoid(40, 16, [0.102, 0.108, 0.128], (x, y, z) => {
    let X = x * 0.102, Y = y * 0.108, Z = z * 0.128;
    if (z < 0) { Z *= 1 + 0.22 * z * z; Y -= 0.03 * z * z * (1 - y); }
    return [X, Y, Z];
  }, undefined, [0, Math.PI * 0.56]), helmetM, MI.helmet, HEAD);
  for (const s of [1, -1]) { // chin straps
    const strap = new THREE.CatmullRomCurve3([V(s * 0.088, 0.012, -0.025), V(s * 0.07, -0.06, 0.012), V(s * 0.02, -0.1, 0.046), V(0, -0.103, 0.05)].map((q) => q.add(J.C)));
    append(new THREE.TubeGeometry(strap, 12, 0.0035, 5), new THREE.Matrix4(), MI.gloves, HEAD);
  }
  // wraparound sunglasses + temples
  append(ellipsoid(30, 4, [0.087, 0.104, 0.104], undefined, [Math.PI / 2 - 1.15, 2.3], [Math.PI / 2 - 0.2, 0.37]), at(Cx, Cy, Cz + 0.004), MI.lens, HEAD);
  for (const s of [1, -1]) append(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V(s * 0.079, 0.006, 0.045), V(s * 0.084, 0.004, 0.0), V(s * 0.08, -0.002, -0.035)].map((q) => q.add(J.C))), 6, 0.0028, 4), new THREE.Matrix4(), MI.gloves, HEAD);

  // gloves gripping the hoods
  J.arms.forEach((g, i) => {
    const hand = [[11 + i * 3, 1]], dir = g.tip.clone().sub(g.wr), len = dir.length();
    const m = new THREE.Matrix4().compose(g.wr.clone().addScaledVector(dir, 0.5), frameQuat(dir, new THREE.Quaternion()), V(1, 1, 1));
    append(ellipsoid(16, 12, [0.037, len * 0.62, 0.029]), m, MI.gloves, hand);
    append(ellipsoid(10, 8, [0.014, 0.03, 0.014]), m.clone().multiply(at(-g.side * 0.03, 0.01, 0.012)), MI.gloves, hand);
  });

  // shoes with a contrasting sole, aligned to the foot
  J.legs.forEach((g, i) => {
    const foot = [[5 + i * 3, 1]], fd = V(0, -Math.sin(g.a), Math.cos(g.a)), up = V(0, Math.cos(g.a), Math.sin(g.a));
    const m = new THREE.Matrix4().makeBasis(V(1, 0, 0), up, fd).setPosition(g.ball.clone().addScaledVector(fd, -0.055).addScaledVector(up, 0.03));
    const taper = (geo, drop) => {
      const P = geo.attributes.position;
      for (let j = 0; j < P.count; j++) {
        const z = P.getZ(j) / 0.14;
        if (z > 0) { P.setX(j, P.getX(j) * (1 - 0.38 * z * z)); if (drop && P.getY(j) > 0) P.setY(j, P.getY(j) - 0.028 * z); }
      }
      return geo;
    };
    append(taper(new RoundedBoxGeometry(0.092, 0.072, 0.275, 3, 0.03), true), m, MI.shoes, foot);
    append(taper(new RoundedBoxGeometry(0.095, 0.018, 0.28, 2, 0.008).translate(0, -0.036, 0), false), m, MI.gloves, foot);
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  const index = [];
  tris.forEach((t, m) => { geo.addGroup(index.length, t.length, m); for (const i of t) index.push(i); });
  geo.setIndex(index);
  geo.computeVertexNormals();
  const N = geo.attributes.normal, n = new THREE.Vector3(), o = new THREE.Vector3();
  for (const [a, b] of seams) { n.fromBufferAttribute(N, a).add(o.fromBufferAttribute(N, b)).normalize(); N.setXYZ(a, n.x, n.y, n.z); N.setXYZ(b, n.x, n.y, n.z); }
  for (let i = 0; i < fixedN.length; i += 4) N.setXYZ(fixedN[i], fixedN[i + 1], fixedN[i + 2], fixedN[i + 3]);
  geo.computeBoundingSphere();
  return { geo, rest: J };
}

// ---------------------------------------------------------------- materials
let TEX, TEAMS, BODIES, SH;
const teamCache = new Map();

export function initBodies(tex, teams) {
  TEX = tex; TEAMS = teams;
  const S = 128, knit = TEX(S, S, (g) => { // fine knit fabric normal map
    const img = g.createImageData(S, S), h = (x, y) => Math.sin((x / S) * Math.PI * 64) * 0.6 + Math.sin((y / S) * Math.PI * 128 + Math.sin((x / S) * Math.PI * 64)) * 0.4;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1), l = Math.hypot(dx, dy, 3), o = (y * S + x) * 4;
      img.data[o] = (-dx / l * 0.5 + 0.5) * 255; img.data[o + 1] = (-dy / l * 0.5 + 0.5) * 255; img.data[o + 2] = (3 / l * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, true, false);
  knit.repeat.set(6, 6);
  const fabric = (opts) => new THREE.MeshPhysicalMaterial({ normalMap: knit, normalScale: new THREE.Vector2(0.3, 0.3), sheenRoughness: 0.45, ...opts });
  SH = {
    fabric,
    shorts: fabric({ color: 0x15171c, roughness: 0.42, sheen: 0.7, sheenColor: new THREE.Color(0x707789) }),
    gloves: new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.6 }),
    lens: new THREE.MeshPhysicalMaterial({ color: 0x0b0b0e, metalness: 0.85, roughness: 0.04, iridescence: 1, iridescenceIOR: 1.7, iridescenceThicknessRange: [180, 520], side: THREE.DoubleSide }),
    whiteSocks: fabric({ color: 0xf2f2f2, roughness: 0.85, sheen: 0.3, sheenColor: new THREE.Color(0xffffff) }),
    skins: [0xf1c7a5, 0xe2ae88, 0xc68a62, 0x9a6440, 0x6e4529].map((c) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.52, sheen: 0.35, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xff8a70) })),
    shoes: [0xf6f6f6, 0x141414, 0xfc6719].map((c) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.2 })),
  };
  BODIES = [0.93, 1, 1.08].map(buildBody);
}

function teamMats(i) {
  if (teamCache.has(i)) return teamCache.get(i);
  const [a, b, name] = TEAMS[i];
  // jersey UVs: v 0..0.8 = torso hem..collar, v 0.82..1 = sleeves; u: 0 left side, .25 back, .5 right side, .75 front
  const jersey = TEX(512, 512, (g, w, h) => {
    const Y = (v) => (1 - v) * h;
    g.fillStyle = a; g.fillRect(0, 0, w, h);
    g.fillStyle = b;
    for (const u of [0, 0.5, 1]) g.fillRect(u * w - 0.05 * w, Y(0.8), 0.1 * w, Y(0) - Y(0.8)); // side panels
    g.fillRect(0, Y(0.6), w, 0.1 * h); g.fillRect(0, Y(0.47), w, 0.018 * h); // chest/back bands
    g.fillRect(0, Y(0.8), w, 0.035 * h); // collar
    g.font = 'italic 800 58px "Barlow Condensed", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.25)'; g.strokeText(name, 0.25 * w, Y(0.3)); g.fillText(name, 0.25 * w, Y(0.3)); // back print
    g.font = 'italic 800 26px "Barlow Condensed", sans-serif'; g.fillText(name, 0.68 * w, Y(0.68)); // chest logo
    g.fillStyle = 'rgba(0,0,0,.4)'; g.fillRect(0.75 * w - 2, Y(0.8), 4, Y(0) - Y(0.8)); // zip
    g.fillStyle = a; g.fillRect(0, 0, w, Y(0.82)); // sleeves
    g.fillStyle = b; g.fillRect(0, Y(0.875), w, 0.03 * h); // cuffs
  });
  // helmet UVs: u .25 front, .75 back; v 1 crown .. 0 rim
  const helmet = TEX(512, 256, (g, w, h) => {
    g.fillStyle = a; g.fillRect(0, 0, w, h);
    g.fillStyle = b; for (const c of [0.25, 0.75]) g.fillRect(c * w - 9, 0, 18, h);
    g.fillStyle = '#0c0d10';
    for (const c of [0.25, 0.75]) for (const s of [-1, 1]) for (let k = 0; k < 3; k++) { g.beginPath(); g.roundRect((c + s * (0.055 + k * 0.065)) * w - 8, 0.22 * h, 16, (0.48 - k * 0.08) * h, 8); g.fill(); }
    g.fillRect(0, 0.92 * h, w, 0.08 * h);
  });
  const m = {
    jersey: SH.fabric({ map: jersey, roughness: 0.62, sheen: 0.5, sheenColor: new THREE.Color(0xffffff) }),
    helmet: new THREE.MeshPhysicalMaterial({ map: helmet, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08, side: THREE.DoubleSide }),
    socks: SH.fabric({ color: b, roughness: 0.85, sheen: 0.3, sheenColor: new THREE.Color(0xffffff) }),
  };
  teamCache.set(i, m);
  return m;
}

// ---------------------------------------------------------------- public
export function createBody({ mass, team, skin, shoe, teamSocks }) {
  const body = BODIES[mass < 64 ? 0 : mass > 80 ? 2 : 1], tm = teamMats(team);
  const mesh = new THREE.SkinnedMesh(body.geo, [SH.skins[skin], tm.jersey, SH.shorts, teamSocks ? tm.socks : SH.whiteSocks, SH.shoes[shoe], SH.gloves, tm.helmet, SH.lens]);
  const bones = Array.from({ length: NB }, () => new THREE.Bone());
  mesh.add(...bones);
  applyPose(bones, body.rest);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.castShadow = mesh.receiveShadow = true;
  return { mesh, bones, J: makeJoints() };
}

// returns the joints so callers can attach bike parts (crank arms) to the feet
export function poseBody(b, stand, crank) {
  poseJoints(b.J, stand, crank, Math.sin(crank));
  applyPose(b.bones, b.J);
  return b.J;
}
