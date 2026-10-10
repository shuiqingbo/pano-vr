/**
 * 验证"场景切换"这条路径（真实执行 app.js 的 loadScene）。
 *
 * 为什么需要它：浏览器里没法稳定复现切换（无头 Chrome 在这台机器上跑
 * 带异步逻辑的页面会挂住），而切换恰恰是出过故障的地方 ——
 * 早先一个整屏黑遮罩让切换期间全屏变黑，看起来像崩了。
 * 所以这里用 DOM/WebGL 桩把 app.js 真正跑起来，直接调用 loadScene 断言：
 *
 *   1. 成功切换后 6 张贴图确实换成了新场景的图
 *   2. 进度回调 0→1 且被调用 6 次
 *   3. 切换期间再点一次会被挡住（返回 false，不会并发换图）
 *   4. 加载失败时返回 false 且给出错误提示（不会卡在"切换中"）
 *
 * 运行： node tools/verify-switch.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { makeGLStub, installBrowserStubs } from './lib/stubs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FACE_ORDER = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

// app.js 里写的是裸模块名（'three'、'three/addons/...'），浏览器靠 index.html
// 的 importmap 解析，Node 不认。这里把它们换成真实文件路径再 import。
const TMP = join(ROOT, '.tmp-switch');
mkdirSync(TMP, { recursive: true });
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

const threeUrl = pathToFileURL(join(ROOT, 'vendor/three/build/three.module.js')).href;
const addons = join(ROOT, 'vendor/three/examples/jsm');

// OrbitControls 自己也有裸 import，需要一并改写
const ocPath = join(TMP, 'OrbitControls.mjs');
writeFileSync(
  ocPath,
  readFileSync(join(addons, 'controls/OrbitControls.js'), 'utf8')
    .replace(/(from\s+['"])three(['"])/g, `$1${threeUrl}$2`)
);
const vrUrl = pathToFileURL(join(addons, 'webxr/VRButton.js')).href;

const appPath = join(TMP, 'app.mjs');
writeFileSync(
  appPath,
  readFileSync(join(ROOT, 'app.js'), 'utf8')
    .replace(/(from\s+['"])three(['"])/g, `$1${threeUrl}$2`)
    .replace(/(from\s+['"])three\/addons\/controls\/OrbitControls\.js(['"])/g,
      `$1${pathToFileURL(ocPath).href}$2`)
    .replace(/(from\s+['"])three\/addons\/webxr\/VRButton\.js(['"])/g, `$1${vrUrl}$2`)
);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 5000, step = 5) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    if (fn()) return true;
    await sleep(step);
  }
  return false;
}

// ---- 装桩并启动 app.js ----
const { gl } = makeGLStub();
const { elements } = installBrowserStubs(gl);

// app.js 启动时会读 window.__PANO__ 拿初始场景
globalThis.__PANO__ = { name: '初始场景', dir: '/b0', meta: '初始' };

console.log('1. 启动 app.js');
await import(pathToFileURL(appPath).href);

const ready = await waitFor(() => globalThis.panoViewer, 5000);
check('app.js 启动并暴露了 panoViewer', ready);
if (!ready) {
  console.log('\napp.js 没能启动，后续无法测试');
  process.exit(1);
}

const viewer = globalThis.panoViewer;
check('暴露了 6 个贴图（供断言切换是否生效）',
  Array.isArray(viewer.textures) && viewer.textures.length === 6,
  String(viewer.textures && viewer.textures.length));

const nameEl = elements.get('sceneName');
const errEl = elements.get('err');

console.log('\n2. 初始贴图');
{
  const srcs = viewer.textures.map((t) => t.image && t.image.src);
  const ok = srcs.every((s, i) => s === `/b0/${FACE_ORDER[i]}.jpg`);
  check('初始 6 个面都指向初始场景', ok, JSON.stringify(srcs));
  check('初始场景名为 "初始场景"', nameEl.textContent === '初始场景', nameEl.textContent);
}

console.log('\n3. 正常切换');
{
  errEl.hidden = true;
  const progress = [];
  const ok = await viewer.loadScene({
    name: '客厅',
    base: '/b1',
    meta: '2048² 面 · 6 面',
    onProgress: (r) => progress.push(r),
  });

  check('loadScene 返回 true', ok === true, String(ok));

  // 贴图确实换成了新场景
  const srcs = viewer.textures.map((t) => t.image && t.image.src);
  check('6 个贴图都换成了新场景的图',
    srcs.every((s, i) => s === `/b1/${FACE_ORDER[i]}.jpg`), JSON.stringify(srcs));

  // needsUpdate 会推高 version，说明贴图被标记为需要重新上传
  check('贴图被标记重新上传（version > 0）',
    viewer.textures.every((t) => t.version > 0),
    viewer.textures.map((t) => t.version).join(','));

  check('场景名已更新为 "客厅"', nameEl.textContent === '客厅', nameEl.textContent);
  check('meta 已更新', elements.get('sceneMeta').textContent === '2048² 面 · 6 面');

  // 进度
  check('进度回调被调用 6 次（每个面一次）', progress.length === 6, `次数=${progress.length}`);
  check('进度单调不减', progress.every((v, i) => i === 0 || v >= progress[i - 1]),
    progress.map((v) => v.toFixed(2)).join(','));
  check('进度结束于 1', progress.length > 0 && progress[progress.length - 1] === 1,
    String(progress[progress.length - 1]));

  check('切换成功后没有报错面板', errEl.hidden === true);
  check('相机回到初始朝向（切换后视角归位）',
    Math.abs(viewer.camera.position.length() - 0.001) < 0.0005,
    viewer.camera.position.length().toExponential(2));
}

console.log('\n4. 并发守卫（切换中再点一次）');
{
  errEl.hidden = true;
  const first = viewer.loadScene({ name: 'A', base: '/b2' });
  const second = await viewer.loadScene({ name: 'B', base: '/b3' });
  check('切换进行中时第二次调用直接返回 false', second === false, String(second));

  const ok = await first;
  check('第一次切换正常完成', ok === true);
  check('最终贴图来自第一次请求（B 没有插队）',
    viewer.textures[0].image.src === '/b2/px.jpg', viewer.textures[0].image.src);

  const after = await viewer.loadScene({ name: 'C', base: '/b4' });
  check('切换结束后可以再次切换（锁已释放）', after === true);
}

console.log('\n5. 加载失败');
{
  errEl.hidden = true;
  const ok = await viewer.loadScene({ name: '坏场景', base: '/BAD' });
  check('加载失败时返回 false', ok === false, String(ok));
  check('显示了错误面板（不会静默失败）', errEl.hidden === false);
  check('错误信息里带上了失败的路径',
    String(errEl.innerHTML).includes('/BAD'),
    String(errEl.innerHTML).slice(0, 80));

  // 关键：失败后锁必须释放，否则后面所有切换都会被挡住
  errEl.hidden = true;
  const again = await viewer.loadScene({ name: '恢复', base: '/b5' });
  check('失败后锁已释放（还能继续切换）', again === true, String(again));
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('RESULT: PASS');
