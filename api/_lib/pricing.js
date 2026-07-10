/* Calcul du montant d'une commande, cote serveur.
 *
 * Regle absolue : le navigateur n'envoie que des identifiants et des quantites.
 * Aucun prix venant du client n'est lu. Toute valeur inconnue fait echouer la commande
 * plutot que d'etre ignoree silencieusement — une commande a moitie comprise ne doit
 * jamais etre encaissee.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CATALOG_PATH = fileURLToPath(new URL("../../assets/products.json", import.meta.url));

let catalog = null;

export function loadCatalog() {
  if (!catalog) {
    const raw = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    catalog = {
      vatRate: raw.vatRate,
      currency: raw.currency,
      products: new Map(raw.products.map((p) => [p.id, p])),
      options: new Map(raw.options.map((o) => [o.id, o])),
    };
  }
  return catalog;
}

/** Pour les tests : repart d'un catalogue neuf. */
export function _resetCatalog() {
  catalog = null;
}

export class OrderError extends Error {
  constructor(message, code = "invalid_order") {
    super(message);
    this.name = "OrderError";
    this.code = code;
  }
}

const MAX_LINES = 10;
const MAX_QTY = 5;

/** Les prix du catalogue sont en euros entiers ; Stripe raisonne en centimes. */
const toCents = (euros) => Math.round(euros * 100);

/**
 * @param {Array<{id:string, qty:number, options?:string[]}>} items panier brut du navigateur
 * @returns {{lines:Array, subtotal:number, dueNow:number, balance:number,
 *            amountInCents:number, currency:string, hasDeposit:boolean}}
 */
export function computeOrder(items) {
  const cat = loadCatalog();

  if (!Array.isArray(items) || items.length === 0) {
    throw new OrderError("Panier vide.", "empty_cart");
  }
  if (items.length > MAX_LINES) {
    throw new OrderError(`Panier limite a ${MAX_LINES} lignes.`, "too_many_lines");
  }

  const lines = items.map((raw, i) => {
    if (!raw || typeof raw.id !== "string") {
      throw new OrderError(`Ligne ${i + 1} : identifiant produit manquant.`, "missing_product");
    }
    const product = cat.products.get(raw.id);
    if (!product) {
      throw new OrderError(`Ligne ${i + 1} : produit inconnu (${raw.id}).`, "unknown_product");
    }

    // typeof strict : Number("2"), Number(true) et Number([2]) valent tous 2 ou 1.
    // On refuse ces formes plutot que de deviner ce que le client voulait dire.
    const qty = raw.qty;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      throw new OrderError(
        `Ligne ${i + 1} : quantite invalide (${raw.qty}). Attendu un entier entre 1 et ${MAX_QTY}.`,
        "invalid_qty"
      );
    }

    const optionIds = raw.options ?? [];
    if (!Array.isArray(optionIds)) {
      throw new OrderError(`Ligne ${i + 1} : options invalides.`, "invalid_options");
    }
    if (new Set(optionIds).size !== optionIds.length) {
      throw new OrderError(`Ligne ${i + 1} : option en double.`, "duplicate_option");
    }

    const options = optionIds.map((oid) => {
      const option = cat.options.get(oid);
      if (!option) {
        throw new OrderError(`Ligne ${i + 1} : option inconnue (${oid}).`, "unknown_option");
      }
      return { id: option.id, name: option.name, price: option.price };
    });

    const unit = product.price + options.reduce((s, o) => s + o.price, 0);
    const total = unit * qty;
    const depositRate = typeof product.depositRate === "number" ? product.depositRate : 1;

    return {
      id: product.id,
      name: product.name,
      availability: product.availability,
      qty,
      options,
      unit,
      total,
      depositRate,
      dueNow: total * depositRate,
    };
  });

  const subtotal = lines.reduce((s, l) => s + l.total, 0);
  const dueNowCents = lines.reduce((s, l) => s + toCents(l.dueNow), 0);
  const subtotalCents = toCents(subtotal);

  return {
    lines,
    subtotal,
    dueNow: dueNowCents / 100,
    balance: (subtotalCents - dueNowCents) / 100,
    amountInCents: dueNowCents,
    currency: cat.currency.toLowerCase(),
    hasDeposit: dueNowCents < subtotalCents,
  };
}

/** Libelle court pour Stripe et Axonaut. */
export function describeOrder(order) {
  return order.lines
    .map((l) => {
      const opts = l.options.length ? ` + ${l.options.map((o) => o.name).join(", ")}` : "";
      const q = l.qty > 1 ? ` x${l.qty}` : "";
      return `${l.name}${q}${opts}`;
    })
    .join(" | ");
}
