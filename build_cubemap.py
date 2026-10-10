#!/usr/bin/env python3
"""
把一张等距柱状投影（equirectangular）全景图切成 6 个立方体面。

原理
----
全景图按经纬度映射到球面：x 轴 = 经度 0..360°，y 轴 = 纬度 +90°(顶)..-90°(底)。
立方体贴图的 6 个面，每个面对应球面上一块 90°x90° 的视锥。
对每个输出像素，从立方体中心朝该像素方向发一条射线，求出它与单位球的交点，
再反算出该点在球面上的 (lon, lat)，即可采样回原全景图。

这样得到的是"光线方向"级别的精确对应，不是简单的透视拉伸近似，
因此 6 个面拼起来接缝严丝合缝。

用法
----
    python3 build_cubemap.py <全景图> [-o 输出目录] [-s 面边长]

示例
----
    python3 build_cubemap.py "~/Downloads/124vr全景图/客厅R0014808 拷贝.jpg"
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# 依赖检查：缺库时给人话提示，而不是甩一长串 ImportError 堆栈
try:
    import numpy as np
    from PIL import Image
except ImportError as _e:  # noqa: BLE001
    _first = str(_e).splitlines()[0][:150]
    raise SystemExit(
        f"缺少依赖或 Pillow 不可用：{_first}\n\n"
        "请先安装：\n"
        "    pip install pillow numpy\n"
    )

Image.MAX_IMAGE_PIXELS = None  # 全景图很大，关掉 PIL 的防解压炸弹限制

# 立方体 6 个面。顺序与 Three.js BoxGeometry 的材质槽一致：+X,-X,+Y,-Y,+Z,-Z。
# 每个面给出：面内向右(u)方向的单位向量、面内向上(v)方向的单位向量、面法线(n)。
# 采样方向 = u * sx + v * sy + n   （sx, sy 是面内归一化坐标，范围 -1..1）
#
# ⚠️ 两个很容易搞错的地方，都是靠"看渲染结果"才发现的：
#
# (1) u 的方向要取【从盒子内部看】时的右手边，不能照抄 BoxGeometry 的 UV。
#     BoxGeometry 的 UV 是给"从外面看"设计的；而这个全景盒是 BackSide
#     （从内部往外看），同一个面的左右会反过来。照着 UV 抄会让整幅全景
#     左右镜像 —— 房间看不出问题，但画面里的文字会明确地反着显示。
#     判定方法：站在球心朝 n 看，up=+Y 时右手边 r = n × up。
#       pz: n=+Z -> r = -X    （所以 u 取 (-1,0,0)，而不是 (1,0,0)）
#       px: n=+X -> r = +Z
#       nx: n=-X -> r = -Z
#       nz: n=-Z -> r = +X
#
# (2) 顶/底两个面的 v 方向不能照抄侧面。Texture 默认 flipY=True，
#     切面图像的"上方"必须对齐该面 uv.y=1 的方向，实测：
#       px/nx/pz/nz = +Y ；py = -Z ；ny = +Z
#
# tools/verify-render.mjs 会用真实相机投影来验证"图像右侧确实显示在屏幕右侧"，
# 改错了跑一下检查就会报出来。
FACES = {
    # 右面：+X，朝东。从内部看右手边是 +Z
    "px": dict(u=(0, 0, 1), v=(0, 1, 0), n=(1, 0, 0)),
    # 左面：-X，朝西。右手边是 -Z
    "nx": dict(u=(0, 0, -1), v=(0, 1, 0), n=(-1, 0, 0)),
    # 上面：+Y，朝天（头顶）。uv.y=1 对应 -Z
    "py": dict(u=(-1, 0, 0), v=(0, 0, -1), n=(0, 1, 0)),
    # 下面：-Y，朝地（脚底）。uv.y=1 对应 +Z
    "ny": dict(u=(-1, 0, 0), v=(0, 0, 1), n=(0, -1, 0)),
    # 前面：+Z，朝南。从内部看右手边是 -X
    "pz": dict(u=(-1, 0, 0), v=(0, 1, 0), n=(0, 0, 1)),
    # 后面：-Z，朝北。右手边是 +X
    "nz": dict(u=(1, 0, 0), v=(0, 1, 0), n=(0, 0, -1)),
}


def load_panorama(path: Path) -> Image.Image:
    """读入全景图，应用 EXIF 旋转，并校验是否为 2:1 等距柱状图。"""
    im = Image.open(path)
    # THETA / 部分相机把方向写在 EXIF 里，不应用会导致上下颠倒或左右镜像
    from PIL import ImageOps

    im = ImageOps.exif_transpose(im)
    im = im.convert("RGB")
    w, h = im.size
    ratio = w / h
    if abs(ratio - 2.0) > 0.02:
        print(
            f"警告：图片宽高比为 {ratio:.4f}，不是标准 2:1 等距柱状投影，"
            f"切面可能出现拉伸或错位。",
            file=sys.stderr,
        )
    print(f"读入全景图 {w}x{h} (比例 {ratio:.4f})")
    return im


def slice_faces(im: Image.Image, size: int) -> dict[str, np.ndarray]:
    """
    用射线-球面反投影把全景图切成 6 个面。

    对每个输出像素取面内坐标 (sx, sy) ∈ [-1, 1]（sx 向右，sy 向上），
    方向向量 d = u*sx + v*sy + n，再归一化到单位球。
    由 d 求经纬度：
        lat = asin(d.y)
        lon = atan2(d.x, d.z)
    映射到全景图像素坐标：
        px = (lon / 2pi + 0.5) * W    （lon = -pi 对应左边缘）
        py = (0.5 - lat / pi) * H     （lat = +pi/2 对应顶边）
    """
    src = np.asarray(im, dtype=np.float32)
    h, w, _ = src.shape

    # 预计算面内像素坐标（用像素中心，+0.5 避免半像素偏移造成接缝）
    idx = (np.arange(size, dtype=np.float32) + 0.5) / size * 2.0 - 1.0  # -1..1
    sx, sy = np.meshgrid(idx, -idx)  # sy 取负：图像 y 向下，面内 v 向上

    out: dict[str, np.ndarray] = {}
    for name, f in FACES.items():
        u = np.array(f["u"], dtype=np.float32)
        v = np.array(f["v"], dtype=np.float32)
        n = np.array(f["n"], dtype=np.float32)

        # 每个像素的方向向量 (size, size, 3)
        d = (
            u[None, None, :] * sx[..., None]
            + v[None, None, :] * sy[..., None]
            + n[None, None, :]
        )
        d /= np.linalg.norm(d, axis=2, keepdims=True)

        # 方向向量 -> 经纬度 -> 全景图像素坐标
        lat = np.arcsin(np.clip(d[..., 1], -1.0, 1.0))
        lon = np.arctan2(d[..., 0], d[..., 2])

        px = (lon / (2 * np.pi) + 0.5) * w
        py = (0.5 - lat / np.pi) * h

        # 双线性采样
        out[name] = _bilinear(src, px, py, w, h)
        print(f"  切出 {name} 面 {size}x{size}")

    return out


def _bilinear(src: np.ndarray, px: np.ndarray, py: np.ndarray, w: int, h: int) -> np.ndarray:
    """
    对浮点坐标做双线性插值。

    x 方向做环绕（左右边缘相接，经度是循环的），
    y 方向做钳制（上下是极点，不环绕）。
    """
    x0 = np.floor(px).astype(np.int64)
    y0 = np.floor(py).astype(np.int64)
    fx = (px - x0)[..., None].astype(np.float32)
    fy = (py - y0)[..., None].astype(np.float32)

    x0m = x0 % w  # 经度环绕
    x1m = (x0 + 1) % w
    y0c = np.clip(y0, 0, h - 1)  # 纬度钳制
    y1c = np.clip(y0 + 1, 0, h - 1)

    # 四个角像素
    c00 = src[y0c, x0m]
    c01 = src[y0c, x1m]
    c10 = src[y1c, x0m]
    c11 = src[y1c, x1m]

    top = c00 * (1 - fx) + c01 * fx
    bot = c10 * (1 - fx) + c11 * fx
    return top * (1 - fy) + bot * fy


def main() -> int:
    ap = argparse.ArgumentParser(
        description="把等距柱状全景图切成 6 个立方体面",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("panorama", help="输入全景图路径")
    ap.add_argument(
        "-o",
        "--outdir",
        default="assets/cubemap",
        help="输出目录（默认 assets/cubemap）",
    )
    ap.add_argument(
        "-s",
        "--size",
        type=int,
        default=2048,
        help="每个面的边长像素（默认 2048，即 2048x2048）",
    )
    ap.add_argument(
        "-q", "--quality", type=int, default=90, help="JPEG 质量 1-100（默认 90）"
    )
    ap.add_argument(
        "--name", default=None, help="场景名，默认用全景图文件名（会写入 faces.json）"
    )
    args = ap.parse_args()

    src_path = Path(args.panorama).expanduser()
    if not src_path.is_file():
        print(f"错误：找不到全景图 {src_path}", file=sys.stderr)
        return 1
    if not 1 <= args.quality <= 100:
        print("错误：质量必须在 1-100 之间", file=sys.stderr)
        return 1
    if args.size < 16:
        print("错误：面边长至少 16 像素", file=sys.stderr)
        return 1

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    scene = args.name or src_path.stem

    t0 = time.time()
    im = load_panorama(src_path)
    faces = slice_faces(im, args.size)

    # 单独存一张小预览图，界面上的场景切换缩略图用它
    prev = im.copy()
    prev.thumbnail((1024, 512), Image.LANCZOS)
    preview_name = f"{scene}_preview.jpg"
    prev.save(outdir / preview_name, "JPEG", quality=82)

    for name, arr in faces.items():
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")
        img.save(outdir / f"{name}.jpg", "JPEG", quality=args.quality, optimize=True)
        print(f"  写入 {name}.jpg")

    meta = {
        "scene": scene,
        "source": src_path.name,
        "sourceSize": list(im.size),
        "faceSize": args.size,
        "quality": args.quality,
        "order": ["px", "nx", "py", "ny", "pz", "nz"],
        "preview": preview_name,
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    (outdir / "faces.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    total = sum(p.stat().st_size for p in outdir.glob("*.jpg"))
    print(
        f"\n完成：6 个面 + 1 张预览，共 {total / 1048576:.2f} MB，"
        f"耗时 {time.time() - t0:.1f}s"
    )
    print(f"输出目录：{outdir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
