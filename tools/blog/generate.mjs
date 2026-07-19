/* Redige et publie un article de blog OXO Spa, optimise SEO.
 *
 *   ANTHROPIC_API_KEY=... node tools/blog/generate.mjs
 *
 * Le modele (Sonnet 5 par defaut) redige uniquement le CONTENU structure ; ce
 * script assemble le HTML dans la template exacte des articles existants (head,
 * JSON-LD BlogPosting + FAQPage + BreadcrumbList, nav/footer partages, tracking),
 * insere la carte dans blog.html et l'URL dans sitemap.xml.
 *
 * Publication 100% automatique : la validation ci-dessous est le seul garde-fou.
 * A la moindre anomalie (JSON illisible, lien casse, balise interdite, doublon),
 * le script LEVE une erreur et n'ecrit RIEN -> le workflow echoue, rien n'est
 * publie. La regeneration des .md (build-llms.py) et les tests tournent apres,
 * cote workflow.
 *
 * Variables d'environnement :
 *   ANTHROPIC_API_KEY   requis
 *   ANTHROPIC_MODEL     optionnel (defaut claude-sonnet-5)
 */
// Le SDK Anthropic est importe dynamiquement dans main() : il n'est installe
// qu'en CI, et l'auto-test hors ligne (BLOG_SELFTEST) n'en a pas besoin.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SITE = "https://oxo-spa.com";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const REFERENCE = "blog-choisir-son-spa.html"; // article dont on reprend l'ossature

const CATEGORIES = ["Guide d'achat", "Conseils", "Bien-etre", "Bien-être", "Entretien", "Installation", "Technologie"];

// Images d'ambiance proposees au modele (nom -> ce qu'elles montrent).
const IMAGES = {
  "apropos-terrasse.webp": "spa haut de gamme sur une terrasse, ambiance chaleureuse",
  "parcours-terrasse.webp": "spa installe sur une terrasse en exterieur",
  "heure-bleue.webp": "spa la nuit avec eclairage LED, ambiance bleutee apaisante",
  "spa-exterieur.webp": "spa en exterieur dans un jardin",
  "detail-assises.webp": "gros plan sur les assises et buses d'un spa",
  "detail-ecran.webp": "ecran de commande tactile d'un spa",
  "detail-place.webp": "detail d'une place assise avec buses d'hydromassage",
};

// Pages reelles vers lesquelles le modele peut faire des liens internes.
const INTERNAL_PAGES = [
  "/", "/spas", "/nexus", "/breeze", "/ease", "/spa-de-nage-40", "/spa-de-nage-56",
  "/technologie", "/garanties", "/livraison", "/contact", "/qui-sommes-nous", "/blog",
];

/* ------------------------------------------------------------------ */
/* utilitaires                                                         */
/* ------------------------------------------------------------------ */
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const fail = (msg) => { throw new Error("[blog] " + msg); };

const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
function dates(d = new Date()) {
  const iso = d.toISOString().slice(0, 10);
  const human = `${d.getDate()} ${MONTHS_FR[d.getMonth()]} ${d.getFullYear()}`;
  return { iso, human };
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* Nettoie et valide un fragment de texte pouvant contenir uniquement
   <a href="/...">, <strong>, <em>. Toute autre balise ou lien externe -> erreur. */
function sanitizeInline(text, allow) {
  const t = String(text);
  if (/<\s*(script|style|iframe|img|svg|link|meta|form|input|button|h[1-6]|div|section)\b/i.test(t))
    fail("balise interdite dans un paragraphe : " + t.slice(0, 80));
  if (/on\w+\s*=|javascript:/i.test(t)) fail("attribut/URL dangereux : " + t.slice(0, 80));
  // liens : uniquement internes et vers une page reelle
  const tags = t.match(/<a\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const m = tag.match(/href\s*=\s*"([^"]*)"/i);
    if (!m) fail("lien sans href : " + tag);
    const href = m[1];
    if (!href.startsWith("/")) fail("lien externe interdit : " + href);
    const base = href.split(/[?#]/)[0];
    if (!allow.has(base)) fail("lien interne inconnu : " + href);
  }
  return t;
}

/* Choisit l'image d'apercu en evitant la repetition : l'image la moins utilisee
   par les articles existants. Le choix du modele n'est conserve que s'il fait
   deja partie des moins utilisees. Sur ~7 images et un rythme hebdo, toute la
   banque defile avant qu'une image ne revienne. */
function rotateHeroImage(modelPick, existing) {
  const pool = Object.keys(IMAGES);
  const count = Object.fromEntries(pool.map((k) => [k, 0]));
  for (const a of existing) if (a.img in count) count[a.img]++;
  const min = Math.min(...pool.map((k) => count[k]));
  const leastUsed = pool.filter((k) => count[k] === min);
  if (modelPick && leastUsed.includes(modelPick)) return modelPick;
  return leastUsed[0];
}

/* ------------------------------------------------------------------ */
/* registre des articles existants (dedup, cartes, "a lire aussi")     */
/* ------------------------------------------------------------------ */
function existingArticles() {
  const out = [];
  for (const f of readdirSync(ROOT)) {
    if (!/^blog-.+\.html$/.test(f)) continue;
    const s = readFileSync(join(ROOT, f), "utf8");
    const slug = f.replace(/\.html$/, "");
    const title = (s.match(/<h1>([^<]*)<\/h1>/) || [])[1] || slug;
    const cat = (s.match(/<span class="post__cat">([^<]*)<\/span>/) || [])[1] || "Conseils";
    const img = (s.match(/<div class="post__hero"><img src="\/assets\/images\/([^"]+)"/) || [])[1] || "apropos-terrasse.webp";
    out.push({ slug, title, cat, img });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* choix du sujet                                                      */
/* ------------------------------------------------------------------ */
async function pickTopic(client, existing) {
  const backlog = JSON.parse(read("tools/blog/topics.json")).topics || [];
  const existingSlugs = new Set(existing.map((a) => a.slug));
  for (const t of backlog) {
    if (!existingSlugs.has("blog-" + t.slug)) return t;
  }
  // backlog epuise : le modele propose un sujet inedit
  console.log("[blog] backlog epuise, le modele propose un sujet inedit.");
  const titles = existing.map((a) => a.title).join("\n- ");
  const msg = await client.messages.create({
    model: MODEL, max_tokens: 400,
    messages: [{
      role: "user",
      content: `Tu es responsable editorial d'OXO Spa (vente de spas et spas de nage a Toulouse). Propose UN sujet d'article de blog inedit, utile et optimise SEO, DIFFERENT de ceux-ci :\n- ${titles}\n\nReponds uniquement par un objet JSON : {"slug":"kebab-case","keyword":"mot-cle","category":"une categorie parmi Guide d'achat|Conseils|Bien-etre|Entretien|Installation","angle":"1 phrase"}`,
    }],
  });
  return JSON.parse(extractText(msg));
}

/* ------------------------------------------------------------------ */
/* appel au modele : redige le contenu                                 */
/* ------------------------------------------------------------------ */
function extractText(msg) {
  const txt = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!txt) fail("reponse du modele vide");
  let s = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < 0) fail("aucun JSON dans la reponse : " + s.slice(0, 120));
  return s.slice(a, b + 1);
}

async function writeArticle(client, topic, existing) {
  const imgList = Object.entries(IMAGES).map(([f, d]) => `  - ${f} : ${d}`).join("\n");
  const links = INTERNAL_PAGES.join(", ");
  const titles = existing.map((a) => a.title).join("\n- ");

  const system = `Tu es un redacteur SEO expert pour OXO Spa, vendeur de spas et de spas de nage base a Toulouse (showroom, livraison France entiere). Tu ecris en francais, dans un ton chaleureux, concret et expert, sans jargon inutile ni superlatifs creux. Objectif : un article de blog utile qui aide vraiment le lecteur ET qui construit le referencement du site (mot-cle, structure Hn, maillage interne, FAQ).

FAITS OXO SPA (n'invente rien d'autre) :
- Gamme en stock : Nexus (3 places, 26 buses, 4 695 €), Breeze (6 places, 27 buses, 5 743 €), Ease (5 places, 27 buses, cascade, 5 753 €). Sur commande : Spa de nage 5,80 m (7 500 €) et Spa convivial 4,00 m (9 500 €).
- Garanties : coque 5 ans, partie electrique 2 ans. Financement jusqu'a 120 mois avec Sofinco (un credit engage, sous reserve d'acceptation). Isolation pleine mousse, couverture isotherme de serie. Showroom a Toulouse, livraison partout en France sous 7 jours pour les modeles en stock, ~3 mois sur commande.

REGLES STRICTES :
- N'invente AUCUN prix, chiffre de consommation, statistique ou specification qui ne serait pas ci-dessus. Pour un cout d'usage, parle d'ordres de grandeur prudents ("selon l'isolation et l'usage"), jamais d'un chiffre presente comme garanti.
- Aucune promesse medicale. Reste sur le bien-etre et le confort.
- Liens internes : uniquement vers ces pages reelles : ${links}. Place 3 a 6 liens pertinents dans le corps (produits, livraison, garanties, contact, autres pages). Balise autorisee pour les liens : <a href="/...">texte</a>. Autres balises inline autorisees : <strong>, <em>. AUCUNE autre balise, aucun lien externe.
- Structure : intro accrocheuse, 4 a 6 sections en <h2>, quelques <h3> si utile, une conclusion orientee action (essai showroom / contact). 800 a 1200 mots.
- FAQ : 3 a 4 vraies questions que se pose un acheteur, reponses courtes et concretes.`;

  const user = `Ecris l'article sur le sujet : "${topic.keyword}" (angle : ${topic.angle}). Categorie : ${topic.category}.

Ne reprends PAS un sujet deja traite :\n- ${titles}

Choisis une image d'illustration dans cette liste (renvoie le nom de fichier exact) :\n${imgList}

Reponds UNIQUEMENT avec un objet JSON valide (pas de texte autour, pas de balises markdown), de cette forme EXACTE :
{
  "slug": "${topic.slug || "kebab-case-court"}",
  "metaTitle": "titre pour la balise <title>, ~55 caracteres, sans le nom du site",
  "h1": "titre de l'article (H1), accrocheur",
  "category": "${topic.category}",
  "metaDescription": "meta description de 140 a 160 caracteres, avec le mot-cle",
  "excerpt": "une phrase d'accroche pour la carte du blog, max 160 caracteres",
  "heroImage": "nom-de-fichier.webp",
  "readingMinutes": 6,
  "intro": "paragraphe d'introduction (peut contenir <a>/<strong>/<em>)",
  "sections": [
    { "heading": "Titre de section (H2)", "blocks": [ {"type":"p","text":"..."}, {"type":"h3","text":"Sous-titre"}, {"type":"p","text":"..."} ] }
  ],
  "faq": [ {"question":"...","answer":"..."} ]
}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system,
    messages: [{ role: "user", content: user }],
  });
  return JSON.parse(extractText(msg));
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */
function validate(a, existing, allow) {
  const need = ["slug", "metaTitle", "h1", "category", "metaDescription", "excerpt", "heroImage", "intro", "sections", "faq"];
  for (const k of need) if (!a[k]) fail("champ manquant : " + k);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(a.slug)) fail("slug invalide : " + a.slug);
  if (existing.some((x) => x.slug === "blog-" + a.slug)) fail("article deja existant : blog-" + a.slug);
  if (!CATEGORIES.includes(a.category)) fail("categorie inconnue : " + a.category);
  if (!IMAGES[a.heroImage]) fail("image inconnue : " + a.heroImage);
  if (a.metaDescription.length < 100 || a.metaDescription.length > 170) fail("meta description hors bornes (" + a.metaDescription.length + ")");
  if (!Array.isArray(a.sections) || a.sections.length < 3) fail("pas assez de sections");
  if (!Array.isArray(a.faq) || a.faq.length < 3 || a.faq.length > 5) fail("FAQ : 3 a 5 questions attendues");

  // longueur du corps (mots) — evite le contenu mince
  let words = a.intro.split(/\s+/).length;
  sanitizeInline(a.intro, allow);
  for (const sec of a.sections) {
    if (!sec.heading || !Array.isArray(sec.blocks)) fail("section malformee");
    for (const bl of sec.blocks) {
      if (bl.type !== "p" && bl.type !== "h3") fail("type de bloc invalide : " + bl.type);
      sanitizeInline(bl.text, allow);
      words += String(bl.text).split(/\s+/).length;
    }
  }
  for (const q of a.faq) { if (!q.question || !q.answer) fail("FAQ incomplete"); sanitizeInline(q.answer, allow); }
  if (words < 550) fail("article trop court (" + words + " mots)");
  return words;
}

/* ------------------------------------------------------------------ */
/* assemblage HTML                                                     */
/* ------------------------------------------------------------------ */
function buildHead(a, url, d) {
  const title = `${a.metaTitle} | Blog OXO Spa`;
  const img = `${SITE}/assets/images/${a.heroImage}`;
  const business = `{"@context": "https://schema.org", "@type": "HotTubStore", "name": "OXO Spa", "image": "${SITE}/assets/images/hero-terrasse.webp", "@id": "${SITE}/#business", "url": "${SITE}/", "telephone": "+33531605161", "priceRange": "€€€", "address": {"@type": "PostalAddress", "streetAddress": "11 impasse Pierre Camo", "addressLocality": "Toulouse", "postalCode": "31200", "addressRegion": "Occitanie", "addressCountry": "FR"}, "geo": {"@type": "GeoCoordinates", "latitude": 43.64207, "longitude": 1.42045}, "areaServed": {"@type": "Country", "name": "France"}, "openingHours": "Mo-Fr 09:00-18:00", "slogan": "Plus qu'un spa, un art de vivre"}`;
  const blogPosting = JSON.stringify({
    "@context": "https://schema.org", "@type": "BlogPosting", headline: a.h1, image: img,
    datePublished: d.iso, dateModified: d.iso,
    author: { "@type": "Organization", name: "OXO Spa" },
    publisher: { "@type": "Organization", name: "OXO Spa", logo: { "@type": "ImageObject", url: `${SITE}/assets/images/logo-oxo-spa.png` } },
    description: a.metaDescription, mainEntityOfPage: url,
  });
  const faqPage = JSON.stringify({
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: a.faq.map((q) => ({ "@type": "Question", name: q.question, acceptedAnswer: { "@type": "Answer", text: stripTags(q.answer) } })),
  });
  const crumbs = JSON.stringify({
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Accueil", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE}/blog` },
      { "@type": "ListItem", position: 3, name: a.category, item: url },
    ],
  });
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>${esc(title)}</title>
<meta name="description" content="${esc(a.metaDescription)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#0B1E33">
<meta property="og:type" content="article">
<meta property="og:site_name" content="OXO Spa">
<meta property="og:locale" content="fr_FR">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(a.metaDescription)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${img}">
<meta property="og:image:alt" content="OXO Spa — spas & spas de nage à Toulouse">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(a.metaDescription)}">
<meta name="twitter:image" content="${img}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@0,62..125,300..900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/styles.css">
<script type="application/ld+json">${business}</script>
<script type="application/ld+json">${blogPosting}</script>
<script type="application/ld+json">${faqPage}</script>
<script type="application/ld+json">${crumbs}</script>
</head>`;
}

const stripTags = (s) => String(s).replace(/<[^>]+>/g, "");

function buildBody(a, d, related) {
  const hero = `/assets/images/${a.heroImage}`;
  const secHtml = a.sections.map((sec) => {
    const inner = sec.blocks.map((bl) => bl.type === "h3" ? `<h3>${esc(bl.text)}</h3>` : `<p>${bl.text}</p>`).join("\n");
    return `<h2>${esc(sec.heading)}</h2>\n${inner}`;
  }).join("\n");
  const faqHtml = a.faq.map((q) => `<details><summary>${esc(q.question)}</summary><p>${q.answer}</p></details>`).join("");
  const relatedHtml = related.map((r) =>
    `<a class="post-card reveal" href="/${r.slug}"><div class="post-card__media"><img src="/assets/images/${r.img}" alt="${esc(r.title)}" loading="lazy" decoding="async"></div><div class="post-card__body"><span class="post-card__cat">${esc(r.cat)}</span><h3 class="post-card__title">${esc(r.title)}</h3><span class="post-card__go">Lire l'article <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></div></a>`
  ).join("");

  return `<article class="post">
  <div class="post__hero"><img src="${hero}" alt="${esc(a.h1)}"><div class="post__shade"></div>
    <div class="post__head"><div class="crumb"><a href="/">Accueil</a> · <a href="/blog">Blog</a> · <span>${esc(a.category)}</span></div>
      <span class="post__cat">${esc(a.category)}</span><h1>${esc(a.h1)}</h1>
      <div class="post__meta">Par OXO Spa · ${d.human} · ${a.readingMinutes || 7} min de lecture</div>
    </div>
  </div>
  <div class="post__body prose"><p>${a.intro}</p>
${secHtml}
    <h2>Questions fréquentes</h2><div class="faq">${faqHtml}</div>
    <div class="post__cta"><a class="btn btn--gold" href="/spas">Découvrir nos spas</a><a class="btn btn--ghost btn--dark" href="/contact?sujet=Renseignement">Poser une question</a></div>
  </div>
</article>
<section class="cat" style="padding-top:0"><h2 style="font-family:Archivo;font-weight:900;text-transform:uppercase;font-size:clamp(20px,2.4vw,30px);margin-bottom:20px">À lire aussi</h2><div class="blog-grid">${relatedHtml}</div></section>`;
}

/* ------------------------------------------------------------------ */
/* insertion index + sitemap                                           */
/* ------------------------------------------------------------------ */
function updateBlogIndex(a, slug, d) {
  const p = join(ROOT, "blog.html");
  let s = readFileSync(p, "utf8");
  const card = `<a class="post-card reveal" href="/${slug}"><div class="post-card__media"><img src="/assets/images/${a.heroImage}" alt="${esc(a.h1)}" loading="lazy" decoding="async"></div><div class="post-card__body"><span class="post-card__cat">${esc(a.category)} · ${d.human}</span><h2 class="post-card__title">${esc(a.h1)}</h2><p class="post-card__ex">${esc(a.excerpt)}</p><span class="post-card__go">Lire l'article <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></div></a>`;
  if (!s.includes('<div class="blog-grid">')) fail("blog.html : grille introuvable");
  s = s.replace('<div class="blog-grid">', '<div class="blog-grid">' + card);
  writeFileSync(p, s);
}

function updateSitemap(slug, d) {
  const p = join(ROOT, "sitemap.xml");
  let s = readFileSync(p, "utf8");
  const loc = `${SITE}/${slug}`;
  if (s.includes(`<loc>${loc}</loc>`)) return; // deja present
  const entry = `  <url><loc>${loc}</loc><lastmod>${d.iso}</lastmod><priority>0.6</priority></url>\n`;
  s = s.replace("</urlset>", entry + "</urlset>");
  writeFileSync(p, s);
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) fail("ANTHROPIC_API_KEY absente");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const d = dates();
  const existing = existingArticles();

  const topic = await pickTopic(client, existing);
  console.log(`[blog] sujet : ${topic.keyword} (${topic.category})`);

  // ossature partagee (nav + footer) reprise d'un article reel
  const ref = read(REFERENCE);
  const bodyOpen = (ref.match(/<body>[\s\S]*?<main id="top">/) || [])[0];
  const tail = (ref.match(/<\/main>[\s\S]*$/) || [])[0];
  if (!bodyOpen || !tail) fail("ossature de reference introuvable");

  const article = await writeArticle(client, topic, existing);
  const slug = "blog-" + article.slug;
  const url = `${SITE}/${slug}`;

  const allow = new Set([...INTERNAL_PAGES, ...existing.map((a) => "/" + a.slug), "/" + slug]);
  const words = validate(article, existing, allow);

  // Rotation des images : on evite de reprendre toujours la meme. On retient
  // l'image la MOINS utilisee par les articles existants ; si le choix du modele
  // fait deja partie des moins utilisees, on le respecte.
  article.heroImage = rotateHeroImage(article.heroImage, existing);

  // "a lire aussi" : 3 articles existants, categories variees si possible
  const pool = existing.slice();
  const related = [];
  const seenCat = new Set();
  for (const art of pool) { if (related.length >= 3) break; if (!seenCat.has(art.cat)) { related.push(art); seenCat.add(art.cat); } }
  for (const art of pool) { if (related.length >= 3) break; if (!related.includes(art)) related.push(art); }
  if (related.length < 3) fail("pas assez d'articles pour la section 'a lire aussi'");

  const html = buildHead(article, url, d) + "\n" + bodyOpen + "\n" + buildBody(article, d, related) + "\n" + tail;

  // ecritures (uniquement apres validation complete)
  writeFileSync(join(ROOT, slug + ".html"), html);
  updateBlogIndex(article, slug, d);
  updateSitemap(slug, d);

  console.log(`[blog] OK -> ${slug}.html (${words} mots, ${article.sections.length} sections, ${article.faq.length} FAQ)`);
  // expose le slug au workflow (pour le message de commit)
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `slug=${slug}\ntitle=${article.h1.replace(/\n/g, " ")}\n`, { flag: "a" });
}

/* Auto-test hors ligne : construit un article factice, le valide et l'assemble
   SANS appeler l'API ni ecrire dans les vrais fichiers. Verifie l'ossature.
     BLOG_SELFTEST=1 node tools/blog/generate.mjs                              */
function selftest() {
  const d = dates();
  const existing = existingArticles();
  if (existing.length < 3) fail("selftest : moins de 3 articles existants");
  const ref = read(REFERENCE);
  const bodyOpen = (ref.match(/<body>[\s\S]*?<main id="top">/) || [])[0];
  const tail = (ref.match(/<\/main>[\s\S]*$/) || [])[0];
  if (!bodyOpen || !tail) fail("selftest : ossature introuvable");

  const article = {
    slug: "selftest-" + Date.now(),
    metaTitle: "Article de test technique",
    h1: "Titre de test : bien choisir la taille de son spa",
    category: "Guide d'achat",
    metaDescription: "Meta description de test pour verifier l'assemblage du gabarit d'article de blog OXO Spa, avec le mot-cle taille de spa quelque part.",
    excerpt: "Une phrase d'accroche de test pour la carte du blog.",
    heroImage: "apropos-terrasse.webp",
    readingMinutes: 6,
    intro: `Ceci est une introduction de test qui renvoie vers <a href="/spas">nos spas</a> et met un mot en <strong>gras</strong>. ` + "Lorem ".repeat(80),
    sections: [
      { heading: "Premiere section", blocks: [{ type: "p", text: "Paragraphe avec lien vers le <a href=\"/nexus\">Nexus</a>. " + "mot ".repeat(150) }, { type: "h3", text: "Un sous-titre" }, { type: "p", text: "Autre paragraphe. " + "mot ".repeat(150) }] },
      { heading: "Deuxieme section", blocks: [{ type: "p", text: "Voir la <a href=\"/livraison\">livraison</a>. " + "mot ".repeat(150) }] },
      { heading: "Troisieme section", blocks: [{ type: "p", text: "Contactez le <a href=\"/contact\">showroom</a>. " + "mot ".repeat(150) }] },
    ],
    faq: [
      { question: "Question de test 1 ?", answer: "Reponse concrete un." },
      { question: "Question de test 2 ?", answer: "Reponse concrete deux, avec <a href=\"/garanties\">garanties</a>." },
      { question: "Question de test 3 ?", answer: "Reponse concrete trois." },
    ],
  };
  const slug = "blog-" + article.slug;
  const url = `${SITE}/${slug}`;
  const allow = new Set([...INTERNAL_PAGES, ...existing.map((a) => "/" + a.slug), "/" + slug]);
  const words = validate(article, existing, allow);
  const related = existing.slice(0, 3);
  const html = buildHead(article, url, d) + "\n" + bodyOpen + "\n" + buildBody(article, d, related) + "\n" + tail;
  writeFileSync("/tmp/blog-selftest.html", html);

  // controles structurels
  const checks = {
    "4 blocs JSON-LD": (html.match(/application\/ld\+json/g) || []).length === 4,
    "1 seul h1": (html.match(/<h1>/g) || []).length === 1,
    "canonical present": html.includes(`<link rel="canonical" href="${url}">`),
    "FAQ present": html.includes("Questions fréquentes"),
    "tracking.js": html.includes("/assets/tracking.js"),
    "nav present": html.includes('class="nav__brand"'),
    "footer present": /<footer/.test(html),
    "JSON-LD parse": [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].every((m) => { try { JSON.parse(m[1]); return true; } catch { return false; } }),
  };
  let okAll = true;
  for (const [k, v] of Object.entries(checks)) { console.log(`  ${v ? "OK " : "!! "} ${k}`); okAll = okAll && v; }
  console.log(`  mots: ${words} | fichier: /tmp/blog-selftest.html`);
  if (!okAll) fail("selftest : un controle a echoue");
  console.log("[blog] selftest OK");
}

if (process.env.BLOG_SELFTEST) { try { selftest(); } catch (e) { console.error(e.message || e); process.exit(1); } }
else main().catch((e) => { console.error(e.message || e); process.exit(1); });
