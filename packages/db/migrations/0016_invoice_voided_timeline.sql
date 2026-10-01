-- 作废发票 goes on the order timeline (INVOICE-005): staff marking an issued
-- invoice 已作废 after 冲红 was only in the admin audit log.
-- One enum value, no data. Nothing in this migration uses it, so adding it
-- inside the migration transaction is allowed (PG 12+). A rolled-back image
-- cannot parse the timeline of an order that has one of these rows; every
-- other order reads as before.
ALTER TYPE "public"."order_status_logs_change_type" ADD VALUE 'invoice_voided' BEFORE 'groupbuy_joined';
