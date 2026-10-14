// Shared living-world systems: global time uniform, wind sway, detailed terrain shading,
// shore-aware water, GPU grass around the camera, and bird flocks.
import * as THREE from 'three';

export const U = { time: { value: 0 }, cam: { value: new THREE.Vector3() } };

const once = (src, find, add) => {
  if (!src.includes(find)) throw new Error(`shader chunk not found: ${find}`);
  return src.replace(find, add);
};

// sway vertices by height (object space, so per-instance scale carries through); k = bend per m²
export function addWind(mat, k, key, flutter = 0.4, opts = {}) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.time;
    if (opts.tints) { sh.uniforms.uTintA = { value: new THREE.Color(opts.tints[0]) }; sh.uniforms.uTintB = { value: new THREE.Color(opts.tints[1]) }; }
    sh.vertexShader = 'uniform float uTime; varying float vWHash;\n' + once(sh.vertexShader, '#include <begin_vertex>', `#include <begin_vertex>
      vec3 wIp = vec3(0.0);
      #ifdef USE_INSTANCING
        wIp = instanceMatrix[3].xyz;
      #endif
      vWHash = fract(sin(dot(wIp.xz, vec2(12.9898, 78.233))) * 43758.5453);
      float wPh = wIp.x * 0.07 + wIp.z * 0.053, wH = max(position.y, 0.0);
      float wS = (sin(uTime * 1.4 + wPh) * 0.6 + sin(uTime * 3.1 + wPh * 1.7) * 0.25) * ${k.toFixed(5)} * wH * wH;
      transformed.x += wS + sin(uTime * 7.0 + position.x * 4.0 + position.z * 3.0 + wPh) * ${(k * flutter).toFixed(5)} * wH * wH;
      transformed.z += cos(uTime * 1.1 + wPh) * 0.5 * ${k.toFixed(5)} * wH * wH;`);
    let f = 'varying float vWHash;\n' + (opts.tints ? 'uniform vec3 uTintA, uTintB;\n' : '') + sh.fragmentShader;
    if (opts.tints) f = once(f, '#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= mix(uTintA, uTintB, vWHash);');
    if (opts.noFlip) f = once(f, '#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize(vNormal);');
    sh.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => 'wind-' + key;
  return mat;
}

// ---------------------------------------------------------------- textures
export async function loadTextures(names, maxAniso) {
  const loader = new THREE.TextureLoader(), out = {};
  await Promise.all(names.map(async (n) => {
    const t = await loader.loadAsync(`assets/tex/${n}`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso;
    if (!n.includes('normal')) t.colorSpace = THREE.SRGBColorSpace;
    out[n.replace(/\.(jpg|png)$/, '')] = t;
  }));
  return out;
}

// GLSL: albedo + world-space normal from texture sets, flat (xz) or triplanar (Golus "whiteout" blend)
const TRI_GLSL = `
  vec3 tpFlatA(sampler2D t, vec3 p, float s) { vec2 uv = p.xz / s; return mix(texture2D(t, uv).rgb, texture2D(t, uv * 0.29 + 0.37).rgb, 0.35); }
  vec3 tpFlatN(sampler2D t, vec3 p, float s, vec3 N) { vec3 n = texture2D(t, p.xz / s).xyz * 2.0 - 1.0; n = vec3(n.xy + N.xz, abs(n.z) * N.y); return normalize(n.xzy); }
  vec3 tpW(vec3 N) { vec3 w = pow(abs(N), vec3(4.0)); return w / (w.x + w.y + w.z); }
  vec3 tpTriA(sampler2D t, vec3 p, float s, vec3 w) { return texture2D(t, p.zy / s).rgb * w.x + texture2D(t, p.xz / s).rgb * w.y + texture2D(t, p.xy / s).rgb * w.z; }
  vec3 tpTriN(sampler2D t, vec3 p, float s, vec3 N, vec3 w) {
    vec3 tx = texture2D(t, p.zy / s).xyz * 2.0 - 1.0, ty = texture2D(t, p.xz / s).xyz * 2.0 - 1.0, tz = texture2D(t, p.xy / s).xyz * 2.0 - 1.0;
    tx = vec3(tx.xy + N.zy, abs(tx.z) * N.x); ty = vec3(ty.xy + N.xz, abs(ty.z) * N.y); tz = vec3(tz.xy + N.xy, abs(tz.z) * N.z);
    return normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
  }`;
// world position/normal varyings that also work for InstancedMesh
const WP_VERT = `
  vec4 tpWp = vec4(transformed, 1.0); vec3 tpWn = objectNormal;
  #ifdef USE_INSTANCING
    tpWp = instanceMatrix * tpWp; tpWn = mat3(instanceMatrix) * tpWn;
  #endif
  vWP = (modelMatrix * tpWp).xyz; vWN = normalize(mat3(modelMatrix) * tpWn);`;

// Terrain: five PBR layers mixed by per-vertex weights (splatA = layers 0-3, splatB = layer 4).
// Layer 2 is the cliff layer and is projected triplanar; vertex colour is a macro tint for variety.
export function terrainMaterial(T, layers) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
  mat.onBeforeCompile = (sh) => {
    layers.forEach((l, i) => {
      sh.uniforms[`tA${i}`] = { value: T[`${l.tex}_color`] }; sh.uniforms[`tN${i}`] = { value: T[`${l.tex}_normal`] };
      sh.uniforms[`tT${i}`] = { value: new THREE.Color(l.tint ?? 0xffffff) };
    });
    sh.vertexShader = 'attribute vec4 splatA; attribute float splatB; varying vec4 vSA; varying float vSB; varying vec3 vWP; varying vec3 vWN;\n' +
      once(sh.vertexShader, '#include <worldpos_vertex>', '#include <worldpos_vertex>\n vSA = splatA; vSB = splatB;' + WP_VERT);
    const S = layers.map((l) => l.scale.toFixed(2)), R = layers.map((l) => (l.rough ?? 0.9).toFixed(2));
    let f = 'varying vec4 vSA; varying float vSB; varying vec3 vWP; varying vec3 vWN;\n' + layers.map((_, i) => `uniform sampler2D tA${i}, tN${i}; uniform vec3 tT${i};`).join('\n') + TRI_GLSL + '\n' + sh.fragmentShader;
    f = once(f, '#include <color_fragment>', `#include <color_fragment>
      vec3 tN = normalize(vWN), tw = tpW(tN);
      float tSum = vSA.x + vSA.y + vSA.z + vSA.w + vSB + 1e-4;
      vec4 wa = vSA / tSum; float wb = vSB / tSum;
      // sample every layer unconditionally: texture fetches inside divergent branches lose their mip derivatives
      vec3 tAlb = vec3(0.0), tNrm = vec3(0.0);
      tAlb += wa.x * tT0 * tpFlatA(tA0, vWP, ${S[0]}); tNrm += wa.x * tpFlatN(tN0, vWP, ${S[0]}, tN);
      tAlb += wa.y * tT1 * tpFlatA(tA1, vWP, ${S[1]}); tNrm += wa.y * tpFlatN(tN1, vWP, ${S[1]}, tN);
      tAlb += wa.z * tT2 * tpTriA(tA2, vWP, ${S[2]}, tw); tNrm += wa.z * tpTriN(tN2, vWP, ${S[2]}, tN, tw);
      tAlb += wa.w * tT3 * tpFlatA(tA3, vWP, ${S[3]}); tNrm += wa.w * tpFlatN(tN3, vWP, ${S[3]}, tN);
      tAlb += wb * tT4 * tpFlatA(tA4, vWP, ${S[4]}); tNrm += wb * tpFlatN(tN4, vWP, ${S[4]}, tN);
      diffuseColor.rgb *= tAlb;
      vec3 terrN = normalize(tNrm + tN * 1e-3);`);
    f = once(f, '#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor = dot(wa, vec4(${R[0]}, ${R[1]}, ${R[2]}, ${R[3]})) + wb * ${R[4]};`);
    f = once(f, '#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(terrN, 0.0)).xyz);');
    sh.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => 'terrain-' + layers.map((l) => l.tex).join();
  return mat;
}

// triplanar albedo+normal on any (instanced) standard material, e.g. boulders; the material's colour/instance colour tints it
export function triplanar(mat, albedo, normal, scale, key) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.tpA = { value: albedo }; sh.uniforms.tpN = { value: normal };
    sh.vertexShader = 'varying vec3 vWP; varying vec3 vWN;\n' + once(sh.vertexShader, '#include <worldpos_vertex>', '#include <worldpos_vertex>' + WP_VERT);
    let f = 'varying vec3 vWP; varying vec3 vWN; uniform sampler2D tpA, tpN;' + TRI_GLSL + '\n' + sh.fragmentShader;
    f = once(f, '#include <color_fragment>', `#include <color_fragment>
      vec3 tpNn = normalize(vWN), tpw = tpW(tpNn);
      diffuseColor.rgb *= tpTriA(tpA, vWP, ${scale.toFixed(2)}, tpw) * 1.6;
      vec3 tpNrm = tpTriN(tpN, vWP, ${scale.toFixed(2)}, tpNn, tpw);`);
    f = once(f, '#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(tpNrm, 0.0)).xyz);');
    sh.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => 'triplanar-' + key;
  return mat;
}
export { TRI_GLSL, WP_VERT };

// display-space colour grade: saturation, contrast, lift/gain, vignette
export const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uSat: { value: 1.1 }, uCon: { value: 1.06 }, uLift: { value: new THREE.Vector3() }, uGain: { value: new THREE.Vector3(1, 1, 1) }, uVig: { value: 0.28 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uSat, uCon, uVig; uniform vec3 uLift, uGain; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv); vec3 col = c.rgb;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSat);
      col = (col - 0.5) * uCon + 0.5;
      col = col * uGain + uLift;
      vec2 d = vUv - 0.5; col *= 1.0 - uVig * dot(d, d) * 2.0;
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
    }`,
};

// heights (m) packed into an R8 texture covering ±30 m around sea level, used for water depth
export function seaDepthTexture(heights, tn) {
  const data = new Uint8Array(tn * tn);
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, ((heights[i] + 30) / 60) * 255));
  const t = new THREE.DataTexture(data, tn, tn, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}

export function waterMaterial(normalTex, depthTex, { deep, shallow, half, size }) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.06, metalness: 0.15, normalMap: normalTex, normalScale: new THREE.Vector2(0.45, 0.45), transparent: true });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uTime: U.time, hTex: { value: depthTex }, uDeep: { value: new THREE.Color(deep) }, uShallow: { value: new THREE.Color(shallow) }, uHalf: { value: half }, uSize: { value: size } });
    sh.vertexShader = 'varying vec3 vWP;\n' + once(sh.vertexShader, '#include <worldpos_vertex>', '#include <worldpos_vertex>\n vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    let f = 'uniform float uTime, uHalf, uSize; uniform sampler2D hTex; uniform vec3 uDeep, uShallow; varying vec3 vWP;\n' + sh.fragmentShader;
    f = once(f, '#include <color_fragment>', `#include <color_fragment>
      float wDepth = -(texture2D(hTex, (vWP.xz + uHalf) / uSize).r * 60.0 - 30.0);
      float wSh = 1.0 - smoothstep(0.0, 14.0, wDepth);
      float wBand = sin(wDepth * 2.2 - uTime * 1.6 + sin(vWP.x * 0.05 + vWP.z * 0.04) * 2.0);
      float foam = (1.0 - smoothstep(0.0, 1.4, wDepth)) + smoothstep(0.78, 1.0, wBand) * (1.0 - smoothstep(0.5, 4.5, wDepth)) * 0.85;
      foam = clamp(foam * (0.65 + 0.35 * sin(vWP.x * 0.9 + uTime) * sin(vWP.z * 0.8 - uTime * 1.3)), 0.0, 1.0);
      diffuseColor.rgb = mix(mix(uDeep, uShallow, wSh * wSh), vec3(0.93), foam);
      diffuseColor.a = mix(0.8 + 0.18 * (1.0 - wSh), 1.0, foam) * smoothstep(-0.3, 0.3, wDepth);`);
    f = once(f, '#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.85, foam);');
    f = once(f, '#include <normal_fragment_maps>', `// two normal-map layers scrolling against each other
      vec3 mapN = normalize(texture2D(normalMap, vNormalMapUv + vec2(uTime * 0.004, uTime * 0.0025)).xyz * 2.0 - 1.0
        + texture2D(normalMap, vNormalMapUv * 1.63 + vec2(-uTime * 0.003, uTime * 0.0042)).xyz * 2.0 - 1.0);
      mapN.xy *= normalScale;
      normal = normalize(tbn * mapN);`);
    sh.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => 'water';
  return mat;
}

// Grass: G×G instances on a camera-snapped grid; each blade clump finds its own height (float texture,
// manual bilinear) and density/tint (RGBA texture) in the vertex shader. Nothing is updated per frame on the CPU.
export function makeGrass({ heights, tn, cell, half, size, tint, grid, spacing }) {
  const hTex = new THREE.DataTexture(heights, tn, tn, THREE.RedFormat, THREE.FloatType); hTex.needsUpdate = true;
  const gTex = new THREE.DataTexture(tint, tn, tn, THREE.RGBAFormat, THREE.UnsignedByteType);
  gTex.magFilter = gTex.minFilter = THREE.LinearFilter; gTex.needsUpdate = true;
  const pos = [], gy = [], idx = [];
  for (let b = 0; b < 5; b++) { // five tapered blades per clump, fanned around the clump centre
    const a = b * 1.256 + 0.3, r = 0.04 + (b % 2) * 0.05, ox = Math.cos(a * 2.3) * r, oz = Math.sin(a * 2.3) * r, cs = Math.cos(a), sn = Math.sin(a), base = pos.length / 3, hgt = 0.75 + (b % 3) * 0.15;
    for (const [w, y] of [[0.026, 0], [0.018, 0.5]]) for (const s of [-1, 1]) { pos.push(ox + cs * w * s, y * hgt, oz + sn * w * s); gy.push(y); }
    pos.push(ox, hgt, oz); gy.push(1);
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('gy', new THREE.Float32BufferAttribute(gy, 1));
  for (let i = 0, n = idx.length; i < n; i += 3) idx.push(idx[i], idx[i + 2], idx[i + 1]); // back faces, same upward normal
  geo.setIndex(idx);
  geo.instanceCount = grid * grid;
  const mat = new THREE.MeshLambertMaterial();
  const fade = grid * spacing * 0.5;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uTime: U.time, uCam: U.cam, hTex: { value: hTex }, gTex: { value: gTex } });
    sh.vertexShader = `uniform float uTime; uniform vec3 uCam; uniform sampler2D hTex, gTex; attribute float gy; varying vec3 vGrass;
      vec2 gHash(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
      float gHeight(vec2 p) {
        vec2 f = (p + ${half.toFixed(1)}) / ${cell.toFixed(3)}; ivec2 i = ivec2(floor(f)); vec2 u = fract(f);
        float a = texelFetch(hTex, i, 0).r, b = texelFetch(hTex, i + ivec2(1, 0), 0).r, c = texelFetch(hTex, i + ivec2(0, 1), 0).r, d = texelFetch(hTex, i + ivec2(1, 1), 0).r;
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }\n` + sh.vertexShader;
    sh.vertexShader = once(sh.vertexShader, '#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);');
    sh.vertexShader = once(sh.vertexShader, '#include <begin_vertex>', `
      float gi = float(gl_InstanceID);
      vec2 gc = vec2(mod(gi, ${grid.toFixed(1)}), floor(gi / ${grid.toFixed(1)})) - ${(grid / 2).toFixed(1)};
      vec2 cellP = floor(uCam.xz / ${spacing.toFixed(3)}) * ${spacing.toFixed(3)} + gc * ${spacing.toFixed(3)};
      vec2 hh = gHash(cellP);
      vec2 wp = cellP + (hh - 0.5) * ${spacing.toFixed(3)};
      vec4 gg = texture2D(gTex, (wp + ${half.toFixed(1)}) / ${size.toFixed(1)});
      float sc = step(hh.x, gg.a) * (1.0 - smoothstep(${(fade * 0.6).toFixed(1)}, ${fade.toFixed(1)}, length(wp - uCam.xz))) * (0.7 + hh.y * 0.5);
      float rot = hh.y * 6.2831;
      vec3 p = position * vec3(sc, sc * (0.3 + hh.x * 0.4), sc);
      p.z += 0.12 * p.y * p.y;
      vec3 transformed = vec3(cos(rot) * p.x - sin(rot) * p.z, p.y, sin(rot) * p.x + cos(rot) * p.z);
      float wnd = sin(uTime * 1.8 + wp.x * 0.15 + wp.y * 0.11) * 0.5 + sin(uTime * 3.7 + wp.x * 0.4 + wp.y * 0.3) * 0.2 + 0.3;
      transformed.xz += vec2(0.8, 0.45) * wnd * 0.55 * p.y * p.y;
      transformed += vec3(wp.x, gHeight(wp) - 0.04, wp.y);
      vGrass = gg.rgb * mix(0.38, 1.25, gy);`);
    sh.fragmentShader = 'varying vec3 vGrass;\n' + once(sh.fragmentShader, '#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= vGrass;');
  };
  mat.customProgramCacheKey = () => 'grass';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  return mesh;
}

// flocks circling slowly; wings flap in the vertex shader
export function makeBirds(scene, flocks, color, rand) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.45, 0.12, 0, 0.15, 0.12, 0, -0.2, 1.25, 0.05, -0.15, 0, 0, 0.45, -0.12, 0, 0.15, -0.12, 0, -0.2, -1.25, 0.05, -0.15, 0, 0, -0.55], 3));
  geo.setAttribute('wing', new THREE.Float32BufferAttribute([0, 0.2, 0.1, 1, 0, 0.2, 0.1, 1, 0], 1));
  geo.setIndex([0, 1, 2, 1, 3, 2, 4, 6, 5, 5, 6, 7, 0, 2, 8, 4, 8, 6]);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.time;
    sh.vertexShader = 'uniform float uTime; attribute float wing;\n' + once(sh.vertexShader, '#include <begin_vertex>',
      '#include <begin_vertex>\n transformed.y += wing * sin(uTime * 8.0 + instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.21) * 0.6;');
  };
  mat.customProgramCacheKey = () => 'birds';
  const birds = [];
  for (const f of flocks) for (let i = 0; i < f.n; i++) birds.push({ f, off: rand() * 6.28, rr: 0.6 + rand() * 0.5, h: (rand() - 0.5) * 14, s: 0.7 + rand() * 0.5 });
  const mesh = new THREE.InstancedMesh(geo, mat, birds.length);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const o = new THREE.Object3D();
  return (t) => {
    birds.forEach((b, i) => {
      const a = t * b.f.speed + b.off, r = b.f.r * b.rr * (0.85 + 0.15 * Math.sin(t * 0.13 + b.off * 3));
      o.position.set(b.f.c.x + Math.cos(a) * r, b.f.c.y + b.h + Math.sin(t * 0.6 + b.off) * 4, b.f.c.z + Math.sin(a) * r);
      o.rotation.set(0, -a - Math.sign(b.f.speed) * Math.PI / 2 + Math.PI / 2, -Math.sign(b.f.speed) * 0.35, 'YXZ');
      o.scale.setScalar(b.s); o.updateMatrix(); mesh.setMatrixAt(i, o.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
}
