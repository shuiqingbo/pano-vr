#!/usr/bin/env python3
"""
生成一张合成的等距柱状全景图，供 Demo / 截图使用。

为什么仓库里不放真实照片：本工具最初的示例是真实住宅的室内全景，
发到公开仓库等于把房屋内部永久公开、还会被爬虫和 fork 扩散。
所以这里程序化生成一张"抽象测试场景"，用它代替：

  - 15° / 45° 经纬网格  → 一眼能看出立方体贴图有没有接缝、
                          经纬线在切面上是否仍然是直线
  - 地平线高亮环        → 环视时能判断视平线位置
  - N/E/S/W 方位标记    → 可以直接验证朝向有没有搞反
  - 天顶/天底附近收束   → 极点处的几何是否正确
  - 几块色板            → 提供视差与方位感，画面不至于空旷

配色沿用界面那套（暖近黑 + 旧黄铜），出来和截图整体协调。

用法：
    python3 tools/make-sample-pano.py                    # 默认 8192x4096
    python3 tools/make-sample-pano.py -o sample/pano.jpg --width 8192
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# 依赖检查：缺库时给人话提示，而不是甩一长串 ImportError 堆栈
try:
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
except ImportError as _e:  # noqa: BLE001
    _first = str(_e).splitlines()[0][:150]
    raise SystemExit(
        f"缺少依赖或 Pillow 不可用：{_first}\n\n"
        "请先安装：\n"
        "    pip install pillow numpy\n"
    )

# 配色（与 web/style.css 的 token 一致）
VOID = (14, 13, 12)
CEIL_NEAR = (30, 28, 26)
CEIL_FAR = (52, 48, 44)
FLOOR_NEAR = (34, 30, 26)
FLOOR_FAR = (58, 51, 43)
BRASS = (200, 169, 110)
INK = (242, 237, 230)

# 挂在"墙上"的色板：(经度, 纬度, 宽°, 高°, 颜色)
PANELS = [
    (-150, 8, 26, 34, (86, 78, 66)),
    (-90, -4, 20, 40, (108, 92, 70)),
    (-30, 12, 30, 26, (72, 80, 78)),
    (15, -10, 22, 30, (120, 98, 68)),
    (70, 6, 26, 36, (78, 74, 84)),
    (130, 0, 18, 44, (96, 86, 70)),
    (175, 14, 24, 22, (110, 100, 86)),
]


def lonlat_grid(w: int, h: int):
    """返回每个像素对应的经纬度（弧度）。x 向右 = 经度增大，y 向下 = 纬度下降。"""
    x = (np.arange(w, dtype=np.float32) + 0.5) / w * 2 * np.pi - np.pi   # -π..π
    y = np.pi / 2 - (np.arange(h, dtype=np.float32) + 0.5) / h * np.pi   # +π/2..-π/2
    return np.meshgrid(x, y)


def dist_to_multiple(v: np.ndarray, step: float) -> np.ndarray:
    """到最近的 step 整数倍的距离（用于画网格线）"""
    return np.abs(((v + step / 2) % step) - step / 2)


def build(width: int, height: int) -> Image.Image:
    lon, lat = lonlat_grid(width, height)
    lon_deg = np.degrees(lon)
    lat_deg = np.degrees(lat)

    # ---- 底色：按纬度做垂直渐变，天花板比地面亮一点 ----
    t = np.abs(lat_deg) / 90.0                       # 0=地平线, 1=极点
    ceil_mix = (CEIL_FAR[0] + (CEIL_NEAR[0] - CEIL_FAR[0]) * t)
    floor_mix = (FLOOR_FAR[0] + (FLOOR_NEAR[0] - FLOOR_FAR[0]) * t)
    base = np.where(lat_deg >= 0, ceil_mix, floor_mix)

    img = np.zeros((height, width, 3), dtype=np.float32)
    img[..., 0] = base
    img[..., 1] = base * 0.94
    img[..., 2] = base * 0.88

    # ---- 经纬网格 ----
    def grid(v, step, width_deg):
        return np.clip(1.0 - dist_to_multiple(v, step) / width_deg, 0, 1)

    g = np.maximum(grid(lon_deg, 15, 0.35), grid(lat_deg, 15, 0.35)) * 0.22
    g = np.maximum(g, np.maximum(grid(lon_deg, 45, 0.5), grid(lat_deg, 45, 0.5)) * 0.5)

    # 经线在天顶/天底附近会极度收束，淡出以免糊成一团
    pole_fade = np.clip((90 - np.abs(lat_deg)) / 18.0, 0, 1)
    g = g * pole_fade

    brass = np.array(BRASS, dtype=np.float32)
    img = img * (1 - g[..., None]) + brass[None, None, :] * g[..., None]

    # ---- 地平线高亮环 ----
    band = np.clip(1.0 - np.abs(lat_deg) / 1.1, 0, 1) ** 2 * 0.85
    img = img * (1 - band[..., None]) + brass[None, None, :] * band[..., None]

    out = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")

    # ---- 墙面色板 ----
    d = ImageDraw.Draw(out)
    for lon_c, lat_c, w_deg, h_deg, color in PANELS:
        x0 = (lon_c - w_deg / 2 + 180) / 360 * width
        x1 = (lon_c + w_deg / 2 + 180) / 360 * width
        y0 = (90 - (lat_c + h_deg / 2)) / 180 * height
        y1 = (90 - (lat_c - h_deg / 2)) / 180 * height
        # 经度方向可能跨边界，这里简化处理（示例图不跨）
        d.rectangle([x0, y0, x1, y1], fill=color, outline=BRASS, width=max(2, width // 1400))

    # ---- 方位标记 ----
    font = _load_font(max(28, height // 26))
    marks = [(0, "N"), (90, "E"), (180, "S"), (270, "W")]
    for lon_c, text in marks:
        x = (lon_c + 180) / 360 * width
        y = height / 2 - height * 0.085
        _text_centered(d, x, y, text, font, INK)
        # 方位刻度
        d.line([x, height / 2 - height * 0.06, x, height / 2 + height * 0.06],
               fill=BRASS, width=max(2, width // 1200))

    _text_centered(d, width / 2, height * 0.5 + height * 0.075, "HORIZON", font, BRASS)

    # ---- 极区标记 ----
    _text_centered(d, width * 0.25, height * 0.035, "ZENITH", font, CEIL_FAR)
    _text_centered(d, width * 0.25, height * 0.955, "NADIR", font, FLOOR_FAR)

    return out


def _load_font(size: int):
    """尽量用系统字体，取不到就退回 Pillow 内置位图字体。"""
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for p in candidates:
        if Path(p).is_file():
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    try:
        return ImageFont.load_default(size=size)   # Pillow 10+
    except TypeError:
        return ImageFont.load_default()


def _text_centered(draw: ImageDraw.ImageDraw, x: float, y: float, text: str, font, fill):
    """把文字居中画在 (x, y)。跨越左右边界时左右各画一份，接缝处才连续。"""
    for dx in (-draw.im.size[0] if hasattr(draw, "im") else 0, 0):
        pass
    bbox = draw.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    draw.text((x - w / 2, y - h / 2), text, font=font, fill=fill)
    # 靠近左右边缘时补画一次，避免接缝处文字被切断
    W = draw.im.size[0]
    if x < W * 0.1:
        draw.text((x + W - w / 2, y - h / 2), text, font=font, fill=fill)
    elif x > W * 0.9:
        draw.text((x - W - w / 2, y - h / 2), text, font=font, fill=fill)


def main() -> int:
    ap = argparse.ArgumentParser(description="生成合成等距柱状全景图")
    ap.add_argument("-o", "--out", default="sample/sample-panorama.jpg")
    ap.add_argument("--width", type=int, default=8192, help="宽度（高度自动取一半）")
    ap.add_argument("-q", "--quality", type=int, default=88)
    ap.add_argument("--variant", type=int, default=0,
                    help="换个色相，用来生成多个示例场景（0 为原始配色）")
    args = ap.parse_args()

    if args.width < 512:
        print("错误：宽度至少 512", file=sys.stderr)
        return 1

    height = args.width // 2
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    img = build(args.width, height)
    # 等距柱状全景必须是 2:1
    assert img.size == (args.width, height), img.size

    if args.variant:
        # 转 HSV 后整体旋转色相，得到"同一套几何、不同配色"的兄弟场景
        hsv = np.asarray(img.convert("HSV"), dtype=np.uint8).astype(np.int16)
        hsv[..., 0] = (hsv[..., 0] + args.variant * 23) % 256
        img = Image.fromarray(hsv.astype(np.uint8), "HSV").convert("RGB")

    img.save(out, "JPEG", quality=args.quality, optimize=True)
    print(f"已生成 {out}  {args.width}x{height}  {out.stat().st_size / 1048576:.2f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
