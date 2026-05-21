// _store.js — helpers compartilhados (arquivo com "_" NÃO vira endpoint)
import { getStore } from "@netlify/blobs";

const store = () => getStore("gpsdash");

// lê um array do Blobs (retorna [] se não existir)
export async function readArr(key) {
  try {
    const v = await store().get(key, { type: "json" });
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// grava um array no Blobs
export async function writeArr(key, arr) {
  await store().setJSON(key, arr);
}

// guarda os últimos payloads crus recebidos (debug do mapeamento)
export async function pushRaw(entry) {
  const raw = await readArr("_raw");
  raw.unshift({ at: new Date().toISOString(), ...entry });
  await writeArr("_raw", raw.slice(0, 200));
}

// valida o token ?token=... contra o env GPSDASH_SECRET
export function checkToken(req) {
  const t = new URL(req.url).searchParams.get("token");
  return !!t && t === process.env.GPSDASH_SECRET;
}

// resposta JSON já com CORS liberado
export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
    },
  });
}

// extrator tolerante: tenta vários caminhos possíveis do payload
export function pick(obj, paths) {
  for (const p of paths) {
    let v = obj, ok = true;
    for (const k of p.split(".")) {
      if (v && typeof v === "object" && k in v) v = v[k];
      else { ok = false; break; }
    }
    if (ok && v != null && v !== "") return v;
  }
  return "";
}
