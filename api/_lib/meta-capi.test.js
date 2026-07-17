import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { normalizePhone, buildUserData, buildEventPayload, sendMetaEvent } from "./meta-capi.js";

const sha = (v) => createHash("sha256").update(v, "utf8").digest("hex");

test("normalizePhone : 0X FR -> 33X", () => {
  assert.equal(normalizePhone("06 12 34 56 78"), "33612345678");
  assert.equal(normalizePhone("0033612345678"), "33612345678");
  assert.equal(normalizePhone("+33 6 12 34 56 78"), "33612345678");
  assert.equal(normalizePhone(""), "");
});

test("buildUserData : email/telephone haches, casse et espaces normalises", () => {
  const ud = buildUserData({ email: "  Test@Example.COM ", phone: "06 12 34 56 78" });
  assert.deepEqual(ud.em, [sha("test@example.com")]);
  assert.deepEqual(ud.ph, [sha("33612345678")]);
});

test("buildUserData : ville/CP normalises alphanum, pays en 2 lettres", () => {
  const ud = buildUserData({ city: "Toulouse", zip: "31 200", country: "FR" });
  assert.deepEqual(ud.ct, [sha("toulouse")]);
  assert.deepEqual(ud.zp, [sha("31200")]);
  assert.deepEqual(ud.country, [sha("fr")]);
});

test("buildUserData : fbp/fbc/IP/UA passent EN CLAIR (non haches)", () => {
  const ud = buildUserData({ fbp: "fb.1.123.abc", fbc: "fb.1.123.click", ip: "1.2.3.4", userAgent: "UA" });
  assert.equal(ud.fbp, "fb.1.123.abc");
  assert.equal(ud.fbc, "fb.1.123.click");
  assert.equal(ud.client_ip_address, "1.2.3.4");
  assert.equal(ud.client_user_agent, "UA");
});

test("buildUserData : champs absents -> cles absentes", () => {
  const ud = buildUserData({ email: "a@b.co" });
  assert.ok(ud.em);
  assert.equal("ph" in ud, false);
  assert.equal("fbp" in ud, false);
});

test("buildEventPayload : structure /events + custom_data + test code", () => {
  const body = buildEventPayload({
    eventName: "Purchase", eventId: "pi_123", eventTime: 1700000000,
    eventSourceUrl: "https://oxo-spa.com/confirmation",
    userData: { email: "a@b.co" }, customData: { currency: "EUR", value: 4695 },
  }, "TEST123");
  assert.equal(body.data.length, 1);
  const e = body.data[0];
  assert.equal(e.event_name, "Purchase");
  assert.equal(e.event_id, "pi_123");
  assert.equal(e.event_time, 1700000000);
  assert.equal(e.action_source, "website");
  assert.equal(e.event_source_url, "https://oxo-spa.com/confirmation");
  assert.deepEqual(e.custom_data, { currency: "EUR", value: 4695 });
  assert.deepEqual(e.user_data.em, [sha("a@b.co")]);
  assert.equal(body.test_event_code, "TEST123");
  // le token n'est jamais dans le payload construit
  assert.equal("access_token" in body, false);
});

test("sendMetaEvent : sans token -> saute, aucun appel reseau", async () => {
  let called = false;
  const r = await sendMetaEvent({ eventName: "Lead" }, { fetchFn: () => { called = true; }, token: "" });
  assert.deepEqual(r, { skipped: "no_token" });
  assert.equal(called, false);
});

test("sendMetaEvent : POST correct + token dans le corps, jamais dans l'URL", async () => {
  let seen = null;
  const fetchFn = async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 200 };
  };
  const r = await sendMetaEvent(
    { eventName: "Purchase", eventId: "pi_1", userData: { email: "a@b.co" }, customData: { currency: "EUR", value: 100 } },
    { token: "SECRET", datasetId: "999", fetchFn }
  );
  assert.equal(r.ok, true);
  assert.match(seen.url, /graph\.facebook\.com\/v\d+\.\d+\/999\/events$/);
  assert.equal(seen.url.includes("SECRET"), false); // token pas dans l'URL
  assert.equal(seen.body.access_token, "SECRET");
  assert.equal(seen.body.data[0].event_name, "Purchase");
});

test("sendMetaEvent : erreur reseau -> ok:false, ne leve pas", async () => {
  const fetchFn = async () => { throw new Error("boom"); };
  const r = await sendMetaEvent({ eventName: "Lead", userData: {} }, { token: "X", fetchFn });
  assert.equal(r.ok, false);
  assert.equal(r.error, "boom");
});
