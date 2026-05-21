// reprocess.js — reconstrói TODAS as vendas Payt a partir do _raw (idempotente, sem duplicar)
//   https://SEU-SITE.netlify.app/.netlify/functions/reprocess?token=SEU_TOKEN
import { readArr, writeArr, checkToken, json } from "./_store.js";
import { normPhone } from "./_capi.js";

function mapStatus(s) {
  s = String(s || "").toLowerCase();
  if (/paid|approv|complet|captured|confirm/.test(s)) return "aprovada";
  if (/pend|waiting|process|analy|created|authorized/.test(s)) return "pendente";
  return "recusada";
}
function mapEnvio(s) {
  const k = String(s || "").toLowerCase();
  const mapa = {
    "waiting_code": "Aguardando código de rastreio", "posted": "Postado nos Correios",
    "shipping": "Em trânsito", "in_transit": "Em trânsito",
    "out_for_delivery": "Saiu para entrega", "delivered": "Entregue",
    "returned": "Devolvido", "lost": "Extraviado", "problem": "Problema na entrega",
    "waiting": "Aguardando postagem",
  };
  return mapa[k] || (s ? String(s) : "Aguardando");
}
function envioParaColuna(s) {
  const k = String(s || "").toLowerCase();
  if (/deliver/.test(k)) return "entregue";
  if (/transit|shipping|out_for/.test(k)) return "transito";
  if (/posted/.test(k)) return "postado";
  if (/return|lost|problem/.test(k)) return "problema";
  return "pendente";
}

export default async (req) => {
  if (!checkToken(req)) return json({ error: "token invalido" }, 401);

  const raw = await readArr("_raw");
  const ctwa = await readArr("ctwa");
  const paytRaws = raw.filter((r) => r.source === "payt" && r.body);

  // mapa por ID -> garante UMA venda por transação, mesmo rodando várias vezes
  const byId = {};

  for (const r of paytRaws) {
    const body = r.body;
    const trans    = body.transaction || {};
    const product  = body.product || {};
    const customer = body.customer || {};
    const shipping = body.shipping || {};

    const extId = String(body.transaction_id || body.cart_id || trans.transaction_id || body.code || "");
    if (!extId) continue;
    const id = "payt:" + extId;

    let valor = Number(trans.total_price || trans.total || product.price || 0) || 0;
    valor = valor / 100;

    const ad = shipping.address || customer.billing_address || {};
    const enderecoLinha = [
      ad.street, ad.street_number, ad.complement, ad.district,
      ad.city, ad.state, ad.zipcode
    ].filter(Boolean).join(", ");

    // origem: afiliado ou venda própria
    const comissoes = Array.isArray(body.commission) ? body.commission : [];
    const afil = comissoes.find((c) => String(c.type).toLowerCase() === "affiliation");
    const ATENDENTES = ["jhonny", "gabriel ramos", "gabriel henrique"];
    const afilNome = afil ? (afil.name || "Afiliado") : "";
    const ehAtendente = ATENDENTES.some((a) => afilNome.toLowerCase().includes(a));
    const origem = (afil && !ehAtendente) ? "afiliado" : "propria";
    const afiliado = afil ? afilNome : "";
    const afiliadoEmail = afil ? (afil.email || "") : "";
    const prodNome = product.name || "";
    const mU = prodNome.match(/(\d+)\s*(unidad|frasc|pote)/i);
    const potes = mU ? Number(mU[1]) : 1;

    const sale = {
      id,
      data: String(trans.paid_at || trans.created_at || body.started_at || new Date().toISOString()).slice(0, 10),
      produto: product.name || (product.items && product.items[0] && product.items[0].name) || "Produto",
      cliente: customer.name || "",
      telefone: customer.phone || "",
      email: customer.email && customer.email !== "null" ? customer.email : "",
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
      quemVendeu: origem === "afiliado" ? afiliado : (afiliado || "Apollo"),
      potes,
      anotacoes: "",
      valor,
      status: mapStatus(trans.payment_status || body.status || ""),
      tipo: "",
      accountId: "",
      campaignId: "",
      campaignName: "",
      clid: "",
    };

    const ph = normPhone(sale.telefone);
    if (ph) {
      const lead = ctwa.find((c) => normPhone(c.phone) === ph);
      if (lead) {
        sale.campaignId = lead.campaignId || "";
        sale.campaignName = lead.campaignName || "";
        sale.clid = lead.clid || "";
      }
    }
    // se a mesma transação aparecer 2x no _raw, fica a mais recente
    byId[id] = sale;
  }

  // ---- processa as vendas Red Rocket ----
  const rrRaws = raw.filter((r) => r.source === "redrocket" && r.body);
  for (const r of rrRaws) {
    const body = r.body;
    const customer = body.customer || {};
    const product  = body.product || {};
    const payment  = body.payment || {};
    const shipping = body.shipping || {};
    const plan     = body.plan || {};
    const affiliate= body.affiliate || null;

    const extId = String(body.id || body.pagarme_order_id || payment.transaction_id || "");
    if (!extId) continue;
    const id = "redrocket:" + extId;

    const valor = Number(body.amount || body.totalToSend || body.subtotal || 0) || 0;
    const ad = customer.address || {};
    const enderecoLinha = [
      ad.street, ad.number, ad.complement, ad.neighborhood,
      ad.city, ad.state, ad.zipCode
    ].filter(Boolean).join(", ");

    const ATEND = ["jhonny", "gabriel ramos", "gabriel henrique"];
    const afilNome = affiliate ? (affiliate.name || "Afiliado") : "";
    const ehAtend = ATEND.some((a) => afilNome.toLowerCase().includes(a));
    const origem = (affiliate && !ehAtend) ? "afiliado" : "propria";

    let potes = Number(plan.items_per_plan || 0);
    if (!potes) {
      const m = String(product.name || "").match(/(\d+)\s*(unidad|frasc|pote|leve)/i);
      potes = m ? Number(m[1]) : 1;
    }

    const sale = {
      id,
      data: String(body.created_at || body.date || new Date().toISOString()).slice(0, 10),
      produto: product.name || plan.name || "Produto",
      cliente: customer.name || "",
      telefone: customer.phone || "",
      email: customer.email && customer.email !== "null" ? customer.email : "",
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
      status: mapStatus(payment.status_label || payment.status_code || body.status || ""),
      tipo: "", accountId: "", campaignId: "", campaignName: "", clid: "",
      source: "webhook",
    };

    const ph = normPhone(sale.telefone);
    if (ph) {
      const lead = ctwa.find((c) => normPhone(c.phone) === ph);
      if (lead) {
        sale.campaignId = lead.campaignId || "";
        sale.campaignName = lead.campaignName || "";
        sale.clid = lead.clid || "";
      }
    }
    byId[id] = sale;
  }

  const sales = await readArr("sales");
  // IDs gerados por webhook (payt: ou redrocket:)
  const ehWebhook = (idv) => /^(payt:|redrocket:)/.test(String(idv));
  // preserva o que o usuário editou/anotou manualmente
  const editadas = {};
  sales.forEach((s) => {
    if (ehWebhook(s.id) && (s.tipo || s.editado || s.anotacoes)) editadas[s.id] = s;
  });

  // mantém vendas manuais (que não vieram de webhook)
  const naoWebhook = sales.filter((s) => !ehWebhook(s.id));

  // reconstrói as de webhook — uma por ID, aplicando edições manuais por cima
  const webhookFinais = Object.values(byId).map((s) => {
    const ed = editadas[s.id];
    if (!ed) return s;
    return { ...s,
      tipo: ed.tipo || "",
      editado: ed.editado,
      anotacoes: ed.anotacoes || "",
      cliente: ed.editado ? ed.cliente : s.cliente,
      telefone: ed.editado ? ed.telefone : s.telefone,
      tratamento: ed.editado && ed.tratamento ? ed.tratamento : s.tratamento,
      endereco: ed.editado ? ed.endereco : s.endereco };
  });

  const novasSales = [...webhookFinais, ...naoWebhook];

  // pedidos: reconstrói os aprovados (Payt + Red Rocket)
  const orders = await readArr("orders");
  const naoWebhookOrders = orders.filter((o) => !ehWebhook(o.id));
  const webhookOrders = webhookFinais.filter((s) => s.status === "aprovada").map((s) => {
    const ext = s.id.replace(/^(payt:|redrocket:)/, "");
    let trackUrl = s.trackingUrl || "";
    if (!trackUrl && s.tracking) {
      trackUrl = "https://rastreamento.correios.com.br/app/index.php?objetos=" + s.tracking;
    }
    return {
      id: s.id, ref: ext, cliente: s.cliente, produto: s.produto, valor: s.valor,
      telefone: s.telefone || "", endereco: s.endereco || "",
      status: envioParaColuna(s.envioStatusRaw),
      envioStatus: s.envioStatus || "Aguardando",
      transportadora: "",
      tracking: s.tracking || "",
      trackingUrl: trackUrl,
      anotacoes: s.anotacoes || "",
    };
  });

  await writeArr("sales", novasSales.slice(0, 3000));
  await writeArr("orders", [...webhookOrders, ...naoWebhookOrders].slice(0, 3000));

  return json({ ok: true, vendasWebhook: webhookFinais.length,
    vendasManuais: naoWebhook.length, totalVendas: novasSales.length });
};
