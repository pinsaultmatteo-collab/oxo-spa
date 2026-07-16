/* Formulaire de contact OXO Spa — source unique.
 *
 * Un seul formulaire, monte a deux endroits : la page /contact.html et la popup
 * "Etre rappele" de l'accueil. Un seul markup, une seule validation, un seul
 * endpoint (Formspree, ou les commerciaux suivent leurs leads).
 *
 * Remplace deux implementations defaillantes :
 *   - la popup affichait un faux message de succes sans rien envoyer ;
 *   - la page ouvrait un mailto:, perdu des que le visiteur n'a pas de client mail.
 *
 * Le pre-remplissage par URL (?sujet=devis&message=...) est conserve : il est utilise
 * par le panier, les fiches produits et le bouton "Demander un devis" de la nav.
 */
(function () {
  "use strict";

  var ENDPOINT = "https://formspree.io/f/xgogaezj";

  var SUJETS = [
    ["Renseignement", "Renseignement général"],
    ["devis", "Demande de devis"],
    ["produit", "Question sur un produit"],
    ["livraison", "Livraison & installation"],
    ["sav", "Service après-vente"],
    ["rappel", "Demande de rappel"],
  ];
  var MODELES = ["Je ne sais pas encore", "Breeze", "Nexus", "Ease", "Spa de nage", "Spa convivial"];
  var CRENEAUX = ["Dès que possible", "Matin (9 h – 12 h)", "Après-midi (14 h – 18 h)", "Fin de journée (18 h – 20 h)"];

  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };
  var opts = function (list) {
    return list
      .map(function (o) {
        var v = Array.isArray(o) ? o[0] : o;
        var l = Array.isArray(o) ? o[1] : o;
        return '<option value="' + esc(v) + '">' + esc(l) + "</option>";
      })
      .join("");
  };

  function template(id, bare) {
    return (
      '<form class="form' + (bare ? " form--bare" : "") + '" id="' + id + '" novalidate>' +
      '<div class="form__row">' +
        '<div><label for="' + id + '-prenom">Prénom *</label><input id="' + id + '-prenom" name="prenom" type="text" autocomplete="given-name" required></div>' +
        '<div><label for="' + id + '-nom">Nom *</label><input id="' + id + '-nom" name="nom" type="text" autocomplete="family-name" required></div>' +
      "</div>" +
      '<div class="form__row">' +
        '<div><label for="' + id + '-tel">Téléphone *</label><input id="' + id + '-tel" name="tel" type="tel" autocomplete="tel" required></div>' +
        '<div><label for="' + id + '-email">E-mail *</label><input id="' + id + '-email" name="email" type="email" autocomplete="email" required></div>' +
      "</div>" +
      '<div class="form__row">' +
        '<div><label for="' + id + '-sujet">Sujet</label><select id="' + id + '-sujet" name="sujet">' + opts(SUJETS) + "</select></div>" +
        '<div><label for="' + id + '-modele">Modèle qui vous intéresse</label><select id="' + id + '-modele" name="modele">' + opts(MODELES) + "</select></div>" +
      "</div>" +
      '<label for="' + id + '-creneau">Créneau souhaité pour être rappelé</label>' +
      '<select id="' + id + '-creneau" name="creneau">' + opts(CRENEAUX) + "</select>" +
      '<label for="' + id + '-msg">Votre message</label>' +
      /* zone plus courte dans la popup : le bouton d'envoi passait sous le pli,
         ce qui coute des leads sur une demande de rappel censee etre rapide */
      '<textarea id="' + id + '-msg" name="message" rows="' + (bare ? 2 : 4) + '"></textarea>' +
      /* piege a robots : invisible, jamais rempli par un humain. Formspree ignore
         la soumission si _gotcha est rempli. */
      '<input type="text" name="_gotcha" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;opacity:0;height:0;width:0">' +
      '<label class="form__check"><input type="checkbox" name="consent" required>' +
        "<span>J'accepte d'être recontacté(e) par OXO Spa au sujet de ma demande. *</span></label>" +
      '<p class="co__error" data-cf-error hidden role="alert"></p>' +
      '<button type="submit" class="btn btn--gold" data-cf-submit>Envoyer ma demande' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>' +
      "</form>" +
      '<div class="cf-ok" data-cf-success hidden>' +
        '<div class="cf-ok__ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>' +
        "<h3>Demande envoyée</h3>" +
        "<p>Merci, nous avons bien reçu votre demande. Un conseiller OXO Spa vous recontacte sous 24 h ouvrées.</p>" +
      "</div>"
    );
  }

  /* Pre-remplissage depuis l'URL : ?sujet=devis&message=... (panier, fiches, nav). */
  function prefill(form) {
    var qp = new URLSearchParams(window.location.search);
    var sujet = qp.get("sujet");
    if (sujet) {
      var sel = form.querySelector('[name="sujet"]');
      if (sel) {
        for (var i = 0; i < sel.options.length; i++) {
          if (sel.options[i].value === sujet) sel.selectedIndex = i;
        }
      }
    }
    var msg = qp.get("message");
    if (msg) {
      var ta = form.querySelector('[name="message"]');
      if (ta) ta.value = msg;
    }
  }

  function validate(form) {
    var need = [
      ["prenom", "votre prénom"],
      ["nom", "votre nom"],
      ["tel", "votre téléphone"],
      ["email", "votre e-mail"],
    ];
    for (var i = 0; i < need.length; i++) {
      var el = form.querySelector('[name="' + need[i][0] + '"]');
      if (!el.value.trim()) {
        el.focus();
        return "Merci d'indiquer " + need[i][1] + ".";
      }
    }
    var email = form.querySelector('[name="email"]').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      form.querySelector('[name="email"]').focus();
      return "Cette adresse e-mail ne semble pas valide.";
    }
    var digits = form.querySelector('[name="tel"]').value.replace(/[^\d]/g, "");
    if (digits.length < 9 || digits.length > 15) {
      form.querySelector('[name="tel"]').focus();
      return "Ce numéro de téléphone ne semble pas valide.";
    }
    if (!form.querySelector('[name="consent"]').checked) {
      return "Merci d'accepter d'être recontacté(e).";
    }
    return null;
  }

  function mount(host, context) {
    var id = "cf-" + Math.random().toString(36).slice(2, 8);
    host.innerHTML = template(id, context === "popup");

    var form = host.querySelector("form");
    var errEl = host.querySelector("[data-cf-error]");
    var okEl = host.querySelector("[data-cf-success]");
    var btn = host.querySelector("[data-cf-submit]");
    var sending = false;

    prefill(form);
    if (context === "popup") {
      // depuis la popup, l'intention est explicite
      var sel = form.querySelector('[name="sujet"]');
      if (sel && !new URLSearchParams(window.location.search).get("sujet")) sel.value = "rappel";
    }

    function fail(msg) {
      errEl.textContent = msg;
      errEl.hidden = false;
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (sending) return;
      errEl.hidden = true;

      var problem = validate(form);
      if (problem) return fail(problem);

      var data = {};
      new FormData(form).forEach(function (v, k) { data[k] = v; });
      data.consent = "oui";
      data._subject = "[OXO Spa] " + (data.sujet || "Demande") + " — " + data.prenom + " " + data.nom;
      data.page = context === "popup" ? "Popup « Être rappelé » (accueil)" : window.location.pathname;

      sending = true;
      btn.disabled = true;
      btn.textContent = "Envoi en cours…";

      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(data),
      })
        .then(function (r) {
          return r.json().then(function (b) { return { ok: r.ok, body: b }; })
                         .catch(function () { return { ok: r.ok, body: null }; });
        })
        .then(function (r) {
          if (!r.ok) {
            // Formspree renvoie {errors:[{message}]}
            var m = r.body && r.body.errors && r.body.errors[0] && r.body.errors[0].message;
            throw new Error(m || "");
          }
          form.hidden = true;
          okEl.hidden = false;
          okEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
        })
        .catch(function (err) {
          console.error("[contact]", err);
          fail(
            (err && err.message ? err.message + " " : "") +
            "L'envoi a échoué. Réessayez, ou appelez-nous au 05 31 60 51 61."
          );
        })
        .finally(function () {
          sending = false;
          btn.disabled = false;
          btn.innerHTML = 'Envoyer ma demande <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
        });
    });
  }

  window.oxoMountContactForm = mount;

  function init() {
    var hosts = document.querySelectorAll("[data-contact-form]");
    for (var i = 0; i < hosts.length; i++) {
      mount(hosts[i], hosts[i].getAttribute("data-contact-form") || "page");
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
