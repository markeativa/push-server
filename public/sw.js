self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(clients.claim()));

/* Receber a notificação NÃO conta como clique. O clique só é registrado quando a pessoa toca nela:
   a URL do payload é o link rastreável do servidor (/r/<token>), que registra e redireciona ao destino. */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: "Nova notificação", message: e.data ? e.data.text() : "" }; }
  const title = d.title || "Notificação";
  const opts = {
    body: d.message || "",
    data: { url: d.url || "/" }
  };
  if (d.icon) {
    opts.icon = d.icon;
    opts.badge = d.icon;
  }
  e.waitUntil(
    self.registration.showNotification(title, opts).catch(() => {
      // Fallback sem ícone/badge se o sistema operacional rejeitar imagens grandes
      return self.registration.showNotification(title, {
        body: d.message || "",
        data: { url: d.url || "/" }
      });
    })
  );
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(clients.openWindow(url));
});
