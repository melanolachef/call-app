# Generates every CPX Call icon from the 16x16 westie below.
# Run from the repository root: python3 assets/gerar-icones.py (needs Pillow).
from PIL import Image, ImageDraw
REPO = '.'
BG = '#8B5CF6'
COLORS = {'W': '#FFFFFF', 'K': '#0B0B0C', 'R': '#E5322D', 'P': '#FF9EB5', 'G': '#C9CCD3'}
ART = """
...K........K...
..KWK......KWK..
..KWPK....KPWK..
..KWPK....KPWK..
.KRRRRRRRRRRRRK.
.KWWWWWWWWWWWWK.
.KWWGGWWWWGGWWK.
KRKWWKWWWWKWWKRK
KRKWWKWWWWKWWKRK
KRKGWWWWWWWWGKRK
KRKWWWKKKKWWWKRK
.RWGWWWKKWWWGWK.
.RWWWWWPPWWWWWK.
..RKGWGWWGWGWK..
..KWKWWKKWWKWK..
...K.KK..KK.K...
""".split()
assert len(ART) == 16 and all(len(r) == 16 for r in ART)

def rects():
    for y, row in enumerate(ART):
        x = 0
        while x < 16:
            c = row[x]
            if c == '.':
                x += 1; continue
            run = 1
            while x + run < 16 and row[x + run] == c: run += 1
            yield c, x, y, run
            x += run

def svg(rounded=True):
    # 20x20 grid: 2 cells of purple around the 16x16 art; corners like the mockup.
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" shape-rendering="crispEdges">',
             f'<rect width="20" height="20" rx="{4 if rounded else 0}" fill="{BG}"/>']
    for c, x, y, w in rects():
        parts.append(f'<rect x="{x+2}" y="{y+2}" width="{w}" height="1" fill="{COLORS[c]}"/>')
    parts.append('</svg>')
    return ''.join(parts) + '\n'

def png(size, rounded=True, art_frac=0.8):
    scale = 8  # draw big then downsample for smooth corners
    S = size * scale
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if rounded: d.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.2, fill=BG)
    else: d.rectangle([0, 0, S, S], fill=BG)
    art = S * art_frac; off = (S - art) / 2; px = art / 16
    for c, x, y, w in rects():
        d.rectangle([round(off + x * px), round(off + y * px), round(off + (x + w) * px) - 1, round(off + (y + 1) * px) - 1], fill=COLORS[c])
    return im.resize((size, size), Image.LANCZOS)

open(f'{REPO}/static/favicon.svg', 'w').write(svg())
open(f'{REPO}/assets/logo.svg', 'w').write(svg())
open(f'{REPO}/assets/logo-light.svg', 'w').write(svg())
png(180, rounded=False).convert('RGB').save(f'{REPO}/static/apple-touch-icon.png')  # iOS rounds it
png(192).save(f'{REPO}/static/icon-192.png')
png(512).save(f'{REPO}/static/icon-512.png')
png(512, rounded=False, art_frac=0.62).save(f'{REPO}/static/icon-maskable-512.png')  # inside the safe zone
png(512).save(f'{REPO}/desktop/icons/icon.png')
png(256).save(f'{REPO}/desktop/icons/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('ok')
