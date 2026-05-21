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
    const origem = afil ? "afiliado" : "propria";
    const afiliado = afil ? (afil.name || "Afiliado") : "";
    const afiliadoEmail = afil ? (afil.email || "") : "";

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

  const sales = await readArr("sales");
  // preserva o que o usuário editou manualmente (tipo classificado no Kanban)
  const editadas = {};
  sales.forEach((s) => {
    if (String(s.id).startsWith("payt:") && (s.tipo || s.editado)) editadas[s.id] = s;
  });

  // mantém vendas que NÃO são Payt (Red Rocket, manuais)
  const naoPayt = sales.filter((s) => !String(s.id).startsWith("payt:"));

  // reconstrói as Payt — uma por ID, aplicando edições manuais por cima
  const paytFinais = Object.values(byId).map((s) => {
    const ed = editadas[s.id];
    return ed ? { ...s, tipo: ed.tipo || "", editado: ed.editado,
      cliente: ed.editado ? ed.cliente : s.cliente,
      telefone: ed.editado ? ed.telefone : s.telefone,
      endereco: ed.editado ? ed.endereco : s.endereco } : s;
  });

  const novasSales = [...paytFinais, ...naoPayt];

  // pedidos: reconstrói os Payt aprovados
  const orders = await readArr("orders");
  const naoPaytOrders = orders.filter((o) => !String(o.id).startsWith("payt:"));
  const paytOrders = paytFinais.filter((s) => s.status === "aprovada").map((s) => {
    const ext = s.id.replace("payt:", "");
    return {
      id: s.id, ref: ext, cliente: s.cliente, produto: s.produto, valor: s.valor,
      status: envioParaColuna(s.envioStatusRaw),
      envioStatus: s.envioStatus || "Aguardando",
      transportadora: "",
      tracking: s.tracking || "",
      trackingUrl: s.trackingUrl || "",
    };
  });

  await writeArr("sales", novasSales.slice(0, 3000));
  await writeArr("orders", [...paytOrders, ...naoPaytOrders].slice(0, 3000));

  return json({ ok: true, vendasPayt: paytFinais.length,
    vendasOutras: naoPayt.length, totalVendas: novasSales.length });
};
