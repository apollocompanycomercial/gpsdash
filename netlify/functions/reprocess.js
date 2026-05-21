// reprocess.js — reprocessa as vendas Payt já recebidas (no _raw) com o mapeamento V1 correto
//   https://SEU-SITE.netlify.app/.netlify/functions/reprocess?token=SEU_TOKEN
import { readArr, writeArr, checkToken, json } from "./_store.js";
import { normPhone } from "./_capi.js";

function mapStatus(s) {
  s = String(s || "").toLowerCase();
  if (/paid|approv|complet|captured|confirm/.test(s)) return "aprovada";
  if (/pend|waiting|process|analy|created|authorized/.test(s)) return "pendente";
  return "recusada";
}

export default async (req) => {
  if (!checkToken(req)) return json({ error: "token invalido" }, 401);

  const raw = await readArr("_raw");
  const ctwa = await readArr("ctwa");
  const paytRaws = raw.filter((r) => r.source === "payt" && r.body);

  const sales = await readArr("sales");
  const orders = await readArr("orders");
  let novas = 0, atualizadas = 0;

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

    const sale = {
      id,
      data: String(trans.paid_at || trans.created_at || body.started_at || new Date().toISOString()).slice(0, 10),
      produto: product.name || (product.items && product.items[0] && product.items[0].name) || "Produto",
      cliente: customer.name || "",
      telefone: customer.phone || "",
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

    const si = sales.findIndex((s) => s.id === id);
    if (si >= 0) { sales[si] = { ...sales[si], ...sale }; atualizadas++; }
    else { sales.unshift(sale); novas++; }

    if (sale.status === "aprovada") {
      const oi = orders.findIndex((x) => x.id === id);
      const ord = {
        id, ref: extId, cliente: sale.cliente, produto: sale.produto, valor: sale.valor,
        status: shipping.status === "shipping" ? "enviado" : "pendente",
        transportadora: shipping.service || "", tracking: shipping.tracking_code || "",
      };
      if (oi >= 0) orders[oi] = { ...orders[oi], ...ord };
      else orders.unshift(ord);
    }
  }

  await writeArr("sales", sales.slice(0, 3000));
  await writeArr("orders", orders.slice(0, 3000));

  return json({ ok: true, processadas: paytRaws.length, novas, atualizadas,
    totalVendas: sales.length });
};
