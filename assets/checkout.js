/* Tunnel de commande OXO Spa.
 *
 * Deux etapes : coordonnees, puis paiement.
 * Le navigateur n'envoie que des identifiants ; les montants affiches a l'etape 2
 * sont ceux renvoyes par le serveur, jamais ceux calcules ici. */
(function () {
  "use strict";

  var $ = function (s) { return document.querySelector(s); };
  var fmt = function (n) { return Math.round(n).toLocaleString("fr-FR") + " €"; };

  var grid = $("#coGrid"), empty = $("#coEmpty");
  var form = $("#coForm"), submitBtn = $("#coSubmit"), formError = $("#coError");
  var payStep = $("#coPay"), payBtn = $("#payBtn"), payError = $("#payError"),
      payAmount = $("#payAmount"), payBack = $("#payBack");
  if (!grid || !form) return;

  var stripe = null, elements = null, clientSecret = null, submitting = false;

  var INDISPO = "Le paiement est momentanément indisponible. Merci de réessayer dans quelques instants, ou de nous contacter pour finaliser votre commande.";

  /** Marque un message comme affichable au client. Tout le reste reste en console. */
  function safeError(message) {
    var e = new Error(message);
    e.safe = true;
    return e;
  }

  /* ---------- recapitulatif ---------- */

  function renderRecap(summary) {
    var lines = summary
      ? summary.lines
      : window.oxoCartLines().map(function (l) {
          return { name: l.name, qty: l.qty, total: l.total, options: l.options, availability: l.availability };
        });

    if (!lines.length) {
      grid.hidden = true;
      empty.hidden = false;
      return false;
    }
    empty.hidden = true;
    grid.hidden = false;

    $("#coLines").innerHTML = lines.map(function (l) {
      var opts = l.options.length
        ? '<div class="ci__opts">' + l.options.map(function (o) { return "+ " + o.name + " (" + fmt(o.price) + ")"; }).join("<br>") + "</div>"
        : "";
      var q = l.qty > 1 ? " ×" + l.qty : "";
      var tag = l.availability === "order" ? ' <span class="co__tag">sur commande</span>' : "";
      return '<div class="ci"><div class="ci__name"><b>' + l.name + q + "</b>" + tag + opts +
             '</div><div class="ci__price">' + fmt(l.total) + "</div></div>";
    }).join("");

    var t = summary || window.oxoCartTotals();
    $("#coSubtotal").textContent = fmt(t.subtotal);

    var due = summary ? summary.dueNow : t.deposit;
    var balance = summary ? summary.balance : t.balance;
    var hasDeposit = summary ? summary.hasDeposit : t.balance > 0;

    $("#coDueNow").textContent = fmt(due);
    $("#coBalance").textContent = fmt(balance);
    $("#coDueRow").hidden = !hasDeposit;
    $("#coBalanceRow").hidden = !hasDeposit;
    $("#coDepositNote").hidden = !hasDeposit;
    return true;
  }

  /* ---------- etape 1 : coordonnees ---------- */

  function readCustomer() {
    var ids = ["firstName", "lastName", "email", "phone", "address", "postalCode", "city"];
    var c = {};
    ids.forEach(function (id) { c[id] = ($("#" + id).value || "").trim(); });
    c.acceptCgv = $("#acceptCgv").checked;
    return c;
  }

  function showFormError(msg) {
    formError.textContent = msg;
    formError.hidden = false;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (submitting) return;
    formError.hidden = true;

    var customer = readCustomer();
    var missing = Object.keys(customer).filter(function (k) { return k !== "acceptCgv" && !customer[k]; });
    if (missing.length) return showFormError("Merci de remplir tous les champs.");
    if (!customer.acceptCgv) return showFormError("Vous devez accepter les conditions générales de vente.");

    var items = window.oxoCartGet();
    if (!items.length) return showFormError("Votre panier est vide.");

    submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Préparation du paiement…";

    fetch("/api/create-payment-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: items, customer: customer }),
    })
      // Une erreur serveur peut renvoyer du HTML (404, page d'erreur de l'hebergeur).
      // On ne laisse jamais une exception de parsing remonter jusqu'au client.
      .then(function (r) {
        return r.text().then(function (text) {
          var body = null;
          try { body = JSON.parse(text); } catch (e) { /* reponse non-JSON */ }
          return { ok: r.ok, body: body };
        });
      })
      .then(function (r) {
        if (!r.ok || !r.body) throw safeError((r.body && r.body.error) || INDISPO);
        if (!r.body.clientSecret || !r.body.summary) throw safeError(INDISPO);
        clientSecret = r.body.clientSecret;
        renderRecap(r.body.summary); // montants faisant autorite
        return mountPayment(r.body.publishableKey, r.body.summary.dueNow);
      })
      .catch(function (err) {
        // seuls nos propres messages sont montres : une exception JS ne doit jamais fuiter
        showFormError(err && err.safe ? err.message : INDISPO);
        if (!err || !err.safe) console.error("[checkout]", err);
      })
      .finally(function () {
        submitting = false;
        submitBtn.disabled = false;
        submitBtn.innerHTML = 'Continuer vers le paiement <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
      });
  });

  /* ---------- etape 2 : paiement ---------- */

  function mountPayment(publishableKey, dueNow) {
    if (!window.Stripe) throw safeError("Le module de paiement n'a pas pu être chargé. Vérifiez votre connexion ou désactivez votre bloqueur de publicités.");
    stripe = window.Stripe(publishableKey);

    elements = stripe.elements({
      clientSecret: clientSecret,
      appearance: {
        theme: "flat",
        variables: {
          colorPrimary: "#9A7327",
          colorBackground: "#ffffff",
          colorText: "#0B1E33",
          fontFamily: "Archivo, system-ui, sans-serif",
          borderRadius: "6px",
        },
      },
    });
    elements.create("payment", { layout: "tabs" }).mount("#paymentElement");

    payAmount.textContent = fmt(dueNow);
    form.hidden = true;
    payStep.hidden = false;
    payStep.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  payBack.addEventListener("click", function () {
    payStep.hidden = true;
    form.hidden = false;
    renderRecap(null);
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  payBtn.addEventListener("click", function () {
    if (!stripe || !elements) return;
    payError.hidden = true;
    payBtn.disabled = true;
    payBtn.textContent = "Paiement en cours…";

    stripe
      .confirmPayment({
        elements: elements,
        confirmParams: { return_url: window.location.origin + "/confirmation" },
      })
      .then(function (result) {
        // On n'arrive ici QUE si la confirmation echoue : sinon Stripe redirige.
        payError.textContent = result.error ? result.error.message : "Le paiement n'a pas abouti.";
        payError.hidden = false;
        payBtn.disabled = false;
        payBtn.innerHTML = 'Payer <span id="payAmount">' + payAmount.textContent + "</span>";
      });
  });

  /* ---------- init ---------- */
  function init() { renderRecap(null); }
  if (window.oxoCatalog) window.oxoCatalog().then(init).catch(function () { showFormError("Catalogue indisponible."); });
  else document.addEventListener("oxo:cart", init, { once: true });
})();
