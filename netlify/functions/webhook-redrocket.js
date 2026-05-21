// webhook-redrocket.js — recebe a venda da Red Rocket, mapeia o formato real e dispara CAPI
//   /.netlify/functions/webhook-redrocket?token=SEU_TOKEN
import { readArr, writeArr, pushRaw, checkToken, json } from "./_store.js";
import { sendCapi, normPhone } from "./_capi.js";

function mapStatus(s) {
  s = String(s || "").toLowerCase();
  if (/paid|approv|complet|captured|confirm|pago/.test(s)) return "aprovada";
  if (/pend|waiting|process|analy|created|authorized|aguard/.test(s)) return "pendente";
  return "recusada";
}
function mapEnvio(s) {
  const k = String(s || "").toLowerCase();
  const mapa = {
    "waiting_code": "Aguardando código de rastreio", "posted": "Postado nos Correios",
    "shipping": "Em trânsito", "in_transit": "Em trânsito",
    "out_for_delivery": "Saiu para entrega", "delivered": "Entregue",
    "returned": "Devolvido", "lost": "Extraviado", "problem": "Problema na entrega",
  };
  return mapa[k] || (s ? String(s) : "");
}
function envioParaColuna(s) {
  const k = String(s || "").toLowerCase();
  if (/deliver|entreg/.test(k)) return "entregue";
  if (/transit|shipping|out_for/.test(k)) return "transito";
  if (/posted|postad/.test(k)) return "postado";
  if (/return|lost|problem/.test(k)) return "problema";
  return "pendente";
}

export default async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (!checkToken(req)) return json({ error: "token invalido" }, 401);

  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  await pushRaw({ source: "redrocket", body });

  // ---- estrutura real do payload Red Rocket ----
  const customer = body.customer || {};
  const product  = body.product || {};
  const payment  = body.payment || {};
  const shipping = body.shipping || {};
  const plan     = body.plan || {};
  const affiliate= body.affiliate || null;

  const extId = String(body.id || body.pagarme_order_id || payment.transaction_id || ("rr_" + Date.now()));
  const id = "redrocket:" + extId;

  // valor: Red Rocket manda em REAIS (ex: "697.00") — NÃO dividir
  const valor = Number(body.amount || body.totalToSend || body.subtotal || product.price && product.price.value || 0) || 0;

  const telefone = customer.phone || "";
  const email    = customer.email && customer.email !== "null" ? customer.email : "";
  const statusRaw = payment.status_label || payment.status_code || body.status || "";

  // endereço
  const ad = customer.address || {};
  const enderecoLinha = [
    ad.street, ad.number, ad.complement, ad.neighborhood,
    ad.city, ad.state, ad.zipCode
  ].filter(Boolean).join(", ");

  // afiliado: se existe body.affiliate, foi venda de afiliado
  const ATENDENTES = ["jhonny", "gabriel ramos", "gabriel henrique"];
  const afilNome = affiliate ? (affiliate.name || "Afiliado") : "";
  const ehAtendente = ATENDENTES.some((a) => afilNome.toLowerCase().includes(a));
  const origem = (affiliate && !ehAtendente) ? "afiliado" : "propria";

  // potes: Red Rocket informa items_per_plan; senão tenta extrair do nome
  let potes = Number(plan.items_per_plan || 0);
  if (!potes) {
    const m = String(product.name || "").match(/(\d+)\s*(unidad|frasc|pote|leve)/i);
    potes = m ? Number(m[1]) : 1;
  }

  const dataRaw = body.created_at || body.date || new Date().toISOString();

  const sale = {
    id,
    data: String(dataRaw).slice(0, 10),
    produto: product.name || plan.name || "Produto",
    cliente: customer.name || "",
    telefone,
    email,
    doc: customer.document || "",
    endereco: enderecoLinha,
    enderecoObj: {
      rua: ad.street||"", numero: ad.number||"", complemento: ad.complement||"",
      bairro: ad.neighborhood||"", cidade: ad.city||"", uf: ad.state||"", cep: ad.zipCode||""
    },
    tracking: shipping.cod_rastreio || "",
    trackingUrl: shipping.link_rastreio || "",
    envioStatus: mapEnvio(shipping.rastreio_servico),
    envioStatusRaw: shipping.rastreio_servico || "",
    origem,
    afiliado: afilNome,
    afiliadoEmail: affiliate ? (affiliate.email || "") : "",
    quemVendeu: origem === "afiliado" ? afilNome : (afilNome || "Apollo"),
    potes,
    anotacoes: "",
    valor,
    status: mapStatus(statusRaw),
    tipo: "",
    accountId: "",
    campaignId: "",
    campaignName: "",
    clid: "",
    source: "webhook",
  };

  // atribuição via telefone -> conversa CTWA
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
  if (si >= 0) sales[si] = { ...sales[si], ...sale, anotacoes: sales[si].anotacoes || "", tipo: sales[si].tipo || "" };
  else sales.unshift(sale);
  await writeArr("sales", sales.slice(0, 3000));

  let capi = { skipped: "venda nao aprovada" };
  if (sale.status === "aprovada") {
    const orders = await readArr("orders");
    const oi = orders.findIndex((x) => x.id === id);
    let trackUrl = sale.trackingUrl || "";
    if (!trackUrl && sale.tracking) {
      trackUrl = "https://rastreamento.correios.com.br/app/index.php?objetos=" + sale.tracking;
    }
    const ord = {
      id, ref: extId, cliente: sale.cliente, produto: sale.produto, valor: sale.valor,
      telefone: sale.telefone, endereco: sale.endereco,
      status: envioParaColuna(sale.envioStatusRaw),
      envioStatus: sale.envioStatus || "Aguardando",
      transportadora: "", tracking: sale.tracking || "", trackingUrl: trackUrl,
      anotacoes: (oi >= 0 ? orders[oi].anotacoes : "") || "",
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
    status: sale.status, origem: sale.origem, afiliado: sale.afiliado, capi });
};
