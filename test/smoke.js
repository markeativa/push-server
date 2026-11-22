/* Teste de ponta a ponta. Sobe o servidor com PUSH_DRY_RUN=1 (nenhum push real é enviado). Uso: npm test */
const { spawn } = require("child_process"), fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto"), http = require("http");
const Database = require("better-sqlite3");
const PORT = 3999, BASE = "http://localhost:" + PORT, PW = "senha-de-teste-123";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-test-"));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  ✔ " : "  ✘ ") + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// fetch com Origin customizado (módulo http: o fetch do navegador não deixaria)
const req = (method, p, { body, headers = {}, token } = {}) => new Promise((res, rej) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request(BASE + p, { method, headers: { ...(data ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: "Bearer " + token } : {}), ...headers } }, x => {
    let b = ""; x.on("data", c => b += c); x.on("end", () => { let j; try { j = JSON.parse(b); } catch {} res({ status: x.statusCode, json: j, headers: x.headers, text: b }); });
  }); r.on("error", rej); if (data) r.write(data); r.end();
});
const sub = (host, extra = "") => { const e = crypto.createECDH("prime256v1"); e.generateKeys();
  return { endpoint: "https://fcm.googleapis.com/fcm/send/" + crypto.randomBytes(8).toString("hex") + extra, keys: { p256dh: e.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } }; };

// db.json no formato ANTIGO, para testar a migração
const legacySub = sub();
fs.writeFileSync(path.join(dir, "db.json"), JSON.stringify({ subs: [{ ...legacySub, at: "2026-01-01T00:00:00.000Z", site: "https://antigo.example" }], history: [{ id: 1, title: "Velha", message: "m", url: "https://antigo.example/x", at: "2026-01-02T00:00:00.000Z", recipients: 3, failed: 1 }] }));

const srv = spawn("node", ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT, ADMIN_PASSWORD: PW, DATA_DIR: dir, BASE_URL: BASE, PUSH_DRY_RUN: "1", SCHEDULER_TICK_MS: "500", TRUST_PROXY: "0" }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", d => log += d); srv.stderr.on("data", d => log += d);

(async () => {
  for (let i = 0; i < 50; i++) { try { await req("GET", "/api/public-key"); break; } catch { await sleep(100); } }
  const A = "https://a.example", B = "https://b.example";

  console.log("Autenticação e proteção do admin");
  for (const [m, p] of [["GET", "/api/stats"], ["GET", "/api/sites"], ["GET", "/api/subscribers"], ["POST", "/api/send"], ["GET", "/api/notifications"], ["DELETE", "/api/subscribers/aaaaaaaaaaaaaaaa"]])
    ok((await req(m, p, { body: m === "POST" ? {} : undefined })).status === 401, `${m} ${p} sem token → 401`);
  ok((await req("GET", "/api/stats", { token: "x".repeat(43) })).status === 401, "token inventado → 401");
  const login = await req("POST", "/api/login", { body: { password: PW } });
  const T = login.json && login.json.token; ok(login.status === 200 && T, "login correto");

  console.log("Migração do formato antigo");
  let sites = (await req("GET", "/api/sites", { token: T })).json;
  ok(sites.length === 1 && sites[0].origins[0] === "https://antigo.example" && sites[0].subscribers === 1, "db.json virou site + inscrição");
  ok(fs.existsSync(path.join(dir, "db.json.imported")) && !fs.existsSync(path.join(dir, "db.json")), "db.json original preservado como backup");
  let hist = (await req("GET", "/api/notifications", { token: T })).json;
  ok(hist.items.length === 1 && hist.items[0].delivered === 3 && hist.items[0].failed === 1, "histórico antigo preservado");

  console.log("Cadastro de sites");
  ok((await req("POST", "/api/sites", { token: T, body: { name: "X", origins: ["http://exemplo.com"] } })).status === 400, "origem http (não-localhost) rejeitada");
  ok((await req("POST", "/api/sites", { token: T, body: { name: "X", origins: ["javascript:alert(1)"] } })).status === 400, "origem inválida rejeitada");
  const sa = (await req("POST", "/api/sites", { token: T, body: { name: "Site A", origins: [A] } })).json;
  const sb = (await req("POST", "/api/sites", { token: T, body: { name: "Site B", origins: [B] } })).json;
  ok(/^site_[a-f0-9]{12}$/.test(sa.id) && sa.id !== sb.id, "cada site tem identificação própria");

  console.log("Inscrição: validação e controle de origem");
  const a1 = sub(), a2 = sub(), a3 = sub(null, "/gone"), b1 = sub();
  const S = (s, origin, siteId) => req("POST", "/api/subscribe", { body: { ...s, ...(siteId ? { siteId } : {}) }, headers: origin ? { Origin: origin } : {} });
  ok((await S(a1, A, sa.id)).status === 201, "A com origem de A → 201");
  ok((await S(a2, A)).status === 201, "A sem siteId (cliente antigo), origem única → 201");
  ok((await S(a3, A, sa.id)).status === 201 && (await S(b1, B, sb.id)).status === 201, "demais inscrições");
  ok((await S(sub(), "https://evil.example", sa.id)).status === 403, "origem não cadastrada → 403");
  ok((await S(sub(), B, sa.id)).status === 403, "siteId de A com origem de B → 403");
  ok((await S(sub(), null, sa.id)).status === 403, "sem cabeçalho Origin → 403");
  ok((await S(sub(), A, "site_000000000000")).status === 403, "siteId inexistente → 403");
  ok((await S({ endpoint: "https://evil.example/x", keys: a1.keys }, A, sa.id)).status === 400, "endpoint fora dos serviços de push → 400 (anti-SSRF)");
  ok((await S({ endpoint: "http://fcm.googleapis.com/x", keys: a1.keys }, A, sa.id)).status === 400, "endpoint http → 400");
  ok((await S({ ...sub(), keys: { p256dh: "abc", auth: "def" } }, A, sa.id)).status === 400, "chaves inválidas → 400");
  await req("PATCH", "/api/sites/" + sb.id, { token: T, body: { active: false } });
  ok((await S(sub(), B, sb.id)).status === 403, "site desativado não aceita inscrição");
  await req("PATCH", "/api/sites/" + sb.id, { token: T, body: { active: true } });

  console.log("CORS");
  const pre = await req("OPTIONS", "/api/subscribe", { headers: { Origin: A } });
  ok(pre.status === 204 && pre.headers["access-control-allow-origin"] === A, "origem cadastrada recebe CORS específico (não *)");
  ok(!(await req("OPTIONS", "/api/subscribe", { headers: { Origin: "https://evil.example" } })).headers["access-control-allow-origin"], "origem desconhecida não recebe CORS");
  ok(!(await req("GET", "/api/stats", { token: T, headers: { Origin: A } })).headers["access-control-allow-origin"], "endpoints admin nunca têm CORS");

  console.log("Isolamento entre sites + validação do envio");
  const send = (b) => req("POST", "/api/send", { token: T, body: b });
  const base = { siteId: sa.id, title: "Oi A", message: "msg", url: "https://a.example/oferta" };
  ok((await send({ ...base, siteId: undefined })).status === 400, "envio sem site → 400");
  ok((await send({ ...base, url: "javascript:alert(1)" })).status === 400, "link javascript: → 400");
  ok((await send({ ...base, url: "ftp://a.example/x" })).status === 400, "link ftp: → 400");
  ok((await send({ ...base, url: "https://evil.example/x" })).status === 400, "link fora do site → 400");
  ok((await send({ ...base, icon: "https://evil.example/uploads/aaaaaaaaaaaaaaaa.png" })).status === 400, "ícone externo → 400");
  const r1 = await send(base);
  ok(r1.status === 200 && r1.json.status === "sent", "envio para A concluído");
  ok(r1.json.delivered === 2 && r1.json.targeted === 3, "A: 3 destinatários (1 expirado = 410), 2 entregues");
  const sbN = (await req("GET", "/api/notifications?site=" + sb.id, { token: T })).json;
  ok(sbN.total === 0, "B não tem nenhuma notificação de A");
  const dbr = new Database(path.join(dir, "push.db"), { readonly: true });
  const tgt = dbr.prepare("SELECT COUNT(*) c FROM deliveries d JOIN subscriptions s ON s.id=d.subscription_id WHERE d.notification_id=? AND s.site_id!=?").get(r1.json.id, sa.id).c;
  ok(tgt === 0, "nenhuma entrega da notificação de A aponta para inscrito de outro site");
  const r1c = dbr.prepare("SELECT COUNT(*) c FROM deliveries WHERE notification_id=?").get(r1.json.id).c;
  ok(r1c === 3, "uma entrega por inscrito (sem duplicidade)");
  const subsA = (await req("GET", "/api/subscribers?site=" + sa.id, { token: T })).json;
  ok(subsA.rows.some(s => s.status === "expired"), "inscrição 410 marcada como expirada");

  console.log("Rastreamento de cliques");
  let st = (await req("GET", "/api/stats?site=" + sa.id, { token: T })).json;
  ok(st.clicks === 0 && st.sent === 1, "receber não conta como clique (0 cliques)");
  const tk = dbr.prepare("SELECT token FROM deliveries WHERE notification_id=? AND status='sent' ORDER BY id").all(r1.json.id).map(r => r.token);
  const go = t => new Promise(res => http.get(BASE + "/r/" + t, x => { x.resume(); res(x); }));
  let x = await go(tk[0]);
  ok(x.statusCode === 302 && x.headers.location === "https://a.example/oferta", "clique redireciona (302) ao destino original");
  await new Promise(res => http.request(BASE + "/r/" + tk[0], { method: "HEAD" }, y => { y.resume(); res(); }).end());
  await go(tk[0]);                                   // duplo toque em < 3 s: ignorado
  let d = (await req("GET", "/api/notifications/" + r1.json.id, { token: T })).json;
  ok(d.clicks === 1, "HEAD e duplo-toque em <3 s não inflam o contador");
  await sleep(3200); await go(tk[0]); await go(tk[1]);
  d = (await req("GET", "/api/notifications/" + r1.json.id, { token: T })).json;
  ok(d.clicks === 3 && d.uniqueClicks === 2 && Math.abs(d.ctr - 1) < 1e-9, "total 3, únicos 2, taxa 100% (2/2 entregues)");
  ok(d.clickDetail.recent.length === 3 && /^\d{4}-\d\d-\d\dT/.test(d.clickDetail.recent[0]), "data e horário de cada clique registrados");
  ok((await go("naoexiste1234567890")).statusCode === 404 && (await go("../../etc/passwd")).statusCode === 404, "token inválido → 404 (sem redirecionamento aberto)");
  ok(!JSON.stringify(d).includes(tk[0]), "tokens dos links não vazam na API do painel");

  console.log("Agendamento");
  ok((await send({ ...base, scheduledAt: new Date(Date.now() + 5000).toISOString() })).status === 400, "agendar < 1 min → 400");
  const when = new Date(Date.now() + 90e3).toISOString();
  const sch = await send({ ...base, title: "Agendada", scheduledAt: when });
  ok(sch.status === 201 && sch.json.status === "scheduled" && sch.json.delivered === 0, "fica 'agendada' sem enviar");
  const cx = await send({ ...base, title: "Cancelar", scheduledAt: when });
  ok((await req("POST", "/api/notifications/" + cx.json.id + "/cancel", { token: T, body: {} })).status === 200 && (await req("POST", "/api/notifications/" + cx.json.id + "/cancel", { token: T, body: {} })).status === 409, "cancelar agendada: 1ª vez ok, 2ª → 409");
  // adianta o horário direto no banco para não esperar 90 s
  const w = new Database(path.join(dir, "push.db")); w.pragma("busy_timeout=5000");
  w.prepare("UPDATE notifications SET scheduled_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), sch.json.id);
  w.prepare("UPDATE notifications SET scheduled_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), cx.json.id);
  await sleep(2500);
  const s2 = (await req("GET", "/api/notifications/" + sch.json.id, { token: T })).json, c2 = (await req("GET", "/api/notifications/" + cx.json.id, { token: T })).json;
  ok(s2.status === "sent" && s2.delivered >= 1, "agendada saiu sozinha no horário");
  ok(c2.status === "canceled" && c2.targeted === 0, "cancelada nunca é enviada");
  await sleep(1500);
  ok(dbr.prepare("SELECT COUNT(*) c FROM (SELECT subscription_id FROM deliveries WHERE notification_id=? GROUP BY subscription_id HAVING COUNT(*)>1)").get(sch.json.id).c === 0, "nenhum inscrito recebeu a agendada duas vezes");
  // recuperação após queda: notificação 'sending' com entregas pendentes é retomada, e só as pendentes
  const rid = "feedfacefeedface", t0 = new Date().toISOString();
  w.prepare("INSERT INTO notifications(id,site_id,title,message,url,icon,base_url,status,scheduled_at,created_at,started_at) VALUES(?,?,?,?,?,NULL,?, 'sending',?,?,?)").run(rid, sa.id, "Retomar", "m", "https://a.example/z", BASE, t0, t0, t0);
  const ids = w.prepare("SELECT id FROM subscriptions WHERE site_id=? AND status='active'").all(sa.id);
  ids.forEach((s, i) => w.prepare("INSERT INTO deliveries(token,notification_id,subscription_id,status,sent_at) VALUES(?,?,?,?,?)").run(crypto.randomBytes(16).toString("base64url"), rid, s.id, i === 0 ? "sent" : "pending", i === 0 ? t0 : null));
  await sleep(2000);
  const rr = (await req("GET", "/api/notifications/" + rid, { token: T })).json;
  ok(rr.status === "sent" && rr.delivered === ids.length, "envio interrompido é retomado e concluído sem reenviar os já enviados");
  w.close();

  console.log("Gerenciamento de inscritos");
  const L = (await req("GET", "/api/subscribers", { token: T })).json;
  const keys = Object.keys(L.rows[0]).sort().join(",");
  ok(keys === "createdAt,device,id,siteId,siteName,status", "lista traz só: site, data, dispositivo, situação (sem endpoint/chaves)");
  ok(!JSON.stringify(L).includes("fcm.googleapis") && !JSON.stringify(L).includes(a1.keys.auth), "nenhum endpoint/chave no JSON");
  const victim = subsA.rows[0].id;
  ok((await req("DELETE", "/api/subscribers/" + victim, { token: T })).status === 200 && (await req("DELETE", "/api/subscribers/" + victim, { token: T })).status === 404, "remover inscrição (e 404 na repetição)");

  console.log("Segredos e cabeçalhos");
  const everything = JSON.stringify([(await req("GET", "/api/sites", { token: T })).json, (await req("GET", "/api/public-key")).json, (await req("GET", "/admin.html")).text]);
  const vapid = JSON.parse(fs.readFileSync(path.join(dir, "vapid.json"), "utf8"));
  ok(!everything.includes(vapid.privateKey), "chave privada VAPID não aparece em nenhuma resposta");
  ok((fs.statSync(path.join(dir, "vapid.json")).mode & 0o777) === 0o600, "vapid.json com permissão 0600");
  const ah = await req("GET", "/admin.html");
  ok(/script-src 'self'/.test(ah.headers["content-security-policy"]) && !/<script>|style=/.test(ah.text), "CSP restritiva e nenhum script/estilo inline");

  console.log("Limite de tentativas de login");
  let last; for (let i = 0; i < 6; i++) last = await req("POST", "/api/login", { body: { password: "errada" + i } });
  ok(last.status === 429, "bloqueio após 5 falhas");
  ok((await req("POST", "/api/login", { body: { password: PW } })).status === 429, "mesmo a senha certa fica bloqueada durante o período");

  console.log("Persistência");
  srv.kill("SIGTERM"); await sleep(800);
  const srv2 = spawn("node", ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT, ADMIN_PASSWORD: PW, DATA_DIR: dir, BASE_URL: BASE, PUSH_DRY_RUN: "1", TRUST_PROXY: "0" }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await req("GET", "/api/public-key"); break; } catch { await sleep(100); } }
  const T2 = (await req("POST", "/api/login", { body: { password: PW } })).json.token;
  const st2 = (await req("GET", "/api/stats", { token: T2 })).json, k2 = (await req("GET", "/api/public-key")).json.key;
  ok(st2.subscribers >= 4 && st2.sent >= 3 && st2.clicks === 3, "inscrições, histórico e cliques sobrevivem ao reinício");
  ok(k2 === vapid.publicKey, "chave VAPID preservada");
  srv2.kill("SIGTERM"); dbr.close();

  console.log(`\n${pass} ok, ${fail} falhas`); if (fail) console.log("--- log do servidor ---\n" + log);
  fs.rmSync(dir, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log(log); srv.kill(); process.exit(1); });
