/* VAPID, envio Web Push e despachante (imediato + agendado). */
const webpush = require("web-push"), fs = require("fs"), path = require("path");

/** Chaves VAPID: variáveis de ambiente (recomendado em produção) ou data/vapid.json (0600, gravação atômica). */
function loadVapid(dataDir) {
  const pub = (process.env.VAPID_PUBLIC || "").trim();
  const priv = (process.env.VAPID_PRIVATE || "").trim();
  if (Boolean(pub) !== Boolean(priv)) {
    throw new Error("Configuração VAPID incompleta: defina AMBAS as variáveis VAPID_PUBLIC e VAPID_PRIVATE no ambiente, ou deixe ambas em branco para usar o arquivo de chaves.");
  }
  if (pub && priv) return { publicKey: pub, privateKey: priv, source: "env" };
  const f = path.join(dataDir, "vapid.json");
  try { const v = JSON.parse(fs.readFileSync(f, "utf8")); try { fs.chmodSync(f, 0o600); } catch {} return { ...v, source: "file" }; } catch {}
  const v = webpush.generateVAPIDKeys();
  fs.writeFileSync(f + ".tmp", JSON.stringify(v), { mode: 0o600 }); fs.renameSync(f + ".tmp", f);
  return { ...v, source: "file", created: true };
}

function setup(vapid) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@seudominio.com", vapid.publicKey, vapid.privateKey);
}

const DRY = process.env.PUSH_DRY_RUN === "1";   // só para testes locais: não contata nenhum serviço de push
const sendPush = (d, payload) => DRY
  ? (d.endpoint.includes("/gone") ? Promise.reject({ statusCode: 410 }) : Promise.resolve())
  : webpush.sendNotification({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, payload, { TTL: 86400, timeout: 15000 });

function createDispatcher(store, { batch = 50, tickMs = 15000 } = {}) {
  const inflight = new Map();

  /** Envia uma notificação. Idempotente: a lista de destinatários é fixada no "claim" e só entregas
      "pending" são enviadas, então reinícios, ticks repetidos ou chamadas duplicadas nunca reenviam. */
  function run(id, { resume = false } = {}) {
    if (inflight.has(id)) return inflight.get(id);
    const p = (async () => {
      if (!resume && !(await store.claimNotification(id))) return;
      const n = await store.getNotification(id);
      if (!n || n.status !== "sending") return;
      const site = await store.getSite(n.site_id);
      if (!site || !site.active) {
        await store.failPending(id);
        await store.finishNotification(id, "failed", "Site desativado no momento do envio.");
        return;
      }
      await store.cleanPending(id);
      for (;;) {
        const list = await store.pendingDeliveries(id, batch);
        if (!list.length) break;
        const results = await Promise.all(list.map(async d => {
          const payload = JSON.stringify({ title: n.title, message: n.message, url: n.base_url + "/r/" + d.token, icon: n.icon || null });
          try { await sendPush(d, payload); return { id: d.id, subId: d.subId, status: "sent" }; }
          catch (e) {
            const gone = e && (e.statusCode === 404 || e.statusCode === 410);
            if (!gone) console.error("push: falha", e && (e.statusCode || e.code) || "erro");   // nunca loga endpoint/corpo
            return { id: d.id, subId: d.subId, status: gone ? "expired" : "failed" };
          }
        }));
        await store.markDeliveries(results);
      }
      await store.finishNotification(id, "sent");
    })().catch(e => console.error("dispatch:", e.message)).finally(() => inflight.delete(id));
    inflight.set(id, p); return p;
  }

  async function tick() {
    try {
      for (const id of await store.dueNotificationIds()) run(id);
      for (const id of await store.stuckNotificationIds()) if (!inflight.has(id)) run(id, { resume: true });   // retoma após queda
    } catch (e) { console.error("scheduler:", e.message); }
  }
  let timer;
  return { run, tick, start() { tick(); timer = setInterval(tick, tickMs); timer.unref(); }, stop() { clearInterval(timer); }, isRunning: id => inflight.has(id) };
}

module.exports = { loadVapid, setup, createDispatcher };
