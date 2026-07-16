import test from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { handle } from "../stripe-webhook.js";
import { buildMetadata, parseCart, parseCustomer } from "./metadata.js";
import { computeOrder } from "./pricing.js";
import { buildInvoiceLines, invoiceTotalTtc, recordOrder, toAxonautDate } from "./axonaut.js";

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
  const emailCalls = [];
  const recordOrderFn = opts.recordOrderFn || (async (a) => (calls.push(a), { dryRun: false, invoiceId: 42 }));
  const sendEmailsFn = opts.sendEmailsFn || (async (a) => (emailCalls.push(a), { customer: { sent: true }, oxo: { sent: true } }));
  const s = opts.stripe || stripeStub();
  return handle(req, res, { stripe: s, webhookSecret: opts.secret || SECRET, rawBody, recordOrderFn, sendEmailsFn })
    .then(() => ({ res, calls, emailCalls, stripe: s }));
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

test("paiement reussi : emails envoyes apres enregistrement", async () => {
  const pi = paymentIntent([{ id: "nexus", qty: 1 }]);
  const { res, emailCalls } = await run(pi);
  assert.equal(res.statusCode, 200);
  assert.equal(emailCalls.length, 1);
  assert.equal(emailCalls[0].reference, "pi_test_123");
  assert.equal(emailCalls[0].amountPaid, 4695);
});

test("email en echec : la commande reste enregistree, webhook a 200", async () => {
  const pi = paymentIntent([{ id: "nexus", qty: 1 }]);
  const s = stripeStub();
  const { res } = await run(pi, {
    stripe: s,
    sendEmailsFn: async () => ({ customer: { sent: false, error: "resend down" }, oxo: { sent: false, error: "resend down" } }),
  });
  assert.equal(res.statusCode, 200, "un email rate ne doit pas faire echouer le webhook");
  assert.equal(s.updates.length, 1, "la facture reste marquee comme enregistree");
  assert.equal(res.body.emails.customer.sent, false);
});

test("mode journal : emails quand meme tentes (testable sans Axonaut)", async () => {
  const pi = paymentIntent([{ id: "nexus", qty: 1 }]);
  const { res, emailCalls } = await run(pi, { recordOrderFn: async () => ({ dryRun: true }) });
  assert.equal(res.body.dryRun, true);
  assert.equal(emailCalls.length, 1, "les emails sont independants d'Axonaut");
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

/* ---------- idempotence Axonaut : le doublon de facture est le pire scenario ----------
   Axonaut ne permet pas de savoir si une facture existe deja pour une commande
   (order_number ni renvoye ni filtrable). L'avancement vit donc dans les metadonnees
   du PaymentIntent. Ces tests verifient qu'un rejeu Stripe ne duplique jamais. */

/** Faux Axonaut : capture les appels ET leurs corps, et peut echouer sur commande. */
function axonautStub({ failOn } = {}) {
  const calls = [];
  const bodies = {};
  const fetchImpl = async (url, opts) => {
    const path = url.replace("https://axonaut.com/api/v2", "");
    const key = `${opts.method} ${path.split("?")[0]}`;
    calls.push(key);
    if (opts.body) bodies[key] = JSON.parse(opts.body);
    if (failOn === key) return { ok: false, status: 502, text: async () => "boom" };
    const body =
      path.startsWith("/companies") && opts.method === "GET" ? "[]"
      : path === "/companies" ? '{"id":7}'
      : path === "/invoices" ? '{"id":42}'
      : "{}";
    return { ok: true, status: 200, text: async () => body };
  };
  return { calls, bodies, fetchImpl, count: (k) => calls.filter((c) => c === k).length };
}

const AX_ORDER = () => computeOrder([{ id: "nexus", qty: 1 }]);

/* Axonaut a rejete la premiere vraie facture avec "Property date: Invalid RFC3339" :
   son parseur refuse les millisecondes et le suffixe Z, pourtant valides en RFC3339.
   Format attendu, tire de l'exemple de leur spec : "2022-05-28T18:05:35+02:00". */
test("Axonaut : format de date — ni millisecondes, ni Z, offset numerique", () => {
  const RFC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
  for (const input of [
    "2026-07-16T19:51:15.000Z",           // ce que produisait toISOString()
    "2026-07-16T19:51:15Z",
    new Date(1_784_231_475_000).toISOString(),
    "2022-05-28T18:05:35+02:00",          // l'exemple de leur doc
  ]) {
    const out = toAxonautDate(input);
    assert.match(out, RFC, `format invalide pour ${input} -> ${out}`);
    assert.ok(!out.includes("."), "les millisecondes doivent disparaitre");
    assert.ok(!out.endsWith("Z"), "le suffixe Z doit disparaitre");
    // la conversion ne doit pas decaler l'instant
    assert.equal(new Date(out).getTime(), new Date(input).getTime());
  }
});

test("Axonaut : une date invalide echoue avant tout appel", () => {
  assert.throws(() => toAxonautDate("pas une date"), /Date invalide/);
});

test("Axonaut : la date envoyee a l'API respecte le format", async () => {
  process.env.AXONAUT_ENABLED = "true";
  process.env.AXONAUT_API_KEY = "k";
  const ax = axonautStub();
  const order = AX_ORDER();
  await recordOrder({
    order, customer: CUSTOMER, reference: "pi_1", amountPaid: order.dueNow,
    date: "2026-07-16T19:51:15.000Z", fetchImpl: ax.fetchImpl, onProgress: async () => {},
  });
  const RFC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
  assert.match(ax.bodies["POST /invoices"].date, RFC);
  assert.match(ax.bodies["POST /invoices"].due_date, RFC);
  assert.match(ax.bodies["POST /payments"].date, RFC);
  assert.equal(ax.bodies["POST /invoices"].date, "2026-07-16T19:51:15+00:00");
  delete process.env.AXONAUT_ENABLED;
});

test("Axonaut : premiere execution cree client + facture + paiement, et jalonne", async () => {
  process.env.AXONAUT_ENABLED = "true";
  process.env.AXONAUT_API_KEY = "k";
  const ax = axonautStub();
  const patches = [];
  const order = AX_ORDER();
  const r = await recordOrder({
    order, customer: CUSTOMER, reference: "pi_1", amountPaid: order.dueNow,
    date: "2026-01-01T00:00:00Z", fetchImpl: ax.fetchImpl,
    onProgress: async (p) => patches.push(p),
  });
  assert.equal(r.invoiceId, 42);
  assert.equal(ax.count("POST /invoices"), 1);
  assert.equal(ax.count("POST /payments"), 1);
  // l'id de facture est jalonne AVANT le paiement : c'est ce qui protege du doublon
  assert.deepEqual(patches.map((p) => Object.keys(p)[0]), ["axonaut_company_id", "axonaut_invoice_id"]);
  delete process.env.AXONAUT_ENABLED;
});

test("Axonaut : rejeu avec facture deja jalonnee -> AUCUNE seconde facture", async () => {
  process.env.AXONAUT_ENABLED = "true";
  process.env.AXONAUT_API_KEY = "k";
  const ax = axonautStub();
  const order = AX_ORDER();
  const r = await recordOrder({
    order, customer: CUSTOMER, reference: "pi_1", amountPaid: order.dueNow,
    date: "2026-01-01T00:00:00Z", fetchImpl: ax.fetchImpl,
    existing: { companyId: 7, invoiceId: 42, paymentRecorded: false },
  });
  assert.equal(r.invoiceId, 42);
  assert.equal(ax.count("POST /invoices"), 0, "la facture ne doit PAS etre recreee");
  assert.equal(ax.count("POST /companies"), 0, "le client ne doit pas etre recree");
  assert.equal(ax.count("POST /payments"), 1, "seul le paiement restant est rejoue");
  delete process.env.AXONAUT_ENABLED;
});

test("Axonaut : rejeu complet deja fait -> aucun appel d'ecriture", async () => {
  process.env.AXONAUT_ENABLED = "true";
  process.env.AXONAUT_API_KEY = "k";
  const ax = axonautStub();
  const order = AX_ORDER();
  await recordOrder({
    order, customer: CUSTOMER, reference: "pi_1", amountPaid: order.dueNow,
    date: "2026-01-01T00:00:00Z", fetchImpl: ax.fetchImpl,
    existing: { companyId: 7, invoiceId: 42, paymentRecorded: true },
  });
  assert.equal(ax.count("POST /invoices"), 0);
  assert.equal(ax.count("POST /payments"), 0);
  delete process.env.AXONAUT_ENABLED;
});

test("Axonaut : echec du paiement APRES creation -> l'erreur porte invoiceId", async () => {
  process.env.AXONAUT_ENABLED = "true";
  process.env.AXONAUT_API_KEY = "k";
  const ax = axonautStub({ failOn: "POST /payments" });
  const order = AX_ORDER();
  await assert.rejects(
    () => recordOrder({
      order, customer: CUSTOMER, reference: "pi_1", amountPaid: order.dueNow,
      date: "2026-01-01T00:00:00Z", fetchImpl: ax.fetchImpl, onProgress: async () => {},
    }),
    (err) => err.invoiceId === 42 // sans ca, le webhook rejouerait et dupliquerait
  );
  delete process.env.AXONAUT_ENABLED;
});

test("webhook : echec APRES creation de facture -> 200, jamais de rejeu", async () => {
  const pi = paymentIntent([{ id: "nexus", qty: 1 }]);
  const s = stripeStub();
  const { res, emailCalls } = await run(pi, {
    stripe: s,
    recordOrderFn: async () => {
      const e = new Error("axonaut timeout");
      e.invoiceId = 42;
      throw e;
    },
  });
  assert.equal(res.statusCode, 200, "un 500 ferait rejouer Stripe et dupliquerait la facture");
  assert.equal(res.body.invoiceId, 42);
  assert.equal(res.body.incomplete, true);
  assert.equal(emailCalls.length, 1, "les emails partent malgre l'echec Axonaut");
});

test("webhook : echec AVANT creation de facture -> 500, rejeu sans risque", async () => {
  const pi = paymentIntent([{ id: "nexus", qty: 1 }]);
  const { res } = await run(pi, {
    recordOrderFn: async () => { throw new Error("axonaut down"); }, // pas d'invoiceId
  });
  assert.equal(res.statusCode, 500);
});

/* Une panne Axonaut rendait la vente TOTALEMENT invisible : client sans confirmation,
   vendeur sans notification. Constate en production le 2026-07-16. Les emails ne
   doivent jamais dependre de la comptabilite. */
test("webhook : Axonaut en panne -> les emails partent QUAND MEME", async () => {
  const pi = paymentIntent([{ id: "nexus", qty: 1 }]);
  const { res, emailCalls } = await run(pi, {
    recordOrderFn: async () => { throw new Error("POST /invoices -> 400"); },
  });
  assert.equal(res.statusCode, 500, "rejeu attendu : rien n'a ete cree cote Axonaut");
  assert.equal(emailCalls.length, 1, "la notification de vente ne doit pas dependre d'Axonaut");
  assert.equal(emailCalls[0].reference, "pi_test_123");
  assert.equal(res.body.emails.customer.sent, true);
});

test("webhook : les jalons deja poses sont transmis a recordOrder", async () => {
  const pi = paymentIntent([{ id: "nexus", qty: 1 }], {
    extraMeta: { axonaut_company_id: "7", axonaut_invoice_id: "42" },
  });
  let received;
  await run(pi, { recordOrderFn: async (a) => ((received = a.existing), { dryRun: false, invoiceId: 42 }) });
  assert.equal(received.companyId, "7");
  assert.equal(received.invoiceId, "42");
  assert.equal(received.paymentRecorded, false);
});

test("recordOrder refuse d'ecrire si le total ne correspond pas au montant encaisse", async () => {
  const order = computeOrder([{ id: "nexus", qty: 1 }]); // 4695 du
  await assert.rejects(
    () => recordOrder({ order, customer: CUSTOMER, reference: "pi_x", amountPaid: 4694, date: "2026-01-01T00:00:00Z" }),
    /!= montant encaisse/
  );
});
