-- Equivalente PostgreSQL/Supabase do esquema em migrations/001_init.sql.
-- Ao migrar: reescreva lib/store.js com o driver "pg" (as funções já são assíncronas e a SQL está toda lá),
-- troque ? por $1,$2..., e copie os dados (veja o README, seção "Migrando para PostgreSQL/Supabase").
CREATE TABLE sites (
  id text PRIMARY KEY, name text NOT NULL,
  allow_external_links boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE site_origins (
  site_id text NOT NULL REFERENCES sites(id) ON DELETE CASCADE, origin text NOT NULL, PRIMARY KEY (site_id, origin));
CREATE INDEX idx_site_origins_origin ON site_origins(origin);
CREATE TABLE subscriptions (
  id text PRIMARY KEY, site_id text NOT NULL REFERENCES sites(id), endpoint text NOT NULL, p256dh text NOT NULL, auth text NOT NULL,
  device text, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (site_id, endpoint));
CREATE INDEX idx_subs_site_status ON subscriptions(site_id, status);
CREATE TABLE notifications (
  id text PRIMARY KEY, site_id text NOT NULL REFERENCES sites(id), title text NOT NULL, message text NOT NULL, url text NOT NULL, icon text,
  base_url text NOT NULL, status text NOT NULL CHECK (status IN ('scheduled','sending','sent','canceled','failed')),
  scheduled_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz, error text);
CREATE INDEX idx_notif_status_sched ON notifications(status, scheduled_at);
CREATE INDEX idx_notif_site_created ON notifications(site_id, created_at);
CREATE TABLE deliveries (
  id bigserial PRIMARY KEY, token text NOT NULL UNIQUE, notification_id text NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id text REFERENCES subscriptions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','expired')), sent_at timestamptz);
CREATE INDEX idx_deliv_notif_status ON deliveries(notification_id, status);
CREATE TABLE clicks (
  id bigserial PRIMARY KEY, notification_id text NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  delivery_id bigint NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE, clicked_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_clicks_notif ON clicks(notification_id, clicked_at);
CREATE INDEX idx_clicks_delivery ON clicks(delivery_id, clicked_at);
CREATE TABLE sessions (token_hash text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE TABLE meta (key text PRIMARY KEY, value text NOT NULL);
-- Claim atômico em PostgreSQL (vários servidores ao mesmo tempo, sem duplicar envio):
--   UPDATE notifications SET status='sending', started_at=now() WHERE id=$1 AND status='scheduled' RETURNING id;
-- Se houver Supabase: ative RLS nas tabelas e use SOMENTE a connection string do servidor (service role). Nunca exponha ao navegador.
