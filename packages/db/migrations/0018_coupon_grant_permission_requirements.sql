-- 发优惠券 moves onto 客户列表 (勾选 / 按筛选), where it picks a 优惠券, and gains
-- 作废 on 已领取的优惠券 (core/src/system/permission-requirements.ts). Whoever may
-- hand out coupons (`coupon:grant:write`) is given what those two screens read.
-- Data only, no schema change. Matches nothing on a fresh database, and a second
-- run inserts nothing. A rolled-back image reads the extra rows as ordinary
-- grants, which is accepted: every one is a read the grant screens already needed.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "role_permissions"."role_id", "requirement"."needs"
FROM "role_permissions"
JOIN (VALUES
  ('coupon:grant:write', 'coupon:template:read'),
  ('coupon:grant:write', 'coupon:user-coupon:read')
) AS "requirement" ("atom", "needs") ON "requirement"."atom" = "role_permissions"."permission"
ON CONFLICT DO NOTHING;
