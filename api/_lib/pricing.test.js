import test from "node:test";
import assert from "node:assert/strict";
import { computeOrder, describeOrder, OrderError } from "./pricing.js";

/* Prix de reference (assets/products.json) :
   nexus 4695 (stock, 100%) | breeze 5743 | ease 5753
   spa-de-nage 7500 (sur commande, 50%) | spa-convivial 9500 (sur commande, 50%)
   options : couverture-hydraulique 1290 | marches-assorties 290 | leve-couverture 490 */

const throwsCode = (fn, code) =>
  assert.throws(fn, (e) => e instanceof OrderError && e.code === code, `attendu code=${code}`);

test("produit en stock : encaisse 100%", () => {
  const o = computeOrder([{ id: "nexus", qty: 1 }]);
  assert.equal(o.subtotal, 4695);
  assert.equal(o.dueNow, 4695);
  assert.equal(o.balance, 0);
  assert.equal(o.amountInCents, 469500);
  assert.equal(o.hasDeposit, false);
  assert.equal(o.currency, "eur");
});

test("produit sur commande : encaisse 50% d'acompte", () => {
  const o = computeOrder([{ id: "spa-convivial", qty: 1 }]);
  assert.equal(o.subtotal, 9500);
  assert.equal(o.dueNow, 4750);
  assert.equal(o.balance, 4750);
  assert.equal(o.amountInCents, 475000);
  assert.equal(o.hasDeposit, true);
});

test("les options s'ajoutent au prix de base et suivent le taux d'acompte", () => {
  const o = computeOrder([
    { id: "spa-de-nage", qty: 1, options: ["couverture-hydraulique", "leve-couverture"] },
  ]);
  assert.equal(o.subtotal, 7500 + 1290 + 490); // 9280
  assert.equal(o.dueNow, 4640);
  assert.equal(o.amountInCents, 464000);
});

test("panier mixte : 100% sur le stock, 50% sur le sur-commande", () => {
  const o = computeOrder([
    { id: "nexus", qty: 1 },        // 4695 du
    { id: "spa-de-nage", qty: 1 },  // 7500 -> 3750 du
  ]);
  assert.equal(o.subtotal, 12195);
  assert.equal(o.dueNow, 8445);
  assert.equal(o.balance, 3750);
  assert.equal(o.hasDeposit, true);
});

test("la quantite multiplie la ligne", () => {
  const o = computeOrder([{ id: "nexus", qty: 3, options: ["marches-assorties"] }]);
  assert.equal(o.subtotal, (4695 + 290) * 3); // 14955
  assert.equal(o.dueNow, 14955);
});

/* ---------- le prix envoye par le navigateur n'est JAMAIS lu ---------- */

test("un prix injecte par le client est ignore", () => {
  const o = computeOrder([{ id: "spa-convivial", qty: 1, price: 1, total: 1, unit: 1, amount: 1 }]);
  assert.equal(o.subtotal, 9500);
  assert.equal(o.amountInCents, 475000);
});

test("un taux d'acompte injecte par le client est ignore", () => {
  const o = computeOrder([{ id: "spa-convivial", qty: 1, depositRate: 0.001 }]);
  assert.equal(o.amountInCents, 475000);
});

/* ---------- toute entree douteuse fait echouer la commande ---------- */

test("produit inconnu : refus", () => {
  throwsCode(() => computeOrder([{ id: "spa-pirate", qty: 1 }]), "unknown_product");
});

test("option inconnue : refus", () => {
  throwsCode(() => computeOrder([{ id: "nexus", qty: 1, options: ["gratuit"] }]), "unknown_option");
});

test("option en double : refus", () => {
  throwsCode(
    () => computeOrder([{ id: "nexus", qty: 1, options: ["marches-assorties", "marches-assorties"] }]),
    "duplicate_option"
  );
});

test("quantite invalide : refus (0, negative, decimale, hors plafond)", () => {
  for (const qty of [0, -3, 1.5, 6, "2", true, [2], null, undefined, NaN]) {
    throwsCode(() => computeOrder([{ id: "nexus", qty }]), "invalid_qty");
  }
});

test("panier vide : refus", () => {
  throwsCode(() => computeOrder([]), "empty_cart");
  throwsCode(() => computeOrder(null), "empty_cart");
});

test("trop de lignes : refus", () => {
  const items = Array.from({ length: 11 }, () => ({ id: "nexus", qty: 1 }));
  throwsCode(() => computeOrder(items), "too_many_lines");
});

test("identifiant manquant ou non textuel : refus", () => {
  throwsCode(() => computeOrder([{ qty: 1 }]), "missing_product");
  throwsCode(() => computeOrder([{ id: 42, qty: 1 }]), "missing_product");
  throwsCode(() => computeOrder([null]), "missing_product");
});

test("options non tableau : refus", () => {
  throwsCode(() => computeOrder([{ id: "nexus", qty: 1, options: "marches-assorties" }]), "invalid_options");
});

/* ---------- montants ---------- */

test("le montant Stripe est un entier de centimes", () => {
  const o = computeOrder([{ id: "spa-de-nage", qty: 1 }]); // 7500 * 0.5 = 3750,00 €
  assert.ok(Number.isInteger(o.amountInCents));
  assert.equal(o.amountInCents, 375000);
});

test("acompte + solde = total, au centime pres", () => {
  const paniers = [
    [{ id: "spa-convivial", qty: 1, options: ["leve-couverture"] }],
    [{ id: "spa-de-nage", qty: 2 }, { id: "ease", qty: 1 }],
    [{ id: "breeze", qty: 1 }, { id: "spa-convivial", qty: 3, options: ["couverture-hydraulique"] }],
  ];
  for (const p of paniers) {
    const o = computeOrder(p);
    assert.equal(Math.round((o.dueNow + o.balance) * 100), Math.round(o.subtotal * 100));
  }
});

test("libelle de commande lisible", () => {
  const o = computeOrder([
    { id: "spa-de-nage", qty: 2, options: ["marches-assorties"] },
    { id: "nexus", qty: 1 },
  ]);
  assert.equal(describeOrder(o), "Spa de nage x2 + Marches assorties | Nexus");
});
