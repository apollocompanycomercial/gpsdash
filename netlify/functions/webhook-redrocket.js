// webhook-redrocket.js — recebe a venda da Red Rocket (mesma logica da Payt)
//   /.netlify/functions/webhook-redrocket?token=SEU_TOKEN
import { readArr, writeArr, pushRaw, checkToken, json, pick } from "./_store.js";
import { sendCapi, normPhone } from "./_capi.js";

function mapStatus(s) {
  s = String(s || "").toLowerCase();
  if (/paid|approv|complet|captured|confirm/.test(s)) return "aprovada";
  if (/pend|waiting|process|analy|created|authorized/.test(s)) return "pendente";
  return "recusada";
}

export default async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (!checkToken(req)) return json({ error: "token invalido" }, 401);

  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  await pushRaw({ source: "redrocket", body });

  const o = body.order || body.data || body.transaction || body.sale || body;

  const extId = String(
    pick(o, ["id", "order_id", "code", "reference", "transaction_id", "hash"]) || ("rr_" + Date.now())
  );
  const id = "redrocket:" + extId;

  const divisor = Number(process.env.PAYT_AMOUNT_DIVISOR || 100);
  let valor = Number(pick(o, ["amount", "total", "value", "paid_amount", "price", "total_amount", "net_amount"])) || 0;
  if (divisor > 1) valor = valor / divisor;

  const telefone = pick(o, ["customer.phone", "client.phone", "buyer.phone", "phone"]) || "";
  const email = pick(o, ["customer.email", "client.email", "buyer.email", "email"]) || "";

  const sale = {
    id,
    data: String(pick(o, ["paid_at", "created_at", "createdAt", "date", "order_date"]) || new Date().toISOString()).slice(0, 10),
    produto: pick(o, ["product.name", "products.0.name", "items.0.name", "plan.name", "product_name", "offer.name"]) || "Produto",
    cliente: pick(o, ["customer.name", "client.name", "buyer.name", "customer.full_name", "name"]) || "",
    telefone,
    valor,
    status: mapStatus(pick(o, ["status", "payment_status", "order_status", "situation"])),
    tipo: "",            // fica vazio de proposito -> voce classifica no Kanban After Pay
    accountId: "",
    campaignId: "",
    campaignName: "",
    clid: "",
  };

  // ATRIBUICAO: casa a venda com a conversa CTWA pelo telefone -> campanha + ctwa_clid
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

  // upsert da venda
  const sales = await readArr("sales");
  const si = sales.findIndex((s) => s.id === id);
  if (si >= 0) sales[si] = { ...sales[si], ...sale };
  else sales.unshift(sale);
  await writeArr("sales", sales.slice(0, 3000));

  let capi = { skipped: "venda nao aprovada" };
  if (sale.status === "aprovada") {
    // pedido logistico
    const orders = await readArr("orders");
    if (!orders.find((x) => x.id === id)) {
      orders.unshift({
        id, ref: extId, cliente: sale.cliente, produto: sale.produto,
        valor: sale.valor, status: "pendente", transportadora: "", tracking: "",
      });
      await writeArr("orders", orders.slice(0, 3000));
    }
    // CAPI Purchase nativo (com ctwa_clid p/ atribuir ao anuncio)
    capi = await sendCapi("Purchase", {
      phone: telefone, email, clid: sale.clid,
      value: sale.valor, currency: "BRL", eventId: id,
    });
  }

  return json({ ok: true, id, status: sale.status, campanha: sale.campaignName || null, capi });
};
