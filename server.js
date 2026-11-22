const express = require("express"), crypto = require("crypto"), fs = require("fs"), path = require("path");
const store = require("./lib/store"), V = require("./lib/validate"), push = require("./lib/push");
const { limiter, loginGuard } = require("./lib/ratelimit");

/* ---------- configuração e verificações de segurança na partida ---------- */
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
if (ADMIN_PASSWORD.length < 12 || ADMIN_PASSWORD === "troque-esta-senha") {
  console.error("Defina ADMIN_PASSWORD no .env com pelo menos 12 caracteres (e diferente do exemplo)."); process.exit(1);
}
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data")), UP = path.join(DATA, "uploads");
fs.mkdirSync(UP, { recursive: true, mode: 0o700 });
const MAX_SUBS = Number(process.env.MAX_SUBSCRIBERS) || 500000;
if (!process.env.BASE_URL) console.warn("AVISO: defina BASE_URL (https://seu-servidor). Os links rastreáveis dependem dela, principalmente nos envios agendados.");

/* ---------- chaves VAPID (a chave privada nunca sai deste processo) ---------- */
let vapid;
try {
  vapid = push.loadVapid(DATA);
  push.setup(vapid);
} catch (e) {
  console.error("Erro na configuração VAPID:", e.message);
  process.exit(1);
}
if (vapid.source === "file") console.warn("AVISO: chaves VAPID em data/vapid.json. Em hospedagem com disco efêmero, defina VAPID_PUBLIC/VAPID_PRIVATE no ambiente (perder as chaves invalida TODAS as inscrições).");

/* ---------- banco ---------- */
store.open(DATA);
const dispatcher = push.createDispatcher(store, { tickMs: Number(process.env.SCHEDULER_TICK_MS) || 15000 });
const sha = x => crypto.createHash("sha256").update(String(x)).digest("hex");

(async () => {
  const prev = await store.getMeta("vapid_public");
  if (prev && prev !== vapid.publicKey) console.error("ALERTA: a chave VAPID pública mudou desde a última execução. Inscrições antigas deixarão de funcionar. Restaure a chave anterior.");
  await store.setMeta("vapid_public", vapid.publicKey);

  // migração única do formato antigo (db.json -> SQLite). O arquivo original é preservado como backup.
  const legacy = path.join(DATA, "db.json");
  if (fs.existsSync(legacy) && !(await store.getMeta("legacy_imported"))) {
    try {
      const r = await store.importLegacy(JSON.parse(fs.readFileSync(legacy, "utf8")), V.normOrigin);
      await store.setMeta("legacy_imported", new Date().toISOString());
      fs.renameSync(legacy, legacy + ".imported");
      console.log(`Migração do db.json concluída: ${r.sites} site(s), ${r.subs} inscrições, ${r.hist} notificações. Backup: db.json.imported`);
    } catch (e) { console.error("Falha ao migrar db.json (nada foi alterado):", e.message); process.exit(1); }
  }
  await store.purgeExpiredSubscriptions(30);
  dispatcher.start();
})();

/* ---------- app ---------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === undefined ? 1 : (isNaN(process.env.TRUST_PROXY) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY)));

app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Cross-Origin-Opener-Policy": "same-origin" });
  if (req.secure) res.set("Strict-Transport-Security", "max-age=15552000");
  if (req.path === "/" || req.path === "/admin.html")
    res.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});

const small = express.json({ limit: "20kb" }), big = express.json({ limit: "2mb" });
app.use("/api/icon", big);
app.use("/api", small);

const base = req => (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => { console.error("erro:", e.message); res.status(500).json({ error: "Erro interno." }); });
const SITE_ID = /^site_[a-f0-9]{12}$/;

/* ---------- CORS: só origens de sites ATIVOS no cadastro. Painel/admin nunca recebe cabeçalhos CORS. ---------- */
const publicCors = wrap(async (req, res, next) => {
  const o = V.normOrigin(req.get("origin") || "");
  if (o && (await store.allOrigins()).includes(o))
    res.set({ "Access-Control-Allow-Origin": o, "Vary": "Origin", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Max-Age": "600" });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/** Site da requisição = (siteId informado OU origem única) E origem do navegador cadastrada para ele. */
async function resolveSite(req) {
  const origin = V.normOrigin(req.get("origin") || ""); if (!origin) return null;
  const id = (req.body || {}).siteId;
  if (id !== undefined) {
    if (typeof id !== "string" || !SITE_ID.test(id)) return null;
    const s = await store.getSite(id);
    return s && s.active && s.origins.includes(origin) ? s : null;
  }
  const c = await store.findActiveSitesByOrigin(origin);   // compatibilidade com clientes antigos (sem siteId)
  return c.length === 1 ? c[0] : null;
}

/* ---------- públicas: usadas pelos sites e apps ---------- */
const subLimit = limiter({ max: 30, windowMs: 10 * 60e3 });
app.options(["/api/public-key", "/api/subscribe", "/api/unsubscribe"], publicCors);
app.get("/api/public-key", publicCors, (q, r) => r.json({ key: vapid.publicKey }));

app.post("/api/subscribe", publicCors, subLimit, wrap(async (req, res) => {
  const site = await resolveSite(req);
  if (!site) return res.status(403).json({ error: "Site não autorizado." });
  const err = V.validSubscription(req.body); if (err) return res.status(400).json({ error: err });
  if (await store.countActiveSubscriptions() >= MAX_SUBS) return res.status(503).json({ error: "Limite atingido." });
  const s = req.body;
  await store.upsertSubscription({ siteId: site.id, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, device: V.deviceLabel(req.get("user-agent") || "") });
  res.status(201).json({ ok: true });
}));

app.post("/api/unsubscribe", publicCors, subLimit, wrap(async (req, res) => {
  const site = await resolveSite(req);
  if (!site) return res.status(403).json({ error: "Site não autorizado." });
  const e = (req.body || {}).endpoint;
  if (typeof e === "string" && e.length <= 1000) await store.removeSubscriptionByEndpoint(site.id, e);
  res.json({ ok: true });
}));

/* ---------- link rastreável: o clique só é contado AQUI, nunca no recebimento ---------- */
app.get("/r/:token", limiter({ max: 300, windowMs: 60e3 }), wrap(async (req, res) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(req.params.token)) return res.status(404).type("text").send("Link inválido.");
  if (req.method === "HEAD") return res.sendStatus(204);   // pré-visualizadores de link não contam como clique
  const r = await store.recordClick(req.params.token);
  const u = r && V.parseTargetUrl(r.url);                  // o destino vem SEMPRE do banco: não existe redirecionamento aberto
  if (!u) return res.status(404).type("text").send("Link inválido ou expirado.");
  res.redirect(302, u.href);
}));

/* ---------- autenticação do painel ---------- */
const guard = loginGuard({ max: 5, windowMs: 15 * 60e3 });
const hash256 = x => crypto.createHash("sha256").update(String(x)).digest();
const passOk = p => crypto.timingSafeEqual(hash256(p), hash256(ADMIN_PASSWORD));
const SESSION_MS = 12 * 3600e3;

app.post("/api/login", wrap(async (req, res) => {
  const wait = guard.blocked(req.ip);
  if (wait) { res.set("Retry-After", String(wait)); return res.status(429).json({ error: `Muitas tentativas. Aguarde ${Math.ceil(wait / 60)} minuto(s).` }); }
  const p = (req.body || {}).password;
  if (typeof p !== "string" || p.length > 200 || !passOk(p)) {
    guard.fail(req.ip); await new Promise(r => setTimeout(r, 500));   // atraso fixo dificulta força bruta
    return res.status(401).json({ error: "Senha incorreta." });
  }
  guard.ok(req.ip);
  const token = crypto.randomBytes(32).toString("base64url");
  await store.createSession(sha(token), new Date(Date.now() + SESSION_MS).toISOString());
  res.json({ token });
}));

const auth = wrap(async (req, res, next) => {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.get("authorization") || "");
  if (m && await store.validSession(sha(m[1]))) { req.sessionHash = sha(m[1]); return next(); }
  res.status(401).json({ error: "Não autorizado." });
});
const adminLimit = limiter({ max: 600, windowMs: 60e3 });
app.post("/api/logout", auth, wrap(async (req, res) => { await store.deleteSession(req.sessionHash); res.json({ ok: true }); }));

/* ---------- admin: sites ---------- */
const siteName = n => V.clean(n, 60);
app.get("/api/sites", adminLimit, auth, wrap(async (q, r) => r.json(await store.listSites())));

app.post("/api/sites", adminLimit, auth, wrap(async (req, res) => {
  const b = req.body || {}, name = siteName(b.name), origins = V.parseOrigins(b.origins);
  if (!name) return res.status(400).json({ error: "Informe o nome do site." });
  if (!origins) return res.status(400).json({ error: "Informe de 1 a 10 origens válidas (ex.: https://meusite.com). Só https é aceito." });
  res.status(201).json(await store.createSite({ name, origins, allowExternalLinks: b.allowExternalLinks === true }));
}));

app.patch("/api/sites/:id", adminLimit, auth, wrap(async (req, res) => {
  if (!SITE_ID.test(req.params.id) || !await store.getSite(req.params.id)) return res.status(404).json({ error: "Site não encontrado." });
  const b = req.body || {}, p = {};
  if (b.name !== undefined) { p.name = siteName(b.name); if (!p.name) return res.status(400).json({ error: "Nome inválido." }); }
  if (b.origins !== undefined) { p.origins = V.parseOrigins(b.origins); if (!p.origins) return res.status(400).json({ error: "Origens inválidas." }); }
  if (b.active !== undefined) p.active = b.active === true;
  if (b.allowExternalLinks !== undefined) p.allowExternalLinks = b.allowExternalLinks === true;
  res.json(await store.updateSite(req.params.id, p));
}));

/* ---------- admin: estatísticas, histórico, detalhes ---------- */
const siteFilter = q => (typeof q.site === "string" && SITE_ID.test(q.site)) ? q.site : undefined;
const page = q => ({ limit: Math.min(Math.max(parseInt(q.limit) || 50, 1), 200), offset: Math.max(parseInt(q.offset) || 0, 0) });
const outN = n => n && ({
  id: n.id, siteId: n.site_id, siteName: n.site_name, title: n.title, message: n.message, url: n.url, icon: n.icon, status: n.status,
  scheduledAt: n.scheduled_at, createdAt: n.created_at, startedAt: n.started_at, finishedAt: n.finished_at, error: n.error,
  targeted: n.targeted, delivered: n.delivered, failed: n.failed, clicks: n.clicks, uniqueClicks: n.unique_clicks,
  ctr: n.delivered ? n.unique_clicks / n.delivered : 0
});

app.get("/api/stats", adminLimit, auth, wrap(async (q, r) => r.json(await store.stats(siteFilter(q.query)))));
app.get("/api/notifications", adminLimit, auth, wrap(async (q, r) => {
  const x = await store.listNotifications({ siteId: siteFilter(q.query), ...page(q.query) });
  r.json({ total: x.total, items: x.rows.map(outN) });
}));
app.get("/api/notifications/:id", adminLimit, auth, wrap(async (req, res) => {
  if (!/^[a-f0-9]{16}$/.test(req.params.id)) return res.status(404).json({ error: "Não encontrada." });
  const n = await store.getNotification(req.params.id); if (!n) return res.status(404).json({ error: "Não encontrada." });
  res.json({ ...outN(n), clickDetail: await store.clickDetail(n.id) });
}));
app.post("/api/notifications/:id/cancel", adminLimit, auth, wrap(async (req, res) => {
  if (!/^[a-f0-9]{16}$/.test(req.params.id)) return res.status(404).json({ error: "Não encontrada." });
  if (!await store.cancelNotification(req.params.id)) return res.status(409).json({ error: "Só é possível cancelar envios ainda agendados." });
  res.json({ ok: true });
}));

/* ---------- admin: inscritos ---------- */
app.get("/api/subscribers", adminLimit, auth, wrap(async (q, r) => {
  const st = ["active", "expired"].includes(q.query.status) ? q.query.status : undefined;
  r.json(await store.listSubscribers({ siteId: siteFilter(q.query), status: st, ...page(q.query) }));
}));
app.delete("/api/subscribers/:id", adminLimit, auth, wrap(async (req, res) => {
  if (!/^[a-f0-9]{16}$/.test(req.params.id) || !await store.deleteSubscriber(req.params.id)) return res.status(404).json({ error: "Inscrição não encontrada." });
  res.json({ ok: true });
}));

/* ---------- admin: ícone e envio ---------- */
app.post("/api/icon", adminLimit, auth, wrap(async (req, res) => {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec((req.body || {}).data || "");
  if (!m || m[2].length > 1.45e6) return res.status(400).json({ error: "Envie uma imagem PNG, JPG ou WEBP de até 1 MB." });
  const buf = Buffer.from(m[2], "base64"), ext = V.imageType(buf);
  if (!ext || buf.length > 1024 * 1024) return res.status(400).json({ error: "Arquivo não é uma imagem válida de até 1 MB." });
  const name = crypto.randomBytes(8).toString("hex") + "." + ext;
  fs.writeFileSync(path.join(UP, name), buf, { mode: 0o600 });
  res.json({ url: base(req) + "/uploads/" + name });
}));

function validIcon(icon, b) {
  if (!icon) return null;
  try {
    const u = new URL(icon);
    if (u.origin === new URL(b).origin && /^\/uploads\/[a-f0-9]{16}\.(png|jpg|webp)$/.test(u.pathname) && fs.existsSync(path.join(UP, path.basename(u.pathname)))) return u.href;
  } catch {}
  return undefined;
}

app.post("/api/send", adminLimit, auth, wrap(async (req, res) => {
  const b = req.body || {};
  const site = typeof b.siteId === "string" && SITE_ID.test(b.siteId) ? await store.getSite(b.siteId) : null;
  if (!site) return res.status(400).json({ error: "Selecione o site de destino." });
  if (!site.active) return res.status(400).json({ error: "Este site está desativado." });
  const title = V.clean(b.title, 50), message = V.clean(b.message, 140);
  if (!title || !message) return res.status(400).json({ error: "Preencha título e mensagem." });
  const u = V.parseTargetUrl(b.url);
  if (!u) return res.status(400).json({ error: "Informe um link de destino válido (http/https)." });
  if (!site.allowExternalLinks && !V.urlBelongsToSite(u, site.origins))
    return res.status(400).json({ error: "O link precisa ser do próprio site selecionado. Para links externos, habilite essa opção no cadastro do site." });
  const baseUrl = base(req), icon = validIcon(b.icon, baseUrl);
  if (icon === undefined) return res.status(400).json({ error: "Ícone inválido. Envie a imagem pelo painel." });

  let scheduledAt = null;
  if (b.scheduledAt) {
    const t = Date.parse(b.scheduledAt);
    if (isNaN(t)) return res.status(400).json({ error: "Data de agendamento inválida." });
    if (t < Date.now() + 60e3) return res.status(400).json({ error: "O agendamento precisa ser pelo menos 1 minuto no futuro." });
    if (t > Date.now() + 365 * 864e5) return res.status(400).json({ error: "O agendamento pode ser de até 1 ano." });
    scheduledAt = new Date(t).toISOString();
  }
  const probe = JSON.stringify({ title, message, url: baseUrl + "/r/" + "x".repeat(22), icon });
  if (Buffer.byteLength(probe) > 3500) return res.status(400).json({ error: "Conteúdo grande demais." });

  const id = await store.createNotification({ siteId: site.id, title, message, url: u.href, icon, baseUrl, scheduledAt });
  if (!scheduledAt) await Promise.race([dispatcher.run(id), new Promise(r => setTimeout(r, 20000))]);   // envios muito grandes continuam em segundo plano
  res.status(scheduledAt ? 201 : 200).json(outN(await store.getNotification(id)));
}));

/* ---------- arquivos ---------- */
app.get("/favicon.ico", (q, r) => r.sendStatus(204));
app.use("/uploads", (q, r, n) => { r.set({ "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" }); n(); },
  express.static(UP, { maxAge: "7d", dotfiles: "deny", index: false }));
app.get("/", (q, r) => r.redirect("/admin.html"));
app.use(express.static(path.join(__dirname, "public"), { dotfiles: "deny" }));
app.use((err, q, res, n) => res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? "Conteúdo grande demais." : "Requisição inválida." }));

const server = app.listen(PORT, () => console.log("Painel: http://localhost:" + PORT));
const bye = () => { dispatcher.stop(); server.close(() => { store.close().then(() => process.exit(0)); }); setTimeout(() => process.exit(0), 8000).unref(); };
process.on("SIGTERM", bye); process.on("SIGINT", bye);
