-- 销售看板 is a new page with its own atoms (core/src/stats/permissions.ts). Its
-- figures are the ones 交易统计 already shows, so whoever reads 交易统计 reads
-- 销售看板, and whoever exports 交易统计 exports its category table.
-- Data only, no schema change. Matches nothing on a fresh database, and a second
-- run inserts nothing. A rolled-back image never checks the atoms; the rows are
-- inert there.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "role_id", 'stats:sales:read' FROM "role_permissions"
WHERE "permission" = 'stats:trade:read'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "role_id", 'stats:sales:export' FROM "role_permissions"
WHERE "permission" = 'stats:trade:export'
ON CONFLICT DO NOTHING;
