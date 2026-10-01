-- Two refund rules change (docs/invariants.md REFUND-016, REFUND-017).
--
-- 1. A refund may be worth 0: the refund of an order a coupon paid for in full.
--    It gives back units, the coupon and the group-buy seat and settles without
--    the gateway. The previous image never writes 0, so rolling back is safe.
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_amount_positive";--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_non_negative" CHECK ("refunds"."amount" >= 0);--> statement-breakpoint
-- 2. A failed refund stays in flight (the merchant can retry it), so it holds
--    its lines again. Data only: one row per order line at most, and never a
--    line another request already holds, so `refund_items_open_uq` cannot
--    refuse it. Matches nothing on a fresh database; a second run opens nothing
--    more.
UPDATE "refund_items" SET "is_open" = true
WHERE "id" IN (
  SELECT DISTINCT ON ("ri"."order_item_id") "ri"."id"
  FROM "refund_items" "ri"
  JOIN "refunds" "r" ON "r"."id" = "ri"."refund_id"
  WHERE "r"."status" = 'failed'
    AND "ri"."is_open" = false
    AND NOT EXISTS (
      SELECT 1 FROM "refund_items" "held"
      WHERE "held"."order_item_id" = "ri"."order_item_id" AND "held"."is_open"
    )
  ORDER BY "ri"."order_item_id", "ri"."id" DESC
);
