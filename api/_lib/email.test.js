import test from "node:test";
import assert from "node:assert/strict";
import { sendOrderEmails } from "./email.js";
import { computeOrder } from "./pricing.js";

const CUSTOMER = {
  firstName: "Jean", lastName: "Dupont", email: "jean@example.com",
  phone: "0612345678", address: "3 rue des Lilas", postalCode: "31200", city: "Toulouse",
};

const params = (items = [{ id: "spa-convivial", qty: 1 }]) => {
  const order = computeOrder(items);
  return { order, customer: CUSTOMER, reference: "pi_test_1", amountPaid: order.dueNow };
};

/** fetch simule qui capture les requetes et repond selon un scenario. */
function fakeFetch(scenario = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, headers: opts.headers, body });
    if (scenario.fail === "all" || scenario.fail === calls.length) {
      return { ok: false, status: 422, text: async () => '{"message":"domain not verified"}' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: `email_${calls.length}` }) };
  };
  fn.calls = calls;
  return fn;
}

function withEnv(env, run) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  return Promise.resolve(run()).finally(() => {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}

test("sans RESEND_API_KEY : mode journal, aucun appel reseau", () =>
  withEnv({ RESEND_API_KEY: undefined, ORDER_NOTIFY_EMAIL: "oxo@oxo.fr" }, async () => {
    const f = fakeFetch();
    const r = await sendOrderEmails(params(), f);
    assert.equal(f.calls.length, 0);
    assert.equal(r.customer.dryRun, true);
    assert.equal(r.oxo.dryRun, true);
  }));

test("nominal : deux emails, client et OXO, avec cles d'idempotence distinctes", () =>
  withEnv({ RESEND_API_KEY: "re_test", ORDER_NOTIFY_EMAIL: "oxo@oxo.fr", EMAIL_FROM: "OXO <x@y.fr>" }, async () => {
    const f = fakeFetch();
    const r = await sendOrderEmails(params(), f);
    assert.equal(f.calls.length, 2);
    assert.equal(r.customer.sent, true);
    assert.equal(r.oxo.sent, true);

    const [c, o] = f.calls;
    assert.equal(c.body.to, "jean@example.com");
    assert.equal(o.body.to, "oxo@oxo.fr");
    assert.equal(c.headers["Idempotency-Key"], "pi_test_1-customer");
    assert.equal(o.headers["Idempotency-Key"], "pi_test_1-oxo");
    assert.match(c.headers.Authorization, /^Bearer re_test$/);
  }));

test("l'email client contient reference, montant regle et solde", () =>
  withEnv({ RESEND_API_KEY: "re_test", ORDER_NOTIFY_EMAIL: "oxo@oxo.fr" }, async () => {
    const f = fakeFetch();
    await sendOrderEmails(params([{ id: "spa-convivial", qty: 1 }]), f); // 9500, acompte 50%
    const html = f.calls[0].body.html;
    assert.match(html, /pi_test_1/);
    assert.match(html, /4\s?750\s?€/); // regle aujourd'hui
    assert.match(html, /Solde à la livraison/);
  }));

test("un produit en stock n'affiche pas de solde", () =>
  withEnv({ RESEND_API_KEY: "re_test", ORDER_NOTIFY_EMAIL: "oxo@oxo.fr" }, async () => {
    const f = fakeFetch();
    await sendOrderEmails(params([{ id: "nexus", qty: 1 }]), f);
    assert.doesNotMatch(f.calls[0].body.html, /Solde à la livraison/);
  }));

test("echec de l'email client : n'empeche pas la notification OXO, ne leve pas", () =>
  withEnv({ RESEND_API_KEY: "re_test", ORDER_NOTIFY_EMAIL: "oxo@oxo.fr" }, async () => {
    const f = fakeFetch({ fail: 1 }); // le 1er envoi echoue
    const r = await sendOrderEmails(params(), f);
    assert.equal(r.customer.sent, false);
    assert.match(r.customer.error, /422/);
    assert.equal(r.oxo.sent, true, "la notification OXO part quand meme");
  }));

test("les deux envois echouent : retourne un etat d'erreur sans lever", () =>
  withEnv({ RESEND_API_KEY: "re_test", ORDER_NOTIFY_EMAIL: "oxo@oxo.fr" }, async () => {
    const f = fakeFetch({ fail: "all" });
    const r = await sendOrderEmails(params(), f);
    assert.equal(r.customer.sent, false);
    assert.equal(r.oxo.sent, false);
  }));

test("sans ORDER_NOTIFY_EMAIL : email client envoye, notif OXO ignoree", () =>
  withEnv({ RESEND_API_KEY: "re_test", ORDER_NOTIFY_EMAIL: undefined }, async () => {
    const f = fakeFetch();
    const r = await sendOrderEmails(params(), f);
    assert.equal(f.calls.length, 1);
    assert.equal(r.customer.sent, true);
    assert.equal(r.oxo.skipped, true);
  }));

test("les donnees client sont echappees dans le HTML (anti-injection)", () =>
  withEnv({ RESEND_API_KEY: "re_test", ORDER_NOTIFY_EMAIL: "oxo@oxo.fr" }, async () => {
    const f = fakeFetch();
    const p = params();
    p.customer = { ...CUSTOMER, firstName: '<script>alert(1)</script>', lastName: "O'Brien & <b>" };
    await sendOrderEmails(p, f);
    const oxoHtml = f.calls[1].body.html;
    assert.doesNotMatch(oxoHtml, /<script>alert/);
    assert.match(oxoHtml, /&lt;script&gt;/);
  }));
