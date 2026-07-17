/* Tracking OXO Spa — GA4 + Pixel Meta + attribution publicitaire.
 *
 * ⚠️ INSTALLÉ SANS BANDEAU DE CONSENTEMENT, à la demande explicite du client
 * (2026-07-17). GA4 et Meta déposent donc des cookies dès le chargement, sans
 * recueil de consentement préalable : NON conforme CNIL sur un site marchand
 * français. À régulariser avec un CMP.
 *
 * Pour brancher un consentement plus tard, sans réécrire ce fichier : retirer
 * l'appel boot() en bas, et l'appeler depuis le callback « accepter » du CMP.
 * La capture d'attribution et le câblage des événements restent, mais rien ne
 * partira vers GA4/Meta tant que boot() n'a pas tourné.
 *
 * IDs : GA4 G-F27LGZHFNX · Pixel Meta 1655275805769277.
 */
(function () {
  "use strict";

  var GA4_ID = "G-F27LGZHFNX";
  var META_ID = "1655275805769277";
  var CURRENCY = "EUR";

  var param = function (n) { return new URLSearchParams(location.search).get(n) || ""; };
  function cookie(n) {
    var m = document.cookie.match("(^|;)\\s*" + n + "\\s*=\\s*([^;]+)");
    return m ? decodeURIComponent(m.pop()) : "";
  }

  /* ============================================================
     1. Attribution — pour rapprocher un lead / un achat d'une pub
     ============================================================ */
  var ATTR_KEY = "oxo_attr";
  var MAX_AGE = 1000 * 60 * 60 * 24 * 90; // 90 jours

  function loadAttr() {
    try { return JSON.parse(localStorage.getItem(ATTR_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveAttr(a) { try { localStorage.setItem(ATTR_KEY, JSON.stringify(a)); } catch (e) {} }

  // Identifiants de clic + UTM : on garde la derniere valeur NON vide, jamais
  // ecrasee par un retour en direct, pour ne pas perdre l'attribution d'une pub.
  var CLICK_IDS = ["gclid", "gbraid", "wbraid", "fbclid", "msclkid"];
  var UTMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

  function captureAttribution() {
    var a = loadAttr();
    var now = Date.now();
    if (a.ts && now - a.ts > MAX_AGE) a = {}; // expiration
    var got = false;
    CLICK_IDS.concat(UTMS).forEach(function (k) {
      var v = param(k);
      if (v) { a[k] = v; got = true; }
    });
    if (!a.first_seen) {
      a.first_seen = new Date(now).toISOString();
      a.landing_page = location.pathname + location.search;
      a.referrer = document.referrer || "";
    }
    if (got || !a.ts) a.ts = now;
    saveAttr(a);
  }

  // fbc/fbp : lus dans les cookies poses par le Pixel ; fbc reconstruit depuis
  // fbclid si le cookie n'est pas encore ecrit (format attendu par Meta).
  function metaIds() {
    var a = loadAttr();
    var fbc = cookie("_fbc");
    if (!fbc && a.fbclid) fbc = "fb.1." + (a.ts || Date.now()) + "." + a.fbclid;
    return { fbp: cookie("_fbp"), fbc: fbc };
  }

  // fbp/fbc pour la Conversions API serveur (transmis au checkout Stripe).
  window.oxoMarketing = function () { return metaIds(); };

  // Objet plat injecte dans le formulaire Formspree (champs non vides seulement).
  window.oxoAttribution = function () {
    var a = loadAttr(), m = metaIds(), out = {};
    CLICK_IDS.concat(UTMS).forEach(function (k) { if (a[k]) out[k] = a[k]; });
    if (m.fbc) out.fbc = m.fbc;
    if (m.fbp) out.fbp = m.fbp;
    if (a.landing_page) out.landing_page = a.landing_page;
    if (a.referrer) out.referrer = a.referrer;
    if (a.first_seen) out.first_seen = a.first_seen;
    return out;
  };

  /* ============================================================
     2. Chargement GA4 + Meta
     ============================================================ */
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;

  function loadGA4() {
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA4_ID;
    document.head.appendChild(s);
    gtag("js", new Date());
    gtag("config", GA4_ID);
  }

  function loadMeta() {
    if (window.fbq) return;
    var n = (window.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    });
    if (!window._fbq) window._fbq = n;
    n.push = n; n.loaded = true; n.version = "2.0"; n.queue = [];
    var t = document.createElement("script");
    t.async = true;
    t.src = "https://connect.facebook.net/en_US/fbevents.js";
    document.head.appendChild(t);
    window.fbq("init", META_ID);
    window.fbq("track", "PageView");
  }

  /* ============================================================
     3. Émission d'événements (GA4 + Meta en parallèle)
     ============================================================ */
  function ga(name, p) { try { gtag("event", name, p || {}); } catch (e) {} }
  function fbTrack(name, p, eventID) {
    try {
      if (!window.fbq) return;
      if (eventID) window.fbq("track", name, p || {}, { eventID: eventID });
      else window.fbq("track", name, p || {});
    } catch (e) {}
  }
  function fbCustom(name, p) { try { window.fbq && window.fbq("trackCustom", name, p || {}); } catch (e) {} }

  var track = {
    call: function () {
      ga("contact_appel", { method: "phone" });
      fbTrack("Contact", { contact_method: "phone" });
    },
    lead: function (info) {
      info = info || {};
      // event_id partage Pixel <-> Conversions API serveur, pour dedupliquer
      var eventId = "lead." + Date.now() + "." + Math.random().toString(36).slice(2, 10);
      ga("generate_lead", { form_page: info.page || "", sujet: info.sujet || "", modele: info.modele || "" });
      fbTrack("Lead", { content_name: info.sujet || "contact" }, eventId);
      // envoi serveur (CAPI) en parallele — best-effort, n'affecte jamais le formulaire
      if (info.email || info.phone) {
        var m = metaIds();
        try {
          fetch("/api/meta-lead", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            keepalive: true,
            body: JSON.stringify({
              eventId: eventId, sourceUrl: location.href, sujet: info.sujet || "",
              email: info.email || "", phone: info.phone || "",
              firstName: info.firstName || "", lastName: info.lastName || "",
              fbp: m.fbp || "", fbc: m.fbc || ""
            })
          }).catch(function () {});
        } catch (e) {}
      }
    },
    addToCart: function (it) {
      it = it || {};
      ga("add_to_cart", {
        currency: CURRENCY, value: it.value || 0,
        items: [{ item_id: it.id, item_name: it.name, price: it.value, quantity: 1 }]
      });
      fbTrack("AddToCart", { content_ids: [it.id], content_name: it.name, content_type: "product", value: it.value || 0, currency: CURRENCY });
    },
    viewItem: function (it) {
      it = it || {};
      ga("view_item", { currency: CURRENCY, value: it.value || 0, items: [{ item_id: it.id, item_name: it.name, price: it.value }] });
      fbTrack("ViewContent", { content_ids: [it.id], content_name: it.name, content_type: "product", value: it.value || 0, currency: CURRENCY });
    },
    beginCheckout: function (value, ids) {
      ga("begin_checkout", { currency: CURRENCY, value: value || 0 });
      fbTrack("InitiateCheckout", { value: value || 0, currency: CURRENCY, content_ids: ids || [], content_type: "product", num_items: (ids || []).length });
    },
    addPaymentInfo: function (value, ids) {
      ga("add_payment_info", { currency: CURRENCY, value: value || 0 });
      fbTrack("AddPaymentInfo", { value: value || 0, currency: CURRENCY, content_ids: ids || [], content_type: "product" });
    },
    simulation: function (amount) {
      ga("simulation_financement", { value: amount || 0, currency: CURRENCY });
      fbCustom("SimulationFinancement", { value: amount || 0, currency: CURRENCY });
    },
    contactIntent: function (kind) {
      ga("contact_intent", { kind: kind || "" });
    },
    purchase: function (o) {
      o = o || {};
      var seen = "oxo_purchase_" + o.id;
      // anti-doublon : la page de confirmation peut etre rechargee
      try { if (o.id && localStorage.getItem(seen)) return; } catch (e) {}
      ga("purchase", { transaction_id: o.id, value: o.value || 0, currency: o.currency || CURRENCY });
      fbTrack("Purchase", { value: o.value || 0, currency: o.currency || CURRENCY }, o.id);
      try { if (o.id) localStorage.setItem(seen, "1"); } catch (e) {}
    }
  };
  window.oxoTrack = track;

  /* ============================================================
     4. Câblage des interactions (délégation, indépendant des autres scripts)
     ============================================================ */
  // Prix produits pour valoriser add_to_cart des cartes de l'accueil.
  var PRICES = {};
  fetch("/assets/products.json", { cache: "force-cache" })
    .then(function (r) { return r.json(); })
    .then(function (c) { c.products.forEach(function (p) { PRICES[p.id] = { price: p.price, name: p.name }; }); })
    .catch(function () {});

  function cartIds() {
    try { return window.oxoCartLines ? window.oxoCartLines().map(function (l) { return l.id; }) : []; } catch (e) { return []; }
  }
  function cartValue() {
    try { return window.oxoCartTotals ? window.oxoCartTotals().subtotal : 0; } catch (e) { return 0; }
  }

  document.addEventListener("click", function (e) {
    var el = e.target.closest ? e.target : e.srcElement;
    if (!el || !el.closest) return;

    if (el.closest('a[href^="tel:"]')) { track.call(); return; }

    var add = el.closest("[data-add]");
    if (add) {
      var id = add.getAttribute("data-id"), info = PRICES[id] || {};
      track.addToCart({ id: id, name: info.name, value: info.price });
      return;
    }
    if (el.closest("#pdpAddCart")) {
      var box = document.querySelector("[data-pdp-id]");
      if (box) track.addToCart({
        id: box.getAttribute("data-pdp-id"),
        name: box.getAttribute("data-pdp-name"),
        value: parseInt(box.getAttribute("data-pdp-base"), 10) || 0
      });
      return;
    }
    if (el.closest('a[href="/commande"]')) { track.beginCheckout(cartValue(), cartIds()); return; }

    var sim = el.closest("[data-sim]");
    if (sim) { track.simulation(parseInt(sim.getAttribute("data-sim"), 10) || 0); return; }

    // intention de contact forte (devis / rappel), pas la simple navigation
    if (el.closest("[data-callback]")) { track.contactIntent("rappel_popup"); return; }
    if (el.closest('a[href*="sujet=devis"]')) { track.contactIntent("devis"); return; }
  });

  // « Continuer vers le paiement » : capture, pour tirer meme si checkout.js
  // fait preventDefault sur le meme submit.
  document.addEventListener("submit", function (e) {
    if (e.target && e.target.id === "coForm") track.addPaymentInfo(cartValue(), cartIds());
  }, true);

  // view_item / ViewContent sur les fiches produit
  function fireViewItem() {
    var box = document.querySelector("[data-pdp-id]");
    if (box) track.viewItem({
      id: box.getAttribute("data-pdp-id"),
      name: box.getAttribute("data-pdp-name"),
      value: parseInt(box.getAttribute("data-pdp-base"), 10) || 0
    });
  }

  /* ============================================================
     5. Démarrage
     ============================================================ */
  function boot() {
    loadGA4();
    loadMeta();
    fireViewItem();
  }

  captureAttribution();
  boot();
})();
