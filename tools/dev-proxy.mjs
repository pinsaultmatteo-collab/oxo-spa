/* Serveur de recette : sert le site statique en local et relaie /api/* vers un
 * deploiement Vercel. Permet de piloter le tunnel de paiement dans un navigateur
 * local tout en tapant sur les vraies fonctions serverless.
 *
 *   node tools/dev-proxy.mjs            (cible par defaut : voir UPSTREAM)
 *   PORT=4321 UPSTREAM=https://... node tools/dev-proxy.mjs
 *
 * Outil de developpement uniquement : ne sert jamais en production.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.PORT || 4321);
const UPSTREAM = process.env.UPSTREAM || "";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
};

async function proxy(req, res, url) {
  if (!UPSTREAM) {
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "UPSTREAM non defini." }));
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const target = UPSTREAM.replace(/\/$/, "") + url.pathname + url.search;
  const upstream = await fetch(target, {
    method: req.method,
    headers: { "content-type": req.headers["content-type"] || "application/json" },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });

  const text = await upstream.text();
  console.log(`[proxy] ${req.method} ${url.pathname} -> ${upstream.status}`);
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "application/json",
  });
  res.end(text);
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);

  // Reproduit cleanUrls de Vercel : /spas sert spas.html, et /spas.html renvoie
  // une 308 vers /spas. Sans ca le local divergerait de la prod.
  if (pathname.endsWith(".html")) {
    const base = pathname.slice(0, -5);
    const clean = (base.endsWith("/index") ? base.slice(0, -5) : base) || "/";
    res.writeHead(308, { Location: clean + url.search });
    return res.end();
  }
  if (pathname.endsWith("/")) pathname += "index.html";
  else if (!extname(pathname)) pathname += ".html"; // /spas -> spas.html

  // pas de remontee hors du dossier du site
  const filePath = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end("Interdit");
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw new Error("dir");
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>404</h1>");
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) await proxy(req, res, url);
    else await serveStatic(req, res, url);
  } catch (err) {
    console.error("[dev-proxy]", err.message);
    if (!res.headersSent) res.writeHead(500).end("Erreur serveur");
  }
}).listen(PORT, () => {
  console.log(`dev-proxy sur http://localhost:${PORT}`);
  console.log(UPSTREAM ? `/api/* -> ${UPSTREAM}` : "/api/* -> AUCUN UPSTREAM");
});
