-- 优惠券's 指定商品 and 指定分类 become pickers over the catalog instead of typed-in
-- ids (core/src/system/permission-requirements.ts). Whoever may edit coupons
-- (`coupon:template:write`) is given the two catalog reads those pickers make, and the list it edits from.
-- Data only, no schema change. Matches nothing on a fresh database, and a second
-- run inserts nothing. A rolled-back image reads the extra rows as ordinary
-- grants, which is accepted: both are reads, and the typed-in ids named the same rows.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "role_permissions"."role_id", "requirement"."needs"
FROM "role_permissions"
JOIN (VALUES
  ('coupon:template:write', 'coupon:template:read'),
  ('coupon:template:write', 'catalog:product:read'),
  ('coupon:template:write', 'catalog:category:read')
) AS "requirement" ("atom", "needs") ON "requirement"."atom" = "role_permissions"."permission"
ON CONFLICT DO NOTHING;
