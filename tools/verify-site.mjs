/**
 * 检查工具站的前后端契约与首页逻辑。
 *
 * 覆盖三类最容易出错、又不容易在页面上立刻看出来的问题：
 *   1. 前端用的 DOM id / class 是否和后端给的 HTML 对得上
 *   2. 场景切换的关键约束（不重建 renderer、先 decode 再换）
 *   3. 后端路由与前端请求的路径是否一致
 *
 * 运行： node tools/verify-site.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const section = (t) => console.log(`\n${t}`);

const server = read('tools/server.py');
const adminHtml = read('web/admin.html');
const adminJs = read('web/admin.js');
const prevHtml = read('web/preview.html');
const prevJs = read('web/preview.js');
const appJs = read('app.js');
const prevCss = read('web/preview.css');
const adminCss = read('web/style.css');

/**
 * 去掉 JS 注释后再做"代码里不该出现某种写法"这类断言。
 * 否则注释里举例说明的错误写法本身会把断言判失败。
 */
function stripJsComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    .replace(/(^|[^:])\/\/.*$/gm, '$1');   // 行注释（避开 http://）
}
const appCode = stripJsComments(appJs);

// ---------------------------------------------------------------- 1
section('1. 管理页');

{
  const jsIds = [...adminJs.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  const htmlIds = [...adminHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const missing = jsIds.filter((i) => !htmlIds.includes(i));
  check(`管理页 ${jsIds.length} 个 DOM id 都存在`, missing.length === 0, missing.join(','));

  const htmlClasses = new Set(
    [...adminHtml.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/))
  );
  const jsClasses = new Set(
    [...adminJs.matchAll(/className\s*=\s*['"]([^'"]+)['"]/g)].flatMap((m) => m[1].split(/\s+/))
  );
  const cssClasses = new Set([...adminCss.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const unstyled = [...htmlClasses, ...jsClasses].filter((c) => c && !cssClasses.has(c));
  check('管理页用到的类都有样式', unstyled.length === 0, [...new Set(unstyled)].join(','));

  // 上传走 multipart，且字段名要和后端一致
  check('上传用 FormData', /new FormData\(\)/.test(adminJs));
  const field = adminJs.match(/append\(\s*['"]([^'"]+)['"]/)?.[1];
  check(`上传字段名 "${field}" 与后端一致`, !!field && server.includes(`filename="`), field);
  check('上传字段名在服务端被解析', /filename=/i.test(server));

  check('会轮询任务进度', /\/api\/jobs\//.test(adminJs));
  check('删除调用 DELETE /api/projects/<id>', /method:\s*['"]DELETE['"]/.test(adminJs));
  check('删除前有确认', /confirm\(/.test(adminJs));
  check('列表读取 GET /api/projects', /fetch\(['"]\/api\/projects['"]\)/.test(adminJs));
}

// ---------------------------------------------------------------- 2
section('2. 预览页');

{
  const jsIds = [...prevJs.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  const htmlIds = [...prevHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const missing = jsIds.filter((i) => !htmlIds.includes(i));
  check(`预览页 ${jsIds.length} 个 DOM id 都存在`, missing.length === 0, missing.join(','));

  // app.js 与预览页共用的元素
  const appIds = [...appJs.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  const missingApp = appIds.filter((i) => !htmlIds.includes(i));
  check(`app.js 需要的 ${appIds.length} 个 id 在预览页里都有`, missingApp.length === 0, missingApp.join(','));

  check('从 URL 解析项目 id', /location\.pathname\.match/.test(prevHtml + prevJs));
  check('项目 id 做了格式校验（8 位十六进制）', /\[0-9a-f\]\{8\}/.test(prevJs + prevHtml));

  // 交接点
  check('通过 __PANO_READY__ 把配置交给 app.js', /__PANO_READY__\s*=/.test(prevJs));
  check('app.js 会 await __PANO_READY__', /__PANO_READY__/.test(appJs) && /await\s+window\.__PANO_READY__/.test(appJs));
  check('app.js 暴露了 loadScene', /window\.panoViewer\s*=/.test(appJs) && /loadScene/.test(appJs));
  check('预览页调用 loadScene', /\.loadScene\(/.test(prevJs));

  // 场景切换的关键约束
  check('切换场景不重建 WebGLRenderer',
    !/new THREE\.WebGLRenderer[\s\S]{0,400}loadScene/.test(appJs));
  check('切换时先全部加载完再换上（loadFacesFor 返回后才改 needsUpdate）',
    /const imgs = await loadFacesFor\([\s\S]{0,400}needsUpdate\s*=\s*true/.test(appJs));
  check('切换场景后会归位视角', /resetView\(\)/.test(appJs));
  check('切换有并发保护（busy/lock）', /if\s*\(switching\)\s*return|let\s+busy/.test(appJs + prevJs));

  // 场景切换条
  check('多场景时才显示切换条', /scenes\.length\s*<=\s*1/.test(prevJs));
  check('当前场景有高亮', /scene-chip--active/.test(prevCss) && /markActive/.test(prevJs));
  check('切换后把场景写回 URL', /history\.replaceState/.test(prevJs));
  check('切换条样式存在', /\.scene-chip\b/.test(prevCss));

  // 单场景项目不应显示切换条。
  // 这里踩过坑：UA 样式表的 [hidden]{display:none} 优先级是 (0,1,0)，
  // 和 .scenes{display:flex} 相同 —— 作者样式表会覆盖 UA 样式表，
  // 结果 hidden 属性失效，单场景也会冒出一条空条。
  check('CSS 显式处理 .scenes[hidden]（否则 hidden 属性会失效）',
    /\.scenes\[hidden\]\s*\{[^}]*display:\s*none/.test(prevCss));
  check('单场景隐藏切换条（hidden 属性）', /scenes\.hidden\s*=\s*true/.test(prevJs));

  // 时序：preview.js 先执行并立刻建场景条，而 app.js 还在加载贴图，
  // 那时 window.panoViewer 还不存在。点缩略图必须先等它挂上来。
  check('等待 panoViewer 就绪后才调用 loadScene',
    /waitForViewer/.test(prevJs));
  check('waitForViewer 会轮询等待（不是只查一次）',
    /setInterval[\s\S]{0,400}panoViewer/.test(prevJs));
  check('waitForViewer 有超时保护', /timeoutMs[\s\S]{0,200}reject/.test(prevJs));
  check('pick 里对 loadScene 做了异常保护（不裸调用）',
    /try\s*\{[\s\S]{0,300}waitForViewer[\s\S]{0,300}loadScene/.test(prevJs));
  check('不直接引用 window.panoViewer.loadScene（会 undefined）',
    !/window\.panoViewer\.loadScene\(/.test(prevJs));
}

// ---------------------------------------------------------------- 3
section('3. 服务端路由与安全');

{
  const routes = [
    ['GET  /api/projects', /def do_GET/],
    ['路由含 /api/projects/<id>', /\/api\/projects\/\(\[0-9a-f\]\{8\}\)/],
    ['路由含 /api/jobs/<id>', /\/api\/jobs\/\(\[0-9a-f\]\{8\}\)/],
    ['路由含 /p/<id> 预览页', /\/p\/\[0-9a-f\]\{8\}/],
    ['DELETE 项目', /def do_DELETE/],
    ['POST 上传', /def do_POST/],
  ];
  for (const [name, re] of routes) check(name, re.test(server));

  check('中文路径会先解码再当路径用（否则切面 404）',
    /unquote\(u\.path\)/.test(server));
  check('data 目录做了穿越防护', /is_relative_to\(DATA\.resolve\(\)\)/.test(server));
  check('vendor 目录做了穿越防护', /is_relative_to\(ROOT\.resolve\(\)\)/.test(server));

  // 【重要回归】web/ 下的静态文件必须限定 /web/ 前缀。
  // 早先写成 (WEB / p)，于是 /style.css 被解析成 web/style.css（管理页样式表），
  // 把根目录的查看器样式表遮蔽掉 —— 两个页面的 HUD 和场景切换条全没了
  // （.hud 规则缺失，且 var(--strip) 未定义导致场景条的 bottom 失效）。
  check('web/ 静态文件限定了 /web/ 前缀（防止同名遮蔽）',
    /p\.startswith\("\/web\/"\)/.test(server));
  check('没有裸用 (WEB / p) 这种会遮蔽根目录的写法',
    !/target = \(WEB \/ p\.lstrip/.test(server));
  check('根目录 /style.css 不会被 web/style.css 顶掉',
    /legacy = \(ROOT \/ p\.lstrip\("\/"\)\)\.resolve\(\)/.test(server));
  check('/index.html 仍指向旧版单场景 Demo（不是管理页）',
    !/p in \("\/", "\/index\.html"\)/.test(server));
  check('"/" 单独指向管理页', /if p == "\/":/.test(server));

  // 官方 VR 按钮不能直接设 display:none —— VRButton 内部会 button.style.display=''
  // 把它清掉，结果"VR NOT SUPPORTED"浮在画面中间。要用隐藏容器包住。
  check('官方 VR 按钮用隐藏容器包住（不能被 resize/显示逻辑翻出来）',
    /holder\.style\.display = 'none'/.test(appJs) &&
    /holder\.appendChild\(official\)/.test(appJs));
  check('没有对官方按钮直接设 display:none（会被 VRButton 清掉）',
    !/official\.style\.display\s*=\s*'none'/.test(appCode));

  // 罗盘读数取模，避免出现 360°
  check('罗盘读数对 360 取模（不显示 360°）',
    /Math\.round\(deg\)\s*%\s*360/.test(appCode));
  check('默认只监听 127.0.0.1', /default="127\.0\.0\.1"/.test(server));
  check('上传校验 2:1 比例', /abs\(ratio - 2\.0\)/.test(server));
  check('上传限制像素总量', /MAX_PIXELS/.test(server));
  check('上传限制文件大小', /MAX_UPLOAD_BYTES/.test(server));
  check('限制扩展名白名单', /ALLOWED_EXT/.test(server));

  check('切片在后台线程执行（不阻塞请求）', /threading\.Thread/.test(server));
  check('同一时间只切一张图（防内存爆）', /_slice_lock/.test(server));
  check('失败会回滚半成品项目', /state="error"[\s\S]{0,400}rmtree/.test(server));
  check('索引写入是原子的（先写 tmp 再 replace）', /\.replace\(PROJECTS_FILE\)/.test(server));
  check('pending 状态会被清除', /pending=False/.test(server));
  check('场景名会被清理（去掉"拷贝"等）', /def clean_scene_name/.test(server));
  check('slug 会去重', /def slugify/.test(server) && /while s in used/.test(server));
}

// ---------------------------------------------------------------- 4
section('4. 前端资源');

{
  check('预览页 importmap 指向本地 Three.js', /\/vendor\/three\/build\/three\.module\.js/.test(prevHtml));
  check('管理页不依赖 Three.js', !/three/i.test(adminHtml));
  check('预览页有两个样式表', /style\.css/.test(prevHtml) && /preview\.css/.test(prevHtml));
  // 【重要回归】切换场景时不能整屏变黑。
  // 早先用一个 inset:0 的近黑遮罩做"过渡"，而切场景要下载并解码 6 张 2048² 的图，
  // 这期间整屏全黑（连 HUD 一起盖住），看起来像崩了。
  // 现在换成顶部一条细进度线，旧画面始终可见。
  check('用顶部进度线而不是整屏遮罩',
    /id="loadbar"/.test(prevHtml) && /\.loadbar\b/.test(prevCss));
  check('没有整屏黑色遮罩',
    !/class="fade"/.test(prevHtml) && !/\.fade--on/.test(prevCss));
  check('进度线显式处理 hidden（否则 UA 样式被覆盖）',
    /\.loadbar\[hidden\]\s*\{[^}]*display:\s*none/.test(prevCss));
  check('切换时显示真实进度（onProgress 回调）',
    /onProgress:\s*\(r\)\s*=>/.test(prevJs) &&
    /function loadFacesFor\(base, onProgress\)/.test(appJs));
  check('进度线层级高于画面（z-index ≥ 3）',
    /\.loadbar\s*\{[\s\S]{0,140}z-index:\s*[3-9]/.test(prevCss));
  check('正在加载的缩略图有标记样式',
    /scene-chip--loading/.test(prevCss) && /scene-chip--loading/.test(prevJs));

  // 切换前先 decode，避免换上贴图时还在解码导致闪白/闪黑
  check('切换前先 img.decode() 再换贴图', /await img\.decode\(\)/.test(appJs));
  check('decode 失败不会中断切换（有 try/catch）',
    /try\s*\{[\s\S]{0,80}await img\.decode\(\)[\s\S]{0,80}\}\s*catch/.test(appJs));
  check('贴图是 6 个面一次换完（同一帧，不会逐个刷）',
    /faceTextures\.forEach\([\s\S]{0,140}tex\.needsUpdate\s*=\s*true/.test(appJs));

  // 预热：往下切更快
  check('切换后会预热下一个场景（填 HTTP 缓存）',
    /function prefetch\(/.test(prevJs) && /prefetch\(next\.base\)/.test(prevJs));
  check('预热不保留 Image 引用（避免吃内存）',
    /function prefetch\(base\)[\s\S]{0,260}img\.src\s*=/.test(prevJs));
  check('尊重 prefers-reduced-motion', /prefers-reduced-motion/.test(prevCss) && /prefers-reduced-motion/.test(adminCss));
  check('管理页支持键盘操作拖放区', /tabindex="0"/.test(adminHtml));
  check('错误提示有 role="alert"', /role="alert"/.test(prevHtml));

  // 不再引用会被删掉的东西
  check('没有引用已删除的 verify.py', !/tools\/verify\.py/.test(server + adminJs + prevJs));
  check('没有引用已删除的 selftest.html', !/selftest/.test(server + adminJs + prevJs));
}

// ---------------------------------------------------------------- 5
section('5. 文件完整性');

{
  const needed = [
    'tools/server.py', 'tools/check-seams.py', 'tools/run-checks.sh',
    'web/admin.html', 'web/admin.js', 'web/style.css',
    'web/preview.html', 'web/preview.js', 'web/preview.css',
    'app.js', 'style.css', 'build_cubemap.py',
    'vendor/three/build/three.module.js',
    'vendor/three/examples/jsm/controls/OrbitControls.js',
    'vendor/three/examples/jsm/webxr/VRButton.js',
  ];
  const missing = needed.filter((f) => !existsSync(join(ROOT, f)));
  check(`${needed.length} 个必需文件都存在`, missing.length === 0, missing.join(','));

  // 旧的 serve.py 已被 server.py 取代
  check('旧的 tools/serve.py 已移除（由 server.py 取代）',
    !existsSync(join(ROOT, 'tools/serve.py')));
  check('README 提到新的启动方式', /tools\/server\.py/.test(read('README.md')));
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('RESULT: PASS');
