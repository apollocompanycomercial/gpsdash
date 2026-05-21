# GPS Digital — Painel de Tráfego & Logística (V3 — autônomo)

Sistema autônomo: tráfego puxando do Meta, vendas atribuídas à campanha na hora,
CPA por campanha, CTWA + CAPI nativos (sem Make/Stape).

## O que é automático

| Fonte | Como entra | Velocidade |
|---|---|---|
| Meta Ads (gasto + conversas) | painel puxa via `meta-sync` | a cada 3 min |
| Venda (Payt) | WebHook → `webhook-payt` | instantâneo |
| Envio (PayLog) | WebHook → `webhook-paylog` | instantâneo |
| Conversa CTWA | WhatsApp Cloud API → `webhook-ctwa` | instantâneo |
| CAPI (Lead + Purchase) | disparado pelo backend | instantâneo |

> A API do Meta é *pull*. O tráfego é "near-real-time" (puxa a cada 3 min).
> Vendas e CTWA chegam na hora via WebHook.

## Estrutura

```
gpsdash/
  index.html
  netlify.toml / package.json
  netlify/functions/
    _store.js        helpers (Blobs, token)
    _capi.js         envio nativo pra Conversions API
    webhook-payt.js  venda -> atribui campanha -> CAPI Purchase
    webhook-paylog.js  status de envio -> Kanban
    webhook-ctwa.js  conversa CTWA (Cloud API) -> CAPI Lead
    meta-sync.js     gasto + conversas por campanha
    data.js          leitura do painel
```

## Deploy

1. Suba a pasta `gpsdash/` num repositório GitHub.
2. Netlify -> Import from GitHub. O `netlify.toml` configura tudo.
3. Environment variables:

| Variável | Valor | Para quê |
|---|---|---|
| `GPSDASH_SECRET` | token secreto que você inventa | protege os endpoints |
| `PAYT_AMOUNT_DIVISOR` | `100` (centavos) ou `1` | converte o valor da venda |
| `META_TOKEN` | token system user (app "Gabriel IA") | sync Meta |
| `META_ACCOUNTS` | `1479485729200192,1266624275324140,299760365365671` | contas |
| `META_PIXEL_ID` | `848037761316314` | CAPI |
| `META_CAPI_TOKEN` | token com acesso ao pixel (pode ser o `META_TOKEN`) | CAPI |
| `META_WABA_ID` | ID da sua conta WhatsApp Business | reforça atribuição CTWA |
| `META_VERIFY_TOKEN` | token p/ verificar o webhook (pode ser o `GPSDASH_SECRET`) | webhook CTWA |
| `META_API_VERSION` | opcional, padrão `v22.0` | — |

4. Deploy. Anote o domínio (ex: `https://gpsdash.netlify.app`).

## Ligar as plataformas

Troque `SEU_TOKEN` pelo valor de `GPSDASH_SECRET`.

- **Payt** -> WebHook de venda:
  `https://SEU-SITE/.netlify/functions/webhook-payt?token=SEU_TOKEN`
- **PayLog** -> WebHook de status de envio:
  `https://SEU-SITE/.netlify/functions/webhook-paylog?token=SEU_TOKEN`

### CTWA — WhatsApp Cloud API (modo Coexistência)

Como seu número roda em Coexistência, ele está conectado à Cloud API e o
webhook de `messages` entrega o `referral` com o `ctwa_clid` nativamente.

No app Meta -> produto WhatsApp -> Configuration -> Webhook:
- **Callback URL:** `https://SEU-SITE/.netlify/functions/webhook-ctwa?token=SEU_TOKEN`
- **Verify token:** o valor de `META_VERIFY_TOKEN`
- Clique **Verify and save** (o backend responde o handshake automaticamente).
- Em **Webhook fields**, assine o campo **`messages`**.

Pronto: toda conversa vinda de anúncio CTWA chega no painel e dispara o Lead na CAPI.

No painel -> Configurações: URL do backend vazia (mesmo site) + token = `GPSDASH_SECRET`.

## Como a atribuição funciona

1. Anúncio CTWA gera `ctwa_clid` + ID do anúncio na conversa.
2. Cloud API envia o `referral` ao `webhook-ctwa` -> grava o lead -> CAPI **Lead**.
3. O lead compra na Payt -> `webhook-payt` casa a venda com o lead **pelo telefone**.
4. A venda herda a campanha e o `ctwa_clid` -> CAPI **Purchase**.
5. `meta-sync` traz o gasto por campanha -> o painel calcula **CPA por campanha**.

## Ajuste fino do mapeamento

Payt e PayLog mandam o JSON em formato próprio. Depois de subir, dispare um
evento de teste de cada uma e acesse:

`https://SEU-SITE/.netlify/functions/data?token=SEU_TOKEN&debug=1`

Mostra os payloads crus recebidos. Mande esse JSON que eu travo o mapeamento
exato em cada `webhook-*.js`. (O `webhook-ctwa` já segue o formato oficial da
Cloud API, então normalmente não precisa de ajuste.)
