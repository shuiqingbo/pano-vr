/**
 * 预览页逻辑：拉项目数据、驱动场景切换。
 *
 * 与 app.js 的分工：
 *   app.js  负责渲染（Three.js、相机、VR）
 *   本文件  负责数据（项目、场景列表）与切换交互
 *
 * 两边的交接点是 window.__PANO_READY__：一个 Promise，
 * app.js 会 await 它拿到初始场景。这样即使 fetch 比脚本执行慢，
 * 也不会出现"先按默认场景渲染、再闪一下换成真场景"。
 */

const FACE_META = '2048² 面 · 6 面';

const el = {
  scenes: document.getElementById('scenes'),
  loadbar: document.getElementById('loadbar'),
  loadbarFill: document.getElementById('loadbarFill'),
  err: document.getElementById('err'),
};

const path = location.pathname;

/** 从 URL 里拿项目 id */
function projectId() {
  const m = path.match(/^\/p\/([0-9a-f]{8})$/);
  return m ? m[1] : null;
}

/** URL 里的 ?scene= 指定初始场景 */
function wantedScene() {
  return new URLSearchParams(location.search).get('scene');
}

function showError(html) {
  el.err.innerHTML = html;
  el.err.hidden = false;
  document.getElementById('boot')?.classList.add('boot--done');
}

async function fetchProject(pid) {
  const r = await fetch(`/api/projects/${pid}`);
  if (r.status === 404) throw new Error('项目不存在，可能已被删除');
  if (!r.ok) throw new Error(`读取项目失败（HTTP ${r.status}）`);
  return r.json();
}

/* ---------------- 场景切换条 ---------------- */

let currentSlug = null;

/**
 * 预热某个场景的 6 个面，只为了填满 HTTP 缓存。
 * 创建完 Image 不留引用 —— 解码后的像素会被浏览器回收，
 * 留在缓存里的是压缩后的字节，所以不会吃内存。
 */
function prefetch(base) {
  for (const f of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) {
    const img = new Image();
    img.decoding = 'async';
    img.src = `${base}/${f}.jpg`;
  }
}

function buildScenes(meta, onPick) {
  const scenes = meta.scenes || [];
  if (scenes.length <= 1) {
    el.scenes.hidden = true;
    return;
  }
  el.scenes.hidden = false;
  el.scenes.innerHTML = '';

  for (const s of scenes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'scene-chip';
    btn.dataset.slug = s.slug;

    const img = document.createElement('img');
    img.className = 'scene-chip__img';
    img.loading = 'lazy';
    img.alt = '';
    img.src = `${s.base}/preview.jpg`;
    btn.appendChild(img);

    const label = document.createElement('span');
    label.className = 'scene-chip__label';
    label.textContent = s.name;
    btn.appendChild(label);

    btn.addEventListener('click', () => onPick(s));
    el.scenes.appendChild(btn);
  }
  markActive(currentSlug);
}

function markActive(slug) {
  for (const c of el.scenes.querySelectorAll('.scene-chip')) {
    const on = c.dataset.slug === slug;
    c.classList.toggle('scene-chip--active', on);
    c.setAttribute('aria-current', on ? 'true' : 'false');
  }
}

/* ---------------- 启动 ---------------- */

const pid = projectId();

// 先把 Promise 挂上去，app.js 会 await 它
window.__PANO_READY__ = (async () => {
  if (!pid) throw new Error('URL 里没有项目 ID');
  const meta = await fetchProject(pid);
  const scenes = meta.scenes || [];
  if (!scenes.length) throw new Error('这个项目还没有场景');

  const want = wantedScene();
  const first = (want && scenes.find((s) => s.slug === want || s.name === want)) || scenes[0];
  currentSlug = first.slug;

  document.title = `${first.name} · 全景环视`;
  return { name: first.name, dir: first.base, meta: FACE_META };
})();

// 这个 Promise 会被 app.js await；如果它也在这里被 await，
// 需要避免"未处理的 rejection"告警，所以额外挂一个空的 catch。
window.__PANO_READY__.catch(() => {});

// 项目数据拿到后建切换条
/**
 * 等 app.js 把 window.panoViewer 挂上来。
 *
 * 为什么必须等：两个模块都是 type="module"，preview.js 先执行，
 * 它一拿到项目数据就会建场景条 —— 但那时 app.js 还在加载 6 张贴图
 * （11008x5504 切面，好几秒），window.panoViewer 还不存在。
 * 如果不等待，用户点缩略图会直接抛 "Cannot read properties of undefined"。
 */
function waitForViewer(timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (window.panoViewer) return resolve(window.panoViewer);
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (window.panoViewer) {
        clearInterval(timer);
        resolve(window.panoViewer);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error('渲染器初始化超时'));
      }
    }, 100);
  });
}

window.__PANO_READY__.then(async () => {
  const meta = await fetchProject(pid);

  let busy = false;

  /** 顶部进度线：on=false 时收起 */
  function setLoading(on, ratio = 0) {
    if (!el.loadbar) return;
    el.loadbar.hidden = !on;
    if (on) {
      const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
      el.loadbarFill.style.width = pct + '%';
    } else {
      el.loadbarFill.style.width = '0%';
    }
  }

  async function pick(s) {
    if (busy || s.slug === currentSlug) return;
    busy = true;

    // 在缩略图上标记"正在加载"，同时显示进度线。
    // 旧画面继续显示 —— 不再用整屏黑遮罩，否则下载+解码这几百毫秒
    // 到几秒里用户看到的是全黑，像是崩了。
    const chip = [...el.scenes.querySelectorAll('.scene-chip')]
      .find((c) => c.dataset.slug === s.slug);
    chip?.classList.add('scene-chip--loading');
    setLoading(true, 0);
    document.title = `${s.name} · 全景环视`;

    let ok = false;
    try {
      const viewer = await waitForViewer();
      ok = await viewer.loadScene({
        name: s.name,
        base: s.base,
        meta: FACE_META,
        onProgress: (r) => setLoading(true, r),
      });
    } catch (e) {
      showError(`<strong>切换场景失败</strong><br>${e.message}`);
    }

    if (ok) {
      currentSlug = s.slug;
      markActive(s.slug);
      // 把当前场景写进 URL，刷新后还停在这个房间
      const u = new URL(location.href);
      u.searchParams.set('scene', s.slug);
      history.replaceState(null, '', u);
    }

    chip?.classList.remove('scene-chip--loading');
    setLoading(false);
    busy = false;
  }

  // 建切换条：场景数 > 1 才显示
  buildScenes(meta, pick);

  // 预热下一个场景：只把字节灌进浏览器 HTTP 缓存（服务端已设 max-age），
  // 创建的 Image 不保留引用，解出来的像素会被回收，内存不会涨。
  // 这样往下切换基本是"秒开"。
  const scenes = meta.scenes || [];
  let warmTimer = null;
  window.addEventListener('pano:scenechange', (ev) => {
    if (scenes.length < 2) return;
    const idx = scenes.findIndex((x) => x.base === ev.detail.base);
    if (idx < 0) return;
    const next = scenes[(idx + 1) % scenes.length];
    clearTimeout(warmTimer);
    // 等画面稳定一会儿再预热，别和新图抢带宽
    warmTimer = setTimeout(() => prefetch(next.base), 1800);
  });
}).catch((e) => {
  // 错误提示由 app.js 统一负责（它会 await 同一个 Promise），
  // 这里只在 app.js 没能显示时兜底，避免弹出两个错误框。
  const err = document.getElementById('err');
  if (err && err.hidden) showError(`<strong>无法打开项目</strong><br>${e.message}`);
});
