# C1-cutover-remove 状态

分支 `storefront/mini-C1-cutover-remove`（自 `storefront/mini` @ 925a2250c）。范围：`docs/mini/cutover.md` 第 2 节的删除
（2.1–2.8、2.11），以及 5.1 的 api-compat 刷新。2.9、2.10 和 `deploy/`、`.github/`、`docker/` 不在本任务内，留给 C2。
按 2.12，`auth.oa*`、`wechatOa.*` 和 `wechat_h5` 全部保留。

## 已完成

| 节   | 提交        | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | `f7a62e65a` | 删除 `apps/uni-app`，以及 workspace、ignore 和文档里对它的引用。                                                                                                                                                                                                                                                                                                                                                                    |
| 2.8  | `56f1048f0` | 删除 uniapp guard，并去掉 retired 检查里给 uni-app 的豁免。                                                                                                                                                                                                                                                                                                                                                                         |
| 2.2  | `c143a1d96` | 删除 uni-app 店面 e2e。e2e-storefront 现在只跑小程序。                                                                                                                                                                                                                                                                                                                                                                              |
| 2.3  | `06b4f1c34` | 删除旧装修的 domain、`/api/v1/diy/*`、后台 diy 接口和编辑器；菜单「店铺装修（新版）」改为「店铺装修」。`load/lib/seed.ts` 改为建 decor v2 首页。invariants 删除 DIY-001…009 和 SMOKE-010。                                                                                                                                                                                                                                          |
| 2.4  | `2b8aa29e4` | 删除 `catalog.categoryVersion`、`catalog.skuPrice`、`cart.decrementItem`、`system.attachmentDataUrl`，以及 `system.siteConfigGet` 的路由和契约。core 的 `siteConfigGet` 保留但不再导出：`app-config` 复用它的构建函数，测试拿它当对照（见待定问题 1）。SYS-016、SYS-020 措辞已更新。                                                                                                                                                |
| 2.5  | `2662f8bc1` | 删除 `apps/web/app/api/v1/staff/**`（36 个接口），以及订单、用户、商品的店员契约。另外删除了 2.5 漏列的优惠券店员接口；`coupon.staff.contract.ts` 改名为 `coupon.gift.contract.ts`，只保留 `coupon.orderGiftCoupons`。core 删除 `StaffCheck`、`StaffRefundPort`、`orderStaffConfig`（「店员与订单提醒」）、各店员服务、存储的店员分支和两个配置键。`AuthMode` 和 `ActorKind` 去掉 `staff`。invariants 删除 AUTH-004，SYS-012 改写。 |
| 2.6  | `c78576da4` | 删除 `wechat.storefront.contract.ts`、`/api/v1/wechat/mini-qrcodes`、`MINI_CODE_PAGES` 等旧路径常量，以及 core 的 `miniCodeUrl`。测试改为针对 `shareMiniCodeUrl`。SHARE-001、SHARE-003 已改写；契约示例改成新路径。                                                                                                                                                                                                                 |
| 2.7  | `b579fa480` | 用户通知不再带 `link`：注册表、拼团、预售都删了；注册时如果用户事件带 `link`，直接抛错（NOTIF-006，有新测试）。管理员事件保留 `link`（铃铛）。删除 `wechatMini.page`，库里已存的这个键读取时丢弃。后台去掉「小程序页面」字段。                                                                                                                                                                                                      |
| 2.11 | `381511eff` | 删除 `schema/diy.ts`。生成迁移 `0008_drop_legacy_diy.sql`：4 条 `DROP TABLE … CASCADE`，每条都带 `-- destructive: approved — <理由>`；另有 3 条 `DROP TYPE`。`EXPECTED_MIGRATIONS` 从 8 改为 9。删除 `check-constraints.sql` 第 15 项。SCHEMA.md 同步：表 86→82，约束 22→21，§6.9 删除。                                                                                                                                            |
| —    | `6c7b2e8a7` | 把仍把 uni-app 当作在用的注释改写掉（不涉及逻辑）。                                                                                                                                                                                                                                                                                                                                                                                 |
| 5.1  | `993ec03e5` | 以 `--release 1.0.0` 重刷 `guards/baselines/storefront-api.json`，清单见下。刷新后 api-compat 对 1.0.0 为 0 条（共 135 个接口）。                                                                                                                                                                                                                                                                                                   |

cutover.md 已勾选 2.1–2.8、2.11（第 5 项除外）和 5.1 的前两条，路径错误已顺手改正，各节都附了 C1 备注。
测试只覆盖被删代码的，已随代码删除；invariants 中退役的规则 ID 已删行，引用都能对上（`pnpm guards` invariants 通过）。

### api-compat 原谅清单（51 条，全部在 2.3–2.6 计划内）

- `/api/v1/diy/*`，8 条：`layouts/{type}`、`navigation`、`pages/{id}`、`pages/home`、`pages/product-detail`、`pages/user-center`、`theme`、`version`。
- 辅助接口，5 条：`POST attachments/base64`、`POST cart/items/decrements`、`GET catalog/categories/version`、`GET catalog/skus/{skuCode}`、`GET site/config`。
- `/api/v1/staff/*`，36 条：coupon-grants、coupons、express-companies、me；orders（含 `{id}`、address、price、remark、shipments GET/POST、status-logs）；product-categories、product-labels；products（GET/POST、`{id}/skus` GET/PUT、`{id}/visibility`、category-assignments、label-assignments）；refunds（含 `{id}`、remark、review）；`shipments/{id}/tracking`、shipping-templates；statistics（含 series）；user-groups；users（含 `{uid}`、coupons、group、labels GET/POST）。
- `GET /api/v1/wechat/mini-qrcodes`，1 条。
- `POST /api/v1/uploads`：`purpose` 不再接受 `staff`（2.5 删除了店员上传分支）。

新小程序不调用其中任何一条（`apps/mini` 按新的 api-client 类型检查通过）。

### 后台可见的变化（旧 → 新）

- 「店铺装修（新版）」→「店铺装修」；旧 diy 编辑器及其菜单删除。
- 系统设置中「店员与订单提醒」分组删除。
- 存储设置删除「店员上传大小上限」和「每店员每小时上传次数」。
- 通知管理删除「小程序页面」字段；「链接地址」只推给公众号。
- 操作日志的「店员」筛选保留，用于查看历史记录。

### 已跑的检查

- 各改动包的 typecheck 和 lint。apps/web 用 `node scripts/eslint-ts6.mjs`，其余包用 `pnpm exec eslint`；改动文件跑了 prettier。
- 改动文件的 vitest 单测（`--maxWorkers=2`），包括 `handle.test`、`kernel.test`、`notification.render.test` 和 `health.test`。
- `pnpm gen`：通过。
- 仓库级 `pnpm turbo run typecheck --concurrency=2` 跑了一次：18/18 通过。
- `pnpm guards`：15 项全部 ok；api-compat 对 1.0.0 为 0 条。
- 没跑任何 int、e2e 或 build。

## 待办

- **2.11 第 5 项：** 由编排者在临时库上跑 `pnpm --filter @shop/db db:migrate`，确认 0008 能执行、`health` 报 9 个迁移。
- **留给 C2：**
  - `docker/*.dockerignore` 仍写着 `apps/uni-app`。
  - CI 仍调用 `test:mini`。
  - `apps/web/app/page.tsx` 顶部讲边缘服务 uni-app H5 的注释要改（属于 2.10）。
- **不在本任务范围：**
  - `site.config` 的 `splashLink` 和拼团 `banners[].link` 仍是字符串，没改成 LinkTarget。
  - kit 链接选择器的测试和演示数据里还有旧路径。

## 待定问题

1. **`siteConfigGet` 是否删除。** core 的 `siteConfigGet` 及其缓存现在只剩 `app-config` 复用构建函数，外加探针和密钥测试把它当对照。可以把这些测试改为针对 `appConfigGet`，然后把它连同缓存一起删掉。这次没做，是为了不在删除任务里重写测试的对照逻辑。
2. **店员相关的残留代码是否清理**（为避免改动订单、售后、优惠券的逻辑，都留着没动）：
   - `UserOrderStatsPort`、`fakeUserOrderStatsPort`、`statsForUsers`：已经没有调用方。
   - `Reviewer {kind:'staff'}`。
   - 优惠券的 `activeOnly` 选项。
   - `order.console` 里 `operatorOf` 的 user 分支。
3. **库里的旧数据是否清理。** 配置表中「order-staff」分组、店员存储的两个键，以及通知配置里已存的 `page` 键仍在库中，代码已忽略它们。要不要另写迁移删除？
4. **审计日志的 `staff`。** `audit_logs` 约束和 `AuditActorKind` 仍允许 `staff`，这是为了保留历史行。新写入一律是 admin。

## 请编排者跑的测试

**迁移与健康检查**

- 临时库上 `pnpm --filter @shop/db db:migrate`（0008）。
- `apps/web/src/server/health.test.ts`（期望 9 个迁移）。

**int，apps/web**

- `app/admin-api/catalog/catalog.int.test.ts`
- `app/admin-api/orders/fulfilment.int.test.ts`
- `app/api/v1/gift-coupons.int.test.ts`：新文件，从 `coupons.staff.int.test.ts` 拆出。
- `app/api/v1/user.int.test.ts`
- `src/server/handle.int.test.ts`：未改动，但它读取历史店员行。

**int，packages/core**（均为 `.int.test.ts`）

- `cart/cart.gaps`
- `catalog/catalog`、`catalog/catalog.concurrency`
- `coupon/coupon`
- `groupbuy/groupbuy`
- `notification/notification`
- `order/order.adjustments`、`order/order.console`、`order/order.user-stats`
- `presale/presale`
- `refund/refund.permissions`
- `storage/storage`
- `system/app-config`、`system/system`
- `wechat/wechat.mini-code`、`wechat/wechat.mini-code.budget`、`wechat/wechat.mini-code.concurrency`

**e2e**

- `e2e/admin/specs/decor.spec.ts`（菜单名已改）。
- e2e-storefront 小程序套件，含 `specs-mini/app-config.spec.ts`。

**最后**

- 整套 `test:int` 跑一次。
- 可选：load smoke（seed 改为建 decor v2 首页）。
