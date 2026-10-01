# X1-dead-code 状态

分支 `storefront/mini-X1-dead-code`（自 `storefront/mini` @ d98f2ce23）。范围：清理切换后留下的死代码和库里的旧数据，
即 [C1-cutover-remove.md](C1-cutover-remove.md) 待定问题 1–3。待定问题 4（审计日志的 `staff`）不动：历史行照常读出。
只删没有调用方的代码；订单、退款、优惠券、评价里仍能走到的逻辑，行为不变。

## 已完成

| 项  | 提交        | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `6ca1c2560` | 删除 core 的 `siteConfigGet`、它的 Redis 缓存（`site:config:v2`）和 `invalidateSiteConfigCache`（`configSave` 不再调它）。`site.service.ts` 只剩 `app/config` 用的构建函数和两个探针注册表。`system.int.test.ts` 的「站点公开配置」两组测试改读 `appConfigGet`（标题不变，SMOKE-007 引用仍对得上）。`app-config.int.test.ts` 的对照测试改为直接断言保存的站点值，SYS-016 的陈述和引用同步改写。                                                                                                   |
| 2a  | `5a5156304` | 删除 `UserOrderStatsPort`、`fakeUserOrderStatsPort`、注册代码、`order.repo.statsForUsers`，以及只测它们的 `order.user-stats.int.test.ts`。                                                                                                                                                                                                                                                                                                                                                        |
| 2b  | `af10fd91b` | `refund.admin.ts` 删除 `Reviewer {kind:'staff'}`：审核人就是管理员 id，写入的字段和日志文字与原来管理员分支相同。`coupon.service.ts` 的 `grant` 删除 `activeOnly`（唯一调用方一直传 `false`，行为不变）。`order.console.service.ts` 的 `operatorOf` 删除 `user` 分支：非管理员一律 `UNAUTHENTICATED`（所有调用它的路由都是 `auth: 'admin'`）。`备注` 测试改为只测管理员，另加一条「用户身份被拒」。invariants 退役 CONSOLE-004（「哪个端操作」，手机端已不存在）。                                |
| 3   | `d3a5c7c28` | 新迁移 `0009_drop_cutover_leftover_config.sql`：删 `config_values` 中 `order-staff` 分组、`storage` 的 `maxStaffUploadBytes`、`staffUploadsPerHour`；从 `notification_templates.channels.wechatMini` 去掉 `page` 键，其余字段不动。三条语句都带 `-- destructive: approved — <理由>`；空库和重复执行都什么也不改。快照照 0005 的做法复制 0008（无表结构变化）。`EXPECTED_MIGRATIONS` 9→10。`NotificationChannels` 类型去掉 `page`。`system.int.test.ts` 新增一组测试：对带旧数据的库连跑两次迁移。 |
| —   | 本提交      | cutover.md 2.4、2.5、2.7 加 X1 备注；契约注释提到 0009。本文件。                                                                                                                                                                                                                                                                                                                                                                                                                                  |

SCHEMA.md 不用改：0009 只动数据，表、枚举、约束数都不变，文件里也不记迁移数。

### 后台可见的变化（旧 → 新）

- 界面没有变化（这些字段 C1 已从后台去掉）。
- 升级后库里的「店员与订单提醒」配置、两个店员上传限额、通知模板里的「小程序页面」值被删除。回滚到切换前的镜像时，
  这些设置回到默认值：店员端对所有人关闭、上传限额为默认值、订阅消息用旧镜像自己的默认页面。已在迁移注释里写明，视为可接受。

### 已跑的检查

- `pnpm --filter @shop/core typecheck`、`@shop/db typecheck`、`@shop/web typecheck`：通过。
- 改动文件的 eslint（core、db 用 `pnpm exec eslint`，web 用 `scripts/eslint-ts6.mjs`）：0 错误。改动文件 prettier：通过。
- vitest（`--maxWorkers=2`）：`apps/web/src/server/health.test.ts`（期望迁移数等于 journal 条数）1/1；
  `packages/core/src/system/system.test.ts`、`notification/notification.render.test.ts` 42/42。
- `pnpm guards`：15 项全部 ok（migrations 10 个文件，破坏性语句都有标注；invariants 279 条规则，引用全部对得上）。
- 没跑任何 int、e2e 或 build。

## 待办

- 编排者跑下面列出的 int 测试和一次临时库迁移。

## 待定问题

1. **旧镜像回滚。** 如果切换后的第一次发布就带着 0009，自动回滚到切换前镜像时，店员端和订阅消息页面回到默认值（见上）。
   目前生产没有在用店员端，影响应为零；如需保留这些值以备回滚，可以把 0009 推迟一个版本再合并。
2. **审计日志的 `staff`**（C1 待定问题 4）：不在本任务范围，`audit_logs` 约束、`AuditActorKind` 和「店员」筛选都保留。

## 请编排者跑的测试

**迁移**

- 临时库上 `pnpm --filter @shop/db db:migrate`（0009），确认 `health` 报 10 个迁移。

**int，packages/core**（均为 `.int.test.ts`）

- `system/system`：改读 `appConfigGet` 的两组，以及新增的「migration 0009」。
- `system/app-config`：SYS-016 改写的一条。
- `order/order.console`：「备注」两条。
- `order/order.fulfil`、`order/order.fulfil.concurrency`（`operatorOf` 的调用方）。
- `refund/refund`、`refund/refund.concurrency`、`refund/refund.isolation`、`refund/refund.permissions`、
  `refund/refund.webhook`（审核售后；`Reviewer` 改为管理员 id）。
- `coupon/coupon`（`grant` 去掉 `activeOnly`）。
- `notification/notification`（`NotificationChannels` 类型去掉 `page`）。

**int，apps/web**

- `src/server/health.int.test.ts`（期望迁移数 10）。
- `app/api/v1/app/config.int.test.ts`（缓存失效只剩 app-config 一条路）。
