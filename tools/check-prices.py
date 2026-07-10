#!/usr/bin/env python3
"""Verifie que les prix affiches dans le HTML correspondent au catalogue.

Le HTML garde des prix en dur (necessaire pour le SEO : ils doivent etre dans la
source, pas injectes en JS). assets/products.json fait autorite. Ce script empeche
les deux de diverger silencieusement.

    python3 tools/check-prices.py     -> code 0 si tout concorde, 1 sinon
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CAT = json.loads((ROOT / "assets" / "products.json").read_text(encoding="utf-8"))

PRODUCTS = {p["id"]: p for p in CAT["products"]}
OPTIONS = {o["id"]: o for o in CAT["options"]}
FIN = CAT["financing"]

# page -> id produit (les URL historiques ne refletent plus les noms)
PAGE_OF = {
    "nexus.html": "nexus",
    "breeze.html": "breeze",
    "ease.html": "ease",
    "spa-de-nage-40.html": "spa-de-nage",
    "spa-de-nage-56.html": "spa-convivial",
}

errors = []


def fail(msg):
    errors.append(msg)


def euros(n):
    """4695 -> '4 695' (espace insecable etroite absente du HTML : espace simple)."""
    return f"{n:,}".replace(",", " ")


def monthly(price):
    """Mensualite sur 60 mois, meme formule que le simulateur du site."""
    taeg = FIN["taegBelowThreshold"] if price < FIN["threshold"] else FIN["taegFromThreshold"]
    r = taeg / 1200
    n = FIN["months"]
    return round(price * r / (1 - (1 + r) ** -n))


def check_product_pages():
    for page, pid in PAGE_OF.items():
        src = (ROOT / page).read_text(encoding="utf-8")
        p = PRODUCTS[pid]

        m = re.search(r'data-pdp-id="([^"]+)"[^>]*data-pdp-base="(\d+)"', src)
        if not m:
            fail(f"{page}: data-pdp-id/data-pdp-base introuvable")
            continue
        if m.group(1) != pid:
            fail(f"{page}: data-pdp-id={m.group(1)!r}, attendu {pid!r}")
        if int(m.group(2)) != p["price"]:
            fail(f"{page}: data-pdp-base={m.group(2)}, catalogue={p['price']}")

        for sim in re.findall(r'data-sim="(\d+)"', src):
            if int(sim) != p["price"]:
                fail(f"{page}: data-sim={sim}, catalogue={p['price']}")

        for sp in re.findall(r'"price": "(\d+)"', src):
            if int(sp) != p["price"]:
                fail(f"{page}: schema.org price={sp}, catalogue={p['price']}")

        if f"{euros(p['price'])} €" not in src:
            fail(f"{page}: prix affiche {euros(p['price'])} € absent")

        for om in re.finditer(r'data-opt data-opt-id="([^"]+)" data-price="(\d+)"', src):
            oid, price = om.group(1), int(om.group(2))
            if oid not in OPTIONS:
                fail(f"{page}: option inconnue {oid!r}")
            elif price != OPTIONS[oid]["price"]:
                fail(f"{page}: option {oid} a {price} €, catalogue={OPTIONS[oid]['price']} €")


def check_listing(page):
    """index.html et spas.html : prix affiches + mensualites en dur."""
    src = (ROOT / page).read_text(encoding="utf-8")

    for pid, p in PRODUCTS.items():
        if f"{euros(p['price'])} €" not in src:
            fail(f"{page}: prix {euros(p['price'])} € ({pid}) absent")

    sims = Counter(int(x) for x in re.findall(r'data-sim="(\d+)"', src))
    expected_sims = Counter(p["price"] for p in PRODUCTS.values())
    if sims != expected_sims:
        fail(f"{page}: data-sim {dict(sims)} != catalogue {dict(expected_sims)}")

    found = Counter(int(x) for x in re.findall(r"<b>(\d+)&nbsp;€</b>", src))
    expected = Counter(monthly(p["price"]) for p in PRODUCTS.values())
    if found != expected:
        fail(f"{page}: mensualites {dict(found)} != calcul {dict(expected)}")


def check_no_prices_in_cart_buttons():
    src = (ROOT / "index.html").read_text(encoding="utf-8")
    if re.search(r"data-add[^>]*data-price", src):
        fail("index.html: un bouton [data-add] porte encore un data-price (prix manipulable)")
    for m in re.finditer(r"data-add data-id=\"([^\"]+)\"", src):
        if m.group(1) not in PRODUCTS:
            fail(f"index.html: data-id inconnu {m.group(1)!r}")


check_product_pages()
check_listing("index.html")
check_listing("spas.html")
check_no_prices_in_cart_buttons()

if errors:
    print(f"✗ {len(errors)} incoherence(s) entre le HTML et assets/products.json :\n")
    for e in errors:
        print("  -", e)
    sys.exit(1)

print(f"✓ prix coherents : {len(PRODUCTS)} produits, {len(OPTIONS)} options, "
      f"{len(PAGE_OF) + 2} pages verifiees")
