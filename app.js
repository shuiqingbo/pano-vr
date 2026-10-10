/**
 * 全景环视 —— Three.js 立方体贴图查看器
 *
 * 用一个内表面朝里的立方体盒子显示 6 个面。相机放在盒中心，
 * 因此无论看向哪里，看到的都是全景图对应方向的内容。
 *
 * 场景来源有两个：
 *   1. 页面注入的 window.__PANO__：{ name, dir, meta }（单场景 Demo）
 *   2. 通过 window.panoViewer.loadScene({ name, base }) 切换（多场景项目）
 *
 * 交互：
 *   - 拖动 / 单指滑 ：环视（OrbitControls，锁定在球面上）
 *   - 滚轮 / 双指   ：缩放（改变相机视场角 FOV，不是移动相机）
 *   - 双击          ：回到初始朝向
 *   - WebXR         ：进入 VR，头显里用 6DoF 环顾
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';

// 立方体贴图 6 个面的加载顺序必须与 THREE.CubeTexture 的约定一致：
// +X, -X, +Y, -Y, +Z, -Z —— 正好是 build_cubemap.py 输出的文件名顺序。
const FACE_ORDER = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

// 默认场景（没有外部注入时用）
const DEFAULT_SCENE = {
  name: '客厅',
  dir: './assets/cubemap',
  meta: '2048² 面 · 6 面',
};

// ---------- 视场角 ----------
//
// 注意 Three.js 的 camera.fov 是【垂直】视场角，水平角度会被 aspect 放大。
// 所以同一个 fov 在宽屏上看到的多、在竖屏手机上看到的极少
// （竖屏 390x844 时垂直 75° 只有约 39° 的水平视野，等于一条缝）。
//
// 因此这里改成用【水平】视角来定义，再按当前 aspect 反算垂直 fov。
// 这样无论屏幕什么比例，"一眼能看到多宽"都是一致的。
const START_HFOV = 110;  // 默认水平视角，接近人眼含余光的范围
const MIN_HFOV = 40;     // 拉近（放大）
const MAX_HFOV = 140;    // 推远（缩小）

// 垂直视角的安全上限：超过 ~120° 边缘会明显拉伸变形
const MAX_VFOV = 120;

// ---------- 初始俯仰角 ----------
//
// 相机在全景球的球心，pitch 就是"视线相对水平线的高低"。
//
// 为什么不是 0：全景图里 lat=0 是水平线，而真实房间中
//   天花板大约在 lat > +45°，地板在 lat < -45°，
//   真正有内容的主体（墙、家具、灯）集中在 lat 0° ~ -20°。
// 对 room 全景图实测（餐厅那张）：结构最密集的位置在 lat 0°~-22°，
// 而 +45° 以上几乎是平坦的吊顶。
// 所以 pitch=0 会把上半屏浪费在天花板上，主体被挤到中间偏下，
// 看起来就是"视角太高"。
//
// 略微向下看 -10°，主体就落到画面中心，天花板只占顶部一条。
const START_PITCH_DEG = -10;

/** 由水平视角和画面比例算出 Three.js 需要的垂直 fov（弧度转度） */
function vfovForHfov(hfovDeg, aspect) {
  const h = (hfovDeg * Math.PI) / 180;
  const v = 2 * Math.atan(Math.tan(h / 2) / aspect);
  return Math.min((v * 180) / Math.PI, MAX_VFOV);
}

// 俯仰角上限，留出余量，避免正对天顶/地面时方向退化
const PITCH_LIMIT = Math.PI / 2 - 0.02;

// OrbitControls 在正常半径上工作，之后相机被收回这个极小半径处。
// 只要远小于盒子半边长（0.5），视觉效果就是"站在盒中心"。
const CAMERA_RADIUS = 0.001;

// 世界坐标的"上"，键盘环视用
const UP = new THREE.Vector3(0, 1, 0);

const el = {
  canvas: document.getElementById('view'),
  boot: document.getElementById('boot'),
  bootFill: document.getElementById('bootFill'),
  sceneName: document.getElementById('sceneName'),
  sceneMeta: document.getElementById('sceneMeta'),
  compassNeedle: document.getElementById('compassNeedle'),
  compassDeg: document.getElementById('compassDeg'),
  vrBtn: document.getElementById('vrBtn'),
  err: document.getElementById('err'),
};

/** 8 个方位的中文读数，用于罗盘 */
const BEARINGS = [
  [0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
  [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'],
];

function showError(html) {
  el.err.innerHTML = html;
  el.err.hidden = false;
  el.boot.classList.add('boot--done');
}

function setProgress(ratio) {
  el.bootFill.style.width = `${Math.round(ratio * 100)}%`;
}

/**
 * 带进度地加载 6 个面。
 * CubeTextureLoader 不报进度，所以自己用 Image + Promise 数数，
 * 这样大图加载时进度条是真实的。
 */
function loadFaceImages(dir, onProgress) {
  let done = 0;
  return Promise.all(
    FACE_ORDER.map(
      (face) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.decoding = 'async';
          img.onload = () => {
            done += 1;
            onProgress(done / FACE_ORDER.length);
            resolve(img);
          };
          img.onerror = () => reject(new Error(`切面加载失败：${dir}/${face}.jpg`));
          img.src = `${dir}/${face}.jpg`;
        })
    )
  );
}

async function main() {
  // 场景来源有三条路，优先级从高到低：
  //   1. window.__PANO_READY__：一个 Promise，resolve 出 { name, dir }
  //      （预览页要先用 fetch 拉项目数据，所以给出这个口子）
  //   2. window.__PANO__：直接注入的对象（单场景 Demo）
  //   3. 内置默认场景
  let initial = { ...DEFAULT_SCENE };
  try {
    if (window.__PANO_READY__) {
      const cfg = await window.__PANO_READY__;
      if (cfg) initial = { ...initial, ...cfg };
    } else if (window.__PANO__) {
      initial = { ...initial, ...window.__PANO__ };
    }
  } catch (e) {
    showError(`<strong>无法读取项目</strong><br>${e.message}`);
    return;
  }

  el.sceneName.textContent = initial.name;
  el.sceneMeta.textContent = initial.meta || DEFAULT_SCENE.meta;

  // ---------- 渲染器 ----------
  const renderer = new THREE.WebGLRenderer({
    canvas: el.canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.xr.enabled = true;

  const scene = new THREE.Scene();

  // ---------- 相机 ----------
  // 相机固定在盒中心，只改变朝向；缩放靠调整 FOV 实现，
  // 这样不会穿出全景盒，也不会产生透视畸变。
  const aspect0 = window.innerWidth / window.innerHeight;
  const camera = new THREE.PerspectiveCamera(
    vfovForHfov(START_HFOV, aspect0),
    aspect0,
    0.1,
    100
  );
  camera.position.set(0, 0, 0);

  // ---------- 贴图 ----------
  setProgress(0.05);
  let images;
  try {
    images = await loadFaceImages(initial.dir, (r) => setProgress(0.05 + r * 0.9));
  } catch (e) {
    showError(
      `<strong>无法载入立方体贴图</strong><br>` +
        `${e.message}<br><br>` +
        `请确认已切好 6 个面，并且通过 HTTP 服务打开此页（<code>file://</code> 会被浏览器拦截）。` +
        `在项目目录运行 <code>python3 tools/server.py</code> 后访问 ` +
        `<code>http://127.0.0.1:8000</code>。`
    );
    return;
  }

  // 每个面用一张独立的普通 Texture。
  // 注意：不能用 CubeTexture 配 material.map —— CubeTexture 只在
  // scene.background / material.envMap 下有效，当成 map 用只会得到纯色。
  // 这里 6 个面各一张 Texture，语义直接、也便于单独替换某个面（切换场景就靠它）。
  const faceTextures = images.map((img) => {
    const t = new THREE.Texture(img);
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    t.needsUpdate = true;
    return t;
  });

  // BoxGeometry 自带 6 个 group，材质槽顺序是 [+X, -X, +Y, -Y, +Z, -Z]，
  // 与 FACE_ORDER 完全一致，所以按下标一一对应即可。
  const materials = faceTextures.map(
    (tex) =>
      new THREE.MeshBasicMaterial({
        map: tex,
        side: THREE.BackSide, // 从盒子内部看
        toneMapped: false,    // 全景图已是最终显示效果，不要再做色调映射
      })
  );

  const skybox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), materials);
  // 盒子固定不动，也不参与视锥剔除的判断
  skybox.frustumCulled = false;
  scene.add(skybox);

  // ---------- 控制 ----------
  //
  // 相机必须待在立方体中心，否则环视会变成"绕着某点转"，视野会歪。
  //
  // 做法：让 OrbitControls 照常用自己的逻辑绕 target 转相机（手感、阻尼、
  // 触摸支持都由它保证），但每帧把相机位置沿原方向缩到极小半径上。
  // 缩放是沿视线方向做的，所以朝向完全不变，相机却回到了盒中心。
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.enableZoom = false;     // 缩放由下面的 FOV 逻辑处理
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.rotateSpeed = 0.42;
  // 允许 controls 在正常半径上工作，最后我们再把它收回来
  controls.minDistance = 0.5;
  controls.maxDistance = 0.5;
  controls.target.set(0, 0, 0);

  /**
   * 把相机摆到"看向 +Z、俯仰 pitchDeg"的位置。
   *
   * 注意 OrbitControls 的几何：相机停在 target 外侧，视线 = target - 相机位置。
   * 所以相机 y 越低，视线越往上；要让视线向下看 pitchDeg（负值），
   * 相机反而要**抬高**，取 y = -r*sin(pitch)。
   */
  function setInitialOrientation() {
    const p = (START_PITCH_DEG * Math.PI) / 180;
    const r = controls.maxDistance;
    camera.position.set(
      0,
      -r * Math.sin(p),         // 视线向下 => 相机在上方（符号不能反）
      -r * Math.cos(p)          // 落在 -Z 侧 => 看向 +Z
    );
    controls.target.set(0, 0, 0);
    controls.update();
    recenter();
  }

  /** 把相机沿当前视线方向收回盒中心（方向不变） */
  function recenter() {
    const len = camera.position.length();
    if (len > CAMERA_RADIUS) {
      camera.position.multiplyScalar(CAMERA_RADIUS / len);
    }
  }

  setInitialOrientation();

  // ---------- 缩放：改 FOV ----------
  //
  // 内部用一个"当前水平视角"作为唯一状态，任何地方都只改它，
  // 再统一换算成 camera.fov。这样缩放的上限下限在不同屏幕上含义一致。
  const canvas = renderer.domElement;
  let hfov = START_HFOV;

  function applyHfov() {
    camera.fov = vfovForHfov(hfov, camera.aspect);
    camera.updateProjectionMatrix();
  }

  function zoomBy(factor) {
    const next = THREE.MathUtils.clamp(hfov * factor, MIN_HFOV, MAX_HFOV);
    if (next === hfov) return;
    hfov = next;
    applyHfov();
  }

  // 双击归位：视角与朝向都回到初始状态。
  // 复用 setInitialOrientation，避免两处各写一份导致以后改动不同步。
  function resetView() {
    hfov = START_HFOV;
    applyHfov();
    setInitialOrientation();
  }

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // deltaY > 0 表示向下滚 = 推远 = 视角变大
      zoomBy(e.deltaY > 0 ? 1.055 : 1 / 1.055);
    },
    { passive: false }
  );

  // 双指捏合
  let pinchStart = null;
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinchStart = {
        dist: touchDistance(e.touches),
        hfov,
      };
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchStart) {
      e.preventDefault();
      const ratio = pinchStart.dist / touchDistance(e.touches);
      hfov = THREE.MathUtils.clamp(pinchStart.hfov * ratio, MIN_HFOV, MAX_HFOV);
      applyHfov();
    }
  }, { passive: false });

  canvas.addEventListener('touchend', () => { pinchStart = null; }, { passive: true });

  function touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy) || 1;
  }

  canvas.addEventListener('dblclick', resetView);

  // 键盘可达性：方向键环视，+/- 缩放。
  // 做法是把相机放在目标方向上，再交给 recenter 收回中心。
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', (e) => {
    const step = 0.1;
    const dir = camera.position.clone().normalize();
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':  dir.applyAxisAngle(UP, step); break;
      case 'ArrowRight': dir.applyAxisAngle(UP, -step); break;
      case 'ArrowUp':    pitchStep(step); handled = false; break;
      case 'ArrowDown':  pitchStep(-step); handled = false; break;
      case '=': case '+': zoomBy(1 / 1.12); handled = false; break;
      case '-': case '_': zoomBy(1.12); handled = false; break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      camera.position.copy(dir.multiplyScalar(controls.maxDistance));
      controls.update();
      recenter();
    }
  });

  function pitchStep(amount) {
    // 绕水平轴抬高/降低视角，并夹住俯仰角避免越过极点
    const dir = camera.position.clone().normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(dir, up).normalize();
    if (right.lengthSq() < 1e-6) return;   // 正对天顶/地面时不做
    const next = dir.clone().applyAxisAngle(right, amount);
    // 限制俯仰在 ±PITCH_LIMIT 内
    const p = Math.asin(THREE.MathUtils.clamp(next.y, -1, 1));
    if (Math.abs(p) > PITCH_LIMIT) return;
    camera.position.copy(next.multiplyScalar(controls.maxDistance));
    controls.update();
    recenter();
  }

  // ---------- WebXR ----------
  setupXR(renderer, scene, camera, controls, applyHfov);

  // ---------- 罗盘 HUD ----------
  // 把相机朝向换算成 0-360° 的方位角。
  // 相机默认朝 -Z；我们让 +Z 视作正北，因此方位角 = atan2(-x, -z) 的补角。
  const tmpDir = new THREE.Vector3();
  let hudTick = 0;

  function updateCompass() {
    camera.getWorldDirection(tmpDir);
    // 把 +Z 视作正北：视线朝 +Z 时读数为 0°
    let deg = THREE.MathUtils.radToDeg(Math.atan2(tmpDir.x, tmpDir.z));
    if (deg < 0) deg += 360;
    // 取模：359.7° 四舍五入会得到 360，读起来像"第 361 度"，
    // 应该是 0°（正北）。
    const rounded = Math.round(deg) % 360;
    el.compassDeg.textContent = `${rounded}°`;
    // 就近取方位缩写
    let best = BEARINGS[0];
    let bestDiff = 999;
    for (const [d, label] of BEARINGS) {
      const diff = Math.min(Math.abs(d - rounded), 360 - Math.abs(d - rounded));
      if (diff < bestDiff) { bestDiff = diff; best = [d, label]; }
    }
    el.compassNeedle.textContent = best[1];
  }

  // ---------- 尺寸 ----------
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    // 画面比例变了要重算垂直 fov：否则手机从横屏转到竖屏后，
    // 水平视野会被 aspect 挤压成很窄的一条（这是"看不全"的根因之一）。
    applyHfov();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, false);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  resize();

  // ---------- 主循环 ----------
  renderer.setAnimationLoop(() => {
    // 注意：进入 VR 后不能再调用 controls.update() / recenter()。
    // WebXR 每帧会把头显的姿态直接写进 camera.position / quaternion，
    // 此时再去收相机位置会跟头显打架，把用户"钉"在原地、丢掉 6DoF。
    if (renderer.xr.isPresenting === false) {
      controls.update();
      recenter();
    }

    // HUD 不需要每帧刷新，隔几帧更新一次省一点开销
    if ((hudTick = (hudTick + 1) % 6) === 0) updateCompass();
    renderer.render(scene, camera);
  });

  // 首帧渲染完再淡出遮罩，避免出现黑屏一闪
  requestAnimationFrame(() => {
    setProgress(1);
    setTimeout(() => el.boot.classList.add('boot--done'), 220);
  });

  // ---------- 场景切换 ----------
  //
  // 关键：切换场景只换贴图，绝不重建 WebGLRenderer。
  // 重建会闪黑、丢上下文、VR 会话也会断掉。
  //
  // 另外要先把 6 张图全部 decode 完再一起换上，
  // 否则会看到 6 个面陆续刷新（明显的"马赛克感"）。
  let switching = false;

  /**
   * 加载某个场景的 6 个面，并确保像素已解码。
   *
   * 为什么要显式 decode()：Image 的 onload 只表示"数据到了"，
   * 像素可能还没解好。此时就把贴图换上，GPU 上传会触发一次同步解码，
   * 画面会短暂出现空白/黑块。先 decode 完再换，切换就是一步到位。
   *
   * @param onProgress 回调 (0..1)，用于显示进度条
   */
  async function loadFacesFor(base, onProgress) {
    let done = 0;
    return Promise.all(
      FACE_ORDER.map(async (f) => {
        const img = new Image();
        const loaded = new Promise((resolve, reject) => {
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error(`切面加载失败：${base}/${f}.jpg`));
        });
        img.src = `${base}/${f}.jpg`;
        await loaded;

        // decode 失败不致命（老浏览器没有这个方法，或图片已损坏），忽略即可
        try {
          await img.decode();
        } catch {
          /* 忽略 */
        }

        done += 1;
        if (onProgress) onProgress(done / FACE_ORDER.length);
        return img;
      })
    );
  }

  async function loadScene({ name, base, meta, onProgress }) {
    // 切换过程中忽略新的请求，返回 false 让调用方知道没执行
    if (switching) return false;
    switching = true;
    try {
      const imgs = await loadFacesFor(base, onProgress);

      // 全部就绪，一次性换上（同一帧内完成，画面不会中途露出旧内容）
      faceTextures.forEach((tex, i) => {
        tex.image = imgs[i];
        tex.needsUpdate = true;
      });

      if (name) el.sceneName.textContent = name;
      if (meta) el.sceneMeta.textContent = meta;

      // 换场景时回到初始朝向，避免上一个房间的视角带过来
      resetView();

      window.dispatchEvent(
        new CustomEvent('pano:scenechange', { detail: { name, base } })
      );
      return true;
    } catch (e) {
      showError(`<strong>切换场景失败</strong><br>${e.message}`);
      return false;
    } finally {
      switching = false;
    }
  }

  // 暴露给预览页（textures 也一并给出，便于自动化测试断言切换是否真的换了贴图）
  window.panoViewer = { loadScene, resetView, camera, renderer, textures: faceTextures };
}

/**
 * WebXR：有 VR 设备时挂上 Three.js 官方的进入 VR 按钮。
 * 进入 VR 后由头显提供 6DoF 视角，此时关掉鼠标控制器，
 * 让头显的姿态成为唯一输入源。
 */
function setupXR(renderer, scene, camera, controls, applyHfov) {
  const xr = navigator.xr;

  if (!xr) {
    // 没有 WebXR（例如桌面 Chrome 未接设备、或非安全上下文）
    el.vrBtn.hidden = false;
    el.vrBtn.disabled = true;
    el.vrBtn.textContent = '此浏览器不支持 WebXR';
    el.vrBtn.title = 'WebXR 需要在 HTTPS 或 localhost 下运行，并连接 VR 设备';
    return;
  }

  // 借用官方按钮的会话逻辑，但不让它显示 —— 我们自己有一个样式统一的按钮。
  //
  // 注意不能直接设 official.style.display = 'none'：
  // VRButton 内部的 showEnterVR/showVRNotFound 会执行 button.style.display = ''，
  // 把我们的内联 none 清掉，于是"VR NOT SUPPORTED"会明晃晃地浮在画面中间。
  // 所以改成把它塞进一个隐藏容器，按钮自身怎么改样式都影响不到容器。
  const official = VRButton.createButton(renderer, {
    optionalFeatures: ['local-floor', 'bounded-floor'],
  });
  const holder = document.createElement('div');
  holder.style.display = 'none';
  holder.setAttribute('aria-hidden', 'true');
  holder.appendChild(official);
  document.body.appendChild(holder);

  // 官方按钮会在会话可用/不可用时更新自己的文案与 disabled 状态，
  // 这里把它同步到我们的按钮上。
  const sync = () => {
    const unavailable = official.disabled;
    const text = official.textContent || '';
    const inSession = /退出|exit/i.test(text);
    el.vrBtn.hidden = false;
    el.vrBtn.disabled = unavailable && !inSession;
    el.vrBtn.textContent = inSession ? '退出 VR' : unavailable ? '未检测到 VR 设备' : '进入 VR';
  };

  new MutationObserver(sync).observe(official, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });
  sync();

  // 点击我们的按钮 = 点击官方按钮
  el.vrBtn.addEventListener('click', () => {
    if (!el.vrBtn.disabled) official.click();
  });

  // 会话期间交出/收回控制权
  renderer.xr.addEventListener('sessionstart', () => {
    controls.enabled = false;
    // 这里不用动 camera.fov：WebXR 每帧会用头显的投影矩阵覆盖它，
    // 手改没有意义（改了也会被覆盖掉）。
  });
  renderer.xr.addEventListener('sessionend', () => {
    controls.enabled = true;
    // 退出 VR 后按当前屏幕比例把 fov 恢复成我们自己的设置
    applyHfov();
  });
}

main().catch((e) => {
  console.error(e);
  showError(`<strong>初始化失败</strong><br>${e.message}`);
});
