/**
 * 测试用的浏览器桩。
 *
 * Node 里跑 Three.js 需要少量 DOM/WebGL 对象。这些桩被 verify-render.mjs
 * （验证渲染路径）和 verify-switch.mjs（验证场景切换）共用，
 * 所以抽到这里，避免两处各写一份、改一处忘一处。
 */

/**
 * 够用的假 WebGL 上下文：记录调用、返回合理默认值，
 * 让 Three.js 能一路走到"编译着色器"这一步。
 */
export function makeGLStub() {
  const calls = [];
  const shaders = [];
  let objId = 1;

  const gl = new Proxy(
    {
      // 常量（Three.js 会读取这些值）。
      // 注意 VERSION / SHADING_LANGUAGE_VERSION 必须存在，
      // 否则 Proxy 兜底会把它们变成函数，导致 gl.getParameter(函数) 拿到垃圾值。
      VERSION: 0x1F02,
      SHADING_LANGUAGE_VERSION: 0x8B8C,
      VENDOR: 0x1F00,
      RENDERER: 0x1F01,
      MAX_TEXTURE_SIZE: 0x0D33,
      MAX_TEXTURE_IMAGE_UNITS: 0x8872,
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4D,
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4C,
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF,
      MAX_SAMPLES: 0x8DFB,
      MAX_VERTEX_ATTRIBS: 0x8869,
      MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C,
      MAX_RENDERBUFFER_SIZE: 0x84E8,
      MAX_VIEWPORT_DIMS: 0x0D3A,
      SCISSOR_BOX: 0x0C10, VIEWPORT: 0x0BA2,
      UNPACK_ALIGNMENT: 0x0CF5, UNPACK_FLIP_Y_WEBGL: 0x9240,
      UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
      UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,
      ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893,
      STATIC_DRAW: 0x88E4, DYNAMIC_DRAW: 0x88E8,
      FLOAT: 0x1406, UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, UNSIGNED_BYTE: 0x1401,
      TRIANGLES: 4, TEXTURE_2D: 0x0DE1, TEXTURE_CUBE_MAP: 0x8513,
      RGBA: 0x1908, RGB: 0x1907, LUMINANCE: 0x1909,
      LINEAR: 0x2601, NEAREST: 0x2600, LINEAR_MIPMAP_LINEAR: 0x2703,
      CLAMP_TO_EDGE: 0x812F, REPEAT: 0x2901, MIRRORED_REPEAT: 0x8370,
      TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
      TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
      TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE,
      DEPTH_TEST: 0x0B71, CULL_FACE: 0x0B44, BACK: 0x0405, FRONT: 0x0404,
      BLEND: 0x0BE2, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
      COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100,
      FRAMEBUFFER: 0x8D40, RENDERBUFFER: 0x8D41, COLOR_ATTACHMENT0: 0x8CE0,
      DEPTH_ATTACHMENT: 0x8D00, FRAMEBUFFER_COMPLETE: 0x8CD5,
      SRGB8_ALPHA8: 0x8C43, EXT_sRGB: 1,
      getParameter(p) {
        switch (p) {
          case 0x1F00: case 0x1F01: return 'StubGL';
          case 0x1F02: return 'WebGL 2.0 (stub)';   // VERSION，Three.js 会调用 indexOf
          case 0x8B8C: return 'WebGL GLSL ES 3.00'; // SHADING_LANGUAGE_VERSION
          case 0x0D33: return 16384;      // MAX_TEXTURE_SIZE
          case 0x8872: return 32;         // MAX_TEXTURE_IMAGE_UNITS
          case 0x8B4D: return 16;         // MAX_VERTEX_TEXTURE_IMAGE_UNITS
          case 0x8B4C: return 32;
          case 0x0D3A: return 4096;
          case 0x84FF: return 16;         // MAX_TEXTURE_MAX_ANISOTROPY
          case 0x8DFB: return 1024;
          case 0x0B21: return 1024;
          case 0x8DFC: return 16;
          case 0x88FF: return 1.0;
          default: return 0;
        }
      },
      getShaderPrecisionFormat() {
        return { rangeMin: 127, rangeMax: 127, precision: 23 };
      },
      getExtension(n) {
        calls.push(['getExtension', n]);
        if (n === 'EXT_texture_filter_anisotropic') {
          return { TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF };
        }
        if (n === 'WEBGL_depth_texture') return {};
        if (n === 'OES_texture_float') return {};
        return null;
      },
      getSupportedExtensions() { return []; },
      createShader(type) { return { id: objId++, type }; },
      shaderSource(sh, src) { shaders.push(src); },
      compileShader() { calls.push(['compileShader']); },
      getShaderParameter() { return true; },
      getShaderInfoLog() { return ''; },
      getProgramParameter(prog, p) { return p === 0x8B82 ? true : 0; },
      getProgramInfoLog() { return ''; },
      createProgram() { return { id: objId++ }; },
      attachShader() {}, linkProgram() {}, useProgram() {}, deleteShader() {},
      createBuffer() { return { id: objId++ }; },
      bindBuffer() {}, bufferData() {}, deleteBuffer() {},
      createTexture() { return { id: objId++ }; },
      bindTexture() {}, texImage2D() {}, texParameteri() {}, texParameterf() {},
      activeTexture() {}, generateMipmap() {}, pixelStorei() {},
      createFramebuffer() { return { id: objId++ }; },
      bindFramebuffer() {}, framebufferTexture2D() {}, deleteFramebuffer() {},
      createRenderbuffer() { return { id: objId++ }; },
      bindRenderbuffer() {}, renderbufferStorage() {}, framebufferRenderbuffer() {},
      checkFramebufferStatus() { return 0x8CD5; },
      getAttribLocation() { return 0; }, getUniformLocation() { return { id: objId++ }; },
      getActiveUniform() { return null; }, getActiveAttrib() { return null; },
      enableVertexAttribArray() {}, disableVertexAttribArray() {},
      vertexAttribPointer() {}, drawArrays() {}, drawElements() {},
      viewport() {}, scissor() {}, clearColor() {}, clearDepth() {}, clear() {},
      enable() {}, disable() {}, depthFunc() {}, depthMask() {}, colorMask() {},
      blendFunc() {}, blendFuncSeparate() {}, cullFace() {}, frontFace() {},
      lineWidth() {}, polygonOffset() {}, finish() {}, flush() {},
      getError() { return 0; }, isContextLost() { return false; },
      canvas: { width: 1280, height: 800 },
    },
    {
      get(t, k) {
        if (k in t) return t[k];
        if (typeof k !== 'string') return undefined;
        // 常量名（全大写）没显式声明时返回数字占位。
        // 绝不能返回函数 —— Three.js 会把函数当成常量值用。
        if (/^[A-Z][A-Z0-9_]*$/.test(k)) {
          t[k] = 0x8000;
          return t[k];
        }
        return (...a) => { calls.push([k, ...a]); return undefined; };
      },
    }
  );
  return { gl, calls, shaders };
}

/** 一个够用的假 DOM 元素 */
export function makeElement(gl, id = '') {
  const classes = new Set();
  return {
    id,
    style: {},
    dataset: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, v) => (v ? classes.add(c) : classes.delete(c)),
    },
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    title: '',
    tabIndex: 0,
    width: 1280,
    height: 800,
    clientWidth: 1280,
    clientHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    getContext() { return gl; },
    appendChild() {},
    setAttribute() {},
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 1280, height: 800 }; },
    // OrbitControls.connect() 会用到这几个
    getRootNode() { return { addEventListener() {}, removeEventListener() {} }; },
    setPointerCapture() {},
    releasePointerCapture() {},
    ownerDocument: { addEventListener() {}, removeEventListener() {} },
  };
}

/**
 * 假的 Image：设置 src 后异步触发 onload；URL 里含 "BAD" 时触发 onerror。
 * 这样可以测试加载失败的分支。
 */
export function makeFakeImage() {
  return class FakeImage {
    constructor() {
      this.width = 2048;
      this.height = 2048;
      this.onload = null;
      this.onerror = null;
      this.decoding = '';
      this._src = '';
    }
    set src(v) {
      this._src = v;
      const bad = String(v).includes('BAD');
      setTimeout(() => {
        if (bad) {
          if (this.onerror) this.onerror(new Error('fake load error'));
        } else if (this.onload) {
          this.onload();
        }
      }, 0);
    }
    get src() { return this._src; }
    decode() {
      return String(this._src).includes('BAD')
        ? Promise.reject(new Error('fake decode error'))
        : Promise.resolve();
    }
  };
}

/**
 * 装上 window/document 等全局对象。
 * @returns {{ elements: Map<string, object>, gl: object }}
 */
export function installBrowserStubs(gl) {
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(gl, id));
    return elements.get(id);
  };

  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.document = {
    createElementNS: () => makeElement(gl),
    createElement: (tag) => Object.assign(makeElement(gl), { tagName: String(tag).toUpperCase() }),
    addEventListener() {},
    removeEventListener() {},
    getElementById: getEl,
    body: { appendChild() {} },
  };
  globalThis.Image = makeFakeImage();
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 800;
  globalThis.devicePixelRatio = 1;
  // 不做真实动画循环：返回 0 即可，否则测试永远不退出
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.dispatchEvent = () => true;

  // Node 24 起 navigator 是只读 getter，只能用 defineProperty 覆盖
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node' },   // 故意不带 xr：setupXR 会走"不支持 WebXR"分支
    configurable: true,
    writable: true,
  });

  return { elements, gl };
}
