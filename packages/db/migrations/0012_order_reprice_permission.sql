-- 改价 leaves `order:order:write` for its own atom, `order:order:reprice`
-- (core/src/order/permissions.ts). Data only, no schema change. Every role that
-- could re-price before keeps that right: it is granted the new atom here.
-- Matches nothing on a fresh database, and a second run inserts nothing.
-- A rolled-back image never checks `order:order:reprice`; the extra rows are
-- inert there.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "role_id", 'order:order:reprice' FROM "role_permissions"
WHERE "permission" = 'order:order:write'
ON CONFLICT DO NOTHING;
