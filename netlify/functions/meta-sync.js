// meta-sync.js — puxa metricas completas do Meta Ads por CAMPANHA
//   /.netlify/functions/meta-sync?token=SEU_TOKEN&preset=last_14d
// presets: today, yesterday, last_7d, last_14d, last_30d, last_90d, this_month, last_month
// Envs: META_TOKEN, META_ACCOUNTS, META_API_VERSION (opcional)
import { writeArr, checkToken, json } from "./_store.js";

async function fetchAll(url, deadline) {
  let rows = [], next = url, guard = 0;
  while (next && guard < 30) {
    // para de paginar se estiver perto do limite de tempo da function
    if (deadline && Date.now() > deadline) break;
    const r = await fetch(next);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    rows = rows.concat(d.data || []);
    next = d.paging && d.paging.next;
    guard++;
  }
  return rows;
}

// soma um action_type especifico da lista de actions
function sumAction(actions, regex) {
  let t = 0;
  (actions || []).forEach((a) => { if (regex.test(a.action_type)) t += Number(a.value) || 0; });
  return t;
}

export default async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (!checkToken(req)) return json({ error: "token invalido" }, 401);

  const token = process.env.META_TOKEN;
  if (!token) return json({ error: "META_TOKEN nao configurado" }, 400);

  const accountsAll = (process.env.META_ACCOUNTS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!accountsAll.length) return json({ error: "META_ACCOUNTS nao configurado" }, 400);

  const v = process.env.META_API_VERSION || "v22.0";
  const sp = new URL(req.url).searchParams;
  const preset = sp.get("preset") || "last_14d";
  // ?acc=ID processa só uma conta (divide a carga e evita timeout)
  const only = sp.get("acc");
  const accounts = only ? accountsAll.filter((a) => a === only) : accountsAll;

  const campaigns = [];
  const admap = {};
  // limite interno: 8s — devolve o que conseguiu antes do Netlify cortar (10s)
  const deadline = Date.now() + 8000;

  // campos: gasto, impressoes, cliques, video, e o budget vem da campanha
  const fields = [
    "campaign_id", "campaign_name", "ad_id",
    "spend", "impressions", "reach", "clicks", "inline_link_clicks",
    "cpm", "ctr", "actions", "action_values",
    "video_play_actions", "video_thruplay_watched_actions",
    "video_p25_watched_actions", "video_p100_watched_actions",
  ].join(",");

  for (const acc of accounts) {
    const url =
      `https://graph.facebook.com/${v}/act_${acc}/insights` +
      `?level=ad&date_preset=${preset}&time_increment=1&fields=${fields}` +
      `&limit=300&access_token=${encodeURIComponent(token)}`;

    let rows;
    try { rows = await fetchAll(url, deadline); }
    catch (e) { campaigns.push({ metaId: acc, error: String(e.message || e) }); continue; }

    const byCamp = {};
    for (const row of rows) {
      const cid = row.campaign_id;
      if (row.ad_id) admap[row.ad_id] = { campaignId: cid, campaignName: row.campaign_name };

      const impressions = Number(row.impressions) || 0;
      const clicks = Number(row.clicks) || 0;
      const linkClicks = Number(row.inline_link_clicks) || 0;
      const spend = Number(row.spend) || 0;

      const conversas = sumAction(row.actions, /messaging_conversation_started/);
      const compras = sumAction(row.actions, /^(omni_purchase|purchase|offsite_conversion.fb_pixel_purchase)$/);
      const valorCompras = sumAction(row.action_values, /^(omni_purchase|purchase|offsite_conversion.fb_pixel_purchase)$/);

      // video: play = quantas vezes comecou; p25 ~ hook; thruplay/p100 ~ hold
      const vPlay = sumAction(row.video_play_actions, /video_view/);
      const vP25 = sumAction(row.video_p25_watched_actions, /video_view/);
      const vP100 = sumAction(row.video_p100_watched_actions, /video_view/);
      const vThru = sumAction(row.video_thruplay_watched_actions, /video_view/);

      byCamp[cid] = byCamp[cid] || {
        metaId: acc, campaignId: cid, campaignName: row.campaign_name, _d: {},
      };
      const d = byCamp[cid]._d;
      const dt = row.date_start;
      d[dt] = d[dt] || {
        date: dt, investimento: 0, conversas: 0, compras: 0, valorCompras: 0,
        impressions: 0, clicks: 0, linkClicks: 0,
        vPlay: 0, vP25: 0, vP100: 0, vThru: 0,
      };
      const x = d[dt];
      x.investimento += spend; x.conversas += conversas;
      x.compras += compras; x.valorCompras += valorCompras;
      x.impressions += impressions; x.clicks += clicks; x.linkClicks += linkClicks;
      x.vPlay += vPlay; x.vP25 += vP25; x.vP100 += vP100; x.vThru += vThru;
    }
    Object.values(byCamp).forEach((c) =>
      campaigns.push({
        metaId: c.metaId, campaignId: c.campaignId,
        campaignName: c.campaignName, days: Object.values(c._d),
      })
    );
  }

  await writeArr("admap", Object.entries(admap).map(([adId, m]) => ({ adId, ...m })));
  return json({ campaigns, preset, accountsAll });
};
