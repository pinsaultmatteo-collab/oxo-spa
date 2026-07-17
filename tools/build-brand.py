#!/usr/bin/env python3
"""Genere les fichiers de marque OXO Spa a partir du logo du header.

    python3 tools/build-brand.py

Le logo de reference est le SVG inline du <a class="nav__brand"> : deux cercles
(or + aqua) et un "O" centre. Ce script en fait des fichiers autonomes :

  assets/images/logo-oxo-spa.svg   le logo vectoriel complet
  assets/images/logo-oxo-spa.png   512x512, fond transparent -> schema publisher.logo
  favicon.svg                      le rond, vectoriel (navigateurs modernes)
  favicon.ico                      repli 16/32/48 px
  apple-touch-icon.png             180x180, fond plein (iOS ignore la transparence)

Le "O" est rasterise avec une police systeme : Archivo (police du site) vient de
Google Fonts et n'est pas installee localement. Le rendu PNG est donc une
approximation fidele en forme, pas au glyphe pres.

Stdlib + Pillow uniquement.
"""
import pathlib
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent

GOLD = "#B0883A"
AQUA = "#244B6E"
INK = "#0E1A2B"
BONE = "#F5F6F8"

# Police de repli pour le "O" : Archivo n'est pas installee (Google Fonts).
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]

# Geometrie reprise telle quelle du SVG du header (viewBox 0 0 120 120).
VB = 120
R_OUT, W_OUT = 54, 4
R_IN, W_IN = 40, 3

SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VB} {VB}" role="img" aria-label="OXO Spa">
  <title>OXO Spa</title>
  <circle cx="60" cy="60" r="{R_OUT}" fill="none" stroke="{GOLD}" stroke-width="{W_OUT}"/>
  <circle cx="60" cy="60" r="{R_IN}" fill="none" stroke="{AQUA}" stroke-width="{W_IN}"/>
  <text x="60" y="72" text-anchor="middle" font-family="Archivo, Arial, Helvetica, sans-serif"
        font-weight="900" font-size="38" fill="{{ink}}">O</text>
</svg>
"""


def font(px):
    for p in FONT_CANDIDATES:
        if pathlib.Path(p).exists():
            try:
                return ImageFont.truetype(p, px)
            except OSError:
                continue
    return ImageFont.load_default()


def draw_mark(size, bg=None, ink=INK):
    """Dessine le rond. Rendu 4x puis reduit : Pillow ne lisse pas les cercles."""
    s = size * 4
    img = Image.new("RGBA", (s, s), bg or (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = s / VB  # echelle viewBox -> pixels

    def ring(r, color, w):
        rr, ww = r * k, max(1, round(w * k))
        d.ellipse([s / 2 - rr, s / 2 - rr, s / 2 + rr, s / 2 + rr], outline=color, width=ww)

    ring(R_OUT, GOLD, W_OUT)
    ring(R_IN, AQUA, W_IN)

    f = font(round(52 * k))
    d.text((s / 2, s / 2), "O", font=f, fill=ink, anchor="mm")
    return img.resize((size, size), Image.LANCZOS)


def main():
    out = []

    # -- logo vectoriel + raster pour le schema ---------------------------
    (ROOT / "assets/images/logo-oxo-spa.svg").write_text(SVG.format(ink=INK), encoding="utf-8")
    out.append("assets/images/logo-oxo-spa.svg")

    # Google attend un logo rasterise >= 112x112 pour publisher.logo.
    draw_mark(512).save(ROOT / "assets/images/logo-oxo-spa.png")
    out.append("assets/images/logo-oxo-spa.png (512x512)")

    # -- favicons --------------------------------------------------------
    (ROOT / "favicon.svg").write_text(SVG.format(ink=INK), encoding="utf-8")
    out.append("favicon.svg")

    # .ico multi-tailles : repli pour les navigateurs sans support SVG
    draw_mark(64).save(ROOT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    out.append("favicon.ico (16/32/48)")

    # iOS ignore la transparence et colle du noir : on force un fond clair
    draw_mark(180, bg=BONE).save(ROOT / "apple-touch-icon.png")
    out.append("apple-touch-icon.png (180x180)")

    for f in out:
        p = ROOT / f.split(" ")[0]
        print(f"  {f:44} {p.stat().st_size:>7,} o".replace(",", " "))


if __name__ == "__main__":
    main()
