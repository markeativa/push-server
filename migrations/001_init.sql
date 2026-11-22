-- Esquema inicial. Mantido propositalmente portável (TEXT/INTEGER, datas em ISO-8601 UTC)
-- para facilitar a migração futura para PostgreSQL/Supabase (veja docs/schema.postgres.sql).

CREATE TABLE sites (
  id                   TEXT PRIMARY KEY,             -- identificação pública do site/app (ex.: site_ab12cd34ef56)
  name                 TEXT NOT NULL,
  allow_external_links INTEGER NOT NULL DEFAULT 0,   -- 0 = links de destino só podem apontar para o próprio site
  active               INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL
);

CREATE TABLE site_origins (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  origin  TEXT NOT NULL,                             -- origem normalizada: https://exemplo.com[:porta]
  PRIMARY KEY (site_id, origin)
);
CREATE INDEX idx_site_origins_origin ON site_origins(origin);

CREATE TABLE subscriptions (
  id         TEXT PRIMARY KEY,                       -- identificador opaco (nunca expõe o endpoint)
  site_id    TEXT NOT NULL REFERENCES sites(id),
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  device     TEXT,                                   -- rótulo genérico, ex.: "Chrome · Android"
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, endpoint)
);
CREATE INDEX idx_subs_site_status ON subscriptions(site_id, status);

CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL REFERENCES sites(id),
  title        TEXT NOT NULL,
  message      TEXT NOT NULL,
  url          TEXT NOT NULL,                        -- destino final (nunca vai direto no push)
  icon         TEXT,
  base_url     TEXT NOT NULL,                        -- base usada para montar os links rastreáveis
  status       TEXT NOT NULL CHECK (status IN ('scheduled','sending','sent','canceled','failed')),
  scheduled_at TEXT NOT NULL,                        -- quando deve sair (envio imediato = agora)
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  error        TEXT
);
CREATE INDEX idx_notif_status_sched ON notifications(status, scheduled_at);
CREATE INDEX idx_notif_site_created ON notifications(site_id, created_at);

-- Uma linha por (notificação, inscrito). Criada no instante em que o envio é "reivindicado",
-- o que fixa a lista de destinatários e impede envio duplicado após falha/reinício.
CREATE TABLE deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token           TEXT NOT NULL UNIQUE,              -- token do link rastreável /r/<token>
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','expired')),
  sent_at         TEXT
);
CREATE INDEX idx_deliv_notif_status ON deliveries(notification_id, status);

CREATE TABLE clicks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  delivery_id     INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  clicked_at      TEXT NOT NULL                      -- só data/hora: nenhum IP/UA é guardado
);
CREATE INDEX idx_clicks_notif ON clicks(notification_id, clicked_at);
CREATE INDEX idx_clicks_delivery ON clicks(delivery_id, clicked_at);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,                       -- SHA-256 do token (o token em si não é guardado)
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
