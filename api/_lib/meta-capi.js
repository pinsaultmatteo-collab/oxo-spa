/* Conversions API Meta (envoi serveur des evenements).
 *
 * Complete le Pixel navigateur : les evenements serveur passent les bloqueurs de
 * pub et la perte de cookies, donc Meta recoit plus de conversions. La
 * deduplication se fait par event_id (le meme cote Pixel et cote serveur).
 *
 * Best-effort par principe : une panne Meta ne doit JAMAIS casser un paiement ni
 * un formulaire. Aucune fonction ici ne leve : on renvoie un statut.
 *
 * Le token vient de META_CAPI_TOKEN (jamais en dur). Sans token -> on saute.
 * Les donnees personnelles (email, telephone, nom...) sont hachees en SHA-256
 * avant l'envoi, conformement aux regles Meta ; fbp/fbc/IP/UA partent en clair.
 */
import { createHash } from "node:crypto";

const DEFAULT_DATASET = "1655275805769277"; // Pixel "oxo-spa-site-internet"
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";

export function isCapiEnabled() {
  return Boolean(process.env.META_CAPI_TOKEN);
}

/* ---------- normalisation + hachage (regles Meta) ---------- */
function sha256(v) {
  return createHash("sha256").update(v, "utf8").digest("hex");
}
function hashField(value, normalizer) {
  if (value == null) return null;
  const norm = normalizer(String(value)).trim();
  return norm ? sha256(norm) : null;
}

const lower = (s) => s.toLowerCase().trim();
const alnumLower = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Telephone au format E.164 sans "+" : un 0X FR devient 33X. */
export function normalizePhone(raw) {
  let d = String(raw).replace(/[^\d]/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.length === 10 && d.startsWith("0")) d = "33" + d.slice(1);
  return d;
}

/** Construit le bloc user_data (champs personnels haches + fbp/fbc/IP/UA en clair). */
export function buildUserData(u = {}) {
  const ud = {};
  const em = hashField(u.email, lower);
  const ph = u.phone ? sha256(normalizePhone(u.phone)) : null;
  const fn = hashField(u.firstName, lower);
  const ln = hashField(u.lastName, lower);
  const ct = hashField(u.city, alnumLower);
  const zp = hashField(u.zip, alnumLower);
  const co = hashField(u.country, alnumLower);
  if (em) ud.em = [em];
  if (ph) ud.ph = [ph];
  if (fn) ud.fn = [fn];
  if (ln) ud.ln = [ln];
  if (ct) ud.ct = [ct];
  if (zp) ud.zp = [zp];
  if (co) ud.country = [co];
  if (u.fbp) ud.fbp = u.fbp;
  if (u.fbc) ud.fbc = u.fbc;
  if (u.ip) ud.client_ip_address = u.ip;
  if (u.userAgent) ud.client_user_agent = u.userAgent;
  return ud;
}

/** Assemble le corps de la requete /events (sans le token). Pur, donc testable. */
export function buildEventPayload(event, testCode) {
  const e = {
    event_name: event.eventName,
    event_time: event.eventTime || Math.floor(Date.now() / 1000),
    action_source: event.actionSource || "website",
    user_data: buildUserData(event.userData),
  };
  if (event.eventId) e.event_id = event.eventId;
  if (event.eventSourceUrl) e.event_source_url = event.eventSourceUrl;
  if (event.customData) e.custom_data = event.customData;
  const body = { data: [e] };
  if (testCode) body.test_event_code = testCode;
  return body;
}

/**
 * Envoie un evenement a Meta. Ne leve jamais.
 * @returns {Promise<{ok:boolean, status?:number, skipped?:string, error?:string}>}
 */
export async function sendMetaEvent(event, opts = {}) {
  const token = opts.token || process.env.META_CAPI_TOKEN;
  if (!token) return { skipped: "no_token" };

  const datasetId = opts.datasetId || process.env.META_DATASET_ID || DEFAULT_DATASET;
  const testCode = opts.testCode || process.env.META_TEST_EVENT_CODE || undefined;
  const doFetch = opts.fetchFn || fetch;

  const body = buildEventPayload(event, testCode);
  body.access_token = token;

  // Une panne Meta ne doit pas geler la fonction serverless : on coupe a 3 s.
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 3000) : null;

  try {
    const r = await doFetch(`https://graph.facebook.com/${GRAPH_VERSION}/${datasetId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!r.ok) {
      let detail = "";
      try { detail = (await r.text()).slice(0, 300); } catch {}
      console.error(`[meta-capi] ${event.eventName} rejete (${r.status}): ${detail}`);
      return { ok: false, status: r.status };
    }
    return { ok: true, status: r.status };
  } catch (err) {
    console.error(`[meta-capi] ${event.eventName} echec reseau: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
