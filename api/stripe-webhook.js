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
import { sendOrderEmails, isEmailEnabled } from "./_lib/email.js";

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
export async function handle(req, res, { stripe, webhookSecret, rawBody, recordOrderFn = recordOrder, sendEmailsFn = sendOrderEmails }) {
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

  const emailParams = {
    order,
    customer,
    reference: pi.id,
    amountPaid: pi.amount_received / 100,
    date: new Date(pi.created * 1000).toISOString(),
  };

  let result;
  try {
    result = await recordOrderFn(emailParams);
  } catch (err) {
    // 500 => Stripe reessaiera. L'idempotence protege contre le doublon Axonaut.
    console.error(`[webhook] ${pi.id} echec d'enregistrement :`, err.message);
    return res.status(500).json({ error: "recording_failed" });
  }

  // Marquage AVANT les emails : un rejeu ne doit jamais recreer la facture Axonaut.
  // En mode journal (dryRun), rien n'est marque, mais les emails restent testables.
  if (!result.dryRun) {
    try {
      await stripe.paymentIntents.update(pi.id, {
        metadata: { ...pi.metadata, order_recorded: "true", axonaut_invoice_id: String(result.invoiceId) },
      });
      console.log(`[webhook] ${pi.id} -> facture Axonaut ${result.invoiceId}`);
    } catch (err) {
      // Le marquage a echoue : Stripe rejouera. recordOrder est deja passe, donc on
      // NE renvoie PAS 500 (sinon double facture au rejeu, l'idempotence n'ayant pas
      // ete posee). On alerte et on continue : la facture existe, c'est l'essentiel.
      console.error(`[webhook] ${pi.id} facture ${result.invoiceId} creee mais marquage impossible :`, err.message);
    }
  } else {
    console.log(`[webhook] ${pi.id} : Axonaut desactive (mode journal).`);
  }

  // Emails : best-effort. Un echec n'invalide pas la commande (deja enregistree,
  // et Stripe envoie son propre recu). sendEmailsFn ne leve jamais.
  const emails = await sendEmailsFn(emailParams);

  return res.status(200).json({
    received: true,
    dryRun: result.dryRun || false,
    invoiceId: result.invoiceId,
    emails,
  });
}

export default async function handler(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[webhook] STRIPE_WEBHOOK_SECRET absente");
    return res.status(500).json({ error: "Webhook mal configuré." });
  }
  if (!isEnabled()) console.warn("[webhook] AXONAUT_ENABLED != true : aucune facture ne sera creee.");
  if (!isEmailEnabled()) console.warn("[webhook] RESEND_API_KEY absente : aucun email ne sera envoye.");

  try {
    const rawBody = await readRawBody(req);
    return await handle(req, res, { stripe: getStripe(), webhookSecret: secret, rawBody });
  } catch (err) {
    console.error("[webhook] erreur inattendue :", err);
    return res.status(500).json({ error: "internal" });
  }
}
