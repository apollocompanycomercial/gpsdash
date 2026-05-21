// _capi.js — envio nativo pra Meta Conversions API (substitui o Make/Stape)
// arquivo com "_" NÃO vira endpoint
import crypto from "node:crypto";

const sha256 = (v) =>
  crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex");

// normaliza telefone BR -> só dígitos com DDI 55
export function normPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length <= 11 && !d.startsWith("55")) d = "55" + d;
  return d;
}

// dispara um evento (Lead, Purchase, etc.) pra CAPI com atribuição CTWA
export async function sendCapi(eventName, { phone, email, clid, value, currency, eventId } = {}) {
  const pixel = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN || process.env.META_TOKEN;
  if (!pixel || !token) return { skipped: "sem META_PIXEL_ID/META_CAPI_TOKEN" };

  const v = process.env.META_API_VERSION || "v22.0";

  const user_data = {};
  const ph = normPhone(phone);
  if (ph) user_data.ph = [sha256(ph)];
  if (email) user_data.em = [sha256(email)];
  // ctwa_clid é o que liga o evento ao anúncio Click-to-WhatsApp
  if (clid) user_data.ctwa_clid = clid;
  // WABA id reforça a atribuição da mensageria (opcional)
  if (process.env.META_WABA_ID) user_data.whatsapp_business_account_id = process.env.META_WABA_ID;

  const ev = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    action_source: "business_messaging",
    messaging_channel: "whatsapp",
    event_id: eventId || (eventName + "_" + Date.now()),
    user_data,
    custom_data: {},
  };
  if (value != null) {
    ev.custom_data.value = Number(value) || 0;
    ev.custom_data.currency = currency || "BRL";
  }

  try {
    const r = await fetch(
      `https://graph.facebook.com/${v}/${pixel}/events?access_token=${encodeURIComponent(token)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: [ev] }) }
    );
    const d = await r.json();
    return d.error ? { error: d.error.message } : { ok: true, received: d.events_received };
  } catch (e) {
    return { error: String(e) };
  }
}
