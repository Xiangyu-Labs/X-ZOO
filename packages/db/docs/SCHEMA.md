# Business schema

86 tables and 69 enums across 17 domain files, one file per domain in
`src/schema/<domain>.ts`.

`auth.ts` (admins, roles, role permissions, admin roles, admin and storefront
sessions) and `system.ts` (config values, audit log, generic job
infrastructure) are the kernel's tables and are described in those files, not
here.

Conventions in force everywhere: `timestamptz` (no epoch integers), real
`boolean`, `numeric(12,2)` money read and written as strings, `jsonb` with a TS
type through `.$type<…>()`, a `pgEnum` named `<table>_<column>` for every status
or type code, real foreign keys with a deliberate `onDelete`, join tables
instead of comma-separated id columns, `NULL` instead of `''` or `0` for
"unset", and `CHECK` constraints on every stock, amount and counter.

---

## 1. Table inventory

| Domain         | Tables | Names                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | -----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reference`    |      3 | `cities`, `express_companies`, `agreements`                                                                                                                                                                                                                                                                                                                                                               |
| `user`         |      9 | `users`, `user_addresses`, `user_groups`, `user_groups_map`, `user_label_categories`, `user_labels`, `user_labels_map`, `user_invoice_profiles`, `user_cancellation_requests`                                                                                                                                                                                                                             |
| `storage`      |      2 | `attachment_categories`, `attachments`                                                                                                                                                                                                                                                                                                                                                                    |
| `shipping`     |      6 | `shipping_templates`, `shipping_template_regions`, `shipping_template_region_cities`, `shipping_template_free_rules`, `shipping_template_free_rule_cities`, `shipping_template_no_delivery_cities`                                                                                                                                                                                                        |
| `catalog`      |     18 | `product_categories`, `products`, `product_categories_map`, `product_descriptions`, `product_recommendations`, `product_specs`, `product_spec_values`, `product_skus`, `product_virtual_cards`, `product_label_categories`, `product_labels`, `product_labels_map`, `product_param_templates`, `product_params`, `product_protections`, `product_protections_map`, `product_favorites`, `product_reviews` |
| `cart`         |      1 | `cart_items`                                                                                                                                                                                                                                                                                                                                                                                              |
| `coupon`       |      5 | `coupon_templates`, `coupon_template_products`, `coupon_template_categories`, `product_gift_coupons`, `user_coupons`                                                                                                                                                                                                                                                                                      |
| `order`        |      6 | `orders`, `order_items`, `order_status_logs`, `shipments`, `shipment_items`, `order_invoices` (the side-effect ledger is the generic `effects` table in `system.ts`)                                                                                                                                                                                                                                      |
| `payment`      |      4 | `payment_attempts`, `payment_callbacks`, `payment_exceptions`, `capital_flows`                                                                                                                                                                                                                                                                                                                            |
| `refund`       |      3 | `refunds`, `refund_items`, `refund_logs`                                                                                                                                                                                                                                                                                                                                                                  |
| `groupbuy`     |      4 | `groupbuy_activities`, `groupbuy_activity_skus`, `groupbuy_groups`, `groupbuy_members`                                                                                                                                                                                                                                                                                                                    |
| `presale`      |      4 | `presale_activities`, `presale_activity_skus`, `presale_orders`, `presale_stock_ledger`                                                                                                                                                                                                                                                                                                                   |
| `cms`          |      3 | `article_categories`, `articles`, `article_contents`                                                                                                                                                                                                                                                                                                                                                      |
| `notification` |      3 | `notification_templates`, `notification_messages`, `sms_logs`                                                                                                                                                                                                                                                                                                                                             |
| `wechat`       |      7 | `wechat_identities`, `wechat_oa_menus`, `wechat_auto_replies`, `wechat_qrcode_categories`, `wechat_qrcodes`, `wechat_qrcode_scans`, `wechat_media`                                                                                                                                                                                                                                                        |
| `stats`        |      3 | `product_events`, `user_visits`, `search_logs`                                                                                                                                                                                                                                                                                                                                                            |
| **Total**      | **82** |                                                                                                                                                                                                                                                                                                                                                                                                           |

### Required extension

`products_name_trgm_idx` and `products_keyword_trgm_idx` are GIN indexes using
`gin_trgm_ops`. **The `0000_init` migration creates `pg_trgm` before the
`CREATE INDEX` statements**:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

Drizzle does not emit this; it is written by hand at the top of `0000_init`.
Without it the migration fails with
`operator class "gin_trgm_ops" does not exist`.

---

## 2. State machines

### 2.1 `orders.status`

An order's state is three orthogonal columns with one meaning each: `status`
(below), `fulfillment_status` (§2.2) and `refund_status` (§2.3). There is no
split hierarchy (§6.1).

| From                                             | Event                                           | To                |
| ------------------------------------------------ | ----------------------------------------------- | ----------------- |
| —                                                | order created                                   | `pending_payment` |
| `pending_payment`                                | payment notification accepted                   | `paid`            |
| `pending_payment`                                | buyer cancels / auto-cancel job fires           | `cancelled`       |
| `paid`                                           | `fulfillment_status` reaches `fulfilled`        | `shipped`         |
| `shipped`                                        | buyer confirms receipt / auto-confirm job fires | `received`        |
| `received`                                       | buyer reviews, or the review window closes      | `completed`       |
| `paid` \| `shipped` \| `received` \| `completed` | every line fully refunded                       | `refunded`        |

`cancelled`, `completed` and `refunded` are terminal. **`paid` is never
reachable from `cancelled`** — the conditional update is
`WHERE id = $1 AND status = 'pending_payment'`, so a late notification for a
cancelled order becomes a `payment_exceptions` row instead (ORDER-006,
PAY-011).

### 2.2 `orders.fulfillment_status`

| From                                   | Event                                                                  | To                    |
| -------------------------------------- | ---------------------------------------------------------------------- | --------------------- |
| `unfulfilled`                          | a shipment covering some lines is dispatched                           | `partially_fulfilled` |
| `unfulfilled` \| `partially_fulfilled` | every line's `shipped_quantity` reaches `quantity - refunded_quantity` | `fulfilled`           |

The admin "to ship" list is
`status = 'paid' AND fulfillment_status IN ('unfulfilled','partially_fulfilled')`.
`orders_fulfillment_matches_status` enforces that `shipped`, `received` and
`completed` imply `fulfilled`.

### 2.3 `orders.refund_status`

| From                                | Event                                          | To                   |
| ----------------------------------- | ---------------------------------------------- | -------------------- |
| `none`                              | a refund row is created                        | `requested`          |
| `requested`                         | refund rejected or cancelled, none left open   | `none`               |
| `requested`                         | a refund succeeds, some units still unrefunded | `partially_refunded` |
| `requested` \| `partially_refunded` | every unit refunded                            | `refunded`           |

### 2.4 `refunds.status`

| From                    | Event                                             | To                                                |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------- |
| —                       | buyer applies                                     | `applied`                                         |
| `applied`               | operator approves, `kind = 'refund_only'`         | `processing`                                      |
| `applied`               | operator approves, `kind = 'return_and_refund'`   | `approved` (`return_stage = 'awaiting_shipment'`) |
| `applied`               | operator rejects (reason required)                | `rejected`                                        |
| `applied` \| `approved` | buyer withdraws                                   | `cancelled`                                       |
| `approved`              | goods received back (`return_stage = 'received'`) | `processing`                                      |
| `processing`            | gateway confirms                                  | `succeeded`                                       |
| `processing`            | gateway refuses                                   | `failed`                                          |
| `processing`            | gateway answer lost                               | `unknown`                                         |
| `unknown`               | query by the frozen `out_refund_no`               | `succeeded` \| `failed`                           |

**Open** = `applied | approved | processing | unknown`. `refund_items.is_open`
mirrors that set and is flipped in the same statement that changes
`refunds.status`.

`unknown` is never resolved by re-sending. `out_refund_no` and `amount` are
frozen at creation and NOT NULL, so a retry carrying a different amount is
detectable and must be refused (REFUND-005, REFUND-006).

### 2.5 `payment_attempts.status`

| From                                   | Event                                                      | To                 |
| -------------------------------------- | ---------------------------------------------------------- | ------------------ |
| —                                      | attempt row created before the gateway call                | `creating`         |
| `creating`                             | gateway accepted, `prepay_id` returned                     | `submitted`        |
| `creating`                             | gateway refused                                            | `failed`           |
| `submitted`                            | notification or query reports paid                         | `paid`             |
| `submitted`                            | cancellation asks the gateway to close                     | `closing`          |
| `closing`                              | gateway confirms the close (`closed_confirmed_at` stamped) | `closed`           |
| `closing`                              | close reports the order was in fact paid                   | `paid`             |
| `creating` \| `submitted` \| `closing` | gateway result lost                                        | `unknown`          |
| `unknown`                              | query by `out_trade_no`                                    | `paid` \| `closed` |

Only `closed` — which `payment_attempts_closed_shape` requires to carry
`closed_confirmed_at` — permits releasing stock and the coupon (QUEUE-003,
QUEUE-004, PAYC-002).

### 2.6 `groupbuy_groups.status`

| From      | Event                               | To                            |
| --------- | ----------------------------------- | ----------------------------- |
| —         | leader's payment succeeds           | `forming` (`seats_taken = 1`) |
| `forming` | a member joins, seats remain        | `forming`                     |
| `forming` | the last seat is taken              | `succeeded`                   |
| `forming` | `expires_at` passes with seats left | `failed`                      |
| `forming` | operator cancels                    | `cancelled`                   |

Taking a seat is one conditional update:

```sql
UPDATE groupbuy_groups
   SET seats_taken = seats_taken + 1
 WHERE id = $1 AND status = 'forming'
   AND expires_at > now() AND seats_taken < seats_total
```

`groupbuy_groups_seats_within_total` is the backstop, and
`groupbuy_groups_succeeded_is_full` forbids a `succeeded` group that is not
exactly full.

**Leader demotion.** When the leader refunds, their `groupbuy_members` row goes
to `refunded` and the first remaining `joined` member is promoted to `leader`,
with `groupbuy_groups.leader_user_id` following.
`groupbuy_members_leader_uq` (partial unique on `group_id WHERE role = 'leader'
AND status = 'joined'`) makes "exactly one leader" true at every instant.

### 2.7 `user_coupons.status`

| From     | Event                                                     | To        |
| -------- | --------------------------------------------------------- | --------- |
| —        | claimed / granted / gifted                                | `unused`  |
| `unused` | spent on an order                                         | `used`    |
| `unused` | `valid_to` passes                                         | `expired` |
| `unused` | operator revokes                                          | `revoked` |
| `used`   | the order that used it is refunded and returns the coupon | `unused`  |

Redemption is one conditional update
(`WHERE id = $1 AND user_id = $2 AND status = 'unused' AND now() BETWEEN
valid_from AND valid_to`) and the service requires exactly one affected row
(COUPON-004 … COUPON-006).

### 2.8 `presale_orders.stage`

| Mode      | From              | Event                | To              |
| --------- | ----------------- | -------------------- | --------------- |
| `full`    | `final_pending`   | payment succeeds     | `final_paid`    |
| `deposit` | `deposit_pending` | deposit paid         | `deposit_paid`  |
| `deposit` | `deposit_paid`    | balance window opens | `final_pending` |
| `deposit` | `final_pending`   | balance paid         | `final_paid`    |
| both      | `*_pending`       | window closes unpaid | `expired`       |
| both      | any               | order cancelled      | `cancelled`     |

See §6.3 — the deposit half is declared but not yet driven by any flow.

---

## 3. Invariants the database enforces

Every one of these is exercised by `scripts/check-constraints.sql`.

| #   | Invariant                                    | Mechanism                                                                          |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | SKU stock never goes negative                | `product_skus_stock_non_negative`                                                  |
| 2   | Coupon supply never oversells                | `coupon_templates_counts_non_negative` + `coupon_templates_remaining_within_total` |
| 3   | A group never oversells its seats            | `groupbuy_groups_seats_within_total`                                               |
| 4   | One leader per group                         | `groupbuy_members_leader_uq`                                                       |
| 5   | One merchant order number, ever              | `payment_attempts_out_trade_no_uq`                                                 |
| 6   | One open payment attempt per order           | `payment_attempts_open_uq`                                                         |
| 7   | `closed` implies a gateway-confirmed close   | `payment_attempts_closed_shape`                                                    |
| 8   | One capital-flow row per payment or refund   | `capital_flows_reference_uq` (`kind`, `reference`)                                 |
| 9   | One effect row per (scope, aggregate, event) | `effects_scope_event_key`                                                          |
| 10  | One in-flight refund per order item          | `refund_items_open_uq`                                                             |
| 11  | Refunds never exceed what was collected      | `orders_refunded_within_paid`                                                      |
| 12  | Never refund more units than bought          | `order_items_refunded_within_quantity`                                             |
| 13  | One gateway refund number, ever              | `refunds_out_refund_no_uq`                                                         |
| 14  | A one-per-user coupon is claimed once        | `user_coupons_slot_uq`                                                             |
| 15  | A gift coupon is issued once per order       | `user_coupons_order_gift_uq`                                                       |
| 16  | A card serves at most one order item         | `product_virtual_cards_order_item_uq`                                              |
| 17  | `claimed` card ⇔ an order item               | `product_virtual_cards_claim_consistent`                                           |
| 18  | Case-insensitive unique logins               | `users_account_lower_uq`, `users_phone_lower_uq`                                   |
| 19  | One default address per user                 | `user_addresses_default_uq`                                                        |
| 20  | A paid order has a payment time and amount   | `orders_paid_shape`                                                                |
| 21  | Never ship more units than bought            | `order_items_shipped_within_quantity`                                              |

### 3.1 Why "one open refund per order **item**"

The rule is "at most one open refund per order item". The shape is a partial
unique index on `refund_items(order_item_id) WHERE is_open`,
backed by `refund_items.is_open`, a boolean that mirrors the parent refund's
open-ness and is written in the same statement that changes `refunds.status`.

- It is **per item**, not per order. Blocking a second after-sale on the whole
  order would forbid refunding two different lines concurrently. Nothing in the
  business requires that, so the constraint follows the items.
- A partial index cannot read another table, hence the denormalised `is_open`
  rather than a predicate over `refunds.status`. The refund domain **must** keep
  it in step; that is the one hand-maintained invariant in the schema.
- The cumulative ceiling (`SUM(refunds) <= paid`) is a _different_ invariant and
  is not this index's job — it is `orders_refunded_within_paid` under a
  `SELECT … FOR UPDATE` on the order row (REFUND-007).
- Fulfilment must still refuse to ship while any refund on the order is open;
  that is a service rule, not a constraint.

### 3.2 Why `user_coupons.claim_slot`

"At most N per user" cannot be a plain unique index, and a partial index cannot
read `coupon_templates.per_user_limit`. So each claim carries its ordinal:

```sql
-- inside the claim transaction
SELECT coalesce(max(claim_slot), 0) + 1             AS claim_slot,
       count(*) FILTER (WHERE status <> 'revoked')  AS held
FROM user_coupons WHERE template_id = $1 AND user_id = $2;
-- assert held < template.per_user_limit, then INSERT with claim_slot
```

`user_coupons_slot_uq (template_id, user_id, claim_slot)` means two concurrent
claims compute the same slot and exactly one survives. A one-per-user template
is simply `per_user_limit = 1`. There is no read-then-write window, and no
advisory lock.

A revoked coupon (作废, or a refund taking back an order's gift) keeps its slot
but no longer counts as held, so revoking gives the user's place under the
limit back; the next issue takes the slot after the highest one used.

### 3.3 Virtual card claiming

```sql
UPDATE product_virtual_cards
   SET state = 'claimed', order_item_id = $1, claimed_by_user_id = $2, claimed_at = now()
 WHERE id = (SELECT id FROM product_virtual_cards
              WHERE sku_id = $3 AND state = 'unclaimed'
              ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
```

`product_virtual_cards_order_item_uq` (partial unique on `order_item_id WHERE
order_item_id IS NOT NULL`) makes a retry of the delivery effect a no-op.

**Consequence, which checkout and fulfilment honour:** one order item can hold
at most one card, so a `virtual_card` product must be sold with `quantity = 1`
per line. If multi-card lines are ever wanted, the index becomes
`(order_item_id, claim_slot)` and the constraint moves to the service.

### 3.4 Immutable payment-attempt context

`out_trade_no`, `provider`, `channel`, `mch_id`, `app_id`, `amount`,
`payer_user_id` and `context` are frozen at insert (PAYC-004). There is no
trigger enforcing this — the schema has no triggers at all — so the payment
domain never `UPDATE`s those columns. A repeated pay tap replays the open row (found via
`payment_attempts_open_uq`); a request that disagrees with any frozen column is
refused, not merged.

---

## 4. `effects.event_type` registry

`event_type` is `varchar(64)`, **not** an enum. A `pgEnum` would need
`ALTER TYPE … ADD VALUE` for every new handler, and that statement cannot run
inside a migration transaction — with every domain registering effects, that is
a hazard rather than safety. Handlers are declared in
`core/<domain>/effects.ts`; keys are dotted and prefixed by domain.

For example (a domain adds more without a migration):

```
order.paid                 order.cancelled           order.shipped
order.received             order.completed           order.refunded
catalog.stock.commit       catalog.stock.release     catalog.virtual_card.issue
coupon.gift.issue          coupon.return             coupon.redeem
groupbuy.join              groupbuy.settle           presale.stock.reserve
presale.stock.release      payment.capital_flow      refund.capital_flow
notification.order_paid    notification.order_shipped
```

`order_status_logs.change_type` **is** an enum, because the order timeline is a
fixed vocabulary the operator console renders, not an extension point.

---

## 5. References to `admins`

Every operator reference is `ON DELETE SET NULL` (an admin
leaving must never delete business history): `attachments.uploaded_by_admin_id`,
`product_reviews.reply_by_admin_id`, `user_cancellation_requests.reviewed_by_admin_id`,
`order_status_logs.operator_admin_id`, `shipments.operator_admin_id`,
`order_invoices.issued_by_admin_id`, `payment_exceptions.operator_admin_id`,
`refunds.reviewed_by_admin_id`, `refund_logs.operator_admin_id`.
`notification_messages.admin_id` is `ON DELETE CASCADE`: an admin's inbox goes with the admin.
`user_sessions.user_id` references `users` with `ON DELETE CASCADE`.

`auth.ts` and the business files import each other, so these references are written
`(): AnyPgColumn => admins.id`.

PostgreSQL truncates identifiers at 63 bytes, and seven of Drizzle's generated
FK constraint names exceed that (all on `shipping_template_*`,
`groupbuy_activities`, `presale_activities`, `presale_stock_ledger`). They
truncate to distinct names and apply cleanly — the migration only emits
`NOTICE`s — but if any pair ever collides, name the constraints explicitly
rather than renaming the tables.

---

## 6. Design decisions

### 6.1 No order splitting — `shipments` instead

An order is never split into child orders. Partial shipment is one or more
`shipments` rows with `shipment_items`, and `order_items.shipped_quantity` is
the progress. Money is never re-divided, so coupon, postage and payment never
have to be re-prorated across children, and the refund ceiling is a single row
check. There is no parent/child order and no "order family" to walk.

### 6.2 `orders.status` has seven values

`received` sits between `shipped` and `completed` because the storefront has a
distinct 待评价 tab: received, not yet reviewed.

### 6.3 Presale deposits are declared but inert

`presale_activities` carries `payment_mode` (全款/定金), the deposit amount and the
balance window, and the admin form edits them — but **no order flow reads them
yet**. A presale order is one order, paid once, in full.

The columns and `presale_orders.stage` are kept so the deposit flow can be
turned on without a schema change. Until then every presale order goes
`final_pending → final_paid`, and `presale_activities_deposit_shape` makes a
half-configured deposit activity impossible.

### 6.4 The coupon ↔ order link runs one way

`orders.user_coupon_id` points at the coupon spent on the order;
`user_coupons.source_order_id` points at the order that _earned_ a gift coupon.
There is no `user_coupons.used_order_id`. "Which order used this coupon" is
`SELECT … FROM orders WHERE user_coupon_id = $1`.

### 6.5 Schema files import each other in cycles

`catalog ↔ order`, `coupon ↔ order` and `refund → order/payment` form import
cycles. This is safe — every `.references()` is a lazy thunk — and it is what
lets `product_reviews.order_item_id` and `user_coupons.source_order_id` be real
foreign keys. TypeScript needs a hand: the column on one side of each cycle is
annotated `(): AnyPgColumn => other.id` to break the inference loop. If you add
a cross-file reference and hit `TS7022`, that is the fix.

### 6.6 `cart_items` is only the cart

There is no "buy now" pseudo-cart row, no `combination_id`, no `advance_id`.
A direct purchase, a group-buy join and a presale order are built from the
request payload. Order creation takes either a list of `cart_items` ids or a
direct-purchase payload.

### 6.7 Denormalised counters

`products.stock`, `products.sales` and `products.price` mirror the SKU rows for
list filtering and sorting. The authoritative values are on `product_skus`;
stock is only ever decremented there. The catalog domain keeps the mirrors in
step, always with an aggregate `UPDATE`, never a read-then-write.

### 6.8 `payment_callbacks`

PAY-007 (two callbacks pay an order exactly once) and late or duplicate
notifications are much easier to get right when a replayed notification
collides on `(mch_id, provider_notify_id)` than when the handler has to reason
about it alongside the attempt state machine.

### 6.9 `wechat_auto_replies.trigger_kind`

`trigger` is a reserved word in PostgreSQL and would break the raw predicate of
the partial unique index, so the column is `trigger_kind`. The same reasoning
names `product_skus.sku_code`, `order_items.item_key` and the `code` columns
(rather than `unique` and `key`).

---

## 7. Seeds

`src/seed/index.ts` exports `seedReference(db)` and runs standalone with
`pnpm --filter @shop/db db:seed` (needs `DATABASE_URL`). It is idempotent:
every statement is an upsert on a natural key.

| Data                     | Source                                 | Rows |
| ------------------------ | -------------------------------------- | ---- |
| `cities`                 | `seed-data/cities.json`                | 3221 |
| `express_companies`      | `seed-data/express-companies.json`     | 25   |
| `agreements`             | shells in `src/seed/reference-data.ts` | 4    |
| `notification_templates` | shells in `src/seed/reference-data.ts` | 17   |

The two JSON files are committed reference data. The division tree
(`parent_id` points at another city's `id`; `code` is the 12-digit division
code) is generated by `scripts/build-cities.ts` from the Ministry of Civil
Affairs list 《中华人民共和国县以上行政区划代码》 (2023 edition); see the script
for how municipalities and directly administered counties are laid out. The
courier list holds the common carriers under the tracking provider's codes;
the 13 most used arrive enabled. Cities and courier companies carry explicit ids, so
a stored address, freight rule or shipment points at the same row after every
re-seed.

Agreements and notification templates are seeded as **shells**: the code and the
title are the contract the application depends on, the body is
installation-specific and is typed by an operator. An existing body is never
overwritten.

Nothing else is seeded — no demo products, no menus, no configuration, no admin
account.
