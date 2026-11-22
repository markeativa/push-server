/* ============ CAMADA DE DADOS (servidor real) ============ */
if (location.protocol === "file:") {
  window.addEventListener("DOMContentLoaded", () => {
    const alert = document.createElement("div");
    alert.style.cssText = "background:#fee2e2;color:#991b1b;border:1px solid #f87171;padding:12px 18px;font-size:14px;position:fixed;top:0;left:0;right:0;z-index:9999;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.15);font-family:sans-serif;";
    alert.innerHTML = "<strong>Atenção:</strong> Você abriu o Painel Push diretamente pelo arquivo (<code>file://</code>). O painel requer o servidor Node.js ativo. Inicie o servidor com <code>npm start</code> e acesse: <a href='http://localhost:3000/admin.html' style='color:#7f1d1d;font-weight:bold;text-decoration:underline;'>http://localhost:3000/admin.html</a>";
    document.body.prepend(alert);
  });
}
let token = sessionStorage.getItem("tk") || "";
async function call(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) } });
  if (r.status === 401 && token) { showLogin(); throw new Error("Sessão expirada. Entre novamente."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Erro " + r.status);
  return j;
}
const q = o => { const p = new URLSearchParams(); for (const k in o) if (o[k] !== undefined && o[k] !== "") p.set(k, o[k]); const s = p.toString(); return s ? "?" + s : ""; };
const api = {
  getSites: () => call("/api/sites"),
  createSite: b => call("/api/sites", { method: "POST", body: JSON.stringify(b) }),
  updateSite: (id, b) => call("/api/sites/" + id, { method: "PATCH", body: JSON.stringify(b) }),
  getStats: site => call("/api/stats" + q({ site })),
  getHistory: (site, offset = 0, limit = 50) => call("/api/notifications" + q({ site, offset, limit })),
  getNotification: id => call("/api/notifications/" + id),
  cancelNotification: id => call("/api/notifications/" + id + "/cancel", { method: "POST", body: "{}" }),
  getSubscribers: (site, status, offset = 0) => call("/api/subscribers" + q({ site, status, offset, limit: 50 })),
  removeSubscriber: id => call("/api/subscribers/" + id, { method: "DELETE" }),
  async sendNotification(n) {
    let icon = null;
    if (n.icon && n.icon.startsWith("data:")) icon = (await call("/api/icon", { method: "POST", body: JSON.stringify({ data: n.icon }) })).url;
    return call("/api/send", { method: "POST", body: JSON.stringify({ siteId: n.siteId, title: n.title, message: n.message, url: n.url, icon, scheduledAt: n.scheduledAt }) });
  }
};

/* ============ INTERFACE ============ */
const $ = id => document.getElementById(id);
let iconData = null, sites = [], filterSite = "", editingSite = null, histData = [], subsData = [];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = iso => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "");
const fmtTime = iso => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const fmtFull = iso => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtNum = n => Number(n || 0).toLocaleString("pt-BR");
const fmtPct = r => (r * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%";
const iconHTML = i => i ? '<img alt="" src="' + esc(i) + '">' : "A";
const STATUS = { scheduled: ["Agendada", "warn"], sending: ["Enviando", ""], sent: ["Enviada", ""], canceled: ["Cancelada", "mute"], failed: ["Falhou", "bad"], active: ["Ativa", ""], expired: ["Expirada", "mute"] };
const badge = s => '<span class="badge ' + STATUS[s][1] + '">' + STATUS[s][0] + "</span>";
const when = n => n.status === "scheduled" ? fmtFull(n.scheduledAt) : fmtDate(n.scheduledAt) + " às " + fmtTime(n.scheduledAt);

function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 3600); }
let current = "painel";
function show(v) {
  current = v;
  document.querySelectorAll(".view").forEach(e => e.classList.toggle("on", e.id === "v-" + v));
  document.querySelectorAll("#nav button").forEach(b => { if (b.dataset.v === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  window.scrollTo(0, 0); load(v).catch(e => toast(e.message));
}
$("nav").addEventListener("click", e => { const t = e.target.closest("button"); if (t) show(t.dataset.v); });
const load = v => ({ painel: renderPainel, historico: () => loadHist(true), inscritos: () => loadSubs(true), sites: renderSites, enviar: async () => { await loadSites(); updatePreview(); } }[v] || (() => 0))();

/* ---- sites e filtros ---- */
async function loadSites() {
  sites = await api.getSites();
  const opts = '<option value="">Todos os sites</option>' + sites.map(s => '<option value="' + esc(s.id) + '">' + esc(s.name) + (s.active ? "" : " (desativado)") + "</option>").join("");
  document.querySelectorAll(".fsite").forEach(s => { s.innerHTML = opts; s.value = filterSite; });
  const prev = $("site").value, act = sites.filter(s => s.active);
  $("site").innerHTML = '<option value="">Selecione o site…</option>' + act.map(s => '<option value="' + esc(s.id) + '">' + esc(s.name) + "</option>").join("");
  $("site").value = act.some(s => s.id === prev) ? prev : (act.length === 1 ? act[0].id : "");
}
document.querySelectorAll(".fsite").forEach(s => s.addEventListener("change", () => {
  filterSite = s.value; document.querySelectorAll(".fsite").forEach(x => x.value = filterSite); load(current).catch(e => toast(e.message));
}));
$("sub-status").onchange = () => loadSubs(true).catch(e => toast(e.message));

/* ---- painel ---- */
async function renderPainel() {
  await loadSites();
  const [s, h] = await Promise.all([api.getStats(filterSite), api.getHistory(filterSite, 0, 4)]);
  $("s-subs").textContent = fmtNum(s.subscribers); $("s-sent").textContent = fmtNum(s.sent);
  $("s-clicks").textContent = fmtNum(s.clicks); $("s-ctr").textContent = fmtPct(s.ctr);
  $("s-note").textContent = "Taxa de cliques = pessoas que clicaram (" + fmtNum(s.uniqueClicks) + ") ÷ notificações entregues (" + fmtNum(s.delivered) + ")." + (s.scheduled ? " " + fmtNum(s.scheduled) + " envio(s) agendado(s)." : "");
  $("recent").innerHTML = h.items.length ? h.items.map(n =>
    '<li><div class="ic">' + iconHTML(n.icon) + '</div><div><div class="t">' + esc(n.title) + '</div><div class="m">' + esc(n.siteName) + " · " + esc(n.message) + '</div></div><div class="d">' + when(n) +
    "<em>" + (n.status === "scheduled" ? "Agendada" : fmtNum(n.delivered) + " entregas · " + fmtNum(n.clicks) + " cliques") + "</em></div></li>").join("")
    : '<li class="empty">Nenhuma notificação ainda.</li>';
}

/* ---- histórico ---- */
async function loadHist(reset) {
  if (reset) { histData = []; await loadSites(); }
  const r = await api.getHistory(filterSite, histData.length); histData = histData.concat(r.items);
  $("hist").innerHTML = histData.length ? histData.map(n =>
    '<tr class="row" data-id="' + esc(n.id) + '" tabindex="0"><td><div class="t">' + esc(n.title) + '</div><div class="m">' + esc(n.message) + "</div></td><td>" + esc(n.siteName) + '</td><td class="n">' + when(n) +
    '</td><td class="n">' + fmtNum(n.delivered) + (n.failed ? ' <span class="m">(' + fmtNum(n.failed) + " falhas)</span>" : "") + '</td><td class="n">' + fmtNum(n.clicks) + '</td><td class="n">' + (n.delivered ? fmtPct(n.ctr) : "—") + "</td><td>" + badge(n.status) + "</td></tr>").join("")
    : '<tr><td colspan="7" class="empty">Nenhuma notificação encontrada.</td></tr>';
  $("hist-more").hidden = histData.length >= r.total;
}
$("hist-more").onclick = () => loadHist(false).catch(e => toast(e.message));
const openRow = e => { const t = e.target.closest("tr.row"); if (t) openDetail(t.dataset.id).catch(x => toast(x.message)); };
$("hist").addEventListener("click", openRow);
$("hist").addEventListener("keydown", e => { if (e.key === "Enter") openRow(e); });

async function openDetail(id) {
  const n = await api.getNotification(id), cd = n.clickDetail;
  $("dlg-body").innerHTML = '<h2>' + esc(n.title) + "</h2><div>" + badge(n.status) + ' <span class="m">' + esc(n.siteName) + "</span></div>" +
    '<div class="kv"><div><b>' + fmtNum(n.delivered) + "</b><span>Entregas</span></div><div><b>" + fmtNum(n.clicks) + "</b><span>Cliques (total)</span></div><div><b>" + (n.delivered ? fmtPct(n.ctr) : "—") + "</b><span>Taxa de cliques</span></div></div>" +
    '<dl class="dl"><dt>Mensagem</dt><dd>' + esc(n.message) + "</dd><dt>Link de destino</dt><dd>" + esc(n.url) + "</dd><dt>" + (n.status === "scheduled" ? "Agendada para" : "Programada para") + "</dt><dd>" + fmtFull(n.scheduledAt) + "</dd>" +
    (n.finishedAt && n.status !== "canceled" ? "<dt>Concluída em</dt><dd>" + fmtFull(n.finishedAt) + "</dd>" : "") +
    "<dt>Destinatários</dt><dd>" + fmtNum(n.targeted) + " (" + fmtNum(n.delivered) + " entregues, " + fmtNum(n.failed) + " sem entrega)</dd>" +
    "<dt>Pessoas que clicaram</dt><dd>" + fmtNum(n.uniqueClicks) + "</dd>" + (n.error ? "<dt>Erro</dt><dd>" + esc(n.error) + "</dd>" : "") + "</dl>" +
    (cd.byDay.length ? "<div class=\"lbl\">Cliques por dia</div><ul class=\"clicks\">" + cd.byDay.map(d => "<li>" + new Date(d.day + "T12:00:00").toLocaleDateString("pt-BR") + ": " + fmtNum(d.clicks) + "</li>").join("") + "</ul>" : "") +
    (cd.recent.length ? '<div class="lbl">Últimos cliques (data e horário)</div><ul class="clicks">' + cd.recent.map(t => "<li>" + fmtFull(t) + "</li>").join("") + "</ul>" : '<p class="m">Nenhum clique registrado.</p>');
  const c = $("dlg-cancel"); c.hidden = n.status !== "scheduled"; c.dataset.id = n.id;
  if (!$("dlg").open) $("dlg").showModal();
}
$("dlg-close").onclick = () => $("dlg").close();
$("dlg-cancel").onclick = async e => {
  if (!confirm("Cancelar este envio agendado?")) return;
  try { await api.cancelNotification(e.target.dataset.id); $("dlg").close(); toast("Agendamento cancelado."); loadHist(true); } catch (x) { toast(x.message); }
};

/* ---- inscritos ---- */
async function loadSubs(reset) {
  if (reset) { subsData = []; await loadSites(); }
  const r = await api.getSubscribers(filterSite, $("sub-status").value, subsData.length); subsData = subsData.concat(r.rows);
  $("subs").innerHTML = subsData.length ? subsData.map(s =>
    "<tr><td>" + esc(s.siteName) + '</td><td class="n">' + fmtFull(s.createdAt) + "</td><td>" + (s.device ? esc(s.device) : '<span class="m">Não identificado</span>') + "</td><td>" + badge(s.status) +
    '</td><td><button class="btn sm danger" data-rm="' + esc(s.id) + '" type="button">Remover</button></td></tr>').join("")
    : '<tr><td colspan="5" class="empty">Nenhum inscrito encontrado.</td></tr>';
  $("subs-more").hidden = subsData.length >= r.total;
}
$("subs-more").onclick = () => loadSubs(false).catch(e => toast(e.message));
$("subs").addEventListener("click", async e => {
  const b = e.target.closest("[data-rm]"); if (!b) return;
  if (!confirm("Remover esta inscrição? A pessoa deixará de receber notificações neste dispositivo.")) return;
  try { await api.removeSubscriber(b.dataset.rm); toast("Inscrição removida."); loadSubs(true); } catch (x) { toast(x.message); }
});

/* ---- sites ---- */
async function renderSites() {
  await loadSites();
  $("sites").innerHTML = sites.length ? sites.map(s => {
    const snip = '<script src="' + location.origin + '/push-client.js" data-site="' + s.id + '"></' + "script>";
    return '<div class="card site"><header><h3>' + esc(s.name) + "</h3><span>" + badge(s.active ? "active" : "expired").replace("Expirada", "Desativado") + "</span></header>" +
      '<div class="m">' + fmtNum(s.subscribers) + " inscritos ativos · código <b>" + esc(s.id) + "</b></div>" +
      '<div class="m">Origens: ' + s.origins.map(esc).join(", ") + (s.allowExternalLinks ? " · links externos permitidos" : "") + "</div>" +
      '<div class="lbl">Código para colar no site</div><code>' + esc(snip) + "</code>" +
      '<div class="actions"><button class="btn sm" data-edit="' + esc(s.id) + '" type="button">Editar</button><button class="btn sm" data-toggle="' + esc(s.id) + '" type="button">' + (s.active ? "Desativar" : "Ativar") + "</button>" +
      '<a class="btn sm" target="_blank" rel="noopener" href="/demo.html?site=' + encodeURIComponent(s.id) + '">Página de teste</a></div></div>';
  }).join("") : '<div class="card empty">Nenhum site cadastrado. Cadastre o primeiro ao lado.</div>';
}
$("sites").addEventListener("click", async e => {
  const ed = e.target.closest("[data-edit]"), tg = e.target.closest("[data-toggle]");
  if (ed) { const s = sites.find(x => x.id === ed.dataset.edit); editingSite = s.id; $("sname").value = s.name; $("sorig").value = s.origins.join("\n"); $("sext").checked = s.allowExternalLinks; $("sform-t").textContent = "Editar site"; $("ssave").textContent = "Salvar"; $("scancel").hidden = false; $("sname").focus(); }
  if (tg) { const s = sites.find(x => x.id === tg.dataset.toggle); try { await api.updateSite(s.id, { active: !s.active }); renderSites(); } catch (x) { toast(x.message); } }
});
function resetSiteForm() { editingSite = null; $("sform").reset(); $("sform-t").textContent = "Cadastrar site"; $("ssave").textContent = "Cadastrar"; $("scancel").hidden = true; $("serr").textContent = ""; }
$("scancel").onclick = resetSiteForm;
$("sform").addEventListener("submit", async e => {
  e.preventDefault();
  const b = { name: $("sname").value.trim(), origins: $("sorig").value.split(/\s+/).filter(Boolean), allowExternalLinks: $("sext").checked };
  try { if (editingSite) await api.updateSite(editingSite, b); else await api.createSite(b); resetSiteForm(); toast("Site salvo."); renderSites(); } catch (ex) { $("serr").textContent = ex.message; }
});

/* ---- envio ---- */
function updatePreview() {
  const t = $("title").value.trim(), m = $("body").value.trim(), u = $("url").value.trim(), s = sites.find(x => x.id === $("site").value);
  $("push-t").textContent = t || "Título da notificação";
  $("push-m").textContent = m || "A mensagem aparece aqui.";
  $("push-app").textContent = s ? s.name : "Seu app";
  $("push-url").textContent = "Ao tocar, abre: " + (u || "—");
  $("c-title").textContent = $("title").value.length + "/50";
  $("c-body").textContent = $("body").value.length + "/140";
  $("clock-d").textContent = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  $("go").textContent = $("when").value ? "Agendar notificação" : "Enviar notificação";
  ["icon-prev", "push-ic"].forEach(id => $(id).innerHTML = iconHTML(iconData));
}
["title", "body", "url", "when", "site"].forEach(id => $(id).addEventListener("input", updatePreview));
$("pick").onclick = () => $("file").click();
$("file").onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 1024 * 1024) { toast("A imagem precisa ter até 1 MB."); return; }
  const r = new FileReader(); r.onload = () => { iconData = r.result; updatePreview(); }; r.readAsDataURL(f);
};
$("preview").onclick = () => {
  $("pv").scrollIntoView({ behavior: "smooth", block: "center" });
  const p = $("push"); p.classList.remove("pulse"); void p.offsetWidth; p.classList.add("pulse");
};

$("form").addEventListener("submit", async e => {
  e.preventDefault();
  const siteId = $("site").value, t = $("title").value.trim(), m = $("body").value.trim(), u = $("url").value.trim(), w = $("when").value;
  let err = "";
  if (!siteId) err = "Selecione o site de destino.";
  else if (!t) err = "Escreva um título para a notificação.";
  else if (!m) err = "Escreva a mensagem da notificação.";
  else if (!/^https?:\/\/.+\..+/.test(u)) err = "Informe um link válido, começando com https://";
  else if (w && new Date(w).getTime() < Date.now() + 60e3) err = "Escolha um horário pelo menos 1 minuto no futuro.";
  $("err").textContent = err; if (err) return;
  const go = $("go"); go.disabled = true; go.textContent = w ? "Agendando…" : "Enviando…";
  try {
    const n = await api.sendNotification({ siteId, title: t, message: m, url: u, icon: iconData, scheduledAt: w ? new Date(w).toISOString() : null });
    $("form").reset(); iconData = null; $("site").value = siteId; updatePreview();
    toast(n.status === "scheduled" ? "Agendada para " + fmtFull(n.scheduledAt) + "." : n.status === "sending" ? "Envio em andamento. Acompanhe no histórico." : "Enviada para " + fmtNum(n.delivered) + " inscritos" + (n.failed ? " (" + fmtNum(n.failed) + " sem entrega)." : "."));
    show("historico");
  } catch (ex) { $("err").textContent = ex.message; }
  go.disabled = false; updatePreview();
});

/* ---- login ---- */
function showLogin() { $("login").hidden = false; $("pw").focus(); }
$("lform").onsubmit = async e => {
  e.preventDefault();
  try {
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("pw").value }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Falha ao entrar.");
    token = j.token; sessionStorage.setItem("tk", token); $("login").hidden = true; $("pw").value = ""; $("lerr").textContent = ""; show("painel");
  } catch (ex) { $("lerr").textContent = ex.message; }
};
$("logout").onclick = async () => { try { await call("/api/logout", { method: "POST", body: "{}" }); } catch {} token = ""; sessionStorage.removeItem("tk"); showLogin(); };
updatePreview();
if (token) show("painel"); else showLogin();
