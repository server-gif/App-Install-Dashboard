-- 001: country-wise flow - app mathi aavto data store karva
-- Eela DB par chalavo: npx wrangler d1 execute installs-db --remote --file=migrations/001_country_flow.sql
ALTER TABLE installs ADD COLUMN install_tag TEXT;
ALTER TABLE installs ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'));

CREATE INDEX IF NOT EXISTS idx_installs_country ON installs (country, installed_at);
CREATE INDEX IF NOT EXISTS idx_installs_app_country ON installs (app_id, country);
CREATE INDEX IF NOT EXISTS idx_installs_time ON installs (installed_at);
