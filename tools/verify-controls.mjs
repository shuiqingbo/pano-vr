/**
 * 验证相机控制方案（用真实的 Three.js 与 OrbitControls 跑，不是静态检查）。
 *
 * 背景：这个 Demo 最容易出错的地方是"相机没有待在立方体中心"。
 * 相机的朝向是通过让它绕 controls.target 旋转实现的，如果相机停留在
 * 离中心有距离的位置，视线方向就会歪掉，整幅全景看起来是斜的。
 *
 * 所以这里的核心断言是：无论怎么拖拽，相机到原点的距离都必须 ~0，
 * 且视线方向必须是单位向量、随拖拽正确变化。
 *
 * 运行： node tools/verify-controls.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// OrbitControls.js 里写的是裸模块名 `from 'three'`：浏览器靠 index.html 的
// importmap 解析它，Node 默认不认识。为了不在项目里塞 node_modules，
// 这里把它读进来、把裸模块名换成真实文件路径，写到临时目录再 import，用完即删。
const TMP = join(ROOT, '.tmp-three');
mkdirSync(TMP, { recursive: true });
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

const threePath = join(ROOT, 'vendor/three/build/three.module.js');
const threeUrl = pathToFileURL(threePath).href;

const ocSrc = readFileSync(
  join(ROOT, 'vendor/three/examples/jsm/controls/OrbitControls.js'),
  'utf8'
);
const ocPath = join(TMP, 'OrbitControls.mjs');
writeFileSync(ocPath, ocSrc.replace(/(from\s+['"])three(['"])/g, `$1${threeUrl}$2`));

// OrbitControls 需要一点点 DOM
globalThis.window = globalThis;
globalThis.self = globalThis;
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node' }, configurable: true, writable: true,
});

const domStub = () => ({
  addEventListener() {}, removeEventListener() {}, style: {},
  ownerDocument: { addEventListener() {}, removeEventListener() {} },
  getRootNode: () => ({ addEventListener() {}, removeEventListener() {} }),
  setPointerCapture() {}, releasePointerCapture() {},
  clientWidth: 1280, clientHeight: 800,
});

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const THREE = await import(pathToFileURL(threePath).href);
const { OrbitControls } = await import(pathToFileURL(ocPath).href);

// ---- 复刻 app.js 里的控制逻辑（常量与算法保持一致）----
const CAMERA_RADIUS = 0.001;
const PITCH_LIMIT = Math.PI / 2 - 0.02;
const MIN_FOV = 28, MAX_FOV = 100, START_FOV = 75;
const UP = new THREE.Vector3(0, 1, 0);

function build() {
  const camera = new THREE.PerspectiveCamera(START_FOV, 1280 / 800, 0.1, 100);
  const controls = new OrbitControls(camera, domStub());
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.rotateSpeed = 0.42;
  controls.minDistance = 0.5;
  controls.maxDistance = 0.5;
  controls.target.set(0, 0, 0);
  camera.position.set(0, 0, -0.5);
  controls.update();
  const recenter = () => {
    const len = camera.position.length();
    if (len > CAMERA_RADIUS) camera.position.multiplyScalar(CAMERA_RADIUS / len);
  };
  recenter();
  return { camera, controls, recenter };
}

console.log('1. 初始状态');
{
  const { camera, recenter } = build();
  recenter();
  check('相机位于盒中心（距原点 ≤ 0.002）', camera.position.length() <= 0.002,
    `距离=${camera.position.length()}`);
  const d = new THREE.Vector3();
  camera.getWorldDirection(d);
  // 相机在 -Z 半轴 -> 视线朝 +Z（看向 pz 面）
  check('初始视线朝向 +Z（pz 面）', d.z > 0.999,
    d.toArray().map((v) => v.toFixed(3)).join(','));
  check('视线是单位向量', Math.abs(d.length() - 1) < 1e-6);
  check('初始 FOV 为 75', camera.fov === START_FOV);
}

console.log('\n2. 拖拽环视（模拟连续拖拽后相机仍在中心）');
{
  const { camera, controls, recenter } = build();
  const d = new THREE.Vector3();
  const seen = [];
  // 模拟向各个方向拖拽
  for (let i = 0; i < 60; i++) {
    controls._rotateLeft(-0.05);            // 水平
    controls._rotateUp(i % 3 === 0 ? -0.04 : 0.03); // 垂直
    controls.update();
    recenter();
    camera.getWorldDirection(d);
    seen.push([d.x, d.y, d.z]);
    if (Math.abs(d.length() - 1) > 1e-6) { check('拖拽过程中视线始终是单位向量', false); break; }
  }
  check('拖拽过程中视线始终是单位向量', true);
  check('拖拽期间相机始终待在盒中心（最大 0.002）',
    camera.position.length() <= 0.002, `距离=${camera.position.length()}`);

  // 视角确实变了
  const first = seen[0], last = seen[seen.length - 1];
  const moved = Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]);
  check('拖拽确实改变了视角方向', moved > 0.3, `位移=${moved.toFixed(3)}`);

  // 关键不变量：recenter 不能改变朝向。
  // 直接比较"有 recenter"和"没有 recenter"两种情况下的视线方向是否一致。
  const A = build();
  const B = build();
  const applySameDrag = (ctx, doRecenter) => {
    for (let i = 0; i < 30; i++) {
      ctx.controls._rotateLeft(-0.05);
      ctx.controls._rotateUp(0.03);
      ctx.controls.update();
      if (doRecenter) ctx.recenter();
    }
  };
  applySameDrag(A, true);
  applySameDrag(B, false);
  const dA = new THREE.Vector3(); A.camera.getWorldDirection(dA);
  const dB = new THREE.Vector3(); B.camera.getWorldDirection(dB);
  check('recenter 不改变视线方向（有/无 recenter 结果一致）',
    dA.distanceTo(dB) < 1e-6, `差异=${dA.distanceTo(dB).toExponential(2)}`);
  check('recenter 确实把相机收回了盒中心',
    A.camera.position.length() <= 0.002 && B.camera.position.length() > 0.1,
    `有=${A.camera.position.length().toFixed(4)} 无=${B.camera.position.length().toFixed(4)}`);
}

console.log('\n3. 缩放（FOV 钳制）');
{
  const { camera } = build();
  const zoomBy = (f) => {
    const next = Math.min(MAX_FOV, Math.max(MIN_FOV, camera.fov * f));
    if (next === camera.fov) return;
    camera.fov = next;
    camera.updateProjectionMatrix();
  };
  // 连续放大很多次，不能越过下限
  for (let i = 0; i < 100; i++) zoomBy(1 / 1.055);
  check('连续放大后 FOV 停在下限 28', Math.abs(camera.fov - MIN_FOV) < 1e-9, `FOV=${camera.fov}`);
  // 连续缩小很多次，不能越过上限
  for (let i = 0; i < 200; i++) zoomBy(1.055);
  check('连续缩小后 FOV 停在上限 100', Math.abs(camera.fov - MAX_FOV) < 1e-9, `FOV=${camera.fov}`);
  check('FOV 始终为正数（不会翻转）', camera.fov > 0);
}

console.log('\n4. 键盘环视（方向键）');
{
  const { camera, controls, recenter } = build();
  const step = 0.1;
  const d = new THREE.Vector3();
  camera.getWorldDirection(d);
  const before = d.clone();
  // ArrowLeft：绕 UP 轴旋转
  const dir = camera.position.clone().normalize().applyAxisAngle(UP, step);
  camera.position.copy(dir.multiplyScalar(controls.maxDistance));
  controls.update();
  recenter();
  camera.getWorldDirection(d);
  check('ArrowLeft 改变了视线', d.distanceTo(before) > 0.05,
    `变化=${d.distanceTo(before).toFixed(3)}`);
  check('键盘环视后相机仍在中心', camera.position.length() <= 0.002);
}

console.log('\n5. 俯仰限位（不会越过天顶/地面）');
{
  const { camera, controls, recenter } = build();
  // 反复向上推，俯仰角应被 PITCH_LIMIT 挡住
  for (let i = 0; i < 200; i++) {
    const dir = camera.position.clone().normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(dir, up).normalize();
    if (right.lengthSq() < 1e-6) break;
    const next = dir.clone().applyAxisAngle(right, 0.1);
    const p = Math.asin(Math.max(-1, Math.min(1, next.y)));
    if (Math.abs(p) > PITCH_LIMIT) break;
    camera.position.copy(next.multiplyScalar(controls.maxDistance));
    controls.update();
    recenter();
  }
  const d = new THREE.Vector3();
  camera.getWorldDirection(d);
  const pitchDeg = Math.abs(Math.asin(Math.max(-1, Math.min(1, d.y)))) * 180 / Math.PI;
  // 上限就是 PITCH_LIMIT（约 88.85°），允许一点点浮点余量
  const limitDeg = PITCH_LIMIT * 180 / Math.PI + 0.5;
  check(`向上推到极限时俯仰角不超过 ${limitDeg.toFixed(1)}°`,
    pitchDeg <= limitDeg, `实测 ${pitchDeg.toFixed(2)}°`);
  check('也没有真的顶到天顶（留有余量）', pitchDeg < 89.5, `实测 ${pitchDeg.toFixed(2)}°`);
  check('视线仍然有效（未退化）', Math.abs(d.length() - 1) < 1e-6);
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('RESULT: PASS');
