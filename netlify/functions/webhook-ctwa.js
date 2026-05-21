// webhook-ctwa.js — webhook nativo da WhatsApp Cloud API (modo Coexistencia)
// Recebe a conversa Click-to-WhatsApp com o objeto referral (ctwa_clid).
//
// No app Meta -> WhatsApp -> Configuration -> Webhook:
//   Callback URL:  https://SEU-SITE/.netlify/functions/webhook-ctwa?token=SEU_TOKEN
//   Verify token:  o valor de META_VERIFY_TOKEN (ou GPSDASH_SECRET)
//   Assine o campo: messages
import { readArr, writeArr, pushRaw, json } from "./_store.js";
import { sendCapi } from "./_capi.js";

export default async (req) => {
  const url = new URL(req.url);

  // ---- 1) Verificacao do webhook (GET que o Meta faz ao registrar) ----
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const verify = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const expected = process.env.META_VERIFY_TOKEN || process.env.GPSDASH_SECRET;
    if (mode === "subscribe" && verify === expected) {
      return new Response(challenge || "", { status: 200, headers: { "content-type": "text/plain" } });
    }
    return new Response("forbidden", { status: 403 });
  }
  if (req.method === "OPTIONS") return json({ ok: true });

  // ---- 2) Recebimento de mensagens (POST) ----
  const token = url.searchParams.get("token");
  if (process.env.GPSDASH_SECRET && token && token !== process.env.GPSDASH_SECRET) {
    return json({ error: "token invalido" }, 401);
  }

  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  await pushRaw({ source: "ctwa", body });

  const admap = await readArr("admap");
  const list = await readArr("ctwa");
  const results = [];

  async function registrar(lead) {
    // dispara o evento Lead na CAPI nativa
    const cap = await sendCapi("Lead", { phone: lead.phone, clid: lead.clid, eventId: lead.id });
    lead.capiLead = !!cap.ok;
    lead.capiMsg = cap.ok ? "enviado" : (cap.error || cap.skipped || "");
    const i = list.findIndex((x) => x.id === lead.id);
    if (i >= 0) list[i] = { ...list[i], ...lead };
    else list.unshift(lead);
    results.push({ clid: lead.clid, capi: cap });
  }

  // formato oficial WhatsApp Cloud API: entry[].changes[].value.messages[]
  const entries = body.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const nameByWa = {};
      (value.contacts || []).forEach((c) => { nameByWa[c.wa_id] = c.profile && c.profile.name; });

      for (const msg of value.messages || []) {
        const ref = msg.referral;
        if (!ref) continue; // so conversas que vieram de anuncio CTWA
        const phone = msg.from || "";
        const adId = String(ref.source_id || "");
        const m = admap.find((x) => x.adId === adId) || {};
        await registrar({
          id: "ctwa:" + (ref.ctwa_clid || phone || msg.id),
          data: new Date((Number(msg.timestamp) || Date.now() / 1000) * 1000).toISOString().slice(0, 10),
          phone,
          nome: nameByWa[phone] || "",
          clid: ref.ctwa_clid || "",
          adId,
          campaignId: m.campaignId || "",
          campaignName: m.campaignName || ref.headline || "",
          evento: "Conversa iniciada",
          capiLead: false, capiMsg: "",
        });
      }
    }
  }

  // fallback: formato generico (outra ferramenta encaminhando o evento)
  if (!entries.length) {
    const o = body.conversation || body.message || body.data || body;
    const ref = o.referral || body.referral || {};
    const clid = o.ctwa_clid || ref.ctwa_clid || "";
    const phone = o.from || o.phone || o.wa_id || "";
    if (clid || phone) {
      const adId = String(ref.source_id || o.ad_id || "");
      const m = admap.find((x) => x.adId === adId) || {};
      await registrar({
        id: "ctwa:" + (clid || phone || Date.now()),
        data: new Date().toISOString().slice(0, 10),
        phone, nome: o.name || "", clid, adId,
        campaignId: m.campaignId || "", campaignName: m.campaignName || ref.headline || "",
        evento: "Conversa iniciada", capiLead: false, capiMsg: "",
      });
    }
  }

  if (results.length) await writeArr("ctwa", list.slice(0, 5000));
  return json({ ok: true, leads: results.length, results });
};
