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
 * @returns {{dryRun:boolean, companyId?:number, invoiceId?:number, payload?:object}}
 */
export async function recordOrder({ order, customer, reference, amountPaid, date, fetchImpl }) {
  const invoiceDate = date || new Date().toISOString();
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

  // 1. client : reutilise s'il existe deja (evite les doublons a chaque commande)
  const found = await call("GET", `/companies?internal_id=${encodeURIComponent(customer.email.toLowerCase())}`);
  const existing = Array.isArray(found) ? found[0] : found && found.id ? found : null;
  const companyId = existing ? existing.id : (await call("POST", "/companies", buildCompanyPayload(customer))).id;

  // 2. facture
  const invoice = await call("POST", "/invoices", { ...invoicePayload, company_id: companyId, employee_email: customer.email });

  // 3. paiement encaisse -> la facture est soldee
  await call("POST", "/payments", {
    invoice_id: invoice.id,
    nature: NATURE_CREDIT_CARD,
    amount: amountPaid,
    reference,
    date: invoiceDate,
  });

  return { dryRun: false, companyId, invoiceId: invoice.id };
}
