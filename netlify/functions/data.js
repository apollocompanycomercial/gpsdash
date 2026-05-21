// data.js — o painel le vendas, pedidos e leads CTWA daqui
//   https://SEU-SITE.netlify.app/.netlify/functions/data?token=SEU_TOKEN
//   ...&debug=1  -> ultimos payloads crus recebidos (p/ ajustar mapeamento)
import { readArr, checkToken, json } from "./_store.js";

export default async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (!checkToken(req)) return json({ error: "token invalido" }, 401);

  const url = new URL(req.url);
  if (url.searchParams.get("debug")) {
    return json({ raw: await readArr("_raw") });
  }

  return json({
    sales: await readArr("sales"),
    orders: await readArr("orders"),
    ctwa: await readArr("ctwa"),
    at: new Date().toISOString(),
  });
};
