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
import { sendMetaEvent } from "./_lib/meta-capi.js";

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

  /* --- idempotence : Stripe rejoue les webhooks (retentatives, doublons) ---
     On ne saute QUE si la commande est integralement traitee. La seule presence d'un
     axonaut_invoice_id signifie "facture creee, paiement peut-etre pas encore
     enregistre" : il faut alors REPRENDRE (recordOrder saute les etapes deja faites),
     sinon la facture resterait impayee indefiniment. */
  if (pi.metadata?.order_recorded === "true") {
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

  /* Avancement persiste dans les metadonnees du PaymentIntent : c'est notre seule
     memoire entre deux tentatives (Axonaut ne sait pas dire si une facture existe
     deja pour une commande). On accumule dans `meta` pour ne pas perdre un patch
     precedent en repartant d'un pi.metadata perime. */
  const meta = { ...pi.metadata };
  const onProgress = async (patch) => {
    Object.assign(meta, patch);
    await stripe.paymentIntents.update(pi.id, { metadata: meta });
  };

  let result = null;
  let recordError = null;
  try {
    result = await recordOrderFn({
      ...emailParams,
      existing: {
        companyId: pi.metadata?.axonaut_company_id,
        invoiceId: pi.metadata?.axonaut_invoice_id,
        paymentRecorded: pi.metadata?.axonaut_payment_recorded === "true",
      },
      onProgress,
    });
  } catch (err) {
    recordError = err;
  }

  // Marquage AVANT les emails : un rejeu ne doit jamais recreer la facture.
  // En mode journal (dryRun), rien n'est marque, mais les emails restent testables.
  if (result && !result.dryRun) {
    try {
      await onProgress({ order_recorded: "true", axonaut_payment_recorded: "true", axonaut_invoice_id: String(result.invoiceId) });
      console.log(`[webhook] ${pi.id} -> facture Axonaut ${result.invoiceId}`);
    } catch (err) {
      // La facture est creee et soldee : surtout pas de 500, qui la dupliquerait.
      console.error(`[webhook] ${pi.id} facture ${result.invoiceId} creee mais marquage impossible :`, err.message);
    }
  } else if (result) {
    console.log(`[webhook] ${pi.id} : Axonaut desactive (mode journal).`);
  }

  /* Emails : envoyes MEME si Axonaut a echoue.
     La notification de commande est le signal qui previent OXO qu'une vente a eu lieu :
     la faire dependre de la comptabilite signifiait qu'une panne Axonaut rendait la
     vente totalement invisible (client sans confirmation, vendeur sans notification).
     Les envois sont idempotents (cle Resend par reference) : un rejeu ne double pas. */
  const emails = await sendEmailsFn(emailParams);

  /* Conversions API Meta — event Purchase cote serveur (best-effort).
     Deduplique avec le Pixel navigateur par event_id = pi.id. UNIQUEMENT en
     mode live : un paiement de test ne doit jamais polluer les donnees pub.
     Ne bloque jamais la reponse : toute erreur est avalee par sendMetaEvent. */
  if (pi.livemode) {
    await sendMetaEvent({
      eventName: "Purchase",
      eventId: pi.id,
      eventTime: pi.created,
      eventSourceUrl: (process.env.SITE_URL || "https://oxo-spa.com") + "/confirmation",
      userData: {
        email: customer.email,
        phone: customer.phone,
        firstName: customer.firstName,
        lastName: customer.lastName,
        city: customer.city,
        zip: customer.postalCode,
        country: "fr",
        fbp: pi.metadata?.fb_fbp,
        fbc: pi.metadata?.fb_fbc,
      },
      customData: { currency: (order.currency || "eur").toUpperCase(), value: pi.amount_received / 100 },
    }).catch(() => {});
  }

  if (recordError) {
    if (recordError.invoiceId) {
      /* La facture EXISTE deja dans la compta du client. Un 500 ferait rejouer Stripe
         et creerait un doublon — bien pire qu'une finalisation incomplete. */
      console.error(
        `[webhook] ${pi.id} : facture Axonaut ${recordError.invoiceId} CREEE mais finalisation incomplete (${recordError.message}). ` +
          `Aucun rejeu (risque de doublon). Verifier manuellement que la facture est bien soldee.`
      );
      return res.status(200).json({ received: true, invoiceId: recordError.invoiceId, incomplete: true, emails });
    }
    // Rien n'a ete cree cote Axonaut : on peut rejouer sans risque de doublon.
    console.error(`[webhook] ${pi.id} echec d'enregistrement :`, recordError.message);
    return res.status(500).json({ error: "recording_failed", emails });
  }

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
