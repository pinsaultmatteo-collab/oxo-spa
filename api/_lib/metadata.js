/* Encodage de la commande dans les metadonnees Stripe.
 *
 * Stripe limite chaque valeur a 500 caracteres et accepte 50 cles. Un panier de
 * 10 lignes ou une adresse longue depassent 500 caracteres si on serialise en un
 * seul JSON — et une troncature produirait du JSON invalide, donc un webhook qui
 * echoue apres l'encaissement. On repartit donc sur plusieurs cles courtes.
 *
 * Ces metadonnees servent a REJOUER la commande (identifiants, quantites, options).
 * Les montants qu'on y ecrit sont purement indicatifs : le webhook les recalcule.
 */

const MAX_VALUE = 500;

export const CUSTOMER_KEYS = {
  firstName: "c_first",
  lastName: "c_last",
  email: "c_email",
  phone: "c_phone",
  address: "c_addr",
  postalCode: "c_zip",
  city: "c_city",
};

export function buildMetadata(order, customer) {
  const meta = {
    cart_lines: String(order.lines.length),
    subtotal_eur: String(order.subtotal),
    due_now_eur: String(order.dueNow),
    balance_eur: String(order.balance),
    has_deposit: String(order.hasDeposit),
    // lisible dans le tableau de bord Stripe
    customer_name: `${customer.firstName} ${customer.lastName}`,
  };

  for (const [field, key] of Object.entries(CUSTOMER_KEYS)) {
    meta[key] = customer[field];
  }

  order.lines.forEach((l, i) => {
    // une cle par ligne : "id|qty|opt1,opt2"
    const value = `${l.id}|${l.qty}|${l.options.map((o) => o.id).join(",")}`;
    if (value.length > MAX_VALUE) throw new Error(`Ligne ${i} trop longue pour les metadonnees Stripe`);
    meta[`cart_${i}`] = value;
  });

  return meta;
}

/** Reconstruit le panier a partir des metadonnees. Leve si une ligne est illisible. */
export function parseCart(metadata) {
  const count = parseInt(metadata.cart_lines, 10);
  if (!Number.isInteger(count) || count < 1) throw new Error("cart_lines absent ou invalide");

  const items = [];
  for (let i = 0; i < count; i++) {
    const raw = metadata[`cart_${i}`];
    if (typeof raw !== "string") throw new Error(`cart_${i} manquant`);
    const [id, qty, opts] = raw.split("|");
    items.push({
      id,
      qty: parseInt(qty, 10),
      options: opts ? opts.split(",").filter(Boolean) : [],
    });
  }
  return items;
}

export function parseCustomer(metadata) {
  const customer = {};
  for (const [field, key] of Object.entries(CUSTOMER_KEYS)) {
    const value = metadata[key];
    if (typeof value !== "string" || !value) throw new Error(`Coordonnée manquante : ${key}`);
    customer[field] = value;
  }
  return customer;
}
