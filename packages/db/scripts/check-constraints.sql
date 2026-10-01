-- Constraint sanity checks.
--
-- Proves that the invariants the application depends on are enforced by the
-- database, not merely by the services. Run against a freshly migrated,
-- seeded database:
--
--   psql "$DATABASE_URL" -f scripts/check-constraints.sql
--
-- Every check prints PASS (the statement was rejected, with the constraint
-- name) or FAIL (the statement went through). The whole script runs inside one
-- transaction and rolls back, so it leaves no rows behind.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = notice;

BEGIN;

CREATE FUNCTION pg_temp.expect_violation(label text, stmt text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  BEGIN
    EXECUTE stmt;
    RAISE NOTICE 'FAIL  % -- statement was accepted but must be rejected', label;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'PASS  % -- % [%]', label, regexp_replace(sqlerrm, E'\n.*', '', 'g'), sqlstate;
  END;
END
$fn$;

CREATE FUNCTION pg_temp.section(label text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '=== % ===', label;
END
$fn$;

-- ---------------------------------------------------------------------------
-- fixtures
-- ---------------------------------------------------------------------------

INSERT INTO users (id, account, nickname) VALUES (9001, 'sanity-buyer', 'Sanity');
INSERT INTO users (id, account, nickname) VALUES (9002, 'sanity-leader', 'Leader');

INSERT INTO products (id, name, image_url, freight_mode, status, price)
VALUES (9001, 'Sanity product', '/uploads/p.png', 'free', 'on_shelf', '10.00');

INSERT INTO product_skus (id, product_id, sku_code, spec_text, price, stock)
VALUES (9001, 9001, 'SANITY-SKU-1', '', '10.00', 5);

INSERT INTO orders (id, order_no, user_id, platform, status, total_quantity,
                    items_amount, payable_amount, paid_amount, paid_at,
                    receiver_name, receiver_phone, receiver_province, receiver_city, receiver_detail)
VALUES (9001, 'SANITY-ORDER-1', 9001, 'h5', 'paid', 1,
        '10.00', '10.00', '10.00', now(),
        'Buyer', '13800000000', '北京市', '北京市', 'Somewhere 1');

INSERT INTO orders (id, order_no, user_id, platform, status, total_quantity,
                    items_amount, payable_amount,
                    receiver_name, receiver_phone, receiver_province, receiver_city, receiver_detail)
VALUES (9002, 'SANITY-ORDER-2', 9001, 'h5', 'pending_payment', 1,
        '10.00', '10.00',
        'Buyer', '13800000000', '北京市', '北京市', 'Somewhere 1');

INSERT INTO order_items (id, order_id, product_id, sku_id, item_key, quantity,
                         unit_price, total_amount, snapshot)
VALUES (9001, 9001, 9001, 9001, 'LINE-1', 1, '10.00', '10.00', '{}'::jsonb);

INSERT INTO payment_attempts (id, order_id, out_trade_no, channel, mch_id, app_id, amount,
                              status, transaction_id, paid_at)
VALUES (9001, 9001, 'SANITY-OTN-1', 'wechat_h5', 'MCH1', 'APP1', '10.00',
        'paid', 'TXN-1', now());

INSERT INTO coupon_templates (id, name, scope, claim_mode, status, discount_amount,
                              validity_mode, valid_days, is_unlimited_supply,
                              total_count, remaining_count, per_user_limit)
VALUES (9001, 'Sanity coupon', 'all_products', 'manual', 'active', '5.00',
        'days_after_claim', 30, false, 10, 1, 1);

INSERT INTO user_coupons (id, template_id, user_id, claim_slot, source_kind,
                          title, discount_amount, min_spend, valid_from, valid_to)
VALUES (9001, 9001, 9001, 1, 'claim', 'Sanity coupon', '5.00', '0.00', now(), now() + interval '30 days');

INSERT INTO user_coupons (id, template_id, user_id, claim_slot, source_kind, source_order_id,
                          title, discount_amount, min_spend, valid_from, valid_to)
VALUES (9002, 9001, 9002, 1, 'gift_order', 9001, 'Sanity coupon', '5.00', '0.00', now(), now() + interval '30 days');

INSERT INTO groupbuy_activities (id, product_id, title, status, price, seats_required,
                                 group_ttl_seconds, stock, start_at, end_at)
VALUES (9001, 9001, 'Sanity group', 'active', '8.00', 2, 86400, 100, now(), now() + interval '7 days');

INSERT INTO groupbuy_groups (id, activity_id, leader_user_id, seats_total, seats_taken, expires_at)
VALUES (9001, 9001, 9002, 2, 2, now() + interval '1 day');

INSERT INTO refunds (id, refund_no, out_refund_no, order_id, user_id, kind, status, quantity, amount)
VALUES (9001, 'SANITY-RF-1', 'SANITY-ORN-1', 9001, 9001, 'refund_only', 'applied', 1, '10.00');

INSERT INTO refund_items (id, refund_id, order_item_id, quantity, amount, is_open)
VALUES (9001, 9001, 9001, 1, '10.00', true);

INSERT INTO refunds (id, refund_no, out_refund_no, order_id, user_id, kind, status, quantity, amount)
VALUES (9002, 'SANITY-RF-2', 'SANITY-ORN-2', 9001, 9001, 'refund_only', 'applied', 1, '10.00');

INSERT INTO product_virtual_cards (id, product_id, sku_id, card_key, card_no, state, order_item_id, claimed_at)
VALUES (9001, 9001, 9001, 'CARD-KEY-1', '1111-2222', 'claimed', 9001, now());

INSERT INTO effects (id, scope, scope_id, event_type, payload) VALUES (9001, 'order', '9001', 'order.paid', '{}');

INSERT INTO capital_flows (id, kind, reference, direction, amount)
VALUES (9001, 'order_payment', 'SANITY-OTN-1', 'in', '10.00');

-- ---------------------------------------------------------------------------
-- checks
-- ---------------------------------------------------------------------------

-- Each check reports through RAISE NOTICE; the empty result rows would only
-- interleave badly with them.
\o /dev/null

SELECT pg_temp.section('stock and counters');
SELECT pg_temp.expect_violation(
  '1. negative SKU stock',
  $$UPDATE product_skus SET stock = stock - 6 WHERE id = 9001$$);
SELECT pg_temp.expect_violation(
  '1b. oversell by conditional update backstop',
  $$INSERT INTO product_skus (product_id, sku_code, spec_text, price, stock)
    VALUES (9001, 'SANITY-SKU-NEG', 'neg', '10.00', -1)$$);
SELECT pg_temp.expect_violation(
  '2. coupon remaining_count below zero',
  $$UPDATE coupon_templates SET remaining_count = remaining_count - 2 WHERE id = 9001$$);

SELECT pg_temp.section('group buy seats');
SELECT pg_temp.expect_violation(
  '3. seats_taken above seats_total',
  $$UPDATE groupbuy_groups SET seats_taken = seats_taken + 1 WHERE id = 9001$$);
SELECT pg_temp.expect_violation(
  '3b. second leader in one group',
  $$INSERT INTO groupbuy_members (group_id, user_id, order_id, role)
    VALUES (9001, 9001, 9002, 'leader'),
           (9001, 9002, 9001, 'leader')$$);

SELECT pg_temp.section('payment');
SELECT pg_temp.expect_violation(
  '4. duplicate out_trade_no',
  $$INSERT INTO payment_attempts (order_id, out_trade_no, channel, mch_id, app_id, amount)
    VALUES (9002, 'SANITY-OTN-1', 'wechat_h5', 'MCH1', 'APP1', '10.00')$$);
SELECT pg_temp.expect_violation(
  '4b. second open attempt on one order',
  $$INSERT INTO payment_attempts (order_id, out_trade_no, channel, mch_id, app_id, amount, status)
    VALUES (9002, 'SANITY-OTN-9', 'wechat_h5', 'MCH1', 'APP1', '10.00', 'submitted'),
           (9002, 'SANITY-OTN-8', 'wechat_h5', 'MCH1', 'APP1', '10.00', 'submitted')$$);
SELECT pg_temp.expect_violation(
  '4c. closed attempt without a confirmed close',
  $$UPDATE payment_attempts SET status = 'closed' WHERE id = 9001$$);
SELECT pg_temp.expect_violation(
  '5. duplicate capital flow for one payment',
  $$INSERT INTO capital_flows (kind, reference, direction, amount)
    VALUES ('order_payment', 'SANITY-OTN-1', 'in', '10.00')$$);
SELECT pg_temp.expect_violation(
  '6. duplicate order effect',
  $$INSERT INTO effects (scope, scope_id, event_type, payload) VALUES ('order', '9001', 'order.paid', '{}')$$);

SELECT pg_temp.section('refunds');
SELECT pg_temp.expect_violation(
  '7. second open refund for one order item',
  $$INSERT INTO refund_items (refund_id, order_item_id, quantity, amount, is_open)
    VALUES (9002, 9001, 1, '10.00', true)$$);
SELECT pg_temp.expect_violation(
  '8. refunded more than paid (REFUND-007)',
  $$UPDATE orders SET refunded_amount = '10.01' WHERE id = 9001$$);
SELECT pg_temp.expect_violation(
  '8b. refunded more units than bought',
  $$UPDATE order_items SET refunded_quantity = 2 WHERE id = 9001$$);
SELECT pg_temp.expect_violation(
  '8c. duplicate out_refund_no',
  $$INSERT INTO refunds (refund_no, out_refund_no, order_id, user_id, kind, quantity, amount)
    VALUES ('SANITY-RF-3', 'SANITY-ORN-1', 9001, 9001, 'refund_only', 1, '1.00')$$);

SELECT pg_temp.section('coupons');
SELECT pg_temp.expect_violation(
  '9. second claim of a one-per-user coupon',
  $$INSERT INTO user_coupons (template_id, user_id, claim_slot, source_kind,
                              title, discount_amount, min_spend, valid_from, valid_to)
    VALUES (9001, 9001, 1, 'claim', 'Sanity coupon', '5.00', '0.00', now(), now() + interval '30 days')$$);
SELECT pg_temp.expect_violation(
  '10. gift coupon issued twice for one order (FULFILL-001)',
  $$INSERT INTO user_coupons (template_id, user_id, claim_slot, source_kind, source_order_id,
                              title, discount_amount, min_spend, valid_from, valid_to)
    VALUES (9001, 9002, 2, 'gift_order', 9001, 'Sanity coupon', '5.00', '0.00', now(), now() + interval '30 days')$$);

SELECT pg_temp.section('virtual cards (VIRTUAL-001)');
SELECT pg_temp.expect_violation(
  '11. second card claimed by one order item',
  $$INSERT INTO product_virtual_cards (product_id, sku_id, card_key, card_no, state, order_item_id, claimed_at)
    VALUES (9001, 9001, 'CARD-KEY-2', '3333-4444', 'claimed', 9001, now())$$);
SELECT pg_temp.expect_violation(
  '11b. claimed card without an order item',
  $$UPDATE product_virtual_cards SET order_item_id = NULL WHERE id = 9001$$);

SELECT pg_temp.section('identity and lifecycle');
SELECT pg_temp.expect_violation(
  '12. duplicate account differing only in case',
  $$INSERT INTO users (account) VALUES ('SANITY-BUYER')$$);
SELECT pg_temp.expect_violation(
  '13. two default addresses for one user',
  $$INSERT INTO user_addresses (user_id, receiver_name, receiver_phone, province_name, city_name, detail, is_default)
    VALUES (9001, 'A', '13800000001', '北京市', '北京市', 'x', true),
           (9001, 'B', '13800000002', '北京市', '北京市', 'y', true)$$);
SELECT pg_temp.expect_violation(
  '14. paid order without a payment time',
  $$INSERT INTO orders (order_no, user_id, platform, status, total_quantity, items_amount,
                        payable_amount, receiver_name, receiver_phone, receiver_province,
                        receiver_city, receiver_detail)
    VALUES ('SANITY-ORDER-3', 9001, 'h5', 'paid', 1, '10.00', '10.00',
            'B', '13800000000', '北京市', '北京市', 'z')$$);

\o
ROLLBACK;
