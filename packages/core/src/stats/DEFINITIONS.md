# 统计口径 — one definition per figure

Every number on every statistics screen, the admin home page included, is
computed from exactly one of the definitions below. Nothing on a page may
redefine a figure locally, and a figure that cannot be sourced is **dropped**
rather than shown as zero.

Why this file exists: 营业额 has several plausible definitions — by payment
time excluding refunded orders, by creation time including them — and so do
退款 and 访客. Let each screen pick one and three screens show three different
numbers for the same day, with no way for the operator to know which is right.
So: one figure, one definition, one SQL expression, read by every page.

---

## 1. The window

- Both ends of a range are **Asia/Shanghai calendar days**. `from` is the
  Shanghai midnight that opens the first day; `to` is the Shanghai midnight
  that opens the day _after_ the last one, and every comparison is
  `paid_at >= from and paid_at < to`. No `BETWEEN`, no `23:59:59`, so a
  payment at 23:59:59.7 is never lost.
- Omitting the range means **the last 30 Shanghai days ending today**
  (today included).
- The range may not be inverted and may not exceed **1096 days** (three years
  plus a leap day); either is `STATS_RANGE_INVALID` with `details.maxDays`.
- The **bucket is derived from the length, never chosen**: up to 2 days →
  `hour`, up to 92 days → `day`, beyond that → `month`. A caller-chosen bucket
  invites a 3-month window bucketed daily, drawn as every third label of a
  daily series, silently dropping two thirds of the data.
- Bucket labels: `09` for an hour, `2026-02-03` for a day, `2026-02` for a
  month. Every series has exactly one value per bucket, in bucket order, zero
  where nothing happened — an empty bucket is a true zero, not a gap.
- `previous` on a tile is the same figure over **the window of the same length
  immediately before this one**. It is `null` for a running total (累计用户),
  where a comparison is meaningless.

**Shanghai, not UTC, and not the server's zone.** Bucketing is
`date_trunc('day', ts at time zone 'Asia/Shanghai')`, cast back to an instant
with `at time zone 'Asia/Shanghai'`. The TypeScript side builds the same
boundaries from a fixed **+08:00** offset: mainland China has observed no
daylight saving since 1991 and every row in this database is later than that,
so the fixed offset and the tz database agree on every boundary this code can
meet. `stats.int.test.ts` pins that agreement with a fixture that straddles a
Shanghai midnight (`23:30 +08:00` and `00:30 +08:00` land in different days
even though they are the same UTC day).

## 2. The populations

| Term                 | Exactly                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **paid order**       | `orders.paid_at is not null and orders.deleted_at is null`, bucketed by `paid_at`                                   |
| **placed order**     | `orders.deleted_at is null`, bucketed by `created_at` — a submitted order, paid or not                              |
| **succeeded refund** | `refunds.status = 'succeeded' and refunds.deleted_at is null`, bucketed by `succeeded_at`, amount `refunded_amount` |
| **product view**     | `product_events.kind = 'view'`, bucketed by `created_at`                                                            |
| **add to cart**      | `product_events.kind = 'cart'`, bucketed by `created_at`                                                            |
| **favourite**        | `product_favorites`, bucketed by `created_at`                                                                       |
| **page view**        | one `user_visits` row, bucketed by `created_at`                                                                     |
| **registration**     | `users`, bucketed by `created_at`, cancelled accounts included                                                      |

An admin-deleted order (`orders.deleted_at`) is out of every figure: the
operator deleted it because it should not be counted. A buyer hiding an order
from their own list (`hidden_by_user_at`) changes nothing.

**Money is bucketed where the money moved.** A payment counts on the day it was
taken; a refund counts on the day it went back, not on the day the order was
paid. So a day's 营业额 never changes retroactively — which is the property an
operator reading last month's chart needs. The alternative,
`sum(paid_amount - refunded_amount)` by `paid_at`, rewrites history whenever
an old order is refunded, and it cannot be combined with refunds counted by
`succeeded_at`: 营业额 would then be neither the paid-day figure nor the cash
figure.

## 3. The figures

### Trade — `GET /admin-api/stats/trade`

| Key                 | 名称         | Definition                                                                     |
| ------------------- | ------------ | ------------------------------------------------------------------------------ |
| `revenue`           | 营业额       | `Σ orders.paid_amount` (paid orders) − `Σ refunds.refunded_amount` (succeeded) |
| `goodsPaidAmount`   | 商品支付金额 | `Σ order_items.total_amount` over the paid orders of the bucket                |
| `refundAmount`      | 商品退款金额 | `Σ refunds.refunded_amount` over the succeeded refunds of the bucket           |
| `freightAmount`     | 运费收入     | `Σ orders.freight_amount` over the paid orders of the bucket                   |
| `paidOrderCount`    | 支付订单数   | count of paid orders in the bucket                                             |
| `averageOrderValue` | 客单价       | `revenue ÷ paidOrderCount`, two decimals, `0` when nothing was paid            |

`order_items.total_amount` is the line after its share of every discount, so
`goodsPaidAmount + freightAmount` equals `Σ paid_amount` except on an order an
operator re-priced by hand; `revenue` follows the gateway, never the lines.
A refund that returns freight (`refunds.includes_freight`) reduces `revenue`
and `refundAmount`; it does not reduce `freightAmount`, which is what was
collected.

### Orders — `GET /admin-api/stats/orders`

| Key                | 名称       | Definition                                                                         |
| ------------------ | ---------- | ---------------------------------------------------------------------------------- |
| `paidOrderCount`   | 订单量     | same figure as 支付订单数 above                                                    |
| `paidAmount`       | 订单销售额 | `Σ orders.paid_amount` over the paid orders of the bucket                          |
| `refundOrderCount` | 退款订单数 | `count(distinct refunds.order_id)` over succeeded refunds                          |
| `refundAmount`     | 退款金额   | same figure as 商品退款金额 above                                                  |
| `refundRate`       | 退款率     | `refundOrderCount ÷ paidOrderCount × 100`, two decimals, `0` when nothing was paid |

退款率 counts every succeeded refund — 仅退款 and 退货退款 alike — because
both are a sale that did not stick. Its two counts are bucketed where each
happened (payments by `paid_at`, refunds by `succeeded_at`), so a short window
can show a refund for an order paid before it, and the rate is only meaningful
over a window of weeks, which is why the home page shows it for the last 30 days.

Breakdowns: **订单来源** counts paid orders by `orders.platform`, **订单类型**
sums `orders.paid_amount` by `orders.kind`. Percentages are of the window's
total, two decimals, and a kind that never occurred is absent rather than 0 %.

### Sales — `GET /admin-api/stats/sales`

The 销售看板 brings the sales figures of the two pages above onto one screen.
None of its tiles is a new figure:

| Key                 | 名称         | Same figure as               |
| ------------------- | ------------ | ---------------------------- |
| `revenue`           | 营业额       | 交易统计 `revenue`           |
| `goodsPaidAmount`   | 商品支付金额 | 交易统计 `goodsPaidAmount`   |
| `paidOrderCount`    | 支付订单数   | 交易统计 `paidOrderCount`    |
| `averageOrderValue` | 客单价       | 交易统计 `averageOrderValue` |
| `paidQuantity`      | 支付件数     | 商品统计 `paidQuantity`      |
| `refundAmount`      | 退款金额     | 交易统计 `refundAmount`      |
| `refundRate`        | 退款率       | 订单统计 `refundRate`        |

Its chart is 营业额 and 支付订单数 per bucket, and its breakdowns are 订单统计's
订单来源 and 订单类型. What it adds:

- **去年同期 (`yearAgo`)**. On every tile, next to `previous`. It is the same
  figure over **the same Shanghai calendar days one year earlier**: the first
  and the last day of the window each move back a year, and 29 February
  becomes the 28th. So a window that contains 29 February is one day shorter a
  year earlier. That is the calendar's doing, and it is better than comparing
  against a window shifted by 365 days, which starts on a different date.
- **时段分布 (`hourly`)**. Paid orders and `Σ orders.paid_amount`, grouped by
  the Shanghai hour of `paid_at` (`00`…`23`) and summed over every day of the
  window. Exactly 24 points, zero where nothing was paid. It answers "which
  hours sell", not "what happened at 9 on the 3rd"; that is the trend chart's
  job over a one-day window.
- **分类销售 (`categories`)**. The lines of the window's paid orders
  (`order_items.total_amount` and `quantity`, as 商品支付金额 and 支付件数),
  attributed to each **top-level** category their product is in **now**:
  - The root of a category is the first id of its materialised path
    (`/3/17/` → 3), or the category itself when its path is `/`.
  - `order_items` carries no category snapshot, so recategorising a product
    moves its past sales with it. There is no other source, and inventing a
    snapshot from today's tree would be no truer.
  - A product filed under two subcategories of one root counts once there. A
    product under two roots counts in both, so the rows' `percent` (of 商品支付金额)
    can add up to more than 100. The page says so under the table.
  - A product in no category is **未分类**, which is sorted last. A soft-deleted
    category keeps its name: the sales happened under it.
  - `orderCount` is `count(distinct order_id)` of those lines.

Export (`…/sales/exports`): the category rows as CSV (分类, 支付金额, 支付件数,
支付订单数, 占比).

### Users — `GET /admin-api/stats/users`

| Key           | 名称         | Definition                                                                                       |
| ------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| `visitors`    | 访客数       | `count(distinct coalesce(user_id::text, 'ip:' \|\| ip))` over page views                         |
| `pageViews`   | 浏览量       | count of page views                                                                              |
| `avgStay`     | 平均停留时长 | `avg(stay_ms) ÷ 1000` over the page views that reported a stay, whole seconds, `0` when none did |
| `newUsers`    | 新增用户     | registrations in the bucket                                                                      |
| `payingUsers` | 成交用户数   | `count(distinct orders.user_id)` over paid orders                                                |
| `totalUsers`  | 累计用户     | live accounts (`deleted_at is null`) created before the end of the window                        |

A distinct count is **not** additive: the window's 访客数 is its own query, not
the sum of its buckets, and the same visitor on two days counts once in the
tile and twice in the chart. That is correct and is what every analytics tool
does; summing the buckets would over-count.

Breakdown: **下单来源** counts paid orders by `orders.platform`.

### 用户地域 — `GET /admin-api/stats/users/regions`

One row per province, and **each column carries the province that column
actually knows**, which is stated here rather than fudged into one join:

| Column       | Province comes from                                                               |
| ------------ | --------------------------------------------------------------------------------- |
| `totalUsers` | the user's default address (`user_addresses.province_name`)                       |
| `newUsers`   | the same, for accounts registered inside the window                               |
| `visitors`   | `user_visits.province` — the visitor's default address when the view was recorded |
| `paidAmount` | `orders.receiver_province` — where the goods actually went                        |

A user with no address, or a visit with no province — every anonymous visit,
and a signed-in visitor with no default address — is grouped under **未知**,
which is sorted last whatever the sort key. `totalUsers` ignores the
window (it is a running total); the other three are inside it.

### Products — `GET /admin-api/stats/products` and `…/ranking`

| Key               | 名称            | Definition                                                                |
| ----------------- | --------------- | ------------------------------------------------------------------------- |
| `productViews`    | 商品浏览量      | product views in the bucket                                               |
| `productVisitors` | 商品访客数      | `count(distinct user_id)` over product views, anonymous views excluded    |
| `cartQuantity`    | 加购件数        | `Σ product_events.quantity` over add-to-cart events                       |
| `orderQuantity`   | 下单件数        | `Σ order_items.quantity` over the **placed** orders of the bucket         |
| `paidQuantity`    | 支付件数        | `Σ order_items.quantity` over the **paid** orders of the bucket           |
| `paidAmount`      | 支付金额        | same figure as 商品支付金额                                               |
| `refundQuantity`  | 退款件数        | `Σ refund_items.quantity` over succeeded refunds                          |
| `refundAmount`    | 退款金额        | same figure as 商品退款金额                                               |
| `payConversion`   | 访问-支付转化率 | `payingViewers ÷ productVisitors × 100`, two decimals, `0` when no viewer |
| `favorites`       | 收藏数          | favourites added in the bucket (ranking rows only)                        |

`payingViewers` is `count(distinct user_id)` over the paid orders of the
window; on a ranking row it is that count for the one product. A signed-out
visitor can be counted in 浏览量 but never in 访客数 — `product_events` has no
session identity, only `user_id`, and inventing one would make the conversion
rate a fiction.

**Ranking rows** are the same figures grouped by product instead of by bucket,
sorted by one of `views | visitors | cartQuantity | orderQuantity |
paidQuantity | paidAmount | favorites` descending with the product id as the
tie-break, so the page is stable between reloads. Only products with at least
one non-zero figure in the window appear.

## 4. Where the rows come from

- **访客数 / 浏览量 / 平均停留时长** come from `user_visits`, filled by the
  storefront page-view beacon (`POST /api/v1/visits`, the user domain). The
  client reports each page twice: when it is shown, which records the view,
  and when it is hidden, with the time it was on screen, which is added to
  that view's `stay_ms` — capped at 30 minutes per view and never more than
  the time since the view was recorded. A view whose hide report never came
  has a null `stay_ms` and is left out of the average.
- **地域访客** reads `user_visits.province`, which the beacon fills from the
  signed-in visitor's default address. There is no IP geolocation: the shop
  ships no IP-to-region database and calls no third-party service, so an
  anonymous visit is honestly 未知 rather than confidently wrong.
- **Retention.** `user_visits` keeps `stats.visitRetentionDays` days (400 by
  default, so a month can be compared with the same month a year earlier);
  the nightly `user.pruneVisits` job deletes older rows. A window reaching
  past it reads 0 for the traffic figures.
- **加购件数** comes from `product_events` rows of `kind = 'cart'`, written
  inside the cart's add transaction. `cart_items` is not a substitute, because
  a row is deleted when the order is placed, so yesterday's additions would
  disappear from history exactly when they start to matter.

Everything else: `product_events` carries `view` and `favorite` rows from the
catalog domain, and the order, payment and refund figures come from `orders` /
`order_items` / `refunds` / `refund_items` directly, which is why this domain
does **not** need `kind in ('order', 'pay', 'refund')` events and must never
write them.

## 5. Not reported — absent, never zero-filled

Statistics for features this shop does not have are absent from every
response rather than present and zero: 余额 / 充值 / 佣金 / 积分 / 付费会员,
资金流水 and 账单记录 (a balance ledger), 余额统计, and the WeChat-subscribe
block. There are no separate home-page dashboard endpoints either: the home
page's tiles arrive through `registerDashboardContributor`, and its charts are
`stats/orders`, `stats/users` and `stats/products/ranking` — the same three
definitions as the pages, not a fourth copy. The same holds for 销售看板:
`stats/sales` reads the queries 交易统计 and 订单统计 read.

## 6. Reading rules

- **Read-only, always.** `stats.repo.ts` is the only file in this domain that
  touches a table, it contains nothing but `select`, and it is the one place in
  the system allowed to read another domain's tables. No `insert`, no `update`,
  no `delete`, no transaction: a statistics page that can write is a statistics
  page that can corrupt.
- **Every block is cached in Redis for 60 seconds**, keyed by the block, the
  resolved window and the query's own arguments. `generatedAt` is the clock
  reading of the computation, so a cached block visibly lags — which is the
  honest thing to show.
