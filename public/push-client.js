/* Inclua no site:
     <script src="https://SEU-SERVIDOR/push-client.js" data-site="site_xxxxxxxxxxxx"></script>
   (o código "data-site" é mostrado no painel, em Sites) e chame PushPainel.ativar() a partir de um clique do usuário.
   O arquivo sw.js precisa estar na RAIZ do site (ex.: https://seusite.com/sw.js).
   O servidor só aceita inscrições vindas de origens cadastradas para o site. */
(function () {
  var s = document.currentScript || (function () {
    var list = document.getElementsByTagName("script");
    return list[list.length - 1];
  })();
  var SERVER = ((s && s.dataset && s.dataset.server) || (s && s.src ? new URL(s.src, location.href).origin : location.origin)).replace(/\/$/, "");
  var SW = (s && s.dataset && s.dataset.sw) || "/sw.js";
  var SITE = (s && s.dataset && s.dataset.site) || "";

  function b64(x) {
    x = (x + "=".repeat((4 - x.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(x), function (c) { return c.charCodeAt(0); });
  }

  async function ativar(opts) {
    if (location.protocol === "file:") {
      throw new Error("Notificações Push e Service Workers não funcionam via file://. Inicie o servidor e use http:// ou https://.");
    }
    var site = (opts && opts.site) || SITE;
    if (!("serviceWorker" in navigator) || !("PushManager" in window))
      throw new Error("Este navegador não suporta notificações push (no iPhone, instale o site na tela inicial).");
    if (Notification.permission === "denied") {
      throw new Error("Permissão bloqueada no navegador. Clique no ícone de configurações ao lado do endereço do site (à esquerda de 'localhost:3000') e altere Notificações para 'Permitir'.");
    }
    if ((await Notification.requestPermission()) !== "granted") throw new Error("Permissão não concedida. É necessário autorizar as notificações no navegador.");
    var reg = await navigator.serviceWorker.register(SW);
    await navigator.serviceWorker.ready;
    var key = (await (await fetch(SERVER + "/api/public-key")).json()).key;
    var sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
    var body = Object.assign({}, sub.toJSON());
    if (site) body.siteId = site;
    var r = await fetch(SERVER + "/api/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      if (r.status === 403) throw new Error("A origem '" + location.origin + "' não está cadastrada ou autorizada para este site no painel.");
      throw new Error("Falha ao registrar a inscrição (HTTP " + r.status + ").");
    }
    return true;
  }

  async function desativar(opts) {
    if (location.protocol === "file:") return true;
    var site = (opts && opts.site) || SITE;
    var reg = await navigator.serviceWorker.getRegistration(SW);
    var sub = reg && await reg.pushManager.getSubscription();
    if (!sub) return true;
    var body = { endpoint: sub.endpoint }; if (site) body.siteId = site;
    await fetch(SERVER + "/api/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return sub.unsubscribe();
  }

  window.PushPainel = { ativar: ativar, desativar: desativar };
})();
