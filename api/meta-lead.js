/* POST /api/meta-lead
 *
 * Envoie l'evenement Lead a la Conversions API Meta, cote serveur, en complement
 * du Pixel navigateur (deduplique par event_id). Le formulaire de contact part
 * chez Formspree ; ce endpoint recoit en parallele de quoi rapprocher le lead
 * d'une campagne (email/tel haches, fbp/fbc, + IP/UA reels vus par le serveur).
 *
 * Best-effort : renvoie toujours 200, ne revele jamais le token, ne bloque rien.
 * Sans META_CAPI_TOKEN (ex. environnement de preversion) -> saute silencieusement.
 */
import { sendMetaEvent, isCapiEnabled } from "./_lib/meta-capi.js";

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress || undefined;
}

export async function handle(req, res, { sendFn = sendMetaEvent } = {}) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Méthode non autorisée." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad_json" }); }
  }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "bad_body" });

  // au moins un identifiant exploitable, sinon l'evenement n'a aucune valeur
  if (!body.email && !body.phone && !body.fbc && !body.fbp) {
    return res.status(400).json({ error: "no_identifier" });
  }
  if (!isCapiEnabled()) return res.status(200).json({ ok: true, skipped: "disabled" });

  const result = await sendFn({
    eventName: "Lead",
    eventId: typeof body.eventId === "string" ? body.eventId : undefined,
    eventSourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : undefined,
    userData: {
      email: body.email,
      phone: body.phone,
      firstName: body.firstName,
      lastName: body.lastName,
      country: "fr",
      fbp: body.fbp,
      fbc: body.fbc,
      ip: clientIp(req),
      userAgent: req.headers["user-agent"],
    },
    customData: body.sujet ? { content_name: String(body.sujet).slice(0, 100) } : undefined,
  }).catch(() => ({ ok: false }));

  return res.status(200).json({ ok: Boolean(result && result.ok) });
}

export default function handler(req, res) {
  return handle(req, res, {});
}
