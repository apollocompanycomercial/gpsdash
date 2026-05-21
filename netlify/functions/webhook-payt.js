// webhook-payt.js — recebe a venda da Payt (formato V1), atribui campanha e dispara CAPI
//   https://SEU-SITE.netlify.app/.netlify/functions/webhook-payt?token=SEU_TOKEN
import { readArr, writeArr, pushRaw, checkToken, json, pick } from "./_store.js";
import { sendCapi, normPhone } from "./_capi.js";

function mapStatus(s) {
  s = String(s || "").toLowerCase();
  if (/paid|approv|complet|captured|confirm/.test(s)) return "aprovada";
  if (/pend|waiting|process|analy|created|authorized/.test(s)) return "pendente";
  return "recusada";
}

// status de envio dos Correios -> texto legível em PT
function mapEnvio(s) {
  const k = String(s || "").toLowerCase();
  const mapa = {
    "waiting_code": "Aguardando código de rastreio",
    "posted": "Postado nos Correios",
    "shipping": "Em trânsito",
    "in_transit": "Em trânsito",
    "out_for_delivery": "Saiu para entrega",
    "delivered": "Entregue",
    "returned": "Devolvido",
    "lost": "Extraviado",
    "problem": "Problema na entrega",
    "waiting": "Aguardando postagem",
  };
  return mapa[k] || (s ? String(s) : "Aguardando");
}
// status de envio -> coluna do Kanban de Pedidos
function envioParaColuna(s) {
  const k = String(s || "").toLowerCase();
  if (/deliver/.test(k)) return "entregue";
  if (/transit|shipping|out_for/.test(k)) return "transito";
  if (/posted/.test(k)) return "postado";
  if (/return|lost|problem/.test(k)) return "problema";
  return "pendente";
}

export default async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (!checkToken(req)) return json({ error: "token invalido" }, 401);

  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  await pushRaw({ source: "payt", body });

  // ---- estrutura real do payload Payt V1 ----
  const trans    = body.transaction || {};
  const product  = body.product || {};
  const customer = body.customer || {};
  const shipping = body.shipping || {};

  const extId = String(
    body.transaction_id || body.cart_id || trans.transaction_id ||
    body.code || ("payt_" + Date.now())
  );
  const id = "payt:" + extId;

  // valor: Payt manda em centavos -> divide por 100
  const divisor = Number(process.env.PAYT_AMOUNT_DIVISOR || 100);
  let valor = Number(trans.total_price || trans.total || product.price || 0) || 0;
  if (divisor > 1) valor = valor / divisor;

  const telefone = customer.phone || "";
  const email    = customer.email && customer.email !== "null" ? customer.email : "";
  const statusRaw = trans.payment_status || body.status || "";
  const dataRaw = trans.paid_at || trans.created_at || body.started_at || body.updated_at || new Date().toISOString();

  // endereço de entrega — monta uma linha legível
  const ad = shipping.address || customer.billing_address || {};
  const enderecoLinha = [
    ad.street, ad.street_number, ad.complement, ad.district,
    ad.city, ad.state, ad.zipcode
  ].filter(Boolean).join(", ");

  // origem da venda: procura comissão do tipo "affiliation"
  const comissoes = Array.isArray(body.commission) ? body.commission : [];
  const afil = comissoes.find((c) => String(c.type).toLowerCase() === "affiliation");
  const origem = afil ? "afiliado" : "propria";
  const afiliado = afil ? (afil.name || "Afiliado") : "";
  const afiliadoEmail = afil ? (afil.email || "") : "";

  const sale = {
    id,
    data: String(dataRaw).slice(0, 10),
    produto: product.name || (product.items && product.items[0] && product.items[0].name) || "Produto",
    cliente: customer.name || "",
    telefone,
    email,
    doc: customer.doc || "",
    endereco: enderecoLinha,
    enderecoObj: {
      rua: ad.street||"", numero: ad.street_number||"", complemento: ad.complement||"",
      bairro: ad.district||"", cidade: ad.city||"", uf: ad.state||"", cep: ad.zipcode||""
    },
    tracking: shipping.tracking_code || "",
    trackingUrl: shipping.tracking_url || "",
    envioStatus: mapEnvio(shipping.status),
    envioStatusRaw: shipping.status || "",
    origem,
    afiliado,
    afiliadoEmail,
    valor,
    status: mapStatus(statusRaw),
    tipo: "",
    accountId: "",
    campaignId: "",
    campaignName: "",
    clid: "",
  };

  const ph = normPhone(telefone);
  if (ph) {
    const ctwa = await readArr("ctwa");
    const lead = ctwa.find((c) => normPhone(c.phone) === ph);
    if (lead) {
      sale.campaignId = lead.campaignId || "";
      sale.campaignName = lead.campaignName || "";
      sale.clid = lead.clid || "";
    }
  }

  const sales = await readArr("sales");
  const si = sales.findIndex((s) => s.id === id);
  if (si >= 0) sales[si] = { ...sales[si], ...sale };
  else sales.unshift(sale);
  await writeArr("sales", sales.slice(0, 3000));

  let capi = { skipped: "venda nao aprovada" };
  if (sale.status === "aprovada") {
    const orders = await readArr("orders");
    const oi = orders.findIndex((x) => x.id === id);
    const ord = {
      id, ref: extId, cliente: sale.cliente, produto: sale.produto,
      valor: sale.valor,
      status: envioParaColuna(shipping.status),
      envioStatus: mapEnvio(shipping.status),
      transportadora: shipping.service || "",
      tracking: shipping.tracking_code || "",
      trackingUrl: shipping.tracking_url || "",
    };
    if (oi >= 0) orders[oi] = { ...orders[oi], ...ord };
    else orders.unshift(ord);
    await writeArr("orders", orders.slice(0, 3000));

    capi = await sendCapi("Purchase", {
      phone: telefone, email, clid: sale.clid,
      value: sale.valor, currency: "BRL", eventId: id,
    });
  }

  return json({ ok: true, id, produto: sale.produto, valor: sale.valor,
    status: sale.status, campanha: sale.campaignName || null, capi });
};
