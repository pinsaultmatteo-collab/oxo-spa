#!/usr/bin/env python3
"""Ajoute (ou rafraichit) les balises <image:image> du sitemap.

Les fiches produit chargent la moitie de leurs vignettes en differe (data-src)
pour ne pas doubler le poids de la page : Google ne les voit donc pas dans le
HTML. Ce sitemap les declare explicitement, ce qui les rend indexables dans
Google Images sans rien couter en performance.

    python3 tools/build-sitemap-images.py

Idempotent : relancer le script reecrit les blocs image a partir du HTML.
"""
import html
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://oxo-spa.com"
SITEMAP = ROOT / "sitemap.xml"
NS = "http://www.google.com/schemas/sitemap-image/1.1"

# url du sitemap -> fichier HTML correspondant
def page_for(loc):
    path = loc[len(SITE):].strip("/")
    return ROOT / ((path or "index") + ".html")


RE_IMG = re.compile(r'<img\b[^>]*>')
RE_SRC = re.compile(r'\s(?:src|data-src)="(/assets/images/[^"]+)"')
RE_ALT = re.compile(r'\salt="([^"]*)"')
# vignettes de galerie : le bouton porte data-full, l'img interne le visuel
RE_FULL = re.compile(r'\sdata-full="(/assets/images/[^"]+)"')

SKIP = ("logo-pmc", "logo-oxo-spa")  # logos : hors sujet pour Google Images


def images_of(page: Path):
    """(url, legende) de chaque visuel de contenu de la page, dans l'ordre, sans doublon."""
    if not page.exists():
        return []
    s = page.read_text()
    out, seen = [], set()
    for tag in RE_IMG.findall(s):
        m = RE_SRC.search(tag)
        if not m:
            continue
        url = m.group(1)
        if any(k in url for k in SKIP) or url in seen:
            continue
        seen.add(url)
        alt = RE_ALT.search(tag)
        out.append((url, html.unescape(alt.group(1)) if alt else ""))
    # les vues pleine taille des galeries produit ne sont pas toujours dans un <img>
    for url in RE_FULL.findall(s):
        if url not in seen:
            seen.add(url)
            out.append((url, ""))
    return out


def esc(t):
    return html.escape(t, quote=False)


def main():
    src = SITEMAP.read_text()
    # repart d'un sitemap propre : on retire les blocs image existants
    src = re.sub(r"<image:image>.*?</image:image>", "", src, flags=re.S)
    src = src.replace(' xmlns:image="%s"' % NS, "")

    total, pages = 0, 0
    def inject(m):
        nonlocal total, pages
        block, loc = m.group(0), m.group(1)
        imgs = images_of(page_for(loc))
        if not imgs:
            return block
        tags = "".join(
            "<image:image><image:loc>%s%s</image:loc>%s</image:image>"
            % (SITE, u, ("<image:caption>%s</image:caption>" % esc(a)) if a else "")
            for u, a in imgs
        )
        total += len(imgs); pages += 1
        return block[: -len("</url>")] + tags + "</url>"

    out = re.sub(r"<url><loc>([^<]+)</loc>.*?</url>", inject, src, flags=re.S)
    out = out.replace(
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="%s">' % NS,
    )
    SITEMAP.write_text(out)
    print("  %d images declarees sur %d pages" % (total, pages))
    return 0


if __name__ == "__main__":
    sys.exit(main())
