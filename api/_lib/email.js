/* Emails transactionnels via Resend (POST https://api.resend.com/emails).
 *
 * Deux envois par commande : confirmation au client, notification a OXO Spa.
 *
 * Principes :
 *  - Best-effort : un echec d'email ne fait JAMAIS echouer le webhook. La commande
 *    est deja enregistree chez Axonaut, et Stripe envoie son propre recu (receipt_email).
 *    On journalise bruyamment, on ne rejette pas.
 *  - Idempotent : cle d'idempotence Resend par (reference, destinataire), pour qu'un
 *    rejeu de webhook ne renvoie pas deux fois le meme email.
 *  - Sans cle RESEND_API_KEY : mode journal, rien n'est envoye (comme Axonaut).
 *
 * Avant verification d'un domaine dans Resend, seul l'expediteur "onboarding@resend.dev"
 * fonctionne, et uniquement vers l'adresse du compte Resend. EMAIL_FROM permet de
 * basculer sur "OXO Spa <commande@oxo-spa.com>" une fois le domaine verifie.
 */

const ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "OXO Spa <onboarding@resend.dev>";

const euros = (n) => Math.round(n).toLocaleString("fr-FR") + " €";

/* Enveloppe a fond clair explicite : sans elle, un client mail en mode sombre
   rendrait le texte fonce illisible. */
const shell = (inner) =>
  `<div style="background:#f2f3f5;padding:24px 0;margin:0">
    <div style="background:#ffffff;max-width:560px;margin:0 auto;padding:28px 30px;border-radius:10px;font-family:Arial,Helvetica,sans-serif;color:#0B1E33">
      ${inner}
    </div>
  </div>`;
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export const isEmailEnabled = () => Boolean(process.env.RESEND_API_KEY);

async function send({ from, to, subject, html, replyTo, idempotencyKey }, fetchImpl = fetch) {
  const key = process.env.RESEND_API_KEY;
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({ from, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

function lineRows(order) {
  return order.lines
    .map((l) => {
      const opts = l.options.length ? ` <span style="color:#7a7f87">(+ ${esc(l.options.map((o) => o.name).join(", "))})</span>` : "";
      const q = l.qty > 1 ? ` × ${l.qty}` : "";
      const tag = l.availability === "order" ? ' <span style="color:#9A7327">— sur commande</span>' : "";
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #eee">${esc(l.name)}${q}${tag}${opts}</td>
        <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap"><b>${euros(l.total)}</b></td>
      </tr>`;
    })
    .join("");
}

function customerHtml({ order, customer, reference, amountPaid }) {
  const depositBlock = order.hasDeposit
    ? `<tr><td style="padding:8px 0;color:#7a7f87">Solde à la livraison</td><td style="padding:8px 0;text-align:right">${euros(order.balance)}</td></tr>`
    : "";
  return shell(`
    <h1 style="font-size:22px;margin:0 0 16px">Merci pour votre commande</h1>
    <p style="margin:0 0 12px">Bonjour ${esc(customer.firstName)},</p>
    <p style="margin:0 0 12px">Nous avons bien reçu votre paiement. Voici le récapitulatif de votre commande.</p>
    <table style="width:100%;border-collapse:collapse;margin:18px 0">${lineRows(order)}
      <tr><td style="padding:10px 0;color:#7a7f87">Total commande</td><td style="padding:10px 0;text-align:right">${euros(order.subtotal)}</td></tr>
      <tr><td style="padding:8px 0"><b>Réglé aujourd'hui</b></td><td style="padding:8px 0;text-align:right"><b style="color:#9A7327">${euros(amountPaid)}</b></td></tr>
      ${depositBlock}
    </table>
    <p style="background:#f6f6f4;border-radius:8px;padding:14px 16px;font-size:14px;margin:0 0 16px">
      <b>Référence :</b> ${esc(reference)}<br>
      Conservez-la pour tout échange avec nos conseillers.
    </p>
    <p style="font-size:14px;color:#555;margin:0 0 12px">Tarif hors livraison et mise en service. Un conseiller OXO Spa vous contacte sous 48&nbsp;h pour organiser la livraison et vous en communiquer le tarif.${order.hasDeposit ? " Le solde sera facturé à la livraison." : ""}</p>
    <p style="font-size:13px;color:#999;margin:24px 0 0">OXO Spa — 11 impasse Pierre Camo, 31200 Toulouse</p>`);
}

function oxoHtml({ order, customer, reference, amountPaid }) {
  return shell(`
    <h1 style="font-size:20px;margin:0 0 14px">Nouvelle commande payée</h1>
    <table style="width:100%;border-collapse:collapse;margin:14px 0">${lineRows(order)}
      <tr><td style="padding:8px 0"><b>Encaissé</b></td><td style="padding:8px 0;text-align:right"><b>${euros(amountPaid)}</b></td></tr>
      ${order.hasDeposit ? `<tr><td style="padding:8px 0;color:#7a7f87">Solde à facturer à la livraison</td><td style="padding:8px 0;text-align:right">${euros(order.balance)}</td></tr>` : ""}
    </table>
    <h2 style="font-size:15px;margin:18px 0 8px">Client</h2>
    <p style="font-size:14px;line-height:1.7;margin:0 0 12px">
      ${esc(customer.firstName)} ${esc(customer.lastName)}<br>
      ${esc(customer.email)} · ${esc(customer.phone)}<br>
      ${esc(customer.address)}, ${esc(customer.postalCode)} ${esc(customer.city)}
    </p>
    <p style="font-size:13px;color:#999;margin:0">Référence Stripe : ${esc(reference)}</p>`);
}

/**
 * Envoie les deux emails. Ne leve jamais : retourne l'etat de chaque envoi.
 * @returns {{customer:{sent:boolean,dryRun?:boolean,error?:string,id?:string},
 *            oxo:{sent:boolean,dryRun?:boolean,skipped?:boolean,error?:string,id?:string}}}
 */
export async function sendOrderEmails(params, fetchImpl = fetch) {
  const { order, customer, reference, amountPaid } = params;
  const from = process.env.EMAIL_FROM || DEFAULT_FROM;
  const notify = process.env.ORDER_NOTIFY_EMAIL;
  const result = { customer: { sent: false }, oxo: { sent: false } };

  if (!isEmailEnabled()) {
    console.log(`[email] DESACTIVE (RESEND_API_KEY absente) — confirmation ${customer.email} + notif ${notify || "(non configuree)"} non envoyees pour ${reference}`);
    result.customer.dryRun = true;
    result.oxo.dryRun = true;
    return result;
  }

  // 1. confirmation client
  try {
    const r = await send({
      from,
      to: customer.email,
      replyTo: notify,
      subject: "Votre commande OXO Spa",
      html: customerHtml(params),
      idempotencyKey: `${reference}-customer`,
    }, fetchImpl);
    result.customer = { sent: true, id: r.id };
  } catch (err) {
    console.error(`[email] confirmation client echouee (${reference}) :`, err.message);
    result.customer = { sent: false, error: err.message };
  }

  // 2. notification OXO
  if (!notify) {
    console.warn(`[email] ORDER_NOTIFY_EMAIL absente : notification interne non envoyee pour ${reference}`);
    result.oxo = { sent: false, skipped: true };
  } else {
    try {
      const r = await send({
        from,
        to: notify,
        replyTo: customer.email,
        subject: `Nouvelle commande — ${customer.firstName} ${customer.lastName} — ${euros(amountPaid)}`,
        html: oxoHtml(params),
        idempotencyKey: `${reference}-oxo`,
      }, fetchImpl);
      result.oxo = { sent: true, id: r.id };
    } catch (err) {
      console.error(`[email] notification OXO echouee (${reference}) :`, err.message);
      result.oxo = { sent: false, error: err.message };
    }
  }

  return result;
}
