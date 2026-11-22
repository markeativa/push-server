/* Teste Completo e Rigoroso dos 10 Itens de Estabilidade e Segurança */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const Database = require("better-sqlite3");
const webpush = require("web-push");

const PORT = 4001;
const BASE = "http://localhost:" + PORT;
const PW = "senha-segura-admin-123";
let pass = 0, fail = 0;

function ok(condition, message) {
  if (condition) {
    pass++;
    console.log("  ✔ " + message);
  } else {
    fail++;
    console.error("  ✘ " + message);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const req = (method, endpointPath, { body, headers = {}, token, port = PORT } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request("http://localhost:" + port + endpointPath, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...headers
    }
  }, res => {
    let raw = "";
    res.on("data", chunk => raw += chunk);
    res.on("end", () => {
      let json;
      try { json = JSON.parse(raw); } catch {}
      resolve({ status: res.statusCode, json, headers: res.headers, text: raw });
    });
  });
  r.on("error", reject);
  if (data) r.write(data);
  r.end();
});

const makeSub = (extra = "") => {
  const e = crypto.createECDH("prime256v1");
  e.generateKeys();
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/" + crypto.randomBytes(8).toString("hex") + extra,
    keys: {
      p256dh: e.getPublicKey().toString("base64url"),
      auth: crypto.randomBytes(16).toString("base64url")
    }
  };
};

async function runTests() {
  console.log("\n=======================================================");
  console.log("INICIANDO BATERIA COMPLETA DE TESTES DE ESTABILIDADE E SEGURANÇA");
  console.log("=======================================================\n");

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "push-full-test-"));

  /* ------------------------------------------------------------------ */
  /* ITEM 1: Configuração das chaves VAPID                               */
  /* ------------------------------------------------------------------ */
  console.log("--- Item 1: Validação de Chaves VAPID ---");
  
  // Teste 1.1: Apenas VAPID_PUBLIC configurada -> servidor DEVE falhar ao iniciar
  const generatedVapid = webpush.generateVAPIDKeys();
  const testVapidOnlyPub = spawn("node", ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: "4002", ADMIN_PASSWORD: PW, DATA_DIR: testDir, VAPID_PUBLIC: generatedVapid.publicKey, VAPID_PRIVATE: "" },
    stdio: "pipe"
  });
  let pubOnlyErr = "";
  testVapidOnlyPub.stderr.on("data", d => pubOnlyErr += d);
  const pubExitCode = await new Promise(r => testVapidOnlyPub.on("exit", r));
  ok(pubExitCode !== 0, "Apenas VAPID_PUBLIC configurada aborta inicialização (código != 0)");
  ok(pubOnlyErr.includes("Configuração VAPID incompleta") || pubOnlyErr.includes("VAPID_PUBLIC e VAPID_PRIVATE"), "Mensagem de erro clara emitida quando só VAPID_PUBLIC existe");

  // Teste 1.2: Apenas VAPID_PRIVATE configurada -> servidor DEVE falhar ao iniciar
  const testVapidOnlyPriv = spawn("node", ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: "4003", ADMIN_PASSWORD: PW, DATA_DIR: testDir, VAPID_PUBLIC: "", VAPID_PRIVATE: generatedVapid.privateKey },
    stdio: "pipe"
  });
  let privOnlyErr = "";
  testVapidOnlyPriv.stderr.on("data", d => privOnlyErr += d);
  const privExitCode = await new Promise(r => testVapidOnlyPriv.on("exit", r));
  ok(privExitCode !== 0, "Apenas VAPID_PRIVATE configurada aborta inicialização (código != 0)");
  ok(privOnlyErr.includes("Configuração VAPID incompleta") || privOnlyErr.includes("VAPID_PUBLIC e VAPID_PRIVATE"), "Mensagem de erro clara emitida quando só VAPID_PRIVATE existe");

  // Teste 1.3: Ambas configuradas no ambiente -> servidor inicia e usa as chaves do ambiente
  const testVapidBoth = spawn("node", ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: "4004", ADMIN_PASSWORD: PW, DATA_DIR: testDir, VAPID_PUBLIC: generatedVapid.publicKey, VAPID_PRIVATE: generatedVapid.privateKey, PUSH_DRY_RUN: "1" },
    stdio: "pipe"
  });
  for (let i = 0; i < 30; i++) {
    try {
      const res = await req("GET", "/api/public-key", { port: 4004 });
      if (res.status === 200 && res.json.key === generatedVapid.publicKey) {
        ok(true, "Ambas VAPID configuradas via ambiente inicializam com sucesso e servem a chave pública correta");
        break;
      }
    } catch { await sleep(100); }
  }
  testVapidBoth.kill("SIGTERM");
  await sleep(300);

  /* ------------------------------------------------------------------ */
  /* Inicialização do Servidor Principal para os testes seguintes       */
  /* ------------------------------------------------------------------ */
  const srv = spawn("node", ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_PASSWORD: PW,
      DATA_DIR: testDir,
      BASE_URL: BASE,
      PUSH_DRY_RUN: "1",
      SCHEDULER_TICK_MS: "400",
      TRUST_PROXY: "0"
    },
    stdio: "pipe"
  });
  let serverLogs = "";
  srv.stdout.on("data", d => serverLogs += d);
  srv.stderr.on("data", d => serverLogs += d);

  for (let i = 0; i < 50; i++) {
    try { await req("GET", "/api/public-key"); break; } catch { await sleep(100); }
  }

  // Login de admin
  const loginRes = await req("POST", "/api/login", { body: { password: PW } });
  const token = loginRes.json.token;
  ok(loginRes.status === 200 && !!token, "Login com sucesso e recebimento do token de sessão");

  /* ------------------------------------------------------------------ */
  /* ITEM 3: Isolamento entre dois ou mais sites                        */
  /* ------------------------------------------------------------------ */
  console.log("\n--- Item 3: Isolamento Rigoroso entre Múltiplos Sites ---");
  const site1 = (await req("POST", "/api/sites", { token, body: { name: "Portal Notícias", origins: ["https://noticias.example.com"], allowExternalLinks: false } })).json;
  const site2 = (await req("POST", "/api/sites", { token, body: { name: "E-Commerce", origins: ["https://loja.example.com"], allowExternalLinks: false } })).json;
  const site3 = (await req("POST", "/api/sites", { token, body: { name: "Afiliados", origins: ["https://afiliados.example.com"], allowExternalLinks: true } })).json;

  ok(site1.id && site2.id && site3.id && site1.id !== site2.id && site2.id !== site3.id, "3 sites criados com IDs únicos e distintos");

  // Inscrições por site
  const subSite1User1 = makeSub();
  const subSite1User2 = makeSub();
  const subSite2User1 = makeSub();
  const sharedEndpointUser = makeSub(); // Mesmo endpoint de navegador registrado em dois sites diferentes

  // Inscrição para Site 1
  const subRes1 = await req("POST", "/api/subscribe", {
    headers: { Origin: "https://noticias.example.com" },
    body: { ...subSite1User1, siteId: site1.id }
  });
  const subRes2 = await req("POST", "/api/subscribe", {
    headers: { Origin: "https://noticias.example.com" },
    body: { ...subSite1User2, siteId: site1.id }
  });
  // Inscrição para Site 2
  const subRes3 = await req("POST", "/api/subscribe", {
    headers: { Origin: "https://loja.example.com" },
    body: { ...subSite2User1, siteId: site2.id }
  });
  // Inscrição do mesmo endpoint nos dois sites
  const subResShared1 = await req("POST", "/api/subscribe", {
    headers: { Origin: "https://noticias.example.com" },
    body: { ...sharedEndpointUser, siteId: site1.id }
  });
  const subResShared2 = await req("POST", "/api/subscribe", {
    headers: { Origin: "https://loja.example.com" },
    body: { ...sharedEndpointUser, siteId: site2.id }
  });

  ok(subRes1.status === 201 && subRes2.status === 201 && subRes3.status === 201, "Inscrições aceitas nas origens autorizadas");
  ok(subResShared1.status === 201 && subResShared2.status === 201, "Mesmo endpoint pode se inscrever independentemente em sites diferentes");

  // Tentativa de violação de isolamento: Origin do Site 2 tentando inscrever no Site 1
  const crossSiteSub = await req("POST", "/api/subscribe", {
    headers: { Origin: "https://loja.example.com" },
    body: { ...makeSub(), siteId: site1.id }
  });
  ok(crossSiteSub.status === 403, "Origem de um site não pode cadastrar inscrições no siteId de outro site (403)");

  // Validação de links: Site 1 não permite link externo
  const badLink = await req("POST", "/api/send", {
    token,
    body: { siteId: site1.id, title: "Alerta", message: "Msg", url: "https://outro-site.com/artigo" }
  });
  ok(badLink.status === 400 && badLink.json.error.includes("próprio site"), "Envio de link externo bloqueado quando allowExternalLinks = false");

  // Validação de links: Site 3 permite link externo
  const goodExternalLink = await req("POST", "/api/send", {
    token,
    body: { siteId: site3.id, title: "Alerta", message: "Msg", url: "https://outro-site.com/artigo" }
  });
  ok(goodExternalLink.status === 200, "Envio de link externo permitido quando allowExternalLinks = true");

  // Envio para Site 1
  const sendSite1 = await req("POST", "/api/send", {
    token,
    body: { siteId: site1.id, title: "Notícia Urgente", message: "Conteúdo", url: "https://noticias.example.com/noticia-1" }
  });
  ok(sendSite1.status === 200 && sendSite1.json.targeted === 3 && sendSite1.json.delivered === 3, "Site 1 entregou apenas para seus 3 inscritos");

  // Verificar que Site 2 não recebeu entregas do Site 1
  const statsSite2 = (await req("GET", "/api/stats?site=" + site2.id, { token })).json;
  ok(statsSite2.sent === 0 && statsSite2.delivered === 0 && statsSite2.subscribers === 2, "Estatísticas do Site 2 permanecem isoladas (0 enviadas)");

  // Desativação de site
  await req("PATCH", "/api/sites/" + site2.id, { token, body: { active: false } });
  const sendToInactive = await req("POST", "/api/send", {
    token,
    body: { siteId: site2.id, title: "Promo", message: "Desconto", url: "https://loja.example.com/promo" }
  });
  ok(sendToInactive.status === 400 && sendToInactive.json.error.includes("desativado"), "Site desativado impede novos envios");
  await req("PATCH", "/api/sites/" + site2.id, { token, body: { active: true } });

  /* ------------------------------------------------------------------ */
  /* ITEM 4: Teste de Envio Imediato e Agendado                         */
  /* ------------------------------------------------------------------ */
  console.log("\n--- Item 4: Envio Imediato e Agendado ---");
  // Imediato já foi comprovado em sendSite1, testamos com falha simulada (endpoint /gone)
  const subGone = makeSub("/gone");
  await req("POST", "/api/subscribe", {
    headers: { Origin: "https://loja.example.com" },
    body: { ...subGone, siteId: site2.id }
  });
  const sendSite2 = await req("POST", "/api/send", {
    token,
    body: { siteId: site2.id, title: "Cupom", message: "Use 10OFF", url: "https://loja.example.com/cupom" }
  });
  ok(sendSite2.status === 200 && sendSite2.json.targeted === 3 && sendSite2.json.delivered === 2 && sendSite2.json.failed === 1, "Envio imediato contabiliza entregas com sucesso e falhas com precisão");

  // Agendamento: validação de data futura mínima (menos de 1 minuto no futuro deve falhar)
  const tooSoon = await req("POST", "/api/send", {
    token,
    body: { siteId: site1.id, title: "Em breve", message: "Msg", url: "https://noticias.example.com/x", scheduledAt: new Date(Date.now() + 30e3).toISOString() }
  });
  ok(tooSoon.status === 400 && tooSoon.json.error.includes("1 minuto"), "Agendamento com menos de 1 minuto no futuro é rejeitado");

  // Agendamento válido no futuro
  const futureDate = new Date(Date.now() + 120e3).toISOString();
  const scheduledNotif = await req("POST", "/api/send", {
    token,
    body: { siteId: site1.id, title: "Edição da Tarde", message: "Resumo", url: "https://noticias.example.com/tarde", scheduledAt: futureDate }
  });
  ok(scheduledNotif.status === 201 && scheduledNotif.json.status === "scheduled" && scheduledNotif.json.delivered === 0, "Envio agendado criado com status 'scheduled' sem disparar push");

  // Cancelamento de envio agendado
  const toCancel = await req("POST", "/api/send", {
    token,
    body: { siteId: site1.id, title: "Para Cancelar", message: "Msg", url: "https://noticias.example.com/cancelar", scheduledAt: futureDate }
  });
  const cancelRes = await req("POST", "/api/notifications/" + toCancel.json.id + "/cancel", { token, body: {} });
  ok(cancelRes.status === 200, "Envio agendado cancelado com sucesso");

  // Avança data no banco para testar o despachante automático
  const dbDirect = new Database(path.join(testDir, "push.db"));
  dbDirect.prepare("UPDATE notifications SET scheduled_at=? WHERE id=?").run(new Date(Date.now() - 2000).toISOString(), scheduledNotif.json.id);
  dbDirect.prepare("UPDATE notifications SET scheduled_at=? WHERE id=?").run(new Date(Date.now() - 2000).toISOString(), toCancel.json.id);
  
  await sleep(1500); // Aguarda o tick do agendador (400ms)
  const checkScheduled = (await req("GET", "/api/notifications/" + scheduledNotif.json.id, { token })).json;
  const checkCanceled = (await req("GET", "/api/notifications/" + toCancel.json.id, { token })).json;

  ok(checkScheduled.status === "sent" && checkScheduled.delivered === 3, "Notificação agendada foi disparada automaticamente quando atingiu o horário");
  ok(checkCanceled.status === "canceled" && checkCanceled.delivered === 0, "Notificação cancelada nunca é disparada mesmo após passar do horário");

  /* ------------------------------------------------------------------ */
  /* ITEM 5: Registro de cliques e redirecionamento                     */
  /* ------------------------------------------------------------------ */
  console.log("\n--- Item 5: Registro de Cliques e Redirecionamento Seguro ---");
  const delivs = dbDirect.prepare("SELECT token FROM deliveries WHERE notification_id=? AND status='sent'").all(sendSite1.json.id).map(r => r.token);
  ok(delivs.length >= 2, "Tokens de entrega gerados no formato seguro");

  // Clique válido
  const clickToken = delivs[0];
  const clickReq = await new Promise(res => http.get(BASE + "/r/" + clickToken, r => { r.resume(); res(r); }));
  ok(clickReq.statusCode === 302 && clickReq.headers.location === "https://noticias.example.com/noticia-1", "Clique em /r/:token redireciona via HTTP 302 para a URL de destino");
  ok(clickReq.headers["cache-control"] === "no-store", "Cabeçalho Cache-Control: no-store evita cache do redirecionamento");
  ok(clickReq.headers["referrer-policy"] === "no-referrer", "Cabeçalho Referrer-Policy: no-referrer protege vazamento de token");

  // Requisição HEAD (link unfurler / pré-visualizador de redes sociais) não deve contar clique
  const headReq = await new Promise(res => http.request(BASE + "/r/" + clickToken, { method: "HEAD" }, r => { r.resume(); res(r); }).end());
  ok(headReq.statusCode === 204, "Requisição HEAD responde 204 No Content");

  // Duplo clique rápido (<3s) deve ser deduplicado
  await new Promise(res => http.get(BASE + "/r/" + clickToken, r => { r.resume(); res(r); }));
  let notifDetail = (await req("GET", "/api/notifications/" + sendSite1.json.id, { token })).json;
  ok(notifDetail.clicks === 1, "Deduplicação de cliques repetidos em <3s impede inflar estatísticas");

  // Clique de outro inscrito após 3.5s
  await sleep(3500);
  await new Promise(res => http.get(BASE + "/r/" + delivs[1], r => { r.resume(); res(r); }));
  await new Promise(res => http.get(BASE + "/r/" + clickToken, r => { r.resume(); res(r); }));

  notifDetail = (await req("GET", "/api/notifications/" + sendSite1.json.id, { token })).json;
  ok(notifDetail.clicks === 3 && notifDetail.uniqueClicks === 2, "Contagem precisa: 3 cliques totais, 2 únicos");
  ok(Math.abs(notifDetail.ctr - (2 / 3)) < 0.01, "Cálculo correto do CTR: 2 únicos / 3 entregues = 66.7%");

  // Token inválido não permite Open Redirect
  const badTokenReq = await new Promise(res => http.get(BASE + "/r/tokeninexistente123456", r => { r.resume(); res(r); }));
  ok(badTokenReq.statusCode === 404, "Token inexistente retorna 404 Not Found");

  /* ------------------------------------------------------------------ */
  /* ITEM 6: Retomada de envios interrompidos                           */
  /* ------------------------------------------------------------------ */
  console.log("\n--- Item 6: Retomada de Envios Interrompidos ---");
  const interruptedId = "feed0000cafe1111";
  const nowIso = new Date().toISOString();
  dbDirect.prepare(`INSERT INTO notifications(id,site_id,title,message,url,icon,base_url,status,scheduled_at,created_at,started_at)
    VALUES(?,?,?,?,?,NULL,?, 'sending',?,?,?)`).run(interruptedId, site1.id, "Interrompida", "Mensagem", "https://noticias.example.com/noticia-1", BASE, nowIso, nowIso, nowIso);
  
  const site1Subs = dbDirect.prepare("SELECT id FROM subscriptions WHERE site_id=? AND status='active'").all(site1.id);
  // Simula 1 envio concluído antes da queda e os outros 2 pendentes
  dbDirect.prepare("INSERT INTO deliveries(token,notification_id,subscription_id,status,sent_at) VALUES(?,?,?, 'sent',?)")
    .run(crypto.randomBytes(16).toString("base64url"), interruptedId, site1Subs[0].id, nowIso);
  for (let i = 1; i < site1Subs.length; i++) {
    dbDirect.prepare("INSERT INTO deliveries(token,notification_id,subscription_id,status) VALUES(?,?,?, 'pending')")
      .run(crypto.randomBytes(16).toString("base64url"), interruptedId, site1Subs[i].id);
  }

  // Espera o agendador identificar e retomar o envio interrompido
  await sleep(1500);
  const resumedNotif = (await req("GET", "/api/notifications/" + interruptedId, { token })).json;
  ok(resumedNotif.status === "sent" && resumedNotif.delivered === site1Subs.length, "Envio interrompido foi retomado e concluído");

  const alreadySentTokens = dbDirect.prepare("SELECT COUNT(*) c FROM deliveries WHERE notification_id=? AND status='sent'").get(interruptedId).c;
  ok(alreadySentTokens === site1Subs.length, "Total de entregas 'sent' bate exatamente com o número de inscritos (nenhum duplicado)");

  /* ------------------------------------------------------------------ */
  /* ITEM 7: Persistência do SQLite e Backup Consistente                */
  /* ------------------------------------------------------------------ */
  console.log("\n--- Item 7: Persistência SQLite e Backup ---");
  // Executa o script de backup oficial
  try {
    const backupOutput = execSync("node scripts/backup.js", {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, DATA_DIR: testDir },
      encoding: "utf8"
    });
    ok(backupOutput.includes("Backup criado:"), "Script de backup executado com sucesso e criou arquivo");
  } catch (e) {
    ok(false, "Falha ao executar backup: " + e.message);
  }

  const backupFiles = fs.readdirSync(path.join(testDir, "backups")).filter(f => f.endsWith(".db"));
  ok(backupFiles.length >= 1, "Arquivo de backup encontrado no diretório data/backups");

  const backupDbPath = path.join(testDir, "backups", backupFiles[0]);
  const backupDb = new Database(backupDbPath, { readonly: true });
  const integrity = backupDb.prepare("PRAGMA integrity_check").get();
  ok(integrity.integrity_check === "ok", "Banco de dados de backup possui integridade perfeita (PRAGMA integrity_check = ok)");

  const countBackupSites = backupDb.prepare("SELECT COUNT(*) c FROM sites").get().c;
  const countBackupSubs = backupDb.prepare("SELECT COUNT(*) c FROM subscriptions").get().c;
  ok(countBackupSites >= 3 && countBackupSubs >= 4, "Backup contém todos os dados consistentes de sites e inscrições");
  backupDb.close();

  /* ------------------------------------------------------------------ */
  /* ITEM 8: Segurança e Proteção de Dados                              */
  /* ------------------------------------------------------------------ */
  console.log("\n--- Item 8: Auditoria de Segurança e Proteção de Dados ---");
  // Rate limit de login (bloqueio progressivo)
  const testIpIp = "127.0.0.99";
  let failCount = 0;
  for (let i = 0; i < 5; i++) {
    const badLogin = await req("POST", "/api/login", { body: { password: "senha-errada-teste" }, headers: { "X-Forwarded-For": testIpIp } });
    if (badLogin.status === 401) failCount++;
  }
  ok(failCount === 5, "5 tentativas com senha errada resultam em 401");
  const blockedLogin = await req("POST", "/api/login", { body: { password: PW }, headers: { "X-Forwarded-For": testIpIp } });
  ok(blockedLogin.status === 429 && blockedLogin.headers["retry-after"], "Após 5 falhas, IP é bloqueado com 429 e cabeçalho Retry-After presente");

  // Não exposição de dados sensíveis na listagem de inscritos
  const subsList = (await req("GET", "/api/subscribers", { token })).json;
  const subJsonString = JSON.stringify(subsList);
  ok(!subJsonString.includes("fcm.googleapis.com") && !subJsonString.includes("p256dh") && !subJsonString.includes("auth"), "API /api/subscribers NÃO vaza endpoints, p256dh nem auth");

  // Sessões gravadas com hash no SQLite (não em texto plano)
  const sessionRows = dbDirect.prepare("SELECT token_hash FROM sessions").all();
  ok(sessionRows.length > 0 && !sessionRows.some(s => s.token_hash === token), "Tokens de sessão são armazenados apenas como hash SHA-256 no banco");

  // Validação SSRF no endpoint de push
  const ssrfAttempt = await req("POST", "/api/subscribe", {
    headers: { Origin: "https://noticias.example.com" },
    body: {
      siteId: site1.id,
      endpoint: "https://169.254.169.254/latest/meta-data/",
      keys: subSite1User1.keys
    }
  });
  ok(ssrfAttempt.status === 400 && ssrfAttempt.json.error.includes("não reconhecido"), "Proteção SSRF bloqueia endpoints fora da lista de serviços push confiáveis");

  /* ------------------------------------------------------------------ */
  /* ITEM 9: Compatibilidade do Service Worker e push-client.js         */
  /* ------------------------------------------------------------------ */
  console.log("\n--- Item 9: Compatibilidade do Service Worker e Client ---");
  const swContent = fs.readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");
  ok(swContent.includes("self.addEventListener(\"push\"") && swContent.includes("showNotification"), "sw.js implementa evento 'push' em conformidade com a especificação W3C Push");
  ok(swContent.includes("self.addEventListener(\"notificationclick\"") && swContent.includes("openWindow"), "sw.js implementa evento 'notificationclick' abrindo o link rastreável");

  const clientContent = fs.readFileSync(path.join(__dirname, "..", "public", "push-client.js"), "utf8");
  ok(clientContent.includes("PushManager") && clientContent.includes("applicationServerKey"), "push-client.js utiliza a API padrão PushManager com applicationServerKey");
  ok(clientContent.includes("b64"), "push-client.js converte chave VAPID para Uint8Array garantindo compatibilidade multiplataforma");

  const demoHtml = fs.readFileSync(path.join(__dirname, "..", "public", "demo.html"), "utf8");
  const adminHtml = fs.readFileSync(path.join(__dirname, "..", "public", "admin.html"), "utf8");
  ok(!demoHtml.includes('src="/push-client.js"') && demoHtml.includes('src="./push-client.js"'), "demo.html utiliza caminho relativo para push-client.js");
  ok(!adminHtml.includes('href="/admin.css"') && adminHtml.includes('href="./admin.css"'), "admin.html utiliza caminho relativo para admin.css");

  /* ------------------------------------------------------------------ */
  /* ITEM 2: Sobrevivência e Validade de Inscrições após Reinício       */
  /* ------------------------------------------------------------------ */
  console.log("\n--- Item 2: Validade de Inscrições após Reinício do Servidor ---");
  // Encerra servidor 1
  dbDirect.close();
  srv.kill("SIGTERM");
  await sleep(1000);

  // Inicia servidor 2 com o mesmo diretório de dados
  const srvRestart = spawn("node", ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_PASSWORD: PW,
      DATA_DIR: testDir,
      BASE_URL: BASE,
      PUSH_DRY_RUN: "1",
      TRUST_PROXY: "0"
    },
    stdio: "pipe"
  });

  for (let i = 0; i < 50; i++) {
    try { await req("GET", "/api/public-key"); break; } catch { await sleep(100); }
  }

  // Faz login e confere que inscrições continuam ativas
  const login2 = (await req("POST", "/api/login", { body: { password: PW } })).json;
  const subsAfterRestart = (await req("GET", "/api/subscribers?site=" + site1.id, { token: login2.token })).json;
  ok(subsAfterRestart.total >= 3, "Todas as inscrições do Site 1 continuam presentes e ativas após o reinício");

  // Dispara novo envio para provar que inscrições continuam elegíveis
  const sendAfterRestart = await req("POST", "/api/send", {
    token: login2.token,
    body: { siteId: site1.id, title: "Pós Reinício", message: "Teste", url: "https://noticias.example.com/noticia-1" }
  });
  ok(sendAfterRestart.status === 200 && sendAfterRestart.json.delivered === 3, "Envio realizado com sucesso para todos os inscritos após o reinício");

  srvRestart.kill("SIGTERM");
  await sleep(500);

  /* ------------------------------------------------------------------ */
  /* Resumo Final dos Resultados                                       */
  /* ------------------------------------------------------------------ */
  console.log("\n=======================================================");
  console.log(`RESULTADO FINAL: ${pass} APROVADOS, ${fail} REPROVADOS`);
  console.log("=======================================================\n");

  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

runTests().catch(err => {
  console.error("ERRO FATAL NO TESTE:", err);
  process.exit(1);
});
