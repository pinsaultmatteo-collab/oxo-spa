import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../create-payment-intent.js";

/* --- doublures --- */

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  res.setHeader = (k, v) => (res.headers[k] = v);
  return res;
}

function fakeStripe(overrides = {}) {
  const calls = [];
  return {
    calls,
    paymentIntents: {
      create: async (params) => {
        calls.push(params);
        if (overrides.throws) throw new Error("stripe down");
        return { client_secret: "pi_test_secret_123" };
      },
    },
  };
}

const CUSTOMER = {
  firstName: "Jean", lastName: "Dupont", email: "jean@example.com",
  phone: "06 12 34 56 78", address: "3 rue des Lilas",
  postalCode: "31200", city: "Toulouse", acceptCgv: true,
};

const post = (body) => ({ method: "POST", body });
const run = (body, stripe = fakeStripe()) =>
  handle(post(body), fakeRes(), { stripe, publishableKey: "pk_test_abc" }).then((res) => ({ res, stripe }));

/* --- chemin nominal --- */

test("commande valide : PaymentIntent cree avec le montant recalcule", async () => {
  const { res, stripe } = await run({ items: [{ id: "spa-convivial", qty: 1 }], customer: CUSTOMER });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.clientSecret, "pi_test_secret_123");
  assert.equal(res.body.publishableKey, "pk_test_abc");

  assert.equal(stripe.calls.length, 1);
  assert.equal(stripe.calls[0].amount, 475000); // 9500 * 50% d'acompte
  assert.equal(stripe.calls[0].currency, "eur");
  assert.equal(stripe.calls[0].receipt_email, "jean@example.com");
});

test("le recapitulatif renvoye fait autorite", async () => {
  const { res } = await run({ items: [{ id: "spa-de-nage", qty: 1 }], customer: CUSTOMER });
  assert.deepEqual(res.body.summary.subtotal, 7500);
  assert.deepEqual(res.body.summary.dueNow, 3750);
  assert.deepEqual(res.body.summary.balance, 3750);
  assert.equal(res.body.summary.hasDeposit, true);
});

test("un montant envoye par le client est ignore", async () => {
  const { res, stripe } = await run({
    items: [{ id: "nexus", qty: 1, price: 1 }],
    customer: CUSTOMER,
    amount: 100, amountInCents: 100, total: 1,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(stripe.calls[0].amount, 469500); // 4695 €, pas 1 €
});

/* --- refus : Stripe ne doit jamais etre appele --- */

const rejects = async (body, code) => {
  const { res, stripe } = await run(body);
  assert.equal(res.statusCode, 400, `attendu 400, recu ${res.statusCode}`);
  assert.equal(res.body.code, code);
  assert.equal(stripe.calls.length, 0, "Stripe ne doit pas etre appele sur une commande invalide");
};

test("produit inconnu : refus sans appel a Stripe", () =>
  rejects({ items: [{ id: "pirate", qty: 1 }], customer: CUSTOMER }, "unknown_product"));

test("panier vide : refus sans appel a Stripe", () =>
  rejects({ items: [], customer: CUSTOMER }, "empty_cart"));

test("quantite invalide : refus sans appel a Stripe", () =>
  rejects({ items: [{ id: "nexus", qty: 0 }], customer: CUSTOMER }, "invalid_qty"));

test("CGV non acceptees : refus", () =>
  rejects({ items: [{ id: "nexus", qty: 1 }], customer: { ...CUSTOMER, acceptCgv: false } }, "cgv_not_accepted"));

test("email invalide : refus", () =>
  rejects({ items: [{ id: "nexus", qty: 1 }], customer: { ...CUSTOMER, email: "jean(at)example" } }, "invalid_email"));

test("telephone invalide : refus", () =>
  rejects({ items: [{ id: "nexus", qty: 1 }], customer: { ...CUSTOMER, phone: "12" } }, "invalid_phone"));

test("champ obligatoire vide : refus", () =>
  rejects({ items: [{ id: "nexus", qty: 1 }], customer: { ...CUSTOMER, city: "   " } }, "missing_field"));

test("coordonnees absentes : refus", () =>
  rejects({ items: [{ id: "nexus", qty: 1 }] }, "missing_customer"));

/* --- robustesse --- */

test("methode GET : 405", async () => {
  const res = fakeRes();
  await handle({ method: "GET" }, res, { stripe: fakeStripe(), publishableKey: "pk" });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "POST");
});

test("corps JSON illisible : 400", async () => {
  const res = fakeRes();
  await handle({ method: "POST", body: "{pas du json" }, res, { stripe: fakeStripe(), publishableKey: "pk" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "bad_json");
});

test("corps recu en chaine JSON : accepte", async () => {
  const res = fakeRes();
  const stripe = fakeStripe();
  await handle(
    { method: "POST", body: JSON.stringify({ items: [{ id: "nexus", qty: 1 }], customer: CUSTOMER }) },
    res, { stripe, publishableKey: "pk" }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(stripe.calls[0].amount, 469500);
});

test("panne Stripe : 502, pas de fuite du message d'erreur", async () => {
  const res = fakeRes();
  await handle(
    post({ items: [{ id: "nexus", qty: 1 }], customer: CUSTOMER }),
    res, { stripe: fakeStripe({ throws: true }), publishableKey: "pk" }
  );
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, "stripe_unavailable");
  assert.ok(!JSON.stringify(res.body).includes("stripe down"));
});

test("aucune cle secrete ne transite dans la reponse", async () => {
  const { res } = await run({ items: [{ id: "nexus", qty: 1 }], customer: CUSTOMER });
  const dump = JSON.stringify(res.body);
  assert.ok(!dump.includes("sk_"), "la reponse ne doit jamais contenir de cle secrete");
  assert.ok(dump.includes("pk_test_abc"), "la cle publiable est attendue");
});
