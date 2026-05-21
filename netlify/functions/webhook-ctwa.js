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

  // captura o corpo cru (texto) e o JSON, sem perder nada
  let bodyText = "";
  let body = {};
  try { bodyText = await req.text(); } catch { bodyText = ""; }
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { body = {}; }

  // DIAGNÓSTICO: registra tudo que chegou, pra inspecionar o que a Data Crazy manda
  const headersObj = {};
  try { req.headers.forEach((v, k) => { headersObj[k] = v; }); } catch {}
  const queryObj = {};
  url.searchParams.forEach((v, k) => { queryObj[k] = v; });
  await pushRaw({
    source: "ctwa",
    body,
    _diag: {
      url: url.href,
      query: queryObj,
      bodyText: bodyText.slice(0, 2000),
      contentType: headersObj["content-type"] || "",
      method: req.method,
    },
  });

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

  // ---- caminho Data Crazy: dados vêm como parâmetros (query string OU corpo JSON) ----
  const qp = url.searchParams;
  // pega o valor procurando primeiro na query, depois no corpo JSON
  const pega = (k) => {
    const q = qp.get(k);
    if (q != null && q !== "") return q;
    if (body && body[k] != null) return body[k];
    return "";
  };
  const dcPhone = pega("phone");
  const dcClid  = pega("ctwa_clid");
  // só registra se veio telefone OU ctwa
  if (dcPhone || dcClid) {
    const limpo = (v) => {
      const s = String(v || "").trim();
      // ignora variável não-substituída tipo "{{Referral Ctwa Id}}"
      return /^\{\{.*\}\}$/.test(s) ? "" : s;
    };
    const phone = limpo(dcPhone);
    const clid  = limpo(dcClid);
    const nome  = limpo(pega("name"));
    const srcId = limpo(pega("source_id"));
    const srcUrl= limpo(pega("source_url"));
    const origem= limpo(pega("origem"));
    // só conta como lead de anúncio se houver ctwa_clid de verdade
    if (clid && phone) {
      const m = admap.find((x) => x.adId === srcId) || {};
      await registrar({
        id: "ctwa:" + clid,
        data: new Date().toISOString().slice(0, 10),
        phone, nome, clid, adId: srcId,
        sourceUrl: srcUrl, origem,
        campaignId: m.campaignId || "",
        campaignName: m.campaignName || "",
        evento: "Conversa iniciada (anúncio)",
        capiLead: false, capiMsg: "",
      });
    }
    if (results.length) await writeArr("ctwa", list.slice(0, 5000));
    return json({ ok: true, via: "datacrazy", leads: results.length,
      recebido: { phone: !!phone, clid: !!clid, nome: !!nome } });
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
