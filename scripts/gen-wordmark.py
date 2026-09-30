#!/usr/bin/env python3
"""Regenerate the terminal splash wordmark in src/scene.js from a TTF font.

Rasterizes the wordmark text in an installed font, downscales it to terminal
cells, and shades each cell with ░▒▒▓█ so the ASCII logo matches the real
letterforms. Prints a JS array you can paste into WORDMARK in src/scene.js.

Usage:
  python scripts/gen-wordmark.py                 # defaults: Engravers, "700 AI"
  python scripts/gen-wordmark.py --rows 8 --factor 1.2 --text "700 AI"
  python scripts/gen-wordmark.py --font "C:\\path\\to\\font.ttf"
"""
import argparse
import io
from PIL import Image, ImageDraw, ImageFont

DEFAULT_FONT = r'C:\Users\hextu\AppData\Local\Microsoft\Windows\Fonts\engravrl.ttf'
SHADES = [(0.14, ' '), (0.34, '░'), (0.58, '▒'), (0.82, '▓'), (1.01, '█')]


def render(text, font_path, rows, factor):
    big = ImageFont.truetype(font_path, 400)
    probe = ImageDraw.Draw(Image.new('L', (10, 10)))
    bb = probe.textbbox((0, 0), text, font=big)
    img = Image.new('L', (bb[2] - bb[0] + 40, bb[3] - bb[1] + 40), 0)
    ImageDraw.Draw(img).text((20 - bb[0], 20 - bb[1]), text, font=big, fill=255)
    img = img.crop(img.getbbox())
    w, h = img.size
    cols = round((w / h) * rows * factor)  # factor squashes width to fit a terminal
    small = img.resize((cols, rows), Image.LANCZOS)
    px = small.load()
    lines = []
    for y in range(rows):
        line = ''
        for x in range(cols):
            t = px[x, y] / 255
            line += next(ch for thr, ch in SHADES if t < thr)
        lines.append(line.rstrip())
    width = max(len(l) for l in lines)
    return [l.ljust(width) for l in lines]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--text', default='700 AI')
    ap.add_argument('--font', default=DEFAULT_FONT)
    ap.add_argument('--rows', type=int, default=8)
    ap.add_argument('--factor', type=float, default=1.2)
    a = ap.parse_args()
    lines = render(a.text, a.font, a.rows, a.factor)
    out = io.StringIO()
    out.write('const WORDMARK = [\n')
    for l in lines:
        out.write("  '" + l + "',\n")
    out.write('];\n')
    print(out.getvalue())


if __name__ == '__main__':
    main()
