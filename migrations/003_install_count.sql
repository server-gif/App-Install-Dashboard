-- 003: install_tag remove kari ne per-device install_count add karvo
-- Same (app_id, device_id) mate duplicate rows na aavte darek API call e count +1 thay chhe.
-- Eela (already-created) DB par chalavo:
--   npx wrangler d1 execute installs-db --local  --file=migrations/003_install_count.sql
--   npx wrangler d1 execute installs-db --remote --file=migrations/003_install_count.sql
-- Nava (fresh) DB mate aa jaruri nathi: schema.sql ma already install_count column che ane install_tag nathi.
ALTER TABLE installs ADD COLUMN install_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE installs DROP COLUMN install_tag;
