/* Panier OXO Spa — module partage.
   Le localStorage ne stocke QUE des identifiants : {id, qty, options:[optionId]}.
   Les prix viennent exclusivement de /assets/products.json.
   Le serveur de paiement recalcule les montants de son cote : ce fichier ne fait pas autorite. */
(function () {
  "use strict";

  var KEY = "oxo_cart";
  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
  var fmt = function (n) { return Math.round(n).toLocaleString("fr-FR"); };

  var catalog = null, byProduct = {}, byOption = {}, loading = null;

  function loadCatalog() {
    if (loading) return loading;
    loading = fetch("/assets/products.json", { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("catalogue indisponible (" + r.status + ")");
        return r.json();
      })
      .then(function (c) {
        catalog = c;
        c.products.forEach(function (p) { byProduct[p.id] = p; });
        c.options.forEach(function (o) { byOption[o.id] = o; });
        migrate();
        return c;
      });
    return loading;
  }

  function readRaw() {
    try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; }
  }
  function writeRaw(items) {
    localStorage.setItem(KEY, JSON.stringify(items));
    badges();
    document.dispatchEvent(new CustomEvent("oxo:cart"));
  }

  /* Ancien format : {name, base, total, options:[{name,price}]} — le prix y etait stocke.
     On le convertit en identifiants et on jette les prix. Une ligne non reconnue est ecartee. */
  function migrate() {
    var items = readRaw();
    if (!items.some(function (i) { return !i.id; })) return;
    var pByName = {}, oByName = {};
    catalog.products.forEach(function (p) { pByName[p.name.toLowerCase()] = p.id; });
    catalog.options.forEach(function (o) { oByName[o.name.toLowerCase()] = o.id; });

    var out = [];
    items.forEach(function (i) {
      if (i.id && byProduct[i.id]) { out.push(clean(i)); return; }
      var pid = pByName[String(i.name || "").toLowerCase()];
      if (!pid) return;
      var opts = (i.options || []).map(function (o) { return oByName[String(o.name || "").toLowerCase()]; }).filter(Boolean);
      out.push({ id: pid, qty: i.qty || 1, options: opts });
    });
    localStorage.setItem(KEY, JSON.stringify(out));
  }

  function clean(i) {
    return {
      id: i.id,
      qty: Math.max(1, parseInt(i.qty, 10) || 1),
      options: (i.options || []).filter(function (o) { return byOption[o]; })
    };
  }

  /* Resout un panier d'identifiants en lignes valorisees. */
  function lines() {
    if (!catalog) return [];
    return readRaw().reduce(function (acc, raw) {
      var p = byProduct[raw.id];
      if (!p) return acc;                       // produit retire du catalogue : on ignore
      var opts = (raw.options || []).map(function (id) { return byOption[id]; }).filter(Boolean);
      var qty = Math.max(1, parseInt(raw.qty, 10) || 1);
      var unit = p.price + opts.reduce(function (s, o) { return s + o.price; }, 0);
      acc.push({
        id: p.id, name: p.name, url: p.url, availability: p.availability,
        depositRate: typeof p.depositRate === "number" ? p.depositRate : 1,
        qty: qty, options: opts, unit: unit, total: unit * qty
      });
      return acc;
    }, []);
  }

  function totals() {
    var l = lines();
    var subtotal = l.reduce(function (s, i) { return s + i.total; }, 0);
    var deposit = l.reduce(function (s, i) { return s + i.total * i.depositRate; }, 0);
    return { subtotal: subtotal, deposit: deposit, balance: subtotal - deposit, count: l.reduce(function (s, i) { return s + i.qty; }, 0) };
  }

  function badges() {
    // avant le chargement du catalogue on compte les lignes brutes ; ensuite,
    // seules les lignes reellement resolues comptent (un stockage trafique ne gonfle pas le badge)
    var n = catalog
      ? totals().count
      : readRaw().reduce(function (s, i) { return s + Math.max(1, parseInt(i.qty, 10) || 1); }, 0);
    $$("[data-cart-count]").forEach(function (b) {
      b.textContent = n;
      b.style.display = n > 0 ? "grid" : "none";
    });
  }

  function add(item) {
    if (!item || !item.id) return;
    loadCatalog().then(function () {
      if (!byProduct[item.id]) return;
      var items = readRaw();
      items.push(clean(item));
      writeRaw(items);
      openDrawer();
    });
  }

  function removeAt(i) {
    var items = readRaw();
    items.splice(i, 1);
    writeRaw(items);
  }

  /* ---------------- tiroir lateral ---------------- */
  var drawer;

  function renderDrawer() {
    if (!drawer) return;
    var items = $("#cartDrawerItems"), foot = $("#cartDrawerFoot");
    if (!items) return;
    var l = lines();

    if (!l.length) {
      items.innerHTML = '<p class="cart-empty">Votre panier est vide.<br><a href="/spas.html" data-cart-close>Découvrir nos spas &rarr;</a></p>';
      if (foot) foot.style.display = "none";
      bindClose();
      return;
    }

    items.innerHTML = l.map(function (it, i) {
      var opts = it.options.length
        ? '<div class="ci__opts">' + it.options.map(function (o) { return "+ " + o.name + " (" + fmt(o.price) + " €)"; }).join("<br>") + "</div>"
        : "";
      var q = it.qty > 1 ? " ×" + it.qty : "";
      return '<div class="ci"><div class="ci__name"><b>' + it.name + q + "</b>" + opts +
        '</div><div class="ci__price">' + fmt(it.total) + ' €</div>' +
        '<button class="ci__rm" data-i="' + i + '" aria-label="Retirer">&times;</button></div>';
    }).join("");

    var t = totals();
    var totalEl = $("#cartDrawerTotal");
    if (totalEl) totalEl.textContent = fmt(t.subtotal) + " €";

    var recall = $("#cartDrawerRecall");
    if (recall) {
      var recap = l.map(function (it) { return it.name + " (" + fmt(it.total) + " €)"; }).join(", ") +
        ". Total panier : " + fmt(t.subtotal) + " €. Merci de me recontacter pour finaliser.";
      recall.href = "/contact.html?sujet=devis&message=" + encodeURIComponent(recap);
    }

    if (foot) foot.style.display = "block";
    $$(".ci__rm", items).forEach(function (b) {
      b.addEventListener("click", function () { removeAt(parseInt(b.getAttribute("data-i"), 10)); });
    });
    bindClose();
  }

  function bindClose() {
    if (!drawer) return;
    $$("[data-cart-close]", drawer).forEach(function (x) {
      if (x._bound) return;
      x._bound = 1;
      x.addEventListener("click", function (e) { e.preventDefault(); closeDrawer(); });
    });
  }

  function openDrawer() {
    if (!drawer) return;
    loadCatalog().then(function () {
      renderDrawer();
      drawer.classList.add("show");
      drawer.setAttribute("aria-hidden", "false");
      document.body.classList.add("lock");
    });
  }
  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove("show");
    drawer.setAttribute("aria-hidden", "true");
    document.body.classList.remove("lock");
  }

  /* ---------------- API publique ---------------- */
  window.oxoAddToCart = add;
  window.oxoOpenCart = openDrawer;
  window.oxoCartGet = readRaw;
  window.oxoCartSet = writeRaw;
  window.oxoCartLines = lines;
  window.oxoCartTotals = totals;
  window.oxoCartRemoveAt = removeAt;
  window.oxoCatalog = loadCatalog;

  /* ---------------- init ---------------- */
  function init() {
    drawer = $("#cartDrawer");
    badges();

    $$("[data-cart-open]").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); openDrawer(); });
    });

    if (drawer) {
      var bd = drawer.querySelector(".cart__backdrop");
      if (bd) bd.addEventListener("click", closeDrawer);
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });
    }

    /* boutons "Ajouter au panier" des cartes (accueil) */
    $$("[data-add]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        add({ id: b.getAttribute("data-id"), qty: 1, options: [] });
        var label = b.textContent;
        b.classList.add("added");
        b.textContent = "✓ Ajouté";
        setTimeout(function () { b.classList.remove("added"); b.textContent = label; }, 1500);
      });
    });

    loadCatalog().then(function () {
      badges();
      document.dispatchEvent(new CustomEvent("oxo:cart"));
    }).catch(function (err) {
      console.error("[oxo] catalogue introuvable :", err.message);
    });

    document.addEventListener("oxo:cart", renderDrawer);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
