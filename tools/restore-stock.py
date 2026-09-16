#!/usr/bin/env python3
"""Sort le site de l'etat "rupture de stock" et le remet comme avant.

    python3 tools/restore-stock.py [--check]

Retire le bandeau de toutes les pages, remet la pastille verte "En stock" sur
Nexus / Breeze / Ease, repasse le schema Product en InStock, restaure les titres
et les textes de disponibilite, et remet --banner-h a 0.

Le CSS de la rupture (.stockbar, .soldout) et assets/stock.js sont CONSERVES :
ils ne servent plus a rien tant qu'aucune page ne les appelle, et ils permettent
de refaire une rupture en une passe si un arrivage se represente.

Sécurité : chaque remplacement attendu est verifie. Si le site a evolue entre
temps et qu'un motif est introuvable, le script s'arrete SANS RIEN ECRIRE plutot
que de laisser le site a moitie restaure.

--check : dit seulement s'il y a quelque chose a restaurer (code 0 = oui, 1 = non).
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STOCK_MODELS = ("nexus", "breeze", "ease")

RE_BANNER = re.compile(r'\n<div class="stockbar".*?</div>\n', re.S)
RE_STOCKJS = re.compile(r'\n<script src="/assets/stock\.js" defer></script>')
RE_PDP_BADGE = re.compile(r'<span class="pdp__pic-badge soldout">.*?</span></span>', re.S)

PDP_BADGE_OK = '<span class="pdp__pic-badge stock"><span class="d"></span>En stock</span>'

# Remplacements appliques a toutes les pages : (rupture -> etat normal, obligatoire ?)
GLOBAL = [
    ('<span class="card__badge soldout"><span class="d"></span>Rupture de stock</span>',
     '<span class="card__badge stock"><span class="d"></span>En stock</span>', False),
    ('<span class="cat-card__badge soldout"><span class="d"></span>Rupture de stock</span>',
     '<span class="cat-card__badge stock"><span class="d"></span>En stock</span>', False),
    ('<span class="eyebrow">Rupture de stock · Arrivage fin novembre</span>',
     '<span class="eyebrow">En stock · Livraison 7 jours</span>', False),
    ('<section class="cat"><h2>Arrivage fin novembre</h2>',
     '<section class="cat"><h2>En stock</h2>', False),
    ('<span class="cmp__tag">Rupture · fin nov.</span>',
     '<span class="cmp__tag">En stock</span>', False),
    ("Arrivage fin novembre, livraison 7 jours", "En stock, livraison 7 jours", False),
    # accueil
    ("    ARRIVAGE : <span>FIN NOV.</span>", "    STOCK : BREEZE · NEXUS · EASE", False),
    ('<span class="hero__instock soldout"><span class="d"></span>Rupture · arrivage fin nov.</span>',
     '<span class="hero__instock"><span class="d"></span>En stock</span>', False),
    ('<div class="gk">Livraison gamme courante</div>', '<div class="gk">Livraison en stock</div>', False),
    ("      <h3>Réservé maintenant, livré sous 7 jours</h3>\n"
     "      <p>Breeze, Nexus et Ease sont en rupture : le prochain arrivage est attendu fin novembre."
     " Paiement intégral sécurisé à la commande, puis livraison partout en France sous une semaine après réception.</p>",
     "      <h3>En stock, livré sous 7 jours</h3>\n"
     "      <p>Breeze, Nexus et Ease sont disponibles immédiatement. Paiement intégral sécurisé,"
     " puis livraison partout en France sous une semaine.</p>", False),
    # titres et descriptions
    ("Spa Breeze 6 places à Toulouse", "Spa Breeze 6 places — en stock à Toulouse", False),
    ("Spa Ease 5 places à Toulouse", "Spa Ease 5 places — en stock à Toulouse", False),
    ("les modèles de la gamme courante", "les modèles en stock", False),
    ("Les spas de la gamme courante (Breeze, Nexus, Ease)", "Les spas en stock (Breeze, Nexus, Ease)", False),
    ("trois spas de la gamme courante", "trois spas en stock", False),
    ("Trois spas de la gamme courante", "Trois spas en stock", False),
    ('og:description" content="Spécialiste du spa et du spa de nage à Toulouse. Livraison France entière',
     'og:description" content="Spécialiste du spa et du spa de nage à Toulouse. Modèles en stock, livraison France entière', False),
    ("Breeze, Nexus, Ease et spa de nage", "Breeze, Nexus, Ease en stock et spa de nage", False),
    ("la sélection courante", "la sélection en stock", False),
    # articles de blog
    ("Ces deux modèles sont actuellement en rupture — prochain arrivage fin novembre — et la"
     ' <a href="/livraison">livraison</a> se fait ensuite sous 7 jours',
     'Ces deux modèles étant en stock, la <a href="/livraison">livraison</a> se fait sous 7 jours', False),
    ("Le Nexus et l'Ease sont actuellement en rupture, prochain arrivage fin novembre ;"
     " la livraison se fait ensuite sous 7 jours",
     "Le Nexus et l'Ease étant en stock, la livraison se fait sous 7 jours", False),
    ("Toute notre gamme est actuellement en rupture, prochain arrivage fin novembre, pour une livraison sous 7 jours",
     "Toute notre gamme est disponible en stock pour une livraison sous 7 jours", False),
]


def en_rupture():
    return any('class="stockbar"' in p.read_text() for p in ROOT.glob("*.html"))


def restore():
    pages = sorted(ROOT.glob("*.html"))
    if not en_rupture():
        # deja restaure : ce n'est pas une erreur, le script doit pouvoir etre relance
        print("Rien a restaurer : le site n'est pas en rupture de stock.")
        return 1
    planned, problems = {}, []

    for p in pages:
        s = orig = p.read_text()
        s = RE_BANNER.sub("", s)
        for a, b, _req in GLOBAL:
            s = s.replace(a, b)
        if p.stem in STOCK_MODELS:
            s, n = RE_PDP_BADGE.subn(PDP_BADGE_OK, s)
            if n != 1:
                problems.append("%s : %d pastille(s) de fiche trouvee(s), 1 attendue" % (p.name, n))
            s = RE_STOCKJS.sub("", s)
            s = s.replace('"availability": "https://schema.org/BackOrder"',
                          '"availability": "https://schema.org/InStock"')
        if s != orig:
            planned[p] = s

    # verifications globales avant ecriture
    for p, s in planned.items():
        for marker in ('class="stockbar"', "soldout", "stock.js", "BackOrder",
                       "Arrivage fin novembre", "gamme courante"):
            if marker in s:
                problems.append("%s : '%s' encore present apres restauration" % (p.name, marker))

    css = ROOT / "assets" / "styles.css"
    css_s = css.read_text()
    if ":root{--banner-h:38px}" in css_s:
        css_new = (css_s.replace(":root{--banner-h:38px}", ":root{--banner-h:0px}")
                        .replace("  :root{--banner-h:34px}", "  :root{--banner-h:0px}"))
    else:
        css_new = css_s

    if problems:
        print("ECHEC — rien n'a ete ecrit :", file=sys.stderr)
        for x in problems:
            print("  -", x, file=sys.stderr)
        return 2

    if not planned and css_new == css_s:
        print("Rien a restaurer : le site n'est pas en rupture de stock.")
        return 1

    for p, s in planned.items():
        p.write_text(s)
    if css_new != css_s:
        css.write_text(css_new)
    print("  %d pages restaurees + styles.css (--banner-h a 0)" % len(planned))
    print("  Conserves pour une prochaine fois : assets/stock.js et le CSS .stockbar/.soldout.")
    return 0


if __name__ == "__main__":
    if "--check" in sys.argv:
        print("rupture en cours" if en_rupture() else "pas de rupture en cours")
        sys.exit(0 if en_rupture() else 1)
    sys.exit(restore())
