#!/usr/bin/env python3
"""
全景 VR 本地工具 —— 后端服务。

功能：
  - 上传多张全景图，后台切片（射线反投影，复用 build_cubemap.py）
  - 一个项目一个链接：/p/<id>
  - 预览页可切换同一项目下的多个场景
  - 删除项目

设计要点：
  - 不用数据库。项目索引就是一个 JSON 文件，写入用文件锁串行化。
  - 切片是 CPU 密集且耗时的（11008x5504 约 5-6 秒），所以放在后台线程里跑，
    前端用 job id 轮询进度，避免请求超时。
  - 同一时间只切一张图。源图转 float32 后可能占几百 MB 内存，
    并发会直接把内存吃光。
  - 只监听 127.0.0.1。上传接口没有鉴权，绝不能暴露到公网。

用法：
    python3 tools/server.py [--port 8000]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import sys
import threading
import time
import traceback
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, unquote

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PROJECTS_FILE = DATA / "projects.json"
WEB = ROOT / "web"

# 上传限制
MAX_UPLOAD_BYTES = 120 * 1024 * 1024        # 单文件 120MB（11008x5504 的 JPEG 约 25MB）
MAX_PIXELS = 16000 * 8000                   # 像素总量上限，防止解码后爆内存
ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp"}

# 面边长。1024 足够桌面预览，2048 用于 VR。
FACE_SIZE = 2048
JPEG_QUALITY = 90

_lock = threading.Lock()          # 保护 projects.json 的读写
_jobs: dict[str, dict] = {}       # job_id -> 进度
_jobs_lock = threading.Lock()
_slice_lock = threading.Lock()    # 保证同一时间只切一张图


# ---------------------------------------------------------------- 切片器加载

def _load_slicer():
    """加载 build_cubemap.py，复用它的切片逻辑（不重写第二份）。"""
    spec = importlib.util.spec_from_file_location(
        "build_cubemap", ROOT / "build_cubemap.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


slicer = _load_slicer()


# ---------------------------------------------------------------- 项目索引

def _read_projects() -> list[dict]:
    if not PROJECTS_FILE.is_file():
        return []
    try:
        data = json.loads(PROJECTS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        # 索引坏了不要让整个服务挂掉
        return []


def _write_projects(items: list[dict]) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = PROJECTS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(PROJECTS_FILE)   # 原子替换，避免写一半被读到


def new_id() -> str:
    return uuid.uuid4().hex[:8]


def project_dir(pid: str) -> Path:
    return DATA / "projects" / pid


# ---------------------------------------------------------------- 切片任务

def _set_job(job_id: str, **kw) -> None:
    with _jobs_lock:
        _jobs.setdefault(job_id, {})
        _jobs[job_id].update(kw)


def get_job(job_id: str) -> dict | None:
    with _jobs_lock:
        j = _jobs.get(job_id)
        return dict(j) if j else None


def mark_project(pid: str, **fields) -> None:
    """更新索引里某个项目的字段（不存在就忽略）。"""
    with _lock:
        items = _read_projects()
        for it in items:
            if it.get("id") == pid:
                it.update(fields)
                break
        _write_projects(items)


def run_slice_job(job_id: str, pid: str, uploads: list[dict]) -> None:
    """
    后台把每个场景切成 6 个面。

    uploads: [{scene_name, tmp_path, filename}]
    """
    total = len(uploads)
    _set_job(job_id, state="running", total=total, done=0, current="", error=None)

    pdir = project_dir(pid)
    scenes_meta: list[dict] = []

    try:
        for i, up in enumerate(uploads):
            name = up["scene_name"]
            _set_job(job_id, current=name, done=i)
            _set_job(job_id, message=f"正在切片：{name}（{i + 1}/{total}）")

            # 只允许一个切片任务占用内存
            with _slice_lock:
                im = slicer.load_panorama(Path(up["tmp_path"]))
                w, h = im.size
                if w * h > MAX_PIXELS:
                    raise ValueError(
                        f"图片过大：{w}x{h}，超过上限 "
                        f"{MAX_PIXELS // 1_000_000} 百万像素"
                    )
                faces = slicer.slice_faces(im, FACE_SIZE)

                outdir = pdir / "scenes" / up["slug"]
                outdir.mkdir(parents=True, exist_ok=True)

                from PIL import Image as PILImage
                import numpy as np

                for fname, arr in faces.items():
                    img = PILImage.fromarray(
                        np.clip(arr, 0, 255).astype("uint8"), "RGB"
                    )
                    img.save(
                        outdir / f"{fname}.jpg",
                        "JPEG",
                        quality=JPEG_QUALITY,
                        optimize=True,
                    )

                # 预览缩略图
                prev = im.copy()
                prev.thumbnail((512, 256), PILImage.LANCZOS)
                prev.save(outdir / "preview.jpg", "JPEG", quality=82)

                # 源图也留一份，方便以后重切
                src_dir = pdir / "sources"
                src_dir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(up["tmp_path"], src_dir / f"{up['slug']}{Path(up['filename']).suffix}")

                # 及时释放，大图很占内存
                del im, faces
                if hasattr(PILImage, "MAX_IMAGE_PIXELS"):
                    pass

            scenes_meta.append(
                {
                    "slug": up["slug"],
                    "name": name,
                    "sourceSize": [w, h],
                    "sourceName": up["filename"],
                }
            )

        # 写项目元数据
        meta = {
            "id": pid,
            "scenes": scenes_meta,
            "faceSize": FACE_SIZE,
            "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        pdir.mkdir(parents=True, exist_ok=True)
        (pdir / "project.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        with _lock:
            items = _read_projects()
            items = [x for x in items if x["id"] != pid]
            items.insert(
                0,
                {
                    "id": pid,
                    "sceneCount": len(scenes_meta),
                    "scenes": [s["name"] for s in scenes_meta],
                    "created": meta["created"],
                    # 用第一个场景的预览图作为项目封面
                    "cover": f"/data/projects/{pid}/scenes/{scenes_meta[0]['slug']}/preview.jpg"
                    if scenes_meta
                    else None,
                },
            )
            _write_projects(items)

        # 切片完成：把 pending 摘掉，补上场景名与封面
        mark_project(pid, pending=False)

        _set_job(job_id, state="done", done=total, message="切片完成")

    except Exception as e:  # noqa: BLE001 - 要把任何失败都反馈给前端
        traceback.print_exc()
        _set_job(job_id, state="error", error=str(e), message=f"失败：{e}")
        # 失败就把半成品删掉，避免留下坏项目
        shutil.rmtree(project_dir(pid), ignore_errors=True)
        with _lock:
            items = [x for x in _read_projects() if x["id"] != pid]
            _write_projects(items)
    finally:
        # 删掉临时上传文件
        for up in uploads:
            try:
                os.unlink(up["tmp_path"])
            except OSError:
                pass


# ---------------------------------------------------------------- 场景命名

def clean_scene_name(filename: str) -> str:
    """
    把文件名整理成像样的场景名。

    相机导出的名字常常是「客厅R0014808 拷贝.jpg」这种，
    去掉扩展名、去掉「拷贝」、再去掉末尾编号。
    清理后如果什么都不剩（例如文件名叫 ".jpg"），退回文件名本身。
    """
    stem = Path(filename).stem
    original = stem
    stem = re.sub(r"\s*拷贝\s*$", "", stem)
    stem = re.sub(r"[Rr]\d{5,}$", "", stem).strip()
    stem = re.sub(r"[_\-\s]+$", "", stem).strip()
    if not stem or stem.startswith("."):
        stem = original.lstrip(".").strip()
    return stem or "未命名"


def slugify(name: str, used: set[str]) -> str:
    """生成安全且不重复的目录名。保留中文，去掉路径分隔符等。"""
    # 空格也换成下划线，避免 URL 里出现 %20
    s = re.sub(r'[\\/:*?"<>|\s]+', "_", name).strip("._-")
    # 去掉可能导致歧义的连续点
    s = re.sub(r"\.+", ".", s)
    s = s[:40].strip("._-")
    if not s:
        s = "scene"
    base = s
    n = 2
    while s in used:
        s = f"{base}_{n}"
        n += 1
    used.add(s)
    return s


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "PanoVR/1.0"

    # ---- 工具方法 ----
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, code: int = 200):
        self._send(
            code,
            json.dumps(obj, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def _error(self, code: int, msg: str):
        self._json({"error": msg}, code)

    def _file(self, path: Path, ctype: str | None = None):
        if not path.is_file():
            self._error(HTTPStatus.NOT_FOUND, "文件不存在")
            return
        ctype = ctype or guess_type(path)
        # 切片图很大，交给浏览器缓存
        self._send(200, path.read_bytes(), ctype, {"Cache-Control": "public, max-age=3600"})

    def log_message(self, fmt, *args):
        # 只打错误，正常请求静音
        code = str(args[1]) if len(args) > 1 else ""
        if not code.startswith(("200", "204", "304")):
            super().log_message(fmt, *args)

    # ---- 路由 ----
    def do_GET(self):
        u = urlparse(self.path)
        # URL 里的中文（场景目录名）是百分号编码的，必须先解码再当路径用，
        # 否则 /data/.../scenes/%E5%AE%A2%E5%8E%85/px.jpg 会找不到文件。
        p = unquote(u.path)

        if p == "/api/projects":
            with _lock:
                self._json(_read_projects())
            return

        m = re.fullmatch(r"/api/projects/([0-9a-f]{8})", p)
        if m:
            meta = self._project_meta(m.group(1))
            if meta is None:
                self._error(404, "项目不存在")
            else:
                self._json(meta)
            return

        m = re.fullmatch(r"/api/jobs/([0-9a-f]{8})", p)
        if m:
            j = get_job(m.group(1))
            if j is None:
                self._error(404, "任务不存在")
            else:
                self._json(j)
            return

        # 静态资源
        if p.startswith("/data/"):
            rel = p[len("/data/"):]
            target = (DATA / rel).resolve()
            if not target.is_relative_to(DATA.resolve()):
                self._error(403, "非法路径")
                return
            self._file(target)
            return

        if p.startswith("/vendor/"):
            target = (ROOT / p.lstrip("/")).resolve()
            if not target.is_relative_to(ROOT.resolve()):
                self._error(403, "非法路径")
                return
            self._file(target)
            return

        # 预览页 /p/<id>（前端自己再拉数据）
        if re.fullmatch(r"/p/[0-9a-f]{8}", p):
            self._file(WEB / "preview.html", "text/html; charset=utf-8")
            return

        # 管理页
        if p == "/":
            self._file(WEB / "admin.html", "text/html; charset=utf-8")
            return

        # web/ 下的静态文件。
        #
        # 这里必须限定 /web/ 前缀：早先的写法是 (WEB / p)，于是 /style.css
        # 会被解析成 web/style.css（管理页的样式表），把根目录的查看器样式表
        # 遮蔽掉 —— 结果预览页和旧 Demo 都拿不到 .hud / --strip 等规则，
        # HUD 与场景切换条全部消失（因为 var(--strip) 未定义，bottom 失效）。
        # 限定前缀后这个"同名遮蔽"的坑就彻底不存在了。
        if p.startswith("/web/"):
            target = (WEB / p[len("/web/"):]).resolve()
            if not target.is_relative_to(WEB.resolve()):
                self._error(403, "非法路径")
                return
            self._file(target)
            return

        # 根目录的静态文件：查看器样式、app.js、旧版单场景 Demo 等
        legacy = (ROOT / p.lstrip("/")).resolve()
        if legacy.is_relative_to(ROOT.resolve()) and legacy.is_file():
            self._file(legacy)
            return

        self._error(404, "找不到")

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/projects":
            self._handle_upload()
            return
        self._error(404, "找不到")

    def do_DELETE(self):
        m = re.fullmatch(r"/api/projects/([0-9a-f]{8})", urlparse(self.path).path)
        if not m:
            self._error(404, "找不到")
            return
        pid = m.group(1)
        with _lock:
            items = _read_projects()
            if not any(x["id"] == pid for x in items):
                self._error(404, "项目不存在")
                return
            items = [x for x in items if x["id"] != pid]
            _write_projects(items)
        shutil.rmtree(project_dir(pid), ignore_errors=True)
        self._json({"ok": True})

    # ---- 具体逻辑 ----
    def _project_meta(self, pid: str) -> dict | None:
        f = project_dir(pid) / "project.json"
        if not f.is_file():
            return None
        try:
            meta = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        # 补上前端要用的 URL
        for s in meta.get("scenes", []):
            s["base"] = f"/data/projects/{pid}/scenes/{s['slug']}"
        return meta

    def _handle_upload(self):
        """
        接收 multipart/form-data 上传。

        这里手写 multipart 解析而不是用 cgi.FieldStorage：
        cgi 模块在 Python 3.13 已移除，手写更可控，
        而且我们可以边收边写临时文件，避免整份内容留在内存里。
        """
        ctype = self.headers.get("Content-Type", "")
        m = re.search(r"boundary=([^;]+)", ctype)
        if not m:
            self._error(400, "请求格式不对：缺少 multipart boundary")
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._error(400, "没有收到内容")
            return
        if length > MAX_UPLOAD_BYTES * 12:
            self._error(413, "上传内容过大")
            return

        boundary = m.group(1).strip().strip('"').encode()
        body = self._read_exact(length)
        if body is None:
            self._error(400, "读取上传内容失败")
            return

        files = parse_multipart(body, boundary)
        if not files:
            self._error(400, "没有解析到任何图片")
            return

        # 校验
        tmpdir = DATA / "tmp"
        tmpdir.mkdir(parents=True, exist_ok=True)
        uploads = []
        used: set[str] = set()
        errors = []

        for f in files:
            ext = Path(f["filename"]).suffix.lower()
            if ext not in ALLOWED_EXT:
                errors.append(f"{f['filename']}：不支持的格式 {ext}")
                continue
            if len(f["data"]) > MAX_UPLOAD_BYTES:
                errors.append(f"{f['filename']}：超过 {MAX_UPLOAD_BYTES // 1024 // 1024}MB")
                continue

            # 校验是不是真的图片、是不是 2:1
            try:
                from PIL import Image as PILImage
                import io

                PILImage.MAX_IMAGE_PIXELS = None
                probe = PILImage.open(io.BytesIO(f["data"]))
                w, h = probe.size
            except Exception:  # noqa: BLE001
                errors.append(f"{f['filename']}：无法识别的图片")
                continue

            ratio = w / h if h else 0
            if abs(ratio - 2.0) > 0.02:
                errors.append(
                    f"{f['filename']}：{w}x{h} 不是 2:1 等距柱状全景图（比例 {ratio:.2f}）"
                )
                continue
            if w * h > MAX_PIXELS:
                errors.append(
                    f"{f['filename']}：{w}x{h} 超过 "
                    f"{MAX_PIXELS // 1_000_000} 百万像素上限"
                )
                continue

            name = clean_scene_name(f["filename"])
            slug = slugify(name, used)
            tmp = tmpdir / f"{uuid.uuid4().hex}{ext}"
            tmp.write_bytes(f["data"])
            uploads.append(
                {
                    "scene_name": name,
                    "slug": slug,
                    "tmp_path": str(tmp),
                    "filename": f["filename"],
                }
            )

        if not uploads:
            self._json({"error": "没有可用的图片", "details": errors}, 400)
            return

        # 建项目 + 起后台任务
        pid = new_id()
        job_id = new_id()
        with _lock:
            items = _read_projects()
            items.insert(
                0,
                {
                    "id": pid,
                    "sceneCount": len(uploads),
                    "scenes": [u["scene_name"] for u in uploads],
                    "created": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "pending": True,
                    "cover": None,
                },
            )
            _write_projects(items)

        threading.Thread(
            target=run_slice_job, args=(job_id, pid, uploads), daemon=True
        ).start()

        self._json(
            {
                "projectId": pid,
                "jobId": job_id,
                "accepted": len(uploads),
                "warnings": errors,
            },
            202,
        )

    def _read_exact(self, n: int) -> bytes | None:
        buf = bytearray()
        remaining = n
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 1 << 20))
            if not chunk:
                return None
            buf.extend(chunk)
            remaining -= len(chunk)
        return bytes(buf)


def parse_multipart(body: bytes, boundary: bytes) -> list[dict]:
    """从 multipart body 里取出文件部分（只关心 filename 与内容）。"""
    out = []
    delim = b"--" + boundary
    parts = body.split(delim)
    for part in parts[1:]:
        if part[:2] == b"--":     # 结束标记
            break
        part = part.lstrip(b"\r\n")
        head_end = part.find(b"\r\n\r\n")
        if head_end < 0:
            continue
        headers = part[:head_end].decode("utf-8", "replace")
        data = part[head_end + 4:]
        if data.endswith(b"\r\n"):
            data = data[:-2]
        m = re.search(r'filename="([^"]*)"', headers)
        if not m or not m.group(1):
            continue
        out.append({"filename": m.group(1), "data": data})
    return out


_CTYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def guess_type(p: Path) -> str:
    return _CTYPES.get(p.suffix.lower(), "application/octet-stream")


def main() -> int:
    ap = argparse.ArgumentParser(description="全景 VR 本地工具")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    DATA.mkdir(parents=True, exist_ok=True)
    if not WEB.is_dir():
        print(f"错误：找不到前端目录 {WEB}", file=sys.stderr)
        return 1

    try:
        httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as e:
        print(f"错误：无法监听 {args.host}:{args.port} —— {e}", file=sys.stderr)
        print("端口可能被占用，试试 --port 8001", file=sys.stderr)
        return 1

    n = len(_read_projects())
    print(f"\n  全景 VR 工具已启动： http://{args.host}:{args.port}/")
    print(f"  已有 {n} 个项目")
    print()
    print("  管理页（上传 / 列表 / 删除）")
    print("  预览页  http://%s:%d/p/<项目ID>" % (args.host, args.port))
    print()
    print("  注意：仅监听本机。上传接口没有鉴权，请勿暴露到公网。")
    print("  按 Ctrl+C 停止\n")
    sys.stdout.flush()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
