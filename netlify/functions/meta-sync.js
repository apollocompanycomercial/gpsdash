// meta-sync.js — puxa investimento + conversas do Meta Ads (nivel CAMPANHA)
//   https://SEU-SITE.netlify.app/.netlify/functions/meta-sync?token=SEU_TOKEN
//   ...&preset=today | last_7d | last_30d   (padrao: last_14d)
// Envs: META_TOKEN, META_ACCOUNTS, META_API_VERSION (opcional)
import { writeArr, checkToken, json } from "./_store.js";

// segue a paginacao da Graph API
async function fetchAll(url) {
  let rows = [], next = url, guard = 0;
  while (next && guard < 25) {
    const r = await fetch(next);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    rows = rows.concat(d.data || []);
    next = d.paging && d.paging.next;
    guard++;
  }
  return rows;
}

export default async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (!checkToken(req)) return json({ error: "token invalido" }, 401);

  const token = process.env.META_TOKEN;
  if (!token) return json({ error: "META_TOKEN nao configurado no Netlify" }, 400);

  const accounts = (process.env.META_ACCOUNTS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!accounts.length) return json({ error: "META_ACCOUNTS nao configurado no Netlify" }, 400);

  const v = process.env.META_API_VERSION || "v22.0";
  const preset = new URL(req.url).searchParams.get("preset") || "last_14d";

  const campaigns = [];          // {metaId, campaignId, campaignName, days:[{date,investimento,conversas}]}
  const admap = {};              // adId -> {campaignId, campaignName}

  for (const acc of accounts) {
    // 1 chamada por conta a nivel de anuncio: da o gasto E o mapa ad->campanha
    const url =
      `https://graph.facebook.com/${v}/act_${acc}/insights` +
      `?level=ad&date_preset=${preset}&time_increment=1` +
      `&fields=campaign_id,campaign_name,ad_id,ad_name,spend,actions` +
      `&limit=400&access_token=${encodeURIComponent(token)}`;

    let rows;
    try { rows = await fetchAll(url); }
    catch (e) { campaigns.push({ metaId: acc, error: String(e.message || e) }); continue; }

    const byCamp = {};
    for (const row of rows) {
      const cid = row.campaign_id;
      if (row.ad_id) admap[row.ad_id] = { campaignId: cid, campaignName: row.campaign_name };

      let conversas = 0;
      (row.actions || []).forEach((a) => {
        if (/messaging_conversation_started/.test(a.action_type)) conversas += Number(a.value) || 0;
      });

      byCamp[cid] = byCamp[cid] || { metaId: acc, campaignId: cid, campaignName: row.campaign_name, _d: {} };
      const d = byCamp[cid]._d;
      d[row.date_start] = d[row.date_start] || { date: row.date_start, investimento: 0, conversas: 0 };
      d[row.date_start].investimento += Number(row.spend) || 0;
      d[row.date_start].conversas += conversas;
    }
    Object.values(byCamp).forEach((c) =>
      campaigns.push({ metaId: c.metaId, campaignId: c.campaignId, campaignName: c.campaignName, days: Object.values(c._d) })
    );
  }

  // grava o mapa ad->campanha (usado p/ atribuir vendas e conversas CTWA)
  await writeArr("admap", Object.entries(admap).map(([adId, m]) => ({ adId, ...m })));

  return json({ campaigns, preset });
};
