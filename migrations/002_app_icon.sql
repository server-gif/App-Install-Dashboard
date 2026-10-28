-- 002: app store icon - package name thi icon fetch kari store karva
-- Eela (already-created) DB par chalavo:
--   npx wrangler d1 execute installs-db --remote --file=migrations/002_app_icon.sql
-- Nava (fresh) DB mate aa jaruri nathi: schema.sql ma already icon_url column che.
ALTER TABLE apps ADD COLUMN icon_url TEXT;
