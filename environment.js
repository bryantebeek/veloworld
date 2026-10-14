// Shared living-world systems: global time uniform, wind sway, detailed terrain shading,
// shore-aware water, GPU grass around the camera, and bird flocks.
import * as THREE from 'three';

export const U = { time: { value: 0 }, cam: { value: new THREE.Vector3() } };

const once = (src, find, add) => {
  if (!src.includes(find)) throw new Error(`shader chunk not found: ${find}`);
  return src.replace(find, add);
};

// sway vertices by height (object space, so per-instance scale carries through); k = bend per m²
export function addWind(mat, k, key, flutter = 0.4) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.time;
    sh.vertexShader = 'uniform float uTime;\n' + once(sh.vertexShader, '#include <begin_vertex>', `#include <begin_vertex>
      vec3 wIp = vec3(0.0);
      #ifdef USE_INSTANCING
        wIp = instanceMatrix[3].xyz;
      #endif
      float wPh = wIp.x * 0.07 + wIp.z * 0.053, wH = max(position.y, 0.0);
      float wS = (sin(uTime * 1.4 + wPh) * 0.6 + sin(uTime * 3.1 + wPh * 1.7) * 0.25) * ${k.toFixed(5)} * wH * wH;
      transformed.x += wS + sin(uTime * 7.0 + position.x * 4.0 + position.z * 3.0 + wPh) * ${(k * flutter).toFixed(5)} * wH * wH;
      transformed.z += cos(uTime * 1.1 + wPh) * 0.5 * ${k.toFixed(5)} * wH * wH;`);
  };
  mat.customProgramCacheKey = () => 'wind-' + key;
  return mat;
}

// vertex colours carry the biome; world-space detail textures add grain (flat) and rock strata (steep, triplanar)
export function terrainMaterial(canvasTex, rand) {
  const grain = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = 'rgb(140,140,140)'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 14000; i++) {
      const v = (95 + rand() * 120) | 0, x = rand() * w, y = rand() * h, l = 2 + rand() * 6, a = rand() * Math.PI;
      g.strokeStyle = `rgba(${v},${v},${v},.55)`; g.lineWidth = 1 + rand() * 1.5;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
  }, true, false);
  const rock = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = 'rgb(138,138,138)'; g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 3 + rand() * 9) { const v = (100 + rand() * 90) | 0; g.fillStyle = `rgba(${v},${v},${v},.5)`; g.fillRect(0, y, w, 1 + rand() * 4); } // strata
    g.strokeStyle = 'rgba(40,40,40,.7)';
    for (let i = 0; i < 60; i++) { // cracks
      let x = rand() * w, y = rand() * h; g.lineWidth = 0.6 + rand() * 1.6; g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 8; k++) { x += (rand() - 0.5) * 22; y += rand() * 14; g.lineTo(x, y); }
      g.stroke();
    }
  }, true, false);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.detA = { value: grain }; sh.uniforms.detB = { value: rock };
    sh.vertexShader = 'varying vec3 vWP; varying vec3 vWN;\n' + once(sh.vertexShader, '#include <worldpos_vertex>',
      '#include <worldpos_vertex>\n vWP = (modelMatrix * vec4(transformed, 1.0)).xyz; vWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = 'uniform sampler2D detA, detB; varying vec3 vWP; varying vec3 vWN;\n' + once(sh.fragmentShader, '#include <color_fragment>', `#include <color_fragment>
      vec3 tAn = abs(vWN); tAn /= (tAn.x + tAn.y + tAn.z);
      float tRock = smoothstep(0.86, 0.62, vWN.y);
      vec3 tG = texture2D(detA, vWP.xz * 0.21).rgb * 0.55 + texture2D(detA, vWP.xz * 0.031 + 0.37).rgb * 0.45;
      vec3 tR = texture2D(detB, vWP.zy * 0.06).rgb * tAn.x + texture2D(detB, vWP.xz * 0.06).rgb * tAn.y + texture2D(detB, vWP.xy * 0.06).rgb * tAn.z;
      diffuseColor.rgb *= mix(tG, tR, tRock) * 1.85;`);
  };
  mat.customProgramCacheKey = () => 'terrain';
  return mat;
}

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
  for (let b = 0; b < 3; b++) { // three tapered, slightly offset blades per clump
    const a = b * 2.1, ox = Math.cos(a * 1.7) * 0.07, oz = Math.sin(a * 1.3) * 0.07, cs = Math.cos(a), sn = Math.sin(a), base = pos.length / 3;
    const rows = [[0.032, 0], [0.026, 0.33], [0.016, 0.66]];
    for (const [w, y] of rows) for (const s of [-1, 1]) { pos.push(ox + cs * w * s, y, oz + sn * w * s); gy.push(y); }
    pos.push(ox, 1, oz); gy.push(1);
    for (let r = 0; r < 2; r++) { const i = base + r * 2; idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2); }
    idx.push(base + 4, base + 5, base + 6);
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
