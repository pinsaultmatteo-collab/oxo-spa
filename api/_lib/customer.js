/* Validation des coordonnees client.
 * L'adresse est requise : une facture Axonaut sans adresse de facturation n'est pas valable,
 * meme si OXO ne gere pas la livraison depuis le site. */
import { OrderError } from "./pricing.js";

const FIELDS = {
  firstName: { label: "Prénom", max: 80 },
  lastName: { label: "Nom", max: 80 },
  email: { label: "E-mail", max: 160 },
  phone: { label: "Téléphone", max: 30 },
  address: { label: "Adresse", max: 200 },
  postalCode: { label: "Code postal", max: 12 },
  city: { label: "Ville", max: 100 },
};

/* Volontairement permissif : le but est d'attraper les fautes de frappe evidentes,
   pas de rejeter une adresse exotique mais valide. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateCustomer(input) {
  if (!input || typeof input !== "object") {
    throw new OrderError("Coordonnées manquantes.", "missing_customer");
  }

  const customer = {};
  for (const [key, { label, max }] of Object.entries(FIELDS)) {
    const raw = input[key];
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new OrderError(`Champ obligatoire : ${label}.`, "missing_field");
    }
    const value = raw.trim().replace(/\s+/g, " ");
    if (value.length > max) {
      throw new OrderError(`${label} : ${max} caractères maximum.`, "field_too_long");
    }
    customer[key] = value;
  }

  if (!EMAIL.test(customer.email)) {
    throw new OrderError("Adresse e-mail invalide.", "invalid_email");
  }

  const digits = customer.phone.replace(/[^\d]/g, "");
  if (digits.length < 9 || digits.length > 15) {
    throw new OrderError("Numéro de téléphone invalide.", "invalid_phone");
  }

  if (input.acceptCgv !== true) {
    throw new OrderError("Vous devez accepter les conditions générales de vente.", "cgv_not_accepted");
  }

  return customer;
}
