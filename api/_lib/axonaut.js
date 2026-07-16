/* Integration Axonaut (CRM / facturation).
 *
 * Axonaut n'a pas d'environnement de bac a sable : la meme cle API ecrit dans la
 * comptabilite reelle du client. Deux garde-fous :
 *   - AXONAUT_ENABLED doit valoir exactement "true" (absent => desactive).
 *   - En mode desactive, on journalise la charge utile exacte au lieu de l'envoyer.
 *
 * Deux choix assumes, faute de documentation :
 *
 * 1. On n'utilise PAS les champs deposit_type / deposit_percent / deposit_flat.
 *    deposit_type est un enum [1,2,3] sans aucune description dans la spec OpenAPI.
 *    Piloter la comptabilite d'un client avec un champ dont on ignore la semantique
 *    serait irresponsable. A la place, la facture d'acompte porte des lignes explicites
 *    dont le total est exactement le montant encaisse par Stripe.
 *
 * 2. products[].price est suppose HORS TAXES (il cotoie un tax_rate). Nos prix
 *    catalogue sont TTC, on convertit. Cette hypothese doit etre validee avec le
 *    comptable via une facture de recette avant activation en production.
 */

const BASE = "https://axonaut.com/api/v2";
const VAT_RATE = 0.2;
const NATURE_CREDIT_CARD = 4; // enum documente : 1 Debit, 2 Transfer, 3 Check, 4 Credit card, 5 Cash, 6 Other

export const isEnabled = () => process.env.AXONAUT_ENABLED === "true";

/* Conversion TTC -> HT.
 *
 * 4 decimales, et non 2 : verifie par force brute sur les 20 millions de montants
 * au centime jusqu'a 200 000 €, arrondir le HT a 2 decimales fait diverger le TTC
 * reconstitue d'un centime dans 1 cas sur 6 (des 100,05 €). A 4 decimales, zero ecart.
 */
const HT_DECIMALS = 4;
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const ht = (ttc) => round(ttc / (1 + VAT_RATE), HT_DECIMALS);
const pct = (rate) => Math.round(rate * 100);

/** Total TTC que la facture representera, tel qu'Axonaut le recalculera. */
export const invoiceTotalTtc = (lines) =>
  round(lines.reduce((s, l) => s + l.price * l.quantity * (1 + VAT_RATE), 0), 2);

/* Axonaut annonce "RFC3339" mais son parseur est plus strict que la norme : il refuse
   les millisecondes et le suffixe Z, pourtant tous deux valides en RFC3339
   ("Property date: Invalid RFC3339" en production le 2026-07-16). On emet donc
   exactement la forme de leur exemple : "2022-05-28T18:05:35+02:00". */
export function toAxonautDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new AxonautError(`Date invalide : ${value}`, 500);
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export class AxonautError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "AxonautError";
    this.status = status;
  }
}

function client(fetchImpl = fetch) {
  const key = process.env.AXONAUT_API_KEY;
  return async function call(method, path, body) {
    if (!key) throw new AxonautError("AXONAUT_API_KEY absente", 500);
    const res = await fetchImpl(BASE + path, {
      method,
      headers: { userApiKey: key, "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new AxonautError(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`, res.status);
    return text ? JSON.parse(text) : null;
  };
}

/* Lignes de facture correspondant EXACTEMENT au montant encaisse.
 *
 * quantity vaut toujours 1 et price porte le total HT de la ligne. Laisser Axonaut
 * multiplier un prix unitaire par la quantite multiplierait aussi l'erreur d'arrondi
 * (verifie : 64 paniers sur 125 derivaient de 1 a 2 centimes). La quantite reste
 * lisible dans le libelle et le descriptif. */
export function buildInvoiceLines(order) {
  return order.lines.map((l) => {
    const acompte = l.depositRate < 1;
    const lineTtc = round(l.total * l.depositRate, 2); // montant reellement encaisse pour cette ligne
    const solde = round(l.total - lineTtc, 2);

    const parts = [];
    if (l.qty > 1) parts.push(`Quantité : ${l.qty}`);
    if (l.options.length) parts.push("Options : " + l.options.map((o) => o.name).join(", "));
    if (acompte) parts.push(`Acompte ${pct(l.depositRate)} % — solde de ${solde} € TTC à la livraison`);

    const qtySuffix = l.qty > 1 ? ` × ${l.qty}` : "";
    return {
      name: acompte ? `${l.name}${qtySuffix} — acompte ${pct(l.depositRate)} %` : `${l.name}${qtySuffix}`,
      description: parts.join(" · "),
      price: ht(lineTtc), // total HT de la ligne
      tax_rate: VAT_RATE * 100,
      quantity: 1,
    };
  });
}

export function buildCompanyPayload(customer) {
  return {
    name: `${customer.firstName} ${customer.lastName}`,
    isB2C: "true",
    is_customer: "true",
    is_prospect: "false",
    internal_id: customer.email.toLowerCase(), // sert de cle de deduplication
    address_street: customer.address,
    address_zip_code: customer.postalCode,
    address_city: customer.city,
    address_country: "France",
    address_contact_name: `${customer.firstName} ${customer.lastName}`,
    employees: [
      {
        firstname: customer.firstName,
        lastname: customer.lastName,
        email: customer.email,
        cellphoneNumber: customer.phone,
        is_billing_contact: "true",
      },
    ],
  };
}

/**
 * Cree (ou retrouve) le client, la facture, puis enregistre le paiement.
 *
 * Reprise sur incident : Axonaut ne permet pas de savoir si une facture existe deja
 * pour une commande (`order_number` est settable mais n'est ni renvoye par l'API ni
 * filtrable ; `internal_ref` n'est pas settable). On memorise donc l'avancement dans
 * les metadonnees du PaymentIntent via `onProgress`, et on reprend la ou on s'est
 * arrete via `existing`. Sans ca, un rejeu Stripe apres un echec partiel creerait une
 * SECONDE facture dans la comptabilite reelle.
 *
 * En cas d'echec APRES creation de la facture, l'erreur porte `.invoiceId` : l'appelant
 * doit alors surtout NE PAS rejouer (voir stripe-webhook.js).
 *
 * @param {object} existing   {companyId?, invoiceId?, paymentRecorded?} lus des metadonnees
 * @param {Function} onProgress  appele apres chaque etape pour persister l'avancement
 * @returns {{dryRun:boolean, companyId?:number, invoiceId?:number, payload?:object}}
 */
export async function recordOrder({ order, customer, reference, amountPaid, date, existing = {}, onProgress, fetchImpl }) {
  const invoiceDate = toAxonautDate(date || new Date().toISOString());
  const lines = buildInvoiceLines(order);

  /* Une facture reglee dont le total differe du montant encaisse laisse un reliquat
     dans la comptabilite du client. Mathematiquement impossible ici : on garde le
     controle comme filet, et on echoue bruyamment plutot que d'ecrire du faux. */
  const total = invoiceTotalTtc(lines);
  if (total !== round(amountPaid, 2)) {
    throw new AxonautError(
      `Total de facture ${total} € != montant encaisse ${amountPaid} €. Aucune ecriture.`,
      500
    );
  }

  const invoicePayload = {
    date: invoiceDate,
    due_date: invoiceDate, // deja regle
    order_number: reference,
    payment_terms: "Payé en ligne par carte bancaire",
    products: lines,
  };

  if (!isEnabled()) {
    // Mode journal : rien n'est ecrit dans la comptabilite du client.
    const payload = { company: buildCompanyPayload(customer), invoice: invoicePayload, payment: { nature: NATURE_CREDIT_CARD, amount: amountPaid, reference } };
    console.log("[axonaut] DESACTIVE — charge utile qui aurait ete envoyee :\n" + JSON.stringify(payload, null, 2));
    return { dryRun: true, payload };
  }

  const call = client(fetchImpl);
  const progress = onProgress || (async () => {});

  // 1. client — deja idempotent : on cherche par internal_id (l'email) avant de creer.
  let companyId = existing.companyId;
  if (!companyId) {
    const found = await call("GET", `/companies?internal_id=${encodeURIComponent(customer.email.toLowerCase())}`);
    const hit = Array.isArray(found) ? found[0] : found && found.id ? found : null;
    companyId = hit ? hit.id : (await call("POST", "/companies", buildCompanyPayload(customer))).id;
    await progress({ axonaut_company_id: String(companyId) });
  }

  // A partir d'ici, toute erreur doit porter l'invoiceId si la facture a ete creee :
  // c'est ce qui interdit a l'appelant de rejouer et de dupliquer la facture.
  let invoiceId = existing.invoiceId;
  try {
    // 2. facture — l'id est persiste IMMEDIATEMENT apres creation, avant toute autre
    //    operation faillible. C'est le point critique de l'idempotence.
    if (!invoiceId) {
      const invoice = await call("POST", "/invoices", {
        ...invoicePayload,
        company_id: companyId,
        employee_email: customer.email,
      });
      invoiceId = invoice.id;
      await progress({ axonaut_invoice_id: String(invoiceId) });
    }

    // 3. paiement encaisse -> la facture est soldee
    if (!existing.paymentRecorded) {
      await call("POST", "/payments", {
        invoice_id: invoiceId,
        nature: NATURE_CREDIT_CARD,
        amount: amountPaid,
        reference,
        date: invoiceDate,
      });
    }
  } catch (err) {
    if (invoiceId) err.invoiceId = invoiceId; // facture existante : NE PAS rejouer
    throw err;
  }

  return { dryRun: false, companyId, invoiceId };
}
