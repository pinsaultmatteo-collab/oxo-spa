import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../meta-lead.js";

function mockRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const req = (method, body, headers = {}) => ({ method, body, headers, socket: {} });

test("refuse les methodes autres que POST", async () => {
  const res = mockRes();
  await handle(req("GET"), res, {});
  assert.equal(res.statusCode, 405);
});

test("400 si aucun identifiant exploitable", async () => {
  const res = mockRes();
  await handle(req("POST", { sujet: "devis" }), res, { sendFn: async () => ({ ok: true }) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "no_identifier");
});

test("sans token CAPI -> 200 skipped, aucun envoi", async () => {
  const prev = process.env.META_CAPI_TOKEN;
  delete process.env.META_CAPI_TOKEN;
  let called = false;
  const res = mockRes();
  await handle(req("POST", { email: "a@b.co" }), res, { sendFn: async () => { called = true; } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.skipped, "disabled");
  assert.equal(called, false);
  if (prev !== undefined) process.env.META_CAPI_TOKEN = prev;
});

test("avec token : transmet Lead + IP/UA du serveur, renvoie ok", async () => {
  process.env.META_CAPI_TOKEN = "TESTTOKEN";
  let seen = null;
  const res = mockRes();
  const r = req("POST",
    { email: "a@b.co", phone: "0612345678", eventId: "lead.1", sourceUrl: "https://oxo-spa.com/contact", fbp: "fb.1.2.3" },
    { "x-forwarded-for": "9.9.9.9, 10.0.0.1", "user-agent": "TestUA" });
  await handle(r, res, { sendFn: async (ev) => { seen = ev; return { ok: true }; } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(seen.eventName, "Lead");
  assert.equal(seen.eventId, "lead.1");
  assert.equal(seen.userData.email, "a@b.co");
  assert.equal(seen.userData.ip, "9.9.9.9");        // premier IP du x-forwarded-for
  assert.equal(seen.userData.userAgent, "TestUA");
  assert.equal(seen.userData.fbp, "fb.1.2.3");
  delete process.env.META_CAPI_TOKEN;
});
