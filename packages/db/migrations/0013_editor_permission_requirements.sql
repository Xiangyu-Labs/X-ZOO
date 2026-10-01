-- Editors get what their editor reads (core/src/system/permission-requirements.ts).
-- Data only, no schema change. A role saved from now on is completed when it is
-- saved; this does the same once for the roles that already exist, so nobody's
-- 商品编辑 keeps opening an editor of 403s. Only reads and 素材 upload are added.
-- Matches nothing on a fresh database, and a second run inserts nothing.
-- A rolled-back image reads the extra rows as ordinary grants, which is accepted:
-- every one of them is a read the editor already needed.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "role_permissions"."role_id", "requirement"."needs"
FROM "role_permissions"
JOIN (VALUES
  ('catalog:product:write', 'catalog:product:read'),
  ('catalog:product:write', 'catalog:category:read'),
  ('catalog:product:write', 'catalog:label:read'),
  ('catalog:product:write', 'catalog:protection:read'),
  ('catalog:product:write', 'catalog:param:read'),
  ('catalog:product:write', 'shipping:template:read'),
  ('catalog:product:write', 'storage:attachment:read'),
  ('catalog:product:write', 'storage:attachment:write'),
  ('catalog:product:write', 'storage:category:read'),
  ('catalog:category:write', 'catalog:category:read'),
  ('catalog:category:write', 'storage:attachment:read'),
  ('catalog:category:write', 'storage:attachment:write'),
  ('catalog:category:write', 'storage:category:read'),
  ('cms:article:write', 'cms:article:read'),
  ('cms:article:write', 'catalog:product:read'),
  ('cms:article:write', 'storage:attachment:read'),
  ('cms:article:write', 'storage:attachment:write'),
  ('cms:article:write', 'storage:category:read'),
  ('cms:category:write', 'cms:article:read'),
  ('cms:category:write', 'storage:attachment:read'),
  ('cms:category:write', 'storage:attachment:write'),
  ('cms:category:write', 'storage:category:read'),
  ('groupbuy:activity:write', 'groupbuy:activity:read'),
  ('groupbuy:activity:write', 'catalog:product:read'),
  ('groupbuy:activity:write', 'storage:attachment:read'),
  ('groupbuy:activity:write', 'storage:attachment:write'),
  ('groupbuy:activity:write', 'storage:category:read'),
  ('presale:activity:write', 'presale:activity:read'),
  ('presale:activity:write', 'catalog:product:read'),
  ('presale:activity:write', 'storage:attachment:read'),
  ('presale:activity:write', 'storage:attachment:write'),
  ('presale:activity:write', 'storage:category:read'),
  ('decor:page:write', 'decor:page:read'),
  ('decor:page:write', 'catalog:product:read'),
  ('decor:page:write', 'catalog:category:read'),
  ('decor:page:write', 'catalog:label:read'),
  ('decor:page:write', 'cms:article:read'),
  ('decor:page:write', 'coupon:template:read'),
  ('decor:page:write', 'groupbuy:activity:read'),
  ('decor:page:write', 'presale:activity:read'),
  ('decor:page:write', 'storage:attachment:read'),
  ('decor:page:write', 'storage:attachment:write'),
  ('decor:page:write', 'storage:category:read')
) AS "requirement" ("atom", "needs") ON "requirement"."atom" = "role_permissions"."permission"
ON CONFLICT DO NOTHING;
