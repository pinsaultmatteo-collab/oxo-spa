#!/usr/bin/env python3
"""Genere les fichiers destines aux LLM a partir des pages du site.

    python3 tools/build-llms.py

Produit, a la racine :
  <page>.md      une version markdown propre de chaque page
  llms.txt       l'index structure (spec llms.txt d'Answer.AI)
  llms-full.txt  tout le contenu concatene en un seul fichier

Les .md sont GENERES : ne pas les editer a la main, editer le HTML puis
relancer ce script. Stdlib uniquement, comme tools/check-prices.py.
"""
import re
import pathlib
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = "https://oxo-spa.com"

# Sections de llms.txt : (titre, [slugs]). L'ordre pilote llms.txt ET llms-full.txt.
SECTIONS = [
    ("Nos spas", [
        "spas", "nexus", "breeze", "ease", "spa-de-nage-40", "spa-de-nage-56",
    ]),
    ("Guides et conseils", [
        "blog", "blog-choisir-son-spa", "blog-spa-ou-spa-de-nage",
        "blog-bienfaits-hydromassage-chromotherapie", "blog-entretenir-son-spa",
    ]),
    ("Informations pratiques", [
        "technologie", "garanties", "livraison", "contact",
    ]),
    ("L'entreprise", [
        "qui-sommes-nous",
    ]),
    # "Optional" est un nom reserve par la spec llms.txt : il signale les pages
    # qu'un parseur peut ignorer quand le contexte est court. Ne pas traduire.
    ("Optional", [
        "cgv", "mentions-legales", "confidentialite",
    ]),
]

# Auto-decouverte des articles de blog : tout blog-*.html present est ajoute a la
# section "Guides et conseils" (apres les articles curates, ordre alphabetique),
# pour que les articles generes automatiquement rejoignent llms.txt / llms-full.txt
# et aient leur .md — sans avoir a editer ce fichier a chaque nouvel article.
for _title, _slugs in SECTIONS:
    if _title == "Guides et conseils":
        _known = set(_slugs)
        for _p in sorted(ROOT.glob("blog-*.html")):
            if _p.stem not in _known:
                _slugs.append(_p.stem)
        break

# Pages du tunnel d'achat : sans contenu editorial, aucun interet pour un LLM.
EXCLUDE = {"panier", "commande", "confirmation", "index"}

# Sous-arbres purement visuels ou interactifs : rien a en tirer en markdown.
SKIP_TREE = {
    "svg", "script", "style", "button", "form", "input", "label",
    "iframe", "noscript", "nav", "footer", "select", "textarea",
}
# Balises orphelines : pas de fermeture, donc jamais de sous-arbre a sauter.
# Sans ca, un <input> ouvrirait un skip que rien ne refermerait et le reste
# de la page passerait a la trappe.
VOID = {
    "input", "img", "br", "hr", "meta", "link", "source", "embed",
    "track", "area", "col", "base", "param", "wbr",
}
BLOCK = {
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "div", "section", "article",
    "details", "summary", "aside", "li", "ul", "ol", "br", "tr",
}
HEADING = {"h1": "# ", "h2": "## ", "h3": "### ", "h4": "#### ", "h5": "##### ", "h6": "###### "}


class ToMarkdown(HTMLParser):
    """Convertit le <main> d'une page en markdown. Stdlib uniquement."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []
        self.buf = []
        self.skip = 0
        self.prefix = ""
        # Pile des <a> ouverts : [buffer_exterieur, href, contient_un_bloc]
        self.a_stack = []
        # Tableau en cours : liste de lignes, chaque ligne = liste de cellules.
        # None hors <table>.
        self.table = None
        self.row = None

    @property
    def in_a(self):
        return bool(self.a_stack)

    def sep(self, s=" · "):
        """Separe deux elements colles (<span>Places</span><span>3</span>).

        Sans ca on obtiendrait "Places3", et surtout "Zone 1500 EUR HT" pour
        "Zone 1" + "500 EUR HT" : un prix faux pour qui lit le markdown.
        """
        t = "".join(self.buf).rstrip()
        if not t or t.endswith(("[", "(", "*", "\u00b7", "\u2014")):
            return
        self.buf = [t, s]

    def flush(self):
        text = "".join(self.buf)
        self.buf = []
        text = text.replace("\xa0", " ")
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r" *\n *", "\n", text).strip()
        if text:
            # l'<em> des titres est decoratif ("Nos <em>spas</em>") : en
            # markdown il ne porte aucun sens, on le retire
            if self.prefix.startswith("#"):
                text = text.replace("*", "")
            self.blocks.append(self.prefix + text)
        self.prefix = ""

    def handle_starttag(self, tag, attrs):
        if self.skip:
            self.skip += tag in SKIP_TREE and tag not in VOID
            return
        if tag in SKIP_TREE:
            if tag not in VOID:
                self.skip = 1
            return

        if tag == "br":
            self.buf.append(" " if self.in_a else "\n")
            return

        # -- tableaux : un vrai tableau markdown, pas des cellules collees ----
        if tag == "table":
            self.flush()
            self.table = []
            return
        if self.table is not None:
            if tag == "tr":
                self.row = []
                return
            if tag in ("td", "th"):
                self.buf = []
                return
            if tag in ("thead", "tbody", "tfoot"):
                return
        if tag == "caption":
            self.flush()
            return

        if tag in BLOCK:
            if self.in_a:
                # Un lien-carte enveloppe des blocs : on note le fait et on
                # garde tout sur une ligne, sinon le lien serait coupe en deux.
                self.a_stack[-1][2] = True
                self.sep(" \u2014 ")
            else:
                self.flush()

        if tag == "a":
            href = dict(attrs).get("href", "")
            if not href or href.startswith(("#", "javascript:")):
                href = None
            if self.in_a:
                self.a_stack.append([None, None, False])  # <a> imbrique : ignore
            else:
                self.a_stack.append([self.buf, href, False])
                self.buf = []
        elif tag in HEADING:
            # un titre dans un lien-carte n'est pas un titre de document
            if not self.in_a:
                self.prefix = HEADING[tag]
        elif tag == "summary":
            self.prefix = "**"  # question de FAQ
        elif tag == "li":
            self.prefix = "- "
        elif tag == "span":
            self.sep()
        elif tag in ("b", "strong"):
            self.buf.append("**")
        elif tag in ("em", "i"):
            self.buf.append("*")

    def handle_endtag(self, tag):
        if self.skip:
            if tag in SKIP_TREE and tag not in VOID:
                self.skip -= 1
            return

        if self.table is not None:
            if tag in ("td", "th"):
                cell = re.sub(r"\s+", " ", "".join(self.buf)).replace("|", "\\|").strip()
                if self.row is not None:
                    self.row.append(cell)
                self.buf = []
                return
            if tag == "tr":
                if self.row:
                    self.table.append(self.row)
                self.row = None
                return
            if tag == "table":
                rows, self.table = self.table, None
                if rows:
                    head = rows[0]
                    md = ["| " + " | ".join(head) + " |",
                          "|" + "|".join([" --- "] * len(head)) + "|"]
                    for r in rows[1:]:
                        r = r + [""] * (len(head) - len(r))  # ligne courte
                        md.append("| " + " | ".join(r[:len(head)]) + " |")
                    self.blocks.append("\n".join(md))
                return
            if tag in ("thead", "tbody", "tfoot"):
                return
        if tag == "caption":
            self.flush()
            return

        if tag == "a":
            if not self.a_stack:
                return
            saved, href, saw_block = self.a_stack.pop()
            if saved is None:
                return
            inner = re.sub(r"\s+", " ", "".join(self.buf)).strip(" \u00b7\u2014")
            self.buf = saved
            if not inner:
                return
            if href:
                url = SITE + href if href.startswith("/") else href
                inner = f"[{inner}]({url})"
            if saw_block:
                # lien-carte : une ligne a lui, hors du paragraphe courant
                self.flush()
                self.buf = [inner]
                self.flush()
            else:
                self.sep()
                self.buf.append(inner)
            return

        if tag in ("b", "strong"):
            self.buf.append("**")
        elif tag in ("em", "i"):
            self.buf.append("*")
        elif tag == "summary":
            self.buf.append("**")
            self.flush()
        elif tag in BLOCK:
            if self.in_a:
                self.sep(" \u2014 ")
            else:
                self.flush()

    def handle_data(self, data):
        if not self.skip:
            self.buf.append(data)

    def result(self):
        self.flush()
        # un bloc reduit a du balisage vide (**, - ) n'apporte rien
        return [b for b in self.blocks if b.strip(" *-#[]()")]


def meta(html, name=None, prop=None):
    if name:
        m = re.search(rf'<meta name="{name}" content="([^"]*)"', html)
    else:
        m = re.search(rf'<meta property="{prop}" content="([^"]*)"', html)
    return m.group(1).strip() if m else ""


def page_title(html):
    m = re.search(r"<title>(.*?)</title>", html, re.S)
    t = re.sub(r"\s+", " ", m.group(1)).strip() if m else ""
    # "Spa Nexus ... | OXO Spa Toulouse" -> "Spa Nexus ..."
    return t.split("|")[0].strip()


def convert(slug):
    html = (ROOT / f"{slug}.html").read_text(encoding="utf-8")
    m = re.search(r"<main.*?</main>", html, re.S)
    if not m:
        raise SystemExit(f"{slug}.html : pas de <main>")
    p = ToMarkdown()
    p.feed(m.group(0))
    blocks = p.result()
    title = page_title(html)
    desc = meta(html, name="description")

    # Le h1 de la page sert de titre du document : on le sort du corps pour
    # ne pas avoir deux titres de niveau 1 dans le meme fichier.
    h1 = next((b for b in blocks if b.startswith("# ")), None)
    if h1:
        blocks = [b for b in blocks if b is not h1]
        title = h1[2:].strip()

    body = "\n\n".join(blocks)
    head = f"# {title}\n\n> {desc}\n\n*Source : {SITE}/{slug}*"
    return page_title(html), desc, f"{head}\n\n{body}\n"


def main():
    pages = {}
    for _, slugs in SECTIONS:
        for slug in slugs:
            title, desc, md = convert(slug)
            (ROOT / f"{slug}.md").write_text(md, encoding="utf-8")
            pages[slug] = (title, desc, md)
            print(f"  {slug}.md ({len(md):,} car.)".replace(",", " "))

    home = (ROOT / "index.html").read_text(encoding="utf-8")
    summary = meta(home, name="description")

    # ---- llms.txt : l'index -------------------------------------------
    out = [f"# OXO Spa", "", f"> {summary}", ""]
    out += [
        "OXO Spa est un vendeur de spas et de spas de nage basé à Toulouse (Occitanie, France),",
        "avec un showroom où les modèles sont visibles et essayables, et une livraison partout en France.",
        "Trois modèles (Breeze, Nexus, Ease) sont en arrivage et livrables sous 7 jours ; le spa de nage",
        "et le spa convivial sont fabriqués sur commande (~3 mois). Les prix affichés sont TTC et fermes",
        "pour toute commande en ligne.",
        "",
        "Chaque page ci-dessous existe en markdown (.md) et en HTML (même URL sans l'extension).",
        "Contact : 11 impasse Pierre Camo, 31200 Toulouse — 05 31 60 51 61.",
        "",
    ]
    for name, slugs in SECTIONS:
        out.append(f"## {name}")
        out.append("")
        for slug in slugs:
            title, desc, _ = pages[slug]
            out.append(f"- [{title}]({SITE}/{slug}.md): {desc}")
        out.append("")
    (ROOT / "llms.txt").write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")

    # ---- llms-full.txt : tout le contenu -------------------------------
    full = [
        "# OXO Spa — contenu complet",
        "",
        f"> {summary}",
        "",
        f"Ce fichier regroupe le contenu de toutes les pages de {SITE}.",
        "Généré automatiquement à partir du site.",
        "",
    ]
    for name, slugs in SECTIONS:
        for slug in slugs:
            full.append("---")
            full.append("")
            full.append(pages[slug][2].strip())
            full.append("")
    (ROOT / "llms-full.txt").write_text("\n".join(full).rstrip() + "\n", encoding="utf-8")

    print(f"\n  llms.txt        ({len((ROOT / 'llms.txt').read_text()):,} car.)".replace(",", " "))
    print(f"  llms-full.txt   ({len((ROOT / 'llms-full.txt').read_text()):,} car.)".replace(",", " "))
    print(f"\n{len(pages)} pages generees.")


if __name__ == "__main__":
    main()
