#!/usr/bin/env python3
"""Generate the extension icons (pure stdlib: no Pillow).

Design: deep-ink rounded square, two cream ledger lines, brass dot —
the popup identity at 16–128 px. Renders 4× supersampled, box-downsampled.
"""
import struct
import zlib
from pathlib import Path

INK = (28, 31, 39)
CREAM = (233, 231, 221)
BRASS = (213, 184, 126)

OUT = Path(__file__).resolve().parent.parent / "icons"


def rounded_rect(x, y, x0, y0, x1, y1, r):
    """Signed 'inside' test for a rounded rectangle."""
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r or (
        x0 + r <= x <= x1 - r and y0 <= y <= y1
    ) or (x0 <= x <= x1 and y0 + r <= y <= y1 - r)


def circle(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def render(size, ss=4):
    w = size * ss
    px = [[(0, 0, 0, 0)] * w for _ in range(w)]
    u = w  # unit = full canvas
    bg = (0.04 * u, 0.04 * u, 0.96 * u, 0.96 * u, 0.21 * u)
    line1 = (0.24 * u, 0.40 * u, 0.60 * u, 0.485 * u, 0.042 * u)
    line2 = (0.24 * u, 0.575 * u, 0.76 * u, 0.66 * u, 0.042 * u)
    dot = (0.72 * u, 0.315 * u, 0.115 * u)

    for j in range(w):
        for i in range(w):
            x, y = i + 0.5, j + 0.5
            if not rounded_rect(x, y, bg[0], bg[1], bg[2], bg[3], bg[4]):
                continue
            color = INK
            if circle(x, y, dot[0], dot[1], dot[2]):
                color = BRASS
            elif rounded_rect(x, y, line1[0], line1[1], line1[2], line1[3], line1[4]):
                color = CREAM
            elif rounded_rect(x, y, line2[0], line2[1], line2[2], line2[3], line2[4]):
                color = CREAM
            px[j][i] = (color[0], color[1], color[2], 255)

    # box downsample ss×ss
    out = []
    for j in range(size):
        row = []
        for i in range(size):
            r = g = b = a = 0
            for dj in range(ss):
                for di in range(ss):
                    pr, pg, pb, pa = px[j * ss + dj][i * ss + di]
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            n = ss * ss
            if a == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((r // a, g // a, b // a, a // n))
        out.append(row)
    return out


def write_png(path, pixels):
    size = len(pixels)
    raw = b""
    for row in pixels:
        raw += b"\x00" + b"".join(struct.pack("4B", *p) for p in row)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(OUT / f"icon{size}.png", render(size))
        print(f"icons/icon{size}.png")
