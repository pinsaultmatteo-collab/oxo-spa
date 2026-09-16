/* Compte a rebours jusqu'au prochain arrivage.
 *
 * SOURCE UNIQUE DE LA DATE : la constante ARRIVAGE ci-dessous. Le bandeau et les
 * pastilles des fiches produit s'y referent tous les deux.
 *
 * Apres l'arrivage :
 *   1. supprimer les <div class="stockbar"> des pages (tools/ n'y touche pas),
 *   2. remettre les pastilles "soldout" en "stock" / "En stock",
 *   3. repasser le schema Product de BackOrder a InStock,
 *   4. remettre --banner-h a 0px dans styles.css.
 * Passee la date, le script masque de lui-meme le compte a rebours plutot que
 * d'afficher un delai negatif — le site reste correct meme si l'etape 1 traine.
 */
(function () {
  "use strict";
  var ARRIVAGE = "2026-11-30T09:00:00+01:00";

  var targets = document.querySelectorAll("[data-arrivage]");
  if (!targets.length) return;

  var end = new Date(ARRIVAGE).getTime();
  if (isNaN(end)) return;

  function render() {
    var left = end - Date.now();
    if (left <= 0) {
      // L'arrivage est passe : on retire le decompte au lieu de compter a l'envers.
      Array.prototype.forEach.call(targets, function (el) {
        var row = el.closest(".eta") || el;
        row.hidden = true;
      });
      return false;
    }
    var s = Math.floor(left / 1000);
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var txt = d > 0
      ? d + " j " + h + " h " + m + " min"
      : h + " h " + m + " min " + sec + " s";
    Array.prototype.forEach.call(targets, function (el) { el.textContent = txt; });
    return true;
  }

  if (render()) {
    // sous 24 h le compteur affiche les secondes : on rafraichit en consequence
    setInterval(render, (end - Date.now()) < 86400000 ? 1000 : 30000);
  }
})();
