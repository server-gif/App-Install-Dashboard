-- 004: platform ane app_version columns remove karva (project mathi fully dropped thaya che)
-- Eela (already-created) DB par chalavo:
--   npx wrangler d1 execute installs-db --remote --file=migrations/004_drop_platform_version.sql
-- Nava (fresh) DB mate aa jaruri nathi: schema.sql ma aa columns nathi.
ALTER TABLE installs DROP COLUMN platform;
ALTER TABLE installs DROP COLUMN app_version;
