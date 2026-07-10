import test from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { handle } from "../stripe-webhook.js";
import { buildMetadata, parseCart, parseCustomer } from "./metadata.js";
import { computeOrder } from "./pricing.js";
import { buildInvoiceLines, invoiceTotalTtc, recordOrder } from "./axonaut.js";

const SECRET = "whsec_test_secret";
const stripe = new Stripe("sk_test_fake", { apiVersion: "2025-08-27.basil" });

const CUSTOMER = {
  firstName: "Jean", lastName: "Dupont", email: "Jean.Dupont@Example.com",
  phone: "0612345678", address: "3 rue des Lilas", postalCode: "31200", city: "Toulouse",
};

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  res.setHeader = (k, v) => (res.headers[k] = v);
  return res;
}

/** Fabrique un evenement signe, exactement comme Stripe le ferait. */
function signedEvent(pi, { type = "payment_intent.succeeded", secret = SECRET } = {}) {
  const payload = JSON.stringify({ id: "evt_1", type, data: { object: pi } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return { rawBody: Buffer.from(payload), req: { method: "POST", headers: { "stripe-signature": header } } };
}

function paymentIntent(items, { amountOverride, extraMeta = {} } = {}) {
  const order = computeOrder(items);
  return {
    id: "pi_test_123",
    amount: order.amountInCents,
    amount_received: amountOverride ?? order.amountInCents,
    created: 1_700_000_000,
    metadata: { ...buildMetadata(order, CUSTOMER), ...extraMeta },
  };
}

function stripeStub() {
  const updates = [];
  return {
    updates,
    webhooks: stripe.webhooks,
    paymentIntents: { update: async (id, params) => (updates.push({ id, params }), {}) },
  };
}

const run = (pi, opts = {}) => {
  const { rawBody, req } = signedEvent(pi, opts);
  const res = fakeRes();
  const calls = [];
  const recordOrderFn = opts.recordOrderFn || (async (a) => (calls.push(a), { dryRun: false, invoiceId: 42 }));
  const s = opts.stripe || stripeStub();
  return handle(req, res, { stripe: s, webhookSecret: opts.secret || SECRET, rawBody, recordOrderFn })
    .then(() => ({ res, calls, stripe: s }));
};

/* ---------- signature ---------- */

test("signature invalide : 400, rien n'est enregistre", async () => {
  const pi = paymentIntent([{ id: "nexus", qty: 1 }]);
  const { rawBody } = signedEvent(pi, { secret: "whsec_mauvais" });
  const res = fakeRes();
  const calls = [];
  await handle({ method: "POST", headers: { "stripe-signature": "t=1,v1=faux" } }, res,
    { stripe: stripeStub(), webhookSecret: SECRET, rawBody, recordOrderFn: async (a) => calls.push(a) });
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test("signature d'un autre secret : 400", async () => {
  const pi = paymentIntent([{ id: "nexus", qty: 1 }]);
  const { rawBody, req } = signedEvent(pi, { secret: "whsec_autre" });
  const res = fakeRes();
  const calls = [];
  await handle(req, res, { stripe: stripeStub(), webhookSecret: SECRET, rawBody, recordOrderFn: async (a) => calls.push(a) });
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test("corps altere apres signature : 400", async () => {
  const pi = paymentIntent([{ id: "nexus", qty: 1 }]);
  const { req } = signedEvent(pi);
  const res = fakeRes();
  const calls = [];
  await handle(req, res, {
    stripe: stripeStub(), webhookSecret: SECRET,
    rawBody: Buffer.from('{"id":"evt_1","type":"payment_intent.succeeded","data":{"object":{"amount":1}}}'),
    recordOrderFn: async (a) => calls.push(a),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

/* ---------- chemin nominal ---------- */

test("paiement reussi : commande enregistree, PI marque comme traite", async () => {
  const pi = paymentIntent([{ id: "spa-convivial", qty: 1, options: ["couverture-hydraulique"] }]);
  const { res, calls, stripe: s } = await run(pi);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.invoiceId, 42);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reference, "pi_test_123");
  assert.equal(calls[0].amountPaid, 5395); // (9500 + 1290) * 50 %
  assert.equal(calls[0].customer.email, "Jean.Dupont@Example.com");

  assert.equal(s.updates.length, 1);
  assert.equal(s.updates[0].params.metadata.order_recorded, "true");
  assert.equal(s.updates[0].params.metadata.axonaut_invoice_id, "42");
});

test("autre type d'evenement : accuse reception sans rien faire", async () => {
  const pi = paymentIntent([{ id: "nexus", qty: 1 }]);
  const { res, calls } = await run(pi, { type: "payment_intent.created" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ignored, "payment_intent.created");
  assert.equal(calls.length, 0);
});

/* ---------- idempotence ---------- */

test("rejeu d'un webhook deja traite : aucune seconde facture", async () => {
  const pi = paymentIntent([{ id: "nexus", qty: 1 }], { extraMeta: { order_recorded: "true", axonaut_invoice_id: "42" } });
  const { res, calls } = await run(pi);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.duplicate, true);
  assert.equal(calls.length, 0, "aucune facture ne doit etre recreee");
});

/* ---------- ecart de montant ---------- */

test("montant encaisse different du montant recalcule : rien n'est ecrit", async () => {
  const pi = paymentIntent([{ id: "spa-convivial", qty: 1 }], { amountOverride: 100 });
  const { res, calls, stripe: s } = await run(pi);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.error, "amount_mismatch");
  assert.equal(calls.length, 0);
  assert.equal(s.updates.length, 0);
});

/* ---------- metadonnees ---------- */

test("metadonnees illisibles : accuse reception, pas de retentative infinie", async () => {
  const pi = paymentIntent([{ id: "nexus", qty: 1 }]);
  delete pi.metadata.cart_0;
  const { res, calls } = await run(pi);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.error, "unreadable_metadata");
  assert.equal(calls.length, 0);
});

test("aller-retour metadonnees : panier et client reconstruits a l'identique", () => {
  const items = [
    { id: "spa-de-nage", qty: 2, options: ["couverture-hydraulique", "leve-couverture"] },
    { id: "nexus", qty: 1, options: [] },
  ];
  const meta = buildMetadata(computeOrder(items), CUSTOMER);
  assert.deepEqual(parseCart(meta), items);
  assert.deepEqual(parseCustomer(meta), CUSTOMER);
  for (const [k, v] of Object.entries(meta)) {
    assert.ok(v.length <= 500, `metadonnee ${k} depasse 500 caracteres`);
  }
});

test("panier maximal : aucune metadonnee ne depasse la limite Stripe", () => {
  const items = Array.from({ length: 10 }, () => ({
    id: "spa-convivial", qty: 5,
    options: ["couverture-hydraulique", "marches-assorties", "leve-couverture"],
  }));
  const longCustomer = { ...CUSTOMER, address: "A".repeat(200), city: "B".repeat(100), email: "c".repeat(150) + "@x.fr" };
  const meta = buildMetadata(computeOrder(items), longCustomer);
  for (const [k, v] of Object.entries(meta)) assert.ok(v.length <= 500, `${k} = ${v.length} caracteres`);
  assert.ok(Object.keys(meta).length <= 50, "Stripe limite a 50 cles");
  assert.deepEqual(parseCart(meta), items);
});

/* ---------- echec transitoire ---------- */

test("Axonaut en panne : 500 pour que Stripe reessaie, PI non marque", async () => {
  const pi = paymentIntent([{ id: "nexus", qty: 1 }]);
  const s = stripeStub();
  const { res } = await run(pi, { stripe: s, recordOrderFn: async () => { throw new Error("axonaut down"); } });
  assert.equal(res.statusCode, 500);
  assert.equal(s.updates.length, 0, "sans marquage, la retentative pourra reussir");
});

test("mode journal : rien n'est ecrit, le PI n'est pas marque", async () => {
  const pi = paymentIntent([{ id: "nexus", qty: 1 }]);
  const s = stripeStub();
  const { res } = await run(pi, { stripe: s, recordOrderFn: async () => ({ dryRun: true }) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dryRun, true);
  assert.equal(s.updates.length, 0);
});

/* ---------- facture d'acompte ---------- */

test("facture : ligne d'acompte a 50 %, prix converti en HT", () => {
  const order = computeOrder([{ id: "spa-convivial", qty: 1 }]); // 9500 TTC -> 4750 du
  const [line] = buildInvoiceLines(order);
  assert.match(line.name, /acompte 50 %/);
  assert.match(line.description, /solde de 4750 € TTC/);
  assert.equal(line.tax_rate, 20);
  assert.equal(line.quantity, 1);
  assert.equal(Math.round(line.price * 1.2 * 100) / 100, 4750);
});

test("facture : produit en stock facture en totalite, quantite dans le libelle", () => {
  const order = computeOrder([{ id: "nexus", qty: 2 }]); // 4695 x2 TTC, 100 %
  const [line] = buildInvoiceLines(order);
  assert.equal(line.name, "Nexus × 2");
  assert.ok(!/acompte/.test(line.name));
  assert.equal(line.quantity, 1, "la quantite est repliee : sinon l'arrondi HT est multiplie");
  assert.match(line.description, /Quantité : 2/);
  assert.equal(Math.round(line.price * 1.2 * 100) / 100, 9390);
});

/* Le test precedent ne couvrait que des quantites de 1 et passait au vert alors que
   64 paniers sur 125 derivaient d'un a deux centimes. On enumere desormais le catalogue. */
test("facture : total exact pour TOUT le catalogue (produits x options x quantites)", () => {
  const products = ["nexus", "breeze", "ease", "spa-de-nage", "spa-convivial"];
  const optionSets = [
    [], ["couverture-hydraulique"], ["marches-assorties"], ["leve-couverture"],
    ["couverture-hydraulique", "marches-assorties", "leve-couverture"],
  ];
  let checked = 0;
  for (const id of products) {
    for (const options of optionSets) {
      for (let qty = 1; qty <= 5; qty++) {
        const order = computeOrder([{ id, qty, options }]);
        assert.equal(
          invoiceTotalTtc(buildInvoiceLines(order)), order.dueNow,
          `${id} x${qty} avec ${options.length} option(s) : facture != montant encaisse`
        );
        checked++;
      }
    }
  }
  assert.equal(checked, 125);
});

test("facture : total exact sur des paniers mixtes", () => {
  const paniers = [
    [{ id: "spa-convivial", qty: 1, options: ["couverture-hydraulique"] }, { id: "nexus", qty: 1 }],
    [{ id: "spa-de-nage", qty: 2 }, { id: "ease", qty: 3, options: ["marches-assorties"] }],
    [{ id: "breeze", qty: 5 }, { id: "spa-convivial", qty: 4, options: ["leve-couverture"] }, { id: "nexus", qty: 2 }],
  ];
  for (const items of paniers) {
    const order = computeOrder(items);
    assert.equal(invoiceTotalTtc(buildInvoiceLines(order)), order.dueNow);
  }
});

test("recordOrder refuse d'ecrire si le total ne correspond pas au montant encaisse", async () => {
  const order = computeOrder([{ id: "nexus", qty: 1 }]); // 4695 du
  await assert.rejects(
    () => recordOrder({ order, customer: CUSTOMER, reference: "pi_x", amountPaid: 4694, date: "2026-01-01T00:00:00Z" }),
    /!= montant encaisse/
  );
});
