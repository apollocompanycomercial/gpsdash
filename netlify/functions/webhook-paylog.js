// webhook-paylog.js — recebe o WebHook de status de envio da PayLog
// URL p/ configurar na PayLog:
//   https://SEU-SITE.netlify.app/.netlify/functions/webhook-paylog?token=SEU_TOKEN
import { readArr, writeArr, pushRaw, checkToken, json, pick } from "./_store.js";

// PayLog -> coluna do Kanban de Pedidos
function mapStatus(s) {
  s = String(s || "").toLowerCase();
  if (/entreg|delivered|finaliz/.test(s)) return "entregue";
  if (/transit|rota|saiu|out_for|caminho/.test(s)) return "transito";
  if (/post|enviad|shipped|coletad|despach/.test(s)) return "postado";
  if (/problem|falha|extravi|devolv|return|fail|erro|recusad|avaria/.test(s)) return "problema";
  if (/cobranc|aguard.*pag|pending_payment|nao_pago/.test(s)) return "cobranca";
  return "pendente";
}

export default async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (!checkToken(req)) return json({ error: "token inválido" }, 401);

  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  await pushRaw({ source: "paylog", body });

  const o = body.order || body.data || body.shipment || body.tracking || body;

  // referência usada pra casar com o pedido criado pela venda Payt
  const ref = String(
    pick(o, ["reference", "order_id", "external_id", "external_reference", "code", "order_reference", "id"]) || ""
  );

  const upd = {
    status: mapStatus(pick(o, ["status", "shipment_status", "situation", "tracking_status", "delivery_status"])),
    tracking: pick(o, ["tracking_code", "tracking", "tracking_number", "code", "rastreio"]) || "",
    transportadora: pick(o, ["carrier", "carrier_name", "transportadora", "shipping_company", "logistic"]) || "PayLog",
    cliente: pick(o, ["customer.name", "client.name", "recipient.name", "name"]) || "",
    produto: pick(o, ["product", "product_name", "items.0.name", "description"]) || "",
  };

  const orders = await readArr("orders");
  // casa por ref, por id payt:REF ou paylog:REF
  let idx = orders.findIndex(
    (x) => (x.ref && x.ref === ref) || x.id === "payt:" + ref || x.id === "paylog:" + ref
  );

  if (idx >= 0) {
    orders[idx] = {
      ...orders[idx],
      status: upd.status,
      tracking: upd.tracking || orders[idx].tracking,
      transportadora: upd.transportadora || orders[idx].transportadora,
      cliente: orders[idx].cliente || upd.cliente,
      produto: orders[idx].produto || upd.produto,
    };
  } else {
    // sem pedido correspondente: cria um novo card
    orders.unshift({
      id: "paylog:" + (ref || Date.now()),
      ref,
      cliente: upd.cliente,
      produto: upd.produto,
      status: upd.status,
      tracking: upd.tracking,
      transportadora: upd.transportadora,
    });
  }
  await writeArr("orders", orders.slice(0, 3000));

  return json({ ok: true, ref, status: upd.status });
};
