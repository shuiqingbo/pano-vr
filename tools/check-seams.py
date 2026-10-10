#!/usr/bin/env python3
"""
检查切出来的 6 个面在真实像素上是否接得上。

这是最贴近"肉眼看到的效果"的验证：
把相邻两个面的公共边各取一列/一行像素，比较它们的差异。
如果切片几何正确，公共边上的像素应当几乎相同（只差 JPEG 压缩噪声）。

用法：
    python3 tools/check-seams.py [--dir assets/cubemap]
"""

from __future__ import annotations

import argparse
import sys
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

Image.MAX_IMAGE_PIXELS = None

# 面的定义直接从 build_cubemap.py 里取，避免两处各写一份、
# 改了一处忘了另一处（这里曾经因为顶/底面 v 方向不一致而误报）。
#
# build_cubemap.py 里的注释说明了推导依据：Three.js 的 Texture 默认
# flipY=True，所以切面图像的"上方"必须对齐该面 uv.y=1 的方向。
import importlib.util
import sys

# 不写 .pyc，免得项目里多出一个 __pycache__ 目录
sys.dont_write_bytecode = True

_spec = importlib.util.spec_from_file_location(
    "build_cubemap", Path(__file__).resolve().parent.parent / "build_cubemap.py"
)
_bc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bc)
FACES = _bc.FACES


def dirs_for(face: str, size: int) -> np.ndarray:
    """返回该面每个像素对应的单位方向向量（size, size, 3）。"""
    f = FACES[face]
    idx = (np.arange(size, dtype=np.float32) + 0.5) / size * 2.0 - 1.0
    sx, sy = np.meshgrid(idx, -idx)
    u = np.array(f["u"], np.float32)
    v = np.array(f["v"], np.float32)
    n = np.array(f["n"], np.float32)
    d = u[None, None, :] * sx[..., None] + v[None, None, :] * sy[..., None] + n[None, None, :]
    return d / np.linalg.norm(d, axis=2, keepdims=True)


def to_face_coords(face: str, d: np.ndarray, size: int):
    """把方向向量投影到指定面的像素坐标上。"""
    f = FACES[face]
    u = np.array(f["u"], np.float32)
    v = np.array(f["v"], np.float32)
    n = np.array(f["n"], np.float32)
    dn = d @ n
    sxp = (d @ u) / dn
    syp = (d @ v) / dn
    px = (sxp + 1) / 2 * size - 0.5
    py = (1 - syp) / 2 * size - 0.5
    return px, py


def sample(img: np.ndarray, px: np.ndarray, py: np.ndarray) -> np.ndarray:
    """按浮点坐标做最近邻采样（边界处比较用，避免插值掩盖错位）。"""
    s = img.shape[0]
    xi = np.clip(np.round(px).astype(int), 0, s - 1)
    yi = np.clip(np.round(py).astype(int), 0, s - 1)
    return img[yi, xi]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="assets/cubemap")
    ap.add_argument("--tol", type=float, default=12.0, help="平均色差容差（0-255）")
    args = ap.parse_args()

    d = Path(args.dir)
    missing = [f for f in FACES if not (d / f"{f}.jpg").is_file()]
    if missing:
        print(f"错误：缺少切面文件 {missing}（先运行 build_cubemap.py）", file=sys.stderr)
        return 1

    imgs = {
        k: np.asarray(Image.open(d / f"{k}.jpg").convert("RGB"), dtype=np.float32)
        for k in FACES
    }
    size = imgs["pz"].shape[0]
    for k, v in imgs.items():
        if v.shape[0] != size or v.shape[1] != size:
            print(f"错误：{k}.jpg 尺寸 {v.shape[:2]} 与其他面不一致", file=sys.stderr)
            return 1

    print(f"检查 {len(FACES)} 个面，每面 {size}x{size}\n")

    # 12 对相邻面。对每一对，找出它们共享的那条边，逐点比较颜色。
    ADJACENT = [
        ("pz", "px"), ("pz", "nx"), ("pz", "py"), ("pz", "ny"),
        ("px", "py"), ("nx", "py"), ("px", "ny"), ("nx", "ny"),
        ("nz", "px"), ("nz", "nx"), ("nz", "py"), ("nz", "ny"),
    ]

    # 每个面的四条边，按方向给出：R/L 是竖直边（列），T/B 是水平边（行）
    def edge_dirs(face: str, edge: str) -> np.ndarray:
        D = dirs_for(face, size)
        t = np.linspace(-1, 1, size, dtype=np.float32)
        if edge == "R":
            return D[:, -1, :]
        if edge == "L":
            return D[:, 0, :]
        if edge == "T":
            return D[0, :, :]
        return D[-1, :, :]

    def edge_pixels(face: str, edge: str) -> np.ndarray:
        a = imgs[face]
        if edge == "R":
            return a[:, -1, :]
        if edge == "L":
            return a[:, 0, :]
        if edge == "T":
            return a[0, :, :]
        return a[-1, :, :]

    worst = 0.0
    worst_label = ""
    fails = []
    for a, b in ADJACENT:
        best = None
        for ea in ("R", "L", "T", "B"):
            da = edge_dirs(a, ea)
            # 在 b 的四条边里找方向最吻合的那条
            for eb in ("R", "L", "T", "B"):
                db = edge_dirs(b, eb)
                # 比较两条边的方向集合：每块边上的点应该能在对面找到同方向的点
                # 用最近邻匹配的平均夹角衡量
                sim = da @ db.T                       # (size, size)
                maxsim = sim.max(axis=1)              # 每个 a 点与 b 的最佳匹配
                ang = np.degrees(np.arccos(np.clip(maxsim, -1, 1))).mean()
                # 只有当两条边确实重合时夹角才接近 0
                if best is None or ang < best[0]:
                    best = (ang, ea, eb)
        ang, ea, eb = best

        # 方向对上了，再比真实像素
        da = edge_dirs(a, ea)
        db = edge_dirs(b, eb)
        sim = da @ db.T
        # 对 a 边上每个点，取 b 边上最接近的点
        j = sim.argmax(axis=1)
        pa = edge_pixels(a, ea)
        pb = edge_pixels(b, eb)[j]
        diff = np.abs(pa - pb).mean()
        worst = max(worst, diff)
        if diff > worst:
            worst_label = f"{a}.{ea} - {b}.{eb}"
        status = "✓" if diff <= args.tol else "✗"
        print(
            f"  {status} {a}.{ea} ↔ {b}.{eb}   方向偏差 {ang:6.3f}°   "
            f"平均色差 {diff:6.2f}"
        )
        if diff > args.tol:
            fails.append((f"{a}-{b}", diff))
        if diff >= worst:
            worst_label = f"{a}.{ea} ↔ {b}.{eb}"

    print(f"\n最大平均色差 {worst:.2f}（容差 {args.tol}）")
    if fails:
        print("\n结果：失败")
        for name, v in fails:
            print(f"  ✗ {name} 色差 {v:.2f} 超过容差")
        return 1
    print("结果：通过（接缝处像素一致，切面无缝）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
