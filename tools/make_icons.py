#!/usr/bin/env python3
"""生成 tradewatcher 扩展图标（纯标准库，无第三方依赖）。

设计：圆角深蓝渐变底 + 白色上升折线（含面积填充）+ 末端高亮点。
以 4x 超采样渲染后盒式降采样，保证小尺寸下边缘平滑。
"""
import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
SIZES = [16, 32, 48, 128]
SS = 4  # 超采样倍率

NAVY = (16, 24, 48)
BLUE = (37, 99, 235)
WHITE = (255, 255, 255)
GOLD = (255, 209, 102)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_rect_alpha(x, y, w, h, r, px, py):
    """返回点 (px,py) 在圆角矩形内的覆盖率（0/1，超采样下足够）。"""
    if px < x or px > x + w or py < y or py > y + h:
        return 0.0
    cx = min(max(px, x + r), x + w - r)
    cy = min(max(py, y + r), y + h - r)
    dx = px - cx
    dy = py - cy
    if dx * dx + dy * dy <= r * r:
        return 1.0
    return 0.0


def dist_to_seg(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    dx, dy = px - (ax + t * vx), py - (ay + t * vy)
    return math.sqrt(dx * dx + dy * dy)


def render(size):
    S = size * SS
    r = S * 0.235
    # 折线路径（归一化到画布 0..1）
    pts_n = [(0.20, 0.72), (0.40, 0.52), (0.58, 0.63), (0.82, 0.28)]
    pts = [(x * S, y * S) for (x, y) in pts_n]
    # 内边距让折线不贴边
    inset = S * 0.16
    span = S - inset * 2
    pts = [(inset + (x / S) * span, inset + (y / S) * span) for (x, y) in pts]
    line_w = max(S * 0.055, 1.0)
    dot_r = max(S * 0.075, 1.0)
    base_y = S * 0.86

    buf = bytearray(S * S * 3)
    for py in range(S):
        for px in range(S):
            i = (py * S + px) * 3
            cxx, cyy = px + 0.5, py + 0.5
            a = rounded_rect_alpha(0, 0, S - 1, S - 1, r, cxx, cyy)
            if a <= 0:
                continue
            t = (cxx + cyy) / (2.0 * S)
            col = lerp(NAVY, BLUE, min(1.0, t * 1.15))
            # 面积填充：折线下方、基线以上的区域
            if base_y > cyy > 0:
                # 计算该 y 处折线的 x（取所有交点中最右）
                xs = []
                for k in range(len(pts) - 1):
                    ax, ay = pts[k]
                    bx, by = pts[k + 1]
                    if (ay - cyy) * (by - cyy) <= 0 and ay != by:
                        xs.append(ax + (bx - ax) * (cyy - ay) / (by - ay))
                if xs and cyy >= min(p[1] for p in pts):
                    line_x = min(xs)
                    if cxx >= line_x and cyy <= base_y:
                        col = lerp(col, WHITE, 0.16)
            # 折线
            dmin = min(
                dist_to_seg(cxx, cyy, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1])
                for k in range(len(pts) - 1)
            )
            if dmin <= line_w / 2:
                col = WHITE
            elif dmin <= line_w / 2 + 0.6 * SS:
                col = lerp(col, WHITE, 0.5)
            # 末端高亮点
            dx, dy = cxx - pts[-1][0], cyy - pts[-1][1]
            dd = math.sqrt(dx * dx + dy * dy)
            if dd <= dot_r:
                col = GOLD
            buf[i] = col[0]
            buf[i + 1] = col[1]
            buf[i + 2] = col[2]

    # 盒式降采样
    out = bytearray(size * size * 4)
    n = SS * SS
    for y in range(size):
        for x in range(size):
            sr = sg = sb = 0
            for dy in range(SS):
                for dx in range(SS):
                    si = ((y * SS + dy) * S + (x * SS + dx)) * 3
                    sr += buf[si]
                    sg += buf[si + 1]
                    sb += buf[si + 2]
            oi = (y * size + x) * 4
            out[oi] = sr // n
            out[oi + 1] = sg // n
            out[oi + 2] = sb // n
            # 圆角外为透明
            a = rounded_rect_alpha(0, 0, size - 1, size - 1, size * 0.235, x + 0.5, y + 0.5)
            out[oi + 3] = 255 if a > 0.5 else 0
    return out


def write_png(path, size, rgba):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw.extend(rgba[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for s in SIZES:
        rgba = render(s)
        p = os.path.join(OUT_DIR, f"icon{s}.png")
        write_png(p, s, rgba)
        print("wrote", os.path.normpath(p), os.path.getsize(p), "bytes")


if __name__ == "__main__":
    main()
