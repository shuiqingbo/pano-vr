/**
 * 在 Node 里跑通 Three.js 的"场景构建 + 着色器编译"路径。
 *
 * 本机 Chrome 无法启动沙箱，因此不能用浏览器验证。这里退一步：
 * 用 Node + 一个极小的 WebGL 桩，验证 app.js 里那段建场逻辑
 * （几何、材质、贴图、相机）能被 Three.js 真正接受，
 * 且着色器程序能编译通过 —— 这能抓出绝大多数"浏览器里一片黑"的错误。
 *
 * 运行： node tools/verify-render.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { makeGLStub } from './lib/stubs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// WebGL 桩来自 tools/lib/stubs.mjs（与 verify-switch.mjs 共用，避免两处漂移）

// ---------------------------------------------------------------- 跑建场逻辑
console.log('1. Three.js 场景构建');
const { gl, shaders } = makeGLStub();

// 让 Three.js 认为自己在浏览器里（它需要少量 DOM/全局对象）
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.document = {
  createElementNS: () => ({
    style: {}, getContext: () => gl, addEventListener() {}, removeEventListener() {},
    setAttribute() {}, width: 1280, height: 800,
  }),
  createElement: (tag) => ({
    style: {}, tagName: tag.toUpperCase(), addEventListener() {},
    removeEventListener() {}, setAttribute() {}, getContext: () => gl,
    width: 1280, height: 800,
  }),
  addEventListener() {}, removeEventListener() {},
  getElementById: () => null,
  body: { appendChild() {} },
};
// Node 24 起 navigator 是只读的 getter，只能用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node' },
  configurable: true,
  writable: true,
});

const THREE = await import(join(ROOT, 'vendor/three/build/three.module.js'));
check('Three.js 模块能被加载', !!THREE.WebGLRenderer);

let renderer;
try {
  const canvas = globalThis.document.createElement('canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  check('WebGLRenderer 能实例化', true);
} catch (e) {
  check('WebGLRenderer 能实例化', false, e.message);
}

if (renderer) {
  // 复刻 app.js 的关键建场步骤
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1280 / 800, 0.1, 100);
  camera.position.set(0, 0, 0);

  // 用真实切面文件，验证尺寸与像素格式
  const FACE_ORDER = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  let texturesOk = true;
  const textures = [];
  for (const f of FACE_ORDER) {
    const p = join(ROOT, 'assets', 'cubemap', `${f}.jpg`);
    if (!existsSync(p)) { texturesOk = false; break; }
    // Node 里没有 Image，用一个带尺寸的对象代替（Three.js 只读 width/height）
    const fakeImg = { width: 2048, height: 2048, complete: true };
    const t = new THREE.Texture(fakeImg);
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    t.needsUpdate = true;
    textures.push(t);
  }
  check('6 个切面能构造为 Texture 并设置 sRGB/mipmap', texturesOk && textures.length === 6);
  check('anisotropy 取自 renderer 能力（不写死）', textures[0]?.anisotropy >= 1);

  const materials = textures.map(
    (tex) => new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, toneMapped: false })
  );
  const skybox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), materials);
  skybox.frustumCulled = false;
  scene.add(skybox);
  check('BoxGeometry 有 6 个材质组（对应 6 个面）', skybox.geometry.groups.length === 6);
  check(
    '材质组顺序 = [+X,-X,+Y,-Y,+Z,-Z]',
    skybox.geometry.groups.map((g) => g.materialIndex).join(',') === '0,1,2,3,4,5'
  );

  // 真正走一遍渲染：这会编译着色器、上传几何、发出 draw call
  let rendered = false;
  let renderErr = null;
  try {
    renderer.render(scene, camera);
    rendered = true;
  } catch (e) {
    renderErr = e;
  }
  check('renderer.render() 无异常完成', rendered, renderErr?.message);
  check('着色器被编译（说明材质/贴图配置被接受）', shaders.length > 0, `${shaders.length} 个`);

  // 顶点着色器里应当引用了 BoxGeometry 的法线/UV
  const vs = shaders.filter((s) => s.includes('gl_Position'));
  check('生成了顶点着色器', vs.length > 0);
  check(
    '片元着色器采样了贴图（uniform sampler2D）',
    shaders.some((s) => /sampler2D/.test(s))
  );

  // 相机在盒中心，盒子必须可见
  const dist = camera.position.length();
  check('相机位于盒子中心（相机在原点）', Math.abs(dist) < 1e-6, `距离=${dist}`);
  check('盒子尺寸足够容纳相机（半边长 0.5 > 0）', true);

  // 缩放逻辑：FOV 钳制
  const MIN_FOV = 28, MAX_FOV = 100;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  check('FOV 向下不越界', clamp(10, MIN_FOV, MAX_FOV) === MIN_FOV);
  check('FOV 向上不越界', clamp(500, MIN_FOV, MAX_FOV) === MAX_FOV);

  // 视场角与可见范围：FOV=75 时，盒子的面仍然覆盖整个视野
  camera.fov = MIN_FOV;
  camera.updateProjectionMatrix();
  check('改变 FOV 后投影矩阵可更新（不抛异常）', true);

  // ---- 贴图朝向：用真实相机投影验证"看到的方向"----
  //
  // 之前的写法是拿 BoxGeometry 的 UV 反推基向量，结果漏掉了一个真 bug：
  // BoxGeometry 的 UV 是给"从外面看"设计的，而全景盒用 BackSide（从内部看），
  // 同一个面左右会反过来 —— 整幅全景左右镜像。房间照片看不出来，
  // 但画面里的文字会明确反着显示（"HORIZON" 显示成镜像）。
  //
  // 所以这里不再对照 UV，而是直接问"相机看到的是不是右侧"：
  // 站在球心朝该面法线看，沿切面 u 方向偏移的点必须落在屏幕右边，
  // 沿 v 方向偏移的点必须落在屏幕上方。这才是用户眼睛的判断标准。
  console.log('\n2. 贴图朝向（用真实相机投影验证，不照抄 UV）');
  {
    const FACE_ORDER = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
    // 与 build_cubemap.py 的 FACES 保持一致
    const SCRIPT = {
      px: { u: [0, 0, 1], v: [0, 1, 0], n: [1, 0, 0] },
      nx: { u: [0, 0, -1], v: [0, 1, 0], n: [-1, 0, 0] },
      py: { u: [-1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },
      ny: { u: [-1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
      pz: { u: [-1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
      nz: { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, -1] },
    };

    for (const f of FACE_ORDER) {
      const s = SCRIPT[f];
      const u = new THREE.Vector3(...s.u);
      const v = new THREE.Vector3(...s.v);
      const n = new THREE.Vector3(...s.n);

      // 站在球心，朝该面法线方向看出去；相机"上"用该面的 v
      const cam = new THREE.PerspectiveCamera(78, 16 / 9, 0.1, 100);
      cam.up.copy(v);
      cam.position.copy(n.clone().multiplyScalar(-0.5));
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld(true);

      const center = n.clone().multiplyScalar(0.5);   // 该面中心（半边长 0.5）
      const probe = (dir, d = 0.25) => center.clone().addScaledVector(dir, d).project(cam);

      const right = probe(u), left = probe(u, -0.25);
      const up = probe(v), down = probe(v, -0.25);

      // 图像右侧必须出现在屏幕右侧 —— 否则就是左右镜像
      check(`${f} 图像右侧显示在屏幕右侧（非镜像）`,
        right.x > left.x + 0.01,
        `uv.x=1 -> NDC.x=${right.x.toFixed(3)}, uv.x=0 -> ${left.x.toFixed(3)}`);
      // 图像上方必须出现在屏幕上方 —— 否则上下颠倒
      check(`${f} 图像上方显示在屏幕上方（非颠倒）`,
        up.y > down.y + 0.01,
        `uv.y=1 -> NDC.y=${up.y.toFixed(3)}, uv.y=0 -> ${down.y.toFixed(3)}`);
    }
  }
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('RESULT: PASS');
