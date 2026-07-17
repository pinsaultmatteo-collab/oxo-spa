/* Page de confirmation.
 *
 * Stripe redirige ici avec ?payment_intent_client_secret=...
 * Le return_url de checkout.js pointe sur /confirmation (sans extension), l'URL
 * servie par cleanUrls : aucune redirection sur le trajet, la query string arrive
 * intacte. Ne jamais le repointer sur /confirmation.html.
 * On interroge Stripe pour connaitre l'etat reel du paiement plutot que de croire
 * le parametre redirect_status, qui est modifiable dans la barre d'adresse.
 *
 * Cet ecran est purement informatif : la commande est enregistree par le webhook
 * cote serveur, meme si le client ferme son navigateur avant d'arriver ici. */
(function () {
  "use strict";

  var $ = function (s) { return document.querySelector(s); };
  var box = $("#cfBox"), title = $("#cfTitle"), intro = $("#cfIntro");
  var msg = $("#cfMsg"), ico = $("#cfIco"), refWrap = $("#cfRefWrap"), ref = $("#cfRef"), next = $("#cfNext");
  if (!box) return;

  var CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  var CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  var CROSS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  function show(state, heading, lead, text, reference) {
    box.hidden = false;
    box.className = "cf cf--" + state;
    ico.innerHTML = state === "ok" ? CHECK : state === "pending" ? CLOCK : CROSS;
    title.innerHTML = heading;
    intro.textContent = lead;
    msg.textContent = text;
    next.hidden = state !== "ok";
    if (reference) {
      ref.textContent = reference;
      refWrap.hidden = false;
    }
  }

  var clientSecret = new URLSearchParams(window.location.search).get("payment_intent_client_secret");

  if (!clientSecret) {
    show("error", "Aucune <em>commande</em>", "Rien à afficher.",
      "Cette page s'affiche après un paiement. Si vous venez de commander et voyez ce message, contactez-nous : votre commande a peut-être bien été enregistrée.");
    return;
  }

  fetch("/api/config")
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      if (!cfg.publishableKey) throw new Error("config");
      return window.Stripe(cfg.publishableKey).retrievePaymentIntent(clientSecret);
    })
    .then(function (result) {
      var pi = result.paymentIntent;
      if (!pi) throw new Error("introuvable");

      if (pi.status === "succeeded") {
        // Le panier n'est vide qu'apres confirmation par Stripe.
        try { localStorage.removeItem("oxo_cart"); } catch (e) {}
        document.querySelectorAll("[data-cart-count]").forEach(function (b) {
          b.textContent = "0";
          b.style.display = "none";
        });
        show("ok", "Merci pour votre <em>commande</em>", "Votre paiement a bien été reçu.",
          "Vous allez recevoir un e-mail de confirmation. Conservez la référence ci-dessous pour tout échange avec nos conseillers.",
          pi.id);
      } else if (pi.status === "processing") {
        show("pending", "Paiement en <em>cours</em>", "Votre banque traite le paiement.",
          "Cela peut prendre quelques instants. Vous recevrez un e-mail dès que le paiement sera confirmé. Inutile de payer une seconde fois.",
          pi.id);
      } else if (pi.status === "requires_payment_method") {
        show("error", "Paiement <em>refusé</em>", "Le paiement n'a pas abouti.",
          "Votre carte n'a pas été débitée. Vous pouvez réessayer avec un autre moyen de paiement depuis votre panier.");
      } else {
        show("error", "Paiement <em>interrompu</em>", "Le paiement n'a pas été finalisé.",
          "Votre carte n'a pas été débitée. Reprenez votre commande depuis le panier, ou contactez-nous.");
      }
    })
    .catch(function () {
      show("pending", "Vérification <em>impossible</em>", "Nous n'avons pas pu vérifier l'état du paiement.",
        "Si votre compte a été débité, votre commande est bien enregistrée : nos conseillers vous recontacteront. Dans le doute, contactez-nous plutôt que de payer à nouveau.");
    });
})();
