/* POST /api/stripe-webhook
 *
 * Seule source de verite d'une commande payee. La page de confirmation peut ne
 * jamais s'afficher (client qui ferme son navigateur) : c'est ici que la commande
 * est enregistree.
 *
 * Trois exigences :
 *   1. Signature verifiee. Sans elle, n'importe qui pourrait declarer une commande payee.
 *   2. Idempotent. Stripe rejoue les webhooks : on ne doit pas creer deux factures.
 *   3. Le montant est recalcule depuis le catalogue et confronte a ce que Stripe a
 *      reellement encaisse. En cas d'ecart, on n'ecrit rien et on alerte.
 */
import Stripe from "stripe";
import { computeOrder } from "./_lib/pricing.js";
import { parseCart, parseCustomer } from "./_lib/metadata.js";
import { recordOrder, isEnabled } from "./_lib/axonaut.js";

// Vercel parse le corps par defaut ; la signature Stripe exige les octets bruts.
export const config = { api: { bodyParser: false } };

let _stripe = null;
function getStripe() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-08-27.basil" });
  return _stripe;
}

export async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

/** Extrait testable : toutes les dependances sont injectees. */
export async function handle(req, res, { stripe, webhookSecret, rawBody, recordOrderFn = recordOrder }) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Méthode non autorisée." });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, req.headers["stripe-signature"], webhookSecret);
  } catch (err) {
    console.error("[webhook] signature invalide :", err.message);
    return res.status(400).json({ error: "Signature invalide." });
  }

  if (event.type !== "payment_intent.succeeded") {
    // Accuse reception : sinon Stripe reessaie indefiniment un evenement qu'on ignore.
    return res.status(200).json({ received: true, ignored: event.type });
  }

  const pi = event.data.object;

  // --- idempotence : Stripe rejoue les webhooks (retentatives, doublons) ---
  if (pi.metadata?.axonaut_invoice_id || pi.metadata?.order_recorded === "true") {
    console.log(`[webhook] ${pi.id} deja enregistre, on ignore`);
    return res.status(200).json({ received: true, duplicate: true });
  }

  let order, customer;
  try {
    order = computeOrder(parseCart(pi.metadata));
    customer = parseCustomer(pi.metadata);
  } catch (err) {
    // Commande illisible : on ne rejoue pas, une retentative echouerait pareil.
    console.error(`[webhook] ${pi.id} metadonnees illisibles : ${err.message}`);
    return res.status(200).json({ received: true, error: "unreadable_metadata" });
  }

  // --- le montant recalcule doit correspondre a ce que Stripe a encaisse ---
  if (order.amountInCents !== pi.amount_received) {
    console.error(
      `[webhook] ECART DE MONTANT sur ${pi.id} : encaisse ${pi.amount_received} c., recalcule ${order.amountInCents} c. ` +
        `Aucune facture creee, intervention manuelle requise.`
    );
    return res.status(200).json({ received: true, error: "amount_mismatch" });
  }

  try {
    const result = await recordOrderFn({
      order,
      customer,
      reference: pi.id,
      amountPaid: pi.amount_received / 100,
      date: new Date(pi.created * 1000).toISOString(),
    });

    if (result.dryRun) {
      console.log(`[webhook] ${pi.id} : Axonaut desactive, rien n'a ete ecrit.`);
      return res.status(200).json({ received: true, dryRun: true });
    }

    // Marque le paiement comme traite : la prochaine relecture sera ignoree.
    await stripe.paymentIntents.update(pi.id, {
      metadata: { ...pi.metadata, order_recorded: "true", axonaut_invoice_id: String(result.invoiceId) },
    });

    console.log(`[webhook] ${pi.id} -> facture Axonaut ${result.invoiceId}`);
    return res.status(200).json({ received: true, invoiceId: result.invoiceId });
  } catch (err) {
    // 500 => Stripe reessaiera. L'idempotence protege contre le doublon.
    console.error(`[webhook] ${pi.id} echec d'enregistrement :`, err.message);
    return res.status(500).json({ error: "recording_failed" });
  }
}

export default async function handler(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[webhook] STRIPE_WEBHOOK_SECRET absente");
    return res.status(500).json({ error: "Webhook mal configuré." });
  }
  if (!isEnabled()) console.warn("[webhook] AXONAUT_ENABLED != true : aucune facture ne sera creee.");

  try {
    const rawBody = await readRawBody(req);
    return await handle(req, res, { stripe: getStripe(), webhookSecret: secret, rawBody });
  } catch (err) {
    console.error("[webhook] erreur inattendue :", err);
    return res.status(500).json({ error: "internal" });
  }
}
