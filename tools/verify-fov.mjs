/**
 * 验证视场角换算：用户在不同屏幕上"能看到多宽"必须是一致的。
 *
 * 背景：Three.js 的 camera.fov 是【垂直】视角，水平角度被 aspect 放大。
 * 上一版直接把垂直 fov 定成 75°，结果：
 *   - 16:9 笔记本水平 108°（还行）
 *   - 竖屏手机水平只有 39°（一条缝，用户反馈"看不全"）
 * 现在改成用水平视角定义，再按 aspect 反算垂直 fov。
 *
 * 运行： node tools/verify-fov.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(join(ROOT, 'app.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---- 从 app.js 里读出真实常量，避免测试和实现各写一份 ----
function num(name) {
  const m = appJs.match(new RegExp(`const ${name}\\s*=\\s*([\\d.]+)`));
  if (!m) throw new Error(`读不到常量 ${name}`);
  return Number(m[1]);
}
const START_HFOV = num('START_HFOV');
const MIN_HFOV = num('MIN_HFOV');
const MAX_HFOV = num('MAX_HFOV');
const MAX_VFOV = num('MAX_VFOV');

// ---- 复刻 app.js 里的换算 ----
function vfovForHfov(hfovDeg, aspect) {
  const h = (hfovDeg * Math.PI) / 180;
  const v = 2 * Math.atan(Math.tan(h / 2) / aspect);
  return Math.min((v * 180) / Math.PI, MAX_VFOV);
}
function hfovOf(vfovDeg, aspect) {
  return (2 * Math.atan(Math.tan((vfovDeg * Math.PI) / 180 / 2) * aspect) * 180) / Math.PI;
}

console.log(`1. 常量（从 app.js 读取）`);
console.log(`   START_HFOV=${START_HFOV}°  MIN=${MIN_HFOV}°  MAX=${MAX_HFOV}°  垂直上限=${MAX_VFOV}°`);
check('默认水平视角足够宽（≥100°）', START_HFOV >= 100, `${START_HFOV}°`);
check('默认水平视角不夸张（≤130°）', START_HFOV <= 130, `${START_HFOV}°`);
check('可以拉到很宽（MAX ≥ 130°）', MAX_HFOV >= 130, `${MAX_HFOV}°`);
check('可以拉近（MIN ≤ 50°）', MIN_HFOV <= 50, `${MIN_HFOV}°`);
check('垂直上限存在且合理（100–130°）', MAX_VFOV >= 100 && MAX_VFOV <= 130, `${MAX_VFOV}°`);

console.log('\n2. 各屏幕下的实际可见范围');
const SCREENS = [
  ['16:9 笔记本', 1920, 1080],
  ['16:10', 1680, 1050],
  ['21:9 带鱼屏', 2560, 1080],
  ['4:3', 1440, 1080],
  ['竖屏手机', 390, 844],
  ['iPad 竖屏', 820, 1180],
  ['超宽 32:9', 3840, 1080],
];

let allWide = true;
for (const [name, w, h] of SCREENS) {
  const aspect = w / h;
  const v = vfovForHfov(START_HFOV, aspect);
  const hActual = hfovOf(v, aspect);
  // 修复前是硬编码垂直 75°
  const beforeH = hfovOf(75, aspect);
  const improved = hActual > beforeH + 0.5;
  const ok = hActual >= 70;   // 至少能看到 70° 宽
  if (!ok) allWide = false;
  console.log(
    `   ${name.padEnd(12)} aspect=${aspect.toFixed(2).padStart(5)}  ` +
    `水平 ${hActual.toFixed(0).padStart(3)}°  垂直 ${v.toFixed(0).padStart(3)}°  ` +
    `(修复前水平 ${beforeH.toFixed(0)}°)${improved ? '  ↑改善' : ''}`
  );
}
check('所有屏幕默认都能看到至少 70° 宽（不再有"一条缝"）', allWide);

console.log('\n3. 关键回归：竖屏手机');
{
  const aspect = 390 / 844;
  const v = vfovForHfov(START_HFOV, aspect);
  const h = hfovOf(v, aspect);
  const before = hfovOf(75, aspect);
  check('竖屏手机水平视野比修复前明显变宽', h > before * 1.6,
    `${before.toFixed(0)}° -> ${h.toFixed(0)}°`);
  check('竖屏手机水平视野达到 70° 以上', h >= 70, `${h.toFixed(0)}°`);
  check('竖屏手机垂直视角被上限保护（不超 MAX_VFOV）', v <= MAX_VFOV + 1e-6,
    `${v.toFixed(1)}°`);
}

console.log('\n4. 宽屏不应因比例被压窄');
{
  const wide = 2560 / 1080;
  const v = vfovForHfov(START_HFOV, wide);
  const h = hfovOf(v, wide);
  check('21:9 屏幕水平视角仍是 110° 左右', Math.abs(h - START_HFOV) < 1,
    `${h.toFixed(1)}°`);
  check('21:9 垂直视角没有被拉到畸形', v < 90, `${v.toFixed(1)}°`);
}

console.log('\n5. 缩放范围');
{
  const aspect = 1920 / 1080;
  const hMin = hfovOf(vfovForHfov(MIN_HFOV, aspect), aspect);
  const hMax = hfovOf(vfovForHfov(MAX_HFOV, aspect), aspect);
  check('拉到最近时水平视角 ≈ MIN_HFOV', Math.abs(hMin - MIN_HFOV) < 1.5, `${hMin.toFixed(1)}°`);
  check('拉到最远时水平视角 ≈ MAX_HFOV', Math.abs(hMax - MAX_HFOV) < 1.5, `${hMax.toFixed(1)}°`);
  check('缩放区间足够大（≥ 3 倍）', MAX_HFOV / MIN_HFOV >= 3,
    `${(MAX_HFOV / MIN_HFOV).toFixed(1)}x`);
}

console.log('\n6. 代码约束（防止退回硬编码垂直 fov）');
{
  check('app.js 定义了 vfovForHfov 换算', /function vfovForHfov/.test(appJs));
  check('内部状态是水平视角 hfov', /let hfov\s*=/.test(appJs));
  check('没有遗留 START_FOV / MIN_FOV / MAX_FOV', !/\b(START|MIN|MAX)_FOV\b/.test(appJs));
  check('resize 时会重算 fov（横竖屏切换才正确）',
    /function resize\(\)[\s\S]{0,300}applyHfov\(\)/.test(appJs));
  check('相机初始 fov 由 aspect 算出，不是写死',
    /new THREE\.PerspectiveCamera\(\s*vfovForHfov\(/.test(appJs));
  check('VR 里不再手改 camera.fov（会被头显投影覆盖）',
    !/sessionstart[\s\S]{0,200}camera\.fov\s*=/.test(appJs));
  check('退出 VR 后恢复 fov', /sessionend[\s\S]{0,200}applyHfov\(\)/.test(appJs));
  check('applyHfov 传给了 setupXR（否则退出 VR 恢复时 ReferenceError）',
    /setupXR\(renderer, scene, camera, controls, applyHfov\)/.test(appJs) &&
    /function setupXR\([^)]*applyHfov/.test(appJs));
}

// ---------------------------------------------------------------- 7
console.log('\n7. 初始俯仰角（"视角太高"那次的回归）');
{
  // 从 app.js 读常量
  const m = appJs.match(/const START_PITCH_DEG\s*=\s*(-?[\d.]+)/);
  const START_PITCH = m ? Number(m[1]) : NaN;
  check('定义了 START_PITCH_DEG', Number.isFinite(START_PITCH), String(START_PITCH));
  check('初始是向下看（不是水平 0°，也不是向上）',
    START_PITCH < 0, `${START_PITCH}°`);
  check('下看幅度不过分（不超过 -25°，否则变俯视地板）',
    START_PITCH >= -25, `${START_PITCH}°`);

  // 关键：符号不能反。OrbitControls 里"相机抬高"才等于"视线向下"。
  // 曾经写成 camera.y = +r*sin(pitch)，结果 pitch 为负时视线反而朝上。
  check('相机 y 用 -r*sin(pitch)（符号写反会导致视线朝上）',
    /camera\.position\.set\(\s*0,\s*-r\s*\*\s*Math\.sin\(p\)/.test(appJs));

  // 用真实 Three.js 验算
  const THREE = await import(join(ROOT, 'vendor/three/build/three.module.js'));
  for (const [name, aspect] of [['16:9', 16 / 9], ['21:9', 21 / 9], ['竖屏', 390 / 844]]) {
    const cam = new THREE.PerspectiveCamera(vfovForHfov(START_HFOV, aspect), aspect, 0.1, 100);
    const r = 0.5, p = (START_PITCH * Math.PI) / 180;
    cam.position.set(0, -r * Math.sin(p), -r * Math.cos(p));
    cam.lookAt(0, 0, 0);
    cam.position.multiplyScalar(0.001 / cam.position.length());
    const d = new THREE.Vector3();
    cam.getWorldDirection(d);
    const pitch = (Math.asin(d.y) * 180) / Math.PI;
    check(`${name} 实际俯仰等于设定值（${pitch.toFixed(1)}°）`,
      Math.abs(pitch - START_PITCH) < 0.5);
    check(`${name} 相机仍在球心`, cam.position.length() < 0.002);
    check(`${name} 仍然朝向 +Z`, d.z > 0.9);
  }

  // 构图检查：天花板不应占满上半屏
  // 实测该房间天花板下沿约 lat +14°（见 README 的说明）
  const CEIL_EDGE = 14;
  const aspect = 16 / 9;
  const vDeg = vfovForHfov(START_HFOV, aspect);
  const top = START_PITCH + vDeg / 2;
  const ceilShare = Math.max(0, Math.min(top, 90) - Math.max(START_PITCH - vDeg / 2, CEIL_EDGE)) / vDeg;
  check(`16:9 下天花板占画面 < 25%（实测 ${(ceilShare * 100).toFixed(1)}%）`,
    ceilShare < 0.25);
  check('视角中心落在墙面主体范围内（不被吊顶占据）', top < 35, `上边界 ${top.toFixed(0)}°`);

  // 双击归位要复用同一个函数，避免以后改动不同步
  check('resetView 复用 setInitialOrientation（两处不各写一份）',
    /function resetView\(\)[\s\S]{0,200}setInitialOrientation\(\)/.test(appJs));
  check('没有遗留硬编码的初始位置 (0,0,-0.5)',
    !/position\.set\(0,\s*0,\s*-0\.5\)/.test(appJs));
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('RESULT: PASS');
