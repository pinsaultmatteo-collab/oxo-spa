/* GET /api/config — expose la seule valeur publique de Stripe.
 * La cle publiable est concue pour vivre dans le navigateur ; elle ne permet
 * ni de lire des donnees, ni de creer un paiement. La cle secrete ne sort jamais d'ici. */
export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Méthode non autorisée." });
  }
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    console.error("[config] STRIPE_PUBLISHABLE_KEY absente");
    return res.status(500).json({ error: "Paiement mal configuré.", code: "misconfigured" });
  }
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.status(200).json({ publishableKey });
}
