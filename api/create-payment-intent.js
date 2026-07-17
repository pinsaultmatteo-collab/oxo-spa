/* POST /api/create-payment-intent
 *
 * Recoit { items:[{id,qty,options}], customer:{...} } — jamais de montant.
 * Recalcule le prix cote serveur, cree le PaymentIntent Stripe, et renvoie
 * le clientSecret + le recapitulatif faisant autorite (celui qu'affichera la page).
 */
import Stripe from "stripe";
import { computeOrder, describeOrder, OrderError } from "./_lib/pricing.js";
import { validateCustomer } from "./_lib/customer.js";
import { buildMetadata } from "./_lib/metadata.js";

let _stripe = null;
function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY absente de l'environnement");
    _stripe = new Stripe(key, { apiVersion: "2025-08-27.basil" });
  }
  return _stripe;
}

/** Extrait pour les tests : aucune dependance implicite. */
export async function handle(req, res, { stripe, publishableKey }) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Méthode non autorisée." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Corps de requête illisible.", code: "bad_json" });
    }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Corps de requête manquant.", code: "bad_json" });
  }

  let order, customer;
  try {
    customer = validateCustomer(body.customer);
    order = computeOrder(body.items);
  } catch (err) {
    if (err instanceof OrderError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  let intent;
  try {
    intent = await stripe.paymentIntents.create({
      amount: order.amountInCents, // recalcule, jamais issu du navigateur
      currency: order.currency,
      automatic_payment_methods: { enabled: true },
      receipt_email: customer.email,
      description: `OXO Spa — ${describeOrder(order)}`,
      metadata: buildMetadata(order, customer, body.marketing),
    });
  } catch (err) {
    console.error("[stripe] echec creation PaymentIntent:", err?.message);
    return res.status(502).json({ error: "Le service de paiement est indisponible.", code: "stripe_unavailable" });
  }

  return res.status(200).json({
    clientSecret: intent.client_secret,
    publishableKey,
    // recapitulatif faisant autorite : la page affiche ces montants, pas les siens
    summary: {
      lines: order.lines.map((l) => ({
        name: l.name, qty: l.qty, total: l.total,
        options: l.options.map((o) => ({ name: o.name, price: o.price })),
        availability: l.availability,
      })),
      subtotal: order.subtotal,
      dueNow: order.dueNow,
      balance: order.balance,
      hasDeposit: order.hasDeposit,
    },
  });
}

export default async function handler(req, res) {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    console.error("[config] STRIPE_PUBLISHABLE_KEY absente");
    return res.status(500).json({ error: "Paiement mal configuré.", code: "misconfigured" });
  }
  try {
    return await handle(req, res, { stripe: getStripe(), publishableKey });
  } catch (err) {
    console.error("[api] erreur inattendue:", err);
    return res.status(500).json({ error: "Erreur interne.", code: "internal" });
  }
}
