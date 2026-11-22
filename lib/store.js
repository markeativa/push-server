/* Camada de dados (SQLite via better-sqlite3).
   TODA a SQL do projeto vive aqui e a API é assíncrona: para migrar para PostgreSQL/Supabase, basta
   reescrever este arquivo (ex.: com "pg") mantendo as mesmas funções. Ver README.md e docs/schema.postgres.sql. */
const Database = require("better-sqlite3"), crypto = require("crypto"), fs = require("fs"), path = require("path");

const rid = n => crypto.randomBytes(n).toString("hex");
const now = () => new Date().toISOString();
let db;

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  db = new Database(path.join(dataDir, "push.db"));
  db.pragma("journal_mode = WAL");      // leitores não bloqueiam o escritor; sobrevive a quedas
  db.pragma("synchronous = NORMAL");    // seguro em WAL
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");     // espera em vez de falhar se houver escrita concorrente
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const cur = Number((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() || {}).value || 0);
  const dir = path.join(__dirname, "..", "migrations");
  for (const f of fs.readdirSync(dir).filter(f => /^\d+.*\.sql$/.test(f)).sort()) {
    const v = parseInt(f, 10); if (v <= cur) continue;
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
      db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(v));
    })();
  }
  return module.exports;
}

const tx = fn => db.transaction(fn)();
const NOTIF_SQL = `SELECT n.*, s.name AS site_name,
  (SELECT COUNT(*) FROM deliveries d WHERE d.notification_id=n.id) AS targeted,
  (SELECT COUNT(*) FROM deliveries d WHERE d.notification_id=n.id AND d.status='sent') AS delivered,
  (SELECT COUNT(*) FROM deliveries d WHERE d.notification_id=n.id AND d.status IN ('failed','expired')) AS failed,
  (SELECT COUNT(*) FROM clicks c WHERE c.notification_id=n.id) AS clicks,
  (SELECT COUNT(DISTINCT c.delivery_id) FROM clicks c WHERE c.notification_id=n.id) AS unique_clicks
  FROM notifications n JOIN sites s ON s.id=n.site_id`;

const siteOut = r => r && ({ id: r.id, name: r.name, active: !!r.active, allowExternalLinks: !!r.allow_external_links, createdAt: r.created_at,
  origins: db.prepare("SELECT origin FROM site_origins WHERE site_id=? ORDER BY origin").all(r.id).map(o => o.origin),
  ...(r.subscribers !== undefined && { subscribers: r.subscribers }) });

const api = {
  open, rid,
  async close() { db.close(); },
  async backup(file) { await db.backup(file); },

  /* ---- meta ---- */
  async getMeta(k) { const r = db.prepare("SELECT value FROM meta WHERE key=?").get(k); return r ? r.value : null; },
  async setMeta(k, v) { db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v); },

  /* ---- sites ---- */
  async listSites() {
    return db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM subscriptions x WHERE x.site_id=s.id AND x.status='active') AS subscribers
      FROM sites s ORDER BY s.created_at`).all().map(siteOut);
  },
  async getSite(id) { return siteOut(db.prepare("SELECT * FROM sites WHERE id=?").get(id)); },
  async findActiveSitesByOrigin(origin) {
    return db.prepare(`SELECT s.* FROM sites s JOIN site_origins o ON o.site_id=s.id WHERE o.origin=? AND s.active=1`).all(origin).map(siteOut);
  },
  async allOrigins() { return db.prepare(`SELECT DISTINCT o.origin FROM site_origins o JOIN sites s ON s.id=o.site_id WHERE s.active=1`).all().map(r => r.origin); },
  async createSite({ name, origins, allowExternalLinks = false }) {
    const id = "site_" + rid(6);
    tx(() => {
      db.prepare("INSERT INTO sites(id,name,allow_external_links,active,created_at) VALUES(?,?,?,1,?)").run(id, name, allowExternalLinks ? 1 : 0, now());
      for (const o of origins) db.prepare("INSERT INTO site_origins(site_id,origin) VALUES(?,?)").run(id, o);
    });
    return api.getSite(id);
  },
  async updateSite(id, { name, origins, active, allowExternalLinks }) {
    tx(() => {
      if (name !== undefined) db.prepare("UPDATE sites SET name=? WHERE id=?").run(name, id);
      if (active !== undefined) db.prepare("UPDATE sites SET active=? WHERE id=?").run(active ? 1 : 0, id);
      if (allowExternalLinks !== undefined) db.prepare("UPDATE sites SET allow_external_links=? WHERE id=?").run(allowExternalLinks ? 1 : 0, id);
      if (origins) { db.prepare("DELETE FROM site_origins WHERE site_id=?").run(id); for (const o of origins) db.prepare("INSERT INTO site_origins(site_id,origin) VALUES(?,?)").run(id, o); }
    });
    return api.getSite(id);
  },

  /* ---- inscrições ---- */
  async countActiveSubscriptions() { return db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE status='active'").get().c; },
  async upsertSubscription({ siteId, endpoint, p256dh, auth, device }) {
    const t = now(), ex = db.prepare("SELECT id FROM subscriptions WHERE site_id=? AND endpoint=?").get(siteId, endpoint);
    if (ex) { db.prepare("UPDATE subscriptions SET p256dh=?,auth=?,device=?,status='active',updated_at=? WHERE id=?").run(p256dh, auth, device, t, ex.id); return ex.id; }
    const id = rid(8);
    db.prepare("INSERT INTO subscriptions(id,site_id,endpoint,p256dh,auth,device,status,created_at,updated_at) VALUES(?,?,?,?,?,?, 'active',?,?)").run(id, siteId, endpoint, p256dh, auth, device, t, t);
    return id;
  },
  async removeSubscriptionByEndpoint(siteId, endpoint) { return db.prepare("DELETE FROM subscriptions WHERE site_id=? AND endpoint=?").run(siteId, endpoint).changes; },
  async deleteSubscriber(id) { return db.prepare("DELETE FROM subscriptions WHERE id=?").run(id).changes; },
  async listSubscribers({ siteId, status, limit = 50, offset = 0 }) {
    const w = [], p = [];
    if (siteId) { w.push("x.site_id=?"); p.push(siteId); }
    if (status) { w.push("x.status=?"); p.push(status); }
    const where = w.length ? "WHERE " + w.join(" AND ") : "";
    const total = db.prepare(`SELECT COUNT(*) c FROM subscriptions x ${where}`).get(...p).c;
    // Só campos não sensíveis: nunca endpoint, chaves ou IP.
    const rows = db.prepare(`SELECT x.id, x.site_id AS siteId, s.name AS siteName, x.created_at AS createdAt, x.device, x.status
      FROM subscriptions x JOIN sites s ON s.id=x.site_id ${where} ORDER BY x.created_at DESC LIMIT ? OFFSET ?`).all(...p, limit, offset);
    return { total, rows };
  },
  async purgeExpiredSubscriptions(days = 30) {
    return db.prepare("DELETE FROM subscriptions WHERE status='expired' AND updated_at < ?").run(new Date(Date.now() - days * 864e5).toISOString()).changes;
  },

  /* ---- notificações / agendamento ---- */
  async createNotification({ siteId, title, message, url, icon, baseUrl, scheduledAt }) {
    const id = rid(8), t = now();
    db.prepare(`INSERT INTO notifications(id,site_id,title,message,url,icon,base_url,status,scheduled_at,created_at)
      VALUES(?,?,?,?,?,?,?, 'scheduled',?,?)`).run(id, siteId, title, message, url, icon, baseUrl, scheduledAt || t, t);
    return id;
  },
  async getNotification(id) { return db.prepare(NOTIF_SQL + " WHERE n.id=?").get(id) || null; },
  async listNotifications({ siteId, limit = 50, offset = 0 }) {
    const where = siteId ? "WHERE n.site_id=?" : "", p = siteId ? [siteId] : [];
    const total = db.prepare(`SELECT COUNT(*) c FROM notifications n ${where}`).get(...p).c;
    return { total, rows: db.prepare(NOTIF_SQL + ` ${where} ORDER BY n.scheduled_at DESC, n.created_at DESC LIMIT ? OFFSET ?`).all(...p, limit, offset) };
  },
  async cancelNotification(id) { // atômico: só cancela se ainda estiver agendada
    return db.prepare("UPDATE notifications SET status='canceled', finished_at=? WHERE id=? AND status='scheduled'").run(now(), id).changes === 1;
  },
  async dueNotificationIds() { return db.prepare("SELECT id FROM notifications WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at").all(now()).map(r => r.id); },
  async stuckNotificationIds() { return db.prepare("SELECT id FROM notifications WHERE status='sending'").all().map(r => r.id); },

  /** Reivindica o envio (scheduled -> sending) e congela a lista de destinatários, tudo na mesma transação.
      Retorna false se outro processo/tick já reivindicou: é isso que impede envio duplicado. */
  async claimNotification(id) {
    return tx(() => {
      const n = db.prepare("SELECT n.site_id, s.active FROM notifications n JOIN sites s ON s.id=n.site_id WHERE n.id=?").get(id);
      if (!n) return false;
      if (!n.active) { // site desativado: não envia
        db.prepare("UPDATE notifications SET status='failed', error='Site desativado no momento do envio.', finished_at=? WHERE id=? AND status='scheduled'").run(now(), id);
        return false;
      }
      if (db.prepare("UPDATE notifications SET status='sending', started_at=? WHERE id=? AND status='scheduled'").run(now(), id).changes !== 1) return false;
      const ins = db.prepare("INSERT INTO deliveries(token,notification_id,subscription_id,status) VALUES(?,?,?, 'pending')");
      for (const s of db.prepare("SELECT id FROM subscriptions WHERE site_id=? AND status='active'").all(n.site_id)) ins.run(crypto.randomBytes(16).toString("base64url"), id, s.id);
      return true;
    });
  },
  /** Entregas pendentes cujo inscrito sumiu/expirou viram "failed"/"expired" antes de enviar. */
  async cleanPending(notificationId) {
    db.prepare(`UPDATE deliveries SET status='failed' WHERE notification_id=? AND status='pending' AND subscription_id IS NULL`).run(notificationId);
    db.prepare(`UPDATE deliveries SET status='expired' WHERE notification_id=? AND status='pending'
      AND subscription_id IN (SELECT id FROM subscriptions WHERE status!='active')`).run(notificationId);
  },
  async failPending(notificationId) {
    return db.prepare("UPDATE deliveries SET status='failed' WHERE notification_id=? AND status='pending'").run(notificationId).changes;
  },
  async pendingDeliveries(notificationId, limit) {
    return db.prepare(`SELECT d.id, d.token, s.id AS subId, s.endpoint, s.p256dh, s.auth FROM deliveries d JOIN subscriptions s ON s.id=d.subscription_id
      WHERE d.notification_id=? AND d.status='pending' ORDER BY d.id LIMIT ?`).all(notificationId, limit);
  },
  async markDeliveries(results) { // [{id, subId, status}]
    tx(() => {
      const u = db.prepare("UPDATE deliveries SET status=?, sent_at=? WHERE id=?"), e = db.prepare("UPDATE subscriptions SET status='expired', updated_at=? WHERE id=?");
      for (const r of results) { u.run(r.status, now(), r.id); if (r.status === "expired") e.run(now(), r.subId); }
    });
  },
  async finishNotification(id, status, error = null) { db.prepare("UPDATE notifications SET status=?, error=?, finished_at=? WHERE id=?").run(status, error, now(), id); },

  /* ---- cliques ---- */
  /** Registra o clique e devolve o destino. Chamado SOMENTE pelo link rastreável (nunca no recebimento). */
  async recordClick(token) {
    return tx(() => {
      const d = db.prepare("SELECT d.id, d.notification_id, n.url FROM deliveries d JOIN notifications n ON n.id=d.notification_id WHERE d.token=?").get(token);
      if (!d) return null;
      const recent = db.prepare("SELECT 1 FROM clicks WHERE delivery_id=? AND clicked_at>?").get(d.id, new Date(Date.now() - 3000).toISOString());
      if (!recent) db.prepare("INSERT INTO clicks(notification_id,delivery_id,clicked_at) VALUES(?,?,?)").run(d.notification_id, d.id, now()); // ignora duplo-toque em 3 s
      return { url: d.url };
    });
  },
  async clickDetail(notificationId) {
    return {
      recent: db.prepare("SELECT clicked_at AS at FROM clicks WHERE notification_id=? ORDER BY clicked_at DESC LIMIT 100").all(notificationId).map(r => r.at),
      byDay: db.prepare("SELECT substr(clicked_at,1,10) AS day, COUNT(*) AS clicks FROM clicks WHERE notification_id=? GROUP BY day ORDER BY day").all(notificationId)
    };
  },

  /* ---- estatísticas ---- */
  async stats(siteId) {
    const p = siteId ? [siteId] : [], f = siteId ? "WHERE site_id=?" : "", fa = siteId ? "AND site_id=?" : "";
    const one = (sql) => db.prepare(sql).get(...p).c;
    const subscribers = one(`SELECT COUNT(*) c FROM subscriptions WHERE status='active' ${fa}`);
    const sent = one(`SELECT COUNT(*) c FROM notifications WHERE status IN ('sent','sending') ${fa}`);
    const scheduled = one(`SELECT COUNT(*) c FROM notifications WHERE status='scheduled' ${fa}`);
    const j = siteId ? "AND n.site_id=?" : "";
    const delivered = one(`SELECT COUNT(*) c FROM deliveries d JOIN notifications n ON n.id=d.notification_id WHERE d.status='sent' ${j}`);
    const clicks = one(`SELECT COUNT(*) c FROM clicks c JOIN notifications n ON n.id=c.notification_id WHERE 1=1 ${j}`);
    const unique = one(`SELECT COUNT(DISTINCT c.delivery_id) c FROM clicks c JOIN notifications n ON n.id=c.notification_id WHERE 1=1 ${j}`);
    return { subscribers, sent, scheduled, delivered, clicks, uniqueClicks: unique, ctr: delivered ? unique / delivered : 0 };
  },

  /* ---- sessões do painel ---- */
  async createSession(hash, expiresAt) { db.prepare("DELETE FROM sessions WHERE expires_at<?").run(now()); db.prepare("INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)").run(hash, expiresAt); },
  async validSession(hash) { const r = db.prepare("SELECT expires_at FROM sessions WHERE token_hash=?").get(hash); return !!r && r.expires_at > now(); },
  async deleteSession(hash) { db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash); },

  /** Importa data/db.json (formato antigo) uma única vez. Retorna resumo. */
  async importLegacy(legacy, normOrigin) {
    return tx(() => {
      const sitesByOrigin = new Map(); let subs = 0, hist = 0;
      const siteFor = origin => {
        const key = normOrigin(origin) || "__legacy__";
        if (sitesByOrigin.has(key)) return sitesByOrigin.get(key);
        const id = "site_" + rid(6);
        db.prepare("INSERT INTO sites(id,name,allow_external_links,active,created_at) VALUES(?,?,1,1,?)")
          .run(id, key === "__legacy__" ? "Legado (sem origem)" : new URL(key).hostname, now());
        if (key !== "__legacy__") db.prepare("INSERT INTO site_origins(site_id,origin) VALUES(?,?)").run(id, key);
        sitesByOrigin.set(key, id); return id;
      };
      for (const s of legacy.subs || []) {
        if (!s.endpoint || !s.keys) continue;
        const t = s.at || now(), sid = siteFor(s.site || "");
        const r = db.prepare("INSERT OR IGNORE INTO subscriptions(id,site_id,endpoint,p256dh,auth,device,status,created_at,updated_at) VALUES(?,?,?,?,?,NULL,'active',?,?)")
          .run(rid(8), sid, s.endpoint, s.keys.p256dh, s.keys.auth, t, t); subs += r.changes;
      }
      // Histórico antigo não tem site: vai para o site com mais inscritos (ou para o "Legado").
      const fallback = sitesByOrigin.size ? [...sitesByOrigin.values()][0] : siteFor("");
      for (const h of legacy.history || []) {
        const nid = rid(8);
        db.prepare(`INSERT INTO notifications(id,site_id,title,message,url,icon,base_url,status,scheduled_at,created_at,started_at,finished_at)
          VALUES(?,?,?,?,?,?,?, 'sent',?,?,?,?)`).run(nid, fallback, h.title || "", h.message || "", h.url || "", h.icon || null, "", h.at || now(), h.at || now(), h.at || now(), h.at || now());
        // sem entregas individuais no formato antigo: guarda só o total como entregas "sent" sem inscrito
        const ins = db.prepare("INSERT INTO deliveries(token,notification_id,subscription_id,status,sent_at) VALUES(?,?,NULL,?,?)");
        for (let i = 0; i < (h.recipients || 0); i++) ins.run(crypto.randomBytes(16).toString("base64url"), nid, "sent", h.at || now());
        for (let i = 0; i < (h.failed || 0); i++) ins.run(crypto.randomBytes(16).toString("base64url"), nid, "failed", h.at || now());
        hist++;
      }
      return { sites: sitesByOrigin.size, subs, hist };
    });
  }
};
module.exports = api;
