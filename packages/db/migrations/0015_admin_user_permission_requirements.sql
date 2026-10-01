-- Two more editors get what their editor reads (core/src/system/permission-requirements.ts),
-- as 0013 did for the others: 管理员 picks a 身份, and 用户 sets 分组 and 标签.
-- Data only, no schema change. Matches nothing on a fresh database, and a second
-- run inserts nothing. A rolled-back image reads the extra rows as ordinary
-- grants, which is accepted: every one is a read the editor already needed.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "role_permissions"."role_id", "requirement"."needs"
FROM "role_permissions"
JOIN (VALUES
  ('system:admin:write', 'system:role:read'),
  ('user:customer:write', 'user:group:read'),
  ('user:customer:write', 'user:label:read')
) AS "requirement" ("atom", "needs") ON "requirement"."atom" = "role_permissions"."permission"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 失败的后台任务 is a new atom (`system:job:handle`). Whoever already handles
-- 待处理任务 (`payment:effect:handle`) sees 「异常待处理」 count failed jobs too, so
-- that role is given the page that lists them. A rolled-back image never checks
-- the atom; the rows are inert there.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "role_id", 'system:job:handle' FROM "role_permissions"
WHERE "permission" = 'payment:effect:handle'
ON CONFLICT DO NOTHING;
