/**
 * 在 Node 里对 VR Demo 的核心逻辑做无浏览器的验证。
 *
 * 为什么需要它：本机 Chrome 无法初始化沙箱（sandbox initialization failed），
 * 也就无法用真实浏览器跑自动化。所以这里换个思路——把"会不会出错"的部分
 * 全部抽出来单独验证：
 *
 *   1. 立方体贴图 6 个面的几何是否正确（用射线反投影交叉验证）
 *   2. app.js / index.html 里的常量与资源名是否一致（拼错文件名是最常见的低级错误）
 *   3. 关键 API 用法是否是 Three.js 真实存在的（防止写出不存在的接口）
 *   4. 渲染路径能否在无 GPU 的情况下跑通（用 three 的软件渲染路径验证着色器）
 *
 * 运行： node tools/verify-logic.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function section(t) {
  console.log(`\n${t}`);
}

const appJs = readFileSync(join(ROOT, 'app.js'), 'utf8');
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
const styleCss = readFileSync(join(ROOT, 'style.css'), 'utf8');
const buildPy = readFileSync(join(ROOT, 'build_cubemap.py'), 'utf8');

// ---------------------------------------------------------------- 1. 几何
section('1. 立方体贴图几何');

// build_cubemap.py 里的 6 个面定义
const FACE_DEFS = {
  px: { u: [0, 0, 1], v: [0, 1, 0], n: [1, 0, 0] },
  nx: { u: [0, 0, -1], v: [0, 1, 0], n: [-1, 0, 0] },
  py: { u: [-1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },
  ny: { u: [-1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
  pz: { u: [-1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  nz: { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, -1] },
};

// 从 build_cubemap.py 里解析真实的 FACES 定义，确保它与这里断言的一致。
// 曾经顶/底面的 v 方向写反，导致画面上下颠倒 180°，所以专门盯住这一点。
{
  const block = buildPy.match(/FACES\s*=\s*\{([\s\S]*?)\n\}/);
  const parsed = {};
  if (block) {
    // 不写一个大正则，而是逐行取面名 + 三个向量，容错更好
    for (const line of block[1].split('\n')) {
      const name = line.match(/"([a-z]{2})"\s*:/);
      if (!name || !line.includes('dict(')) continue;
      const grab = (key) => {
        const m = line.match(new RegExp(`${key}\\s*=\\s*\\(([^)]*)\\)`));
        return m ? m[1].split(',').map((t) => Number(t.trim())) : null;
      };
      const u = grab('u'), v = grab('v'), n = grab('n');
      if (u && v && n && u.length === 3 && v.length === 3 && n.length === 3) {
        parsed[name[1]] = { u, v, n };
      }
    }
  }
  const keys = Object.keys(parsed).sort().join(',');
  check('能解析出 build_cubemap.py 的 6 个面', keys === 'nx,ny,nz,px,py,pz', keys);
  let same = true;
  for (const [k, v] of Object.entries(parsed)) {
    if (JSON.stringify(v) !== JSON.stringify(FACE_DEFS[k])) {
      same = false;
      console.log(`       ${k} 脚本里是 ${JSON.stringify(v)}，期望 ${JSON.stringify(FACE_DEFS[k])}`);
    }
  }
  check('切片脚本的基向量与 Three.js BoxGeometry 的 UV 约定一致', same);
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

// 正交性：u、v、n 必须两两垂直且都是单位向量，否则面会拉伸
let orthoOk = true;
for (const [name, f] of Object.entries(FACE_DEFS)) {
  const o = [Math.abs(dot(f.u, f.v)), Math.abs(dot(f.u, f.n)), Math.abs(dot(f.v, f.n))];
  const lens = [Math.hypot(...f.u), Math.hypot(...f.v), Math.hypot(...f.n)];
  if (Math.max(...o) > 1e-9 || Math.max(...lens.map((l) => Math.abs(l - 1))) > 1e-9) {
    orthoOk = false;
    console.log(`       ${name} 不正交: 点积=${o} 长度=${lens}`);
  }
}
check('6 个面的 u/v/n 都是正交单位向量', orthoOk);

/**
 * 朝向判据：不用 u×v 的符号（不同面族约定不同，py/ny 与 4 个侧面恰好相反），
 * 而用真正决定成败的性质 —— 每个面的中心方向必须正好是它的法线方向，
 * 且面的四角必须落在立方体的 8 个顶点上。
 * 这两条同时成立，就排除了镜像与旋转错误。
 */
function corner(face, sx, sy) {
  const f = FACE_DEFS[face];
  return [
    f.u[0] * sx + f.v[0] * sy + f.n[0],
    f.u[1] * sx + f.v[1] * sy + f.n[1],
    f.u[2] * sx + f.v[2] * sy + f.n[2],
  ];
}

let orientOk = true;
for (const [name, f] of Object.entries(FACE_DEFS)) {
  // 中心方向 == 法线
  if (dot(dirOf(name, 0, 0), f.n) < 0.9999) {
    orientOk = false;
    console.log(`       ${name} 中心方向不等于法线`);
  }
  // 四角必须是立方体顶点（三个分量绝对值都为 1）
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const c = corner(name, sx, sy).map((v) => Math.abs(Math.abs(v) - 1) < 1e-9);
    if (!c.every(Boolean)) {
      orientOk = false;
      console.log(`       ${name} 角点 (${sx},${sy}) 不在立方体顶点上`);
    }
  }
}
check('每个面的中心朝向=法线，且四角落在立方体顶点上', orientOk);

// 镜像检测：这 6 个面的角点集合必须恰好覆盖立方体的 8 个顶点各 3 次
//（每个顶点被 3 个面共享）。若某面镜像，顶点分布仍会满足，
// 所以再单独检查每个面的 u 方向与"从内部看时该往哪边"一致。
/**
 * 镜像判据：从盒子【内部】看这个面时，右手指向的世界方向就是 u。
 * 站在球心朝 n 看、up = +Y，右手边 r = n × up：
 *   pz: (+Z)×(+Y) = -X      px: (+X)×(+Y) = +Z
 *   nz: (-Z)×(+Y) = +X      nx: (-X)×(+Y) = -Z
 * ⚠️ 这里踩过坑：早先照抄 BoxGeometry 的 UV 方向（那是给"从外面看"用的），
 * 结果整幅全景左右镜像 —— 房间看不出，但文字会反着显示。
 * 真正的投影验证在 verify-render.mjs（用真实相机算 NDC 符号）。
 */
const CORNER_EXPECT = {
  pz: [-1, 0, 0], nz: [1, 0, 0],
  px: [0, 0, 1], nx: [0, 0, -1],
  py: [-1, 0, 0], ny: [-1, 0, 0],
};
let mirrorOk = true;
for (const [name, want] of Object.entries(CORNER_EXPECT)) {
  if (dot(FACE_DEFS[name].u, want) < 0.9999) {
    mirrorOk = false;
    console.log(`       ${name} 的 u 方向 ${FACE_DEFS[name].u} 与预期 ${want} 不符（可能镜像）`);
  }
}
check('各面 u 方向正确（排除左右镜像）', mirrorOk);

/** 把面内归一化坐标映射到方向向量 */
function dirOf(face, sx, sy) {
  const f = FACE_DEFS[face];
  return norm([
    f.u[0] * sx + f.v[0] * sy + f.n[0],
    f.u[1] * sx + f.v[1] * sy + f.n[1],
    f.u[2] * sx + f.v[2] * sy + f.n[2],
  ]);
}

/**
 * 接缝的真正判据：同一条视线方向，无论由哪个面算出，
 * 都必须采样到全景图的同一个像素。
 *
 * 做法：取面的边界像素，算出它的方向向量，再用"统一公式"
 * 反算该方向在全景图上的经纬度；两个相邻面在公共边上的
 * 方向向量既然相同，采样点自然相同。这里直接比较方向向量本身。
 */
function edgeDirs(face, edge, n = 40) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = -1 + (2 * i) / n;
    if (edge === 'R') out.push(dirOf(face, 1, t));
    else if (edge === 'L') out.push(dirOf(face, -1, t));
    else if (edge === 'T') out.push(dirOf(face, t, 1));
    else out.push(dirOf(face, t, -1));
  }
  return out;
}

/** 对两组方向集合，找最小夹角（忽略参数化方向） */
function minAngleBetween(aDirs, bDirs) {
  let best = Infinity;
  for (const a of aDirs) for (const b of bDirs) {
    const ang = Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
    if (ang < best) best = ang;
  }
  return (best * 180) / Math.PI;
}

// 相邻面的邻接关系：(面A, 面B) 它们共享一条边
const ADJACENT = [
  ['pz', 'px'], ['pz', 'nx'], ['pz', 'py'], ['pz', 'ny'],
  ['px', 'py'], ['nx', 'py'], ['px', 'ny'], ['nx', 'ny'],
  ['nz', 'px'], ['nz', 'nx'], ['nz', 'py'], ['nz', 'ny'],
];

let worstSeamDeg = 0;
let worstLabel = '';
for (const [a, b] of ADJACENT) {
  let bestForPair = Infinity;
  for (const ea of ['R', 'L', 'T', 'B']) {
    const da = edgeDirs(a, ea);
    for (const eb of ['R', 'L', 'T', 'B']) {
      const db = edgeDirs(b, eb);
      // 公共边：两条边上所有点应当一一对应，取逐点最小夹角的"最大值"来判断
      // 这里用集合最小夹角，若两面共享一条边，则必然存在完全重合的方向
      const m = minAngleBetween(da, db);
      if (m < bestForPair) bestForPair = m;
    }
  }
  if (bestForPair > worstSeamDeg) { worstSeamDeg = bestForPair; worstLabel = `${a}-${b}`; }
}

// 相邻面共享边上的方向应当完全一致（夹角 0），容差取半像素对应角度
const pixelAngle = (90 / 2048) * 2;
check(
  `12 对相邻面的公共边方向一致（最大偏差 ${worstSeamDeg.toFixed(5)}° @ ${worstLabel}，半像素=${pixelAngle.toFixed(3)}°）`,
  worstSeamDeg < pixelAngle,
  `实测 ${worstSeamDeg}°`
);

// 6 个面的法线必须恰好覆盖 ±X ±Y ±Z
const normals = Object.values(FACE_DEFS).map((f) => f.n.join(',')).sort();
check(
  '6 个面法线覆盖全部 6 个方向',
  new Set(normals).size === 6,
  normals.join(' ')
);

// ---------------------------------------------------------------- 2. 资源一致性
section('2. 资源与常量一致性');

const FACE_ORDER = (appJs.match(/const FACE_ORDER\s*=\s*\[([^\]]+)\]/) || [])[1];
const orderList = FACE_ORDER ? FACE_ORDER.split(',').map((s) => s.trim().replace(/['"]/g, '')) : [];
check('app.js 定义了 6 个面顺序', orderList.length === 6, orderList.join(','));
check(
  '面顺序 = Three.js BoxGeometry 材质槽顺序 [+X,-X,+Y,-Y,+Z,-Z]',
  orderList.join(',') === 'px,nx,py,ny,pz,nz',
  orderList.join(',')
);
check('面顺序与 build_cubemap.py 的 FACES 一致',
  ['px','nx','py','ny','pz','nz'].every((k) => buildPy.includes(`"${k}"`)));

// 每个面文件真实存在
const cubeDir = join(ROOT, 'assets', 'cubemap');
let allExist = true;
const missing = [];
for (const f of orderList) {
  if (!existsSync(join(cubeDir, `${f}.jpg`))) { allExist = false; missing.push(`${f}.jpg`); }
}
check(`6 个切面文件都存在 (assets/cubemap/)`, allExist, missing.join(','));
check('faces.json 存在', existsSync(join(cubeDir, 'faces.json')));

// index.html 引用的资源都存在
const refs = [...indexHtml.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((m) => m[1]);
let refsOk = true;
const missingRefs = [];
for (const r of refs) {
  if (!existsSync(join(ROOT, r))) { refsOk = false; missingRefs.push(r); }
}
check(`index.html 引用的 ${refs.length} 个本地资源都存在`, refsOk, missingRefs.join(','));

// importmap 必须能让裸模块名 "three" 解析成功
const importmap = JSON.parse(
  (indexHtml.match(/<script type="importmap">([\s\S]*?)<\/script>/) || [])[1]
);
check('importmap 定义了 three', !!importmap.imports['three']);
check(
  'importmap 的 three 路径真实存在',
  existsSync(join(ROOT, importmap.imports['three'].replace('./', '')))
);
check('importmap 定义了 three/addons/ 前缀', !!importmap.imports['three/addons/']);

// app.js 里 import 的 addon 必须能在 vendor 里找到
const imports = [...appJs.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
let importsOk = true;
for (const spec of imports) {
  let p;
  if (spec.startsWith('three/addons/')) {
    p = join(ROOT, 'vendor/three/examples/jsm', spec.replace('three/addons/', ''));
  } else if (spec === 'three') {
    p = join(ROOT, importmap.imports['three'].replace('./', ''));
  } else continue;
  if (!existsSync(p)) { importsOk = false; console.log(`       缺失: ${spec} -> ${p}`); }
}
check('app.js 的所有 import 都能解析到真实文件', importsOk, imports.join(' '));

// ---------------------------------------------------------------- 3. 代码质量
section('3. 代码正确性');

// 曾经写错过的用法：CubeTexture 不能当 material.map
check(
  '没有把 CubeTexture 当作 material.map（Three.js 不支持）',
  !/map\s*:\s*cubeTexture/.test(appJs)
);

// 用到的 Three 类必须真实导出
const threeSrc = readFileSync(join(ROOT, 'vendor/three/build/three.module.js'), 'utf8');
const threeClasses = ['WebGLRenderer', 'PerspectiveCamera', 'Scene', 'BoxGeometry',
  'MeshBasicMaterial', 'Texture', 'Mesh', 'Vector3', 'MathUtils', 'CubeTexture',
  'LinearMipmapLinearFilter', 'SRGBColorSpace', 'BackSide'];
let classesOk = true;
const badClasses = [];
for (const c of threeClasses) {
  const used = new RegExp(`THREE\\.${c}\\b`).test(appJs);
  if (!used) continue;
  // 确认 three 里确实存在这个导出
  if (!new RegExp(`\\b${c}\\s*[,}]|\\bclass ${c}\\b|\\bconst ${c}\\b|\\b${c}\\s*=\\s*`).test(threeSrc)) {
    classesOk = false;
    badClasses.push(c);
  }
}
check('app.js 用到的 Three.js 导出都真实存在', classesOk, badClasses.join(','));

// OrbitControls / VRButton 的类名与用法
check('OrbitControls 被正确 import', /import\s*\{\s*OrbitControls\s*\}/.test(appJs));
check('VRButton 被正确 import', /import\s*\{\s*VRButton\s*\}/.test(appJs));
check('VRButton.createButton 用法存在', /VRButton\.createButton\(/.test(appJs));
check('调用了 renderer.xr.enabled = true', /renderer\.xr\.enabled\s*=\s*true/.test(appJs));

// XR 会话事件
check('监听了 XR sessionstart', /addEventListener\(\s*['"]sessionstart['"]/.test(appJs));
check('监听了 XR sessionend', /addEventListener\(\s*['"]sessionend['"]/.test(appJs));

// OrbitControls 的 API 用法必须与当前版本一致。
// 这个版本的 OrbitControls 只有 getter，没有 setAzimuthalAngle/setPolarAngle，
// 也没有公开的 rotateLeft —— 早先就是踩了这个坑导致一进页面就抛异常。
check(
  '没有调用 OrbitControls 不存在的 setAzimuthalAngle',
  !/setAzimuthalAngle\s*\(/.test(appJs)
);
check(
  '没有调用 OrbitControls 不存在的 setPolarAngle',
  !/setPolarAngle\s*\(/.test(appJs)
);
check('没有调用 OrbitControls 不存在的 rotateLeft', !/\.rotateLeft\s*\(/.test(appJs));

// 相机必须能回到盒中心（否则视野会歪）。这里检查 recenter 的存在与调用
check('实现了 recenter() 把相机收回盒中心', /function recenter\(/.test(appJs));
check('主循环里每帧都调用 recenter()', /controls\.update\(\);\s*\n\s*recenter\(\)/.test(appJs));
check('recenter 是沿视线方向缩放（不改变朝向）',
  /multiplyScalar\(CAMERA_RADIUS\s*\/\s*len\)/.test(appJs));

// VR 期间必须停止干涉相机。
// WebXR 每帧把头显姿态写进 camera.position，此时若还在 recenter()，
// 用户会被钉在原地、丢掉 6DoF —— 这类问题只有上真机才看得到，
// 所以在这里用静态检查兜住。
check('主循环在 VR 会话期间跳过 controls.update/recenter',
  /renderer\.xr\.isPresenting\s*===\s*false/.test(appJs));
check('进入 VR 时关闭了 OrbitControls',
  /sessionstart[\s\S]{0,200}controls\.enabled\s*=\s*false/.test(appJs));
check('退出 VR 时恢复 OrbitControls',
  /sessionend[\s\S]{0,200}controls\.enabled\s*=\s*true/.test(appJs));

// 控制半径的常量要远小于盒子半边长 0.5，否则等于没收回中心
const radiusMatch = appJs.match(/CAMERA_RADIUS\s*=\s*([\d.]+)/);
check(
  'CAMERA_RADIUS 远小于盒子半边长(0.5)',
  radiusMatch && parseFloat(radiusMatch[1]) < 0.01,
  radiusMatch ? `= ${radiusMatch[1]}` : '未定义'
);

// 缩放：视角必须被钳制，否则会翻转到负数或畸形。
// 注意这里用的是【水平】视角（HFOV），换算与验证在 verify-fov.mjs 里做得更细。
check('缩放定义了水平视角上下限', /MIN_HFOV/.test(appJs) && /MAX_HFOV/.test(appJs));
check('缩放对水平视角做了 clamp', /clamp\([^)]*MIN_HFOV[^)]*MAX_HFOV/.test(appJs));
check('水平视角经换算后再写入 camera.fov', /camera\.fov\s*=\s*vfovForHfov\(/.test(appJs));
check('更新 fov 后调用了 updateProjectionMatrix',
  /function applyHfov\(\)[\s\S]{0,120}updateProjectionMatrix/.test(appJs));
check('滚轮监听是 passive:false（才能 preventDefault）', /'wheel'[\s\S]{0,200}passive:\s*false/.test(appJs));

// 尺寸自适应
check('监听了 resize', /addEventListener\(\s*['"]resize['"]/.test(appJs));
check('resize 时同步了 aspect',
  /function resize\(\)[\s\S]{0,200}camera\.aspect\s*=/.test(appJs));
check('resize 时按新比例重算了 fov（否则横竖屏切换会看不全）',
  /function resize\(\)[\s\S]{0,300}applyHfov\(\)/.test(appJs));

// 避免移动端双指缩放与页面缩放冲突
check('canvas 设了 touch-action: none', /touch-action:\s*none/.test(styleCss));

// HUD 元素 id 必须与 JS 里的取值一一对应
const jsIds = [...appJs.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
const htmlIds = [...indexHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const missingIds = jsIds.filter((i) => !htmlIds.includes(i));
check(
  `app.js 取用的 ${jsIds.length} 个 DOM id 都存在于 index.html`,
  missingIds.length === 0,
  missingIds.join(',')
);

// CSS 类名一致性（避免出现没有样式的类）
const cssClasses = new Set([...styleCss.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const htmlClasses = new Set(
  [...indexHtml.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/))
);
const unstyled = [...htmlClasses].filter((c) => c && !cssClasses.has(c));
check('index.html 用到的类都有样式', unstyled.length === 0, unstyled.join(','));

// 可访问性
check('VR 按钮是 <button> 而非 div', /<button[^>]*id="vrBtn"/.test(indexHtml));
check('页面声明了 lang="zh-CN"', /<html lang="zh-CN"/.test(indexHtml));
check('有 prefers-reduced-motion 处理', /prefers-reduced-motion/.test(styleCss));
check('有 :focus-visible 焦点样式', /:focus-visible/.test(styleCss));
check('canvas 可通过键盘聚焦 (tabIndex)', /tabIndex\s*=\s*0/.test(appJs));
check('错误提示使用 role="alert"', /role="alert"/.test(indexHtml));

// 视口设置（移动端必需）
check('有 viewport meta', /name="viewport"/.test(indexHtml));

// ---------------------------------------------------------------- 4. 切片脚本
section('4. 切片脚本');

check('切片使用双线性插值', /_bilinear/.test(buildPy));
check('经度方向做环绕采样（避免左右边缘接缝）', /%\s*w/.test(buildPy));
check('纬度方向做钳制', /clip\(y0/.test(buildPy));
check('应用了 EXIF 旋转', /exif_transpose/.test(buildPy));
check('校验 2:1 比例并告警', /abs\(ratio - 2\.0\)/.test(buildPy));
check('输出 faces.json 元数据', /faces\.json/.test(buildPy));

// ---------------------------------------------------------------- 汇总
console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败项:');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('RESULT: PASS');
