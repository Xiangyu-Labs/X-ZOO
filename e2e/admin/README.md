# `@shop/e2e-admin` — 后台端到端套件

后台的浏览器端到端测试。一条命令，在仓库根目录跑：

```
pnpm --filter @shop/e2e-admin e2e
```

它会：拉起 PostgreSQL 17 + Redis 7（Testcontainers）、建库灌 schema、播种、`next build`（只在没构建过时）、`next start`，然后跑 Playwright。第一次冷跑要几分钟（拉镜像 + 构建），之后热跑约一分钟。

其他入口：

| 命令                                                      | 作用                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm --filter @shop/e2e-admin e2e -- specs/auth.spec.ts` | 只跑一个文件                                                |
| `pnpm --filter @shop/e2e-admin e2e:ui`                    | Playwright UI 模式                                          |
| `pnpm --filter @shop/e2e-admin exec tsx scripts/serve.ts` | 只起栈，保持常驻；随后带 `SHOP_E2E_REUSE=1` 的 `e2e` 复用它 |
| `SHOP_E2E_REUSE=1 pnpm …`                                 | 复用本检出端口上已在跑的服务（默认**不**复用，见下节）      |
| `SHOP_TEST_PG_URL=… SHOP_TEST_REDIS_URL=… pnpm …`         | 用已有的 PG/Redis，跳过容器                                 |
| `SHOP_E2E_BUILD=1 pnpm …`                                 | 强制重新 `next build`                                       |
| `SHOP_E2E_PORT=3510 SHOP_E2E_STACK=/tmp/x.json pnpm …`    | 显式指定端口与交接文件（覆盖按检出派生的默认值）            |

## 多个检出（worktree）同时跑

端口和交接文件按检出派生，且默认不复用已在跑的服务（`src/stack-file.ts`）。否则第二个 worktree 的 Playwright 看见端口上已有服务就会直接复用，拿**别人的构建和数据库**跑自己的 spec，红绿都与自己的代码无关。

| 变量             | 默认                                        | 说明                                                                                 |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| `SHOP_E2E_PORT`  | `20000 + (CHECKOUT_ID % 5000)`              | `CHECKOUT_ID` = 检出根目录绝对路径 SHA-256 的前 8 位十六进制；每个检出固定、彼此不同 |
| `SHOP_E2E_STACK` | `$TMPDIR/shop-e2e-admin-<CHECKOUT_ID>.json` | 交接文件，同样按检出区分                                                             |
| `SHOP_E2E_REUSE` | 未设 = 不复用                               | `=1` 才复用端口上已在跑的服务；不设时端口被占用会直接报错，而不是悄悄接管            |

同一个检出要并行跑两遍时，显式给第二遍 `SHOP_E2E_PORT` 和 `SHOP_E2E_STACK`。端口段 20000–24999 在 Linux 临时端口段（32768 起）之下；撞号的结果是「端口已占用」报错，不会是静默复用。

**首次运行前**：`pnpm --filter @shop/e2e-admin exec playwright install chromium`（约 150 MB，不进仓库）。

## 这个套件断言什么

| 文件                            | 覆盖                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `specs/smoke.spec.ts`           | 登录页在浏览器里渲染、真实会话下外壳渲染、kit 演示页五个 tab 控制台零报错、超管逐页打开菜单里每个页面和每个设置分组（无报错页、无 404、无 5xx、控制台零报错、不跳走）、`/api/v1/health`                                                                                                                                                                                |
| `specs/auth.spec.ts`            | 密码错与账号不存在同一句话；登录成功落壳、cookie 属性、刷新存活；退出后 token 对 API 也失效；第六次尝试 429 且正确密码也被挡；跨站变更 403                                                                                                                                                                                                                             |
| `specs/restricted-role.spec.ts` | 用界面建一个只有 `order:order:read` 的身份和账号；它只看得到「订单」菜单；六个未授权读全 403；建管理员的提权尝试 403；`/admin/403` 文案                                                                                                                                                                                                                                |
| `specs/config-secrets.spec.ts`  | 密钥写入后标记 `已设置`、响应里只有布尔、库里确有值；再存一次不清空密钥                                                                                                                                                                                                                                                                                                |
| `specs/upload.spec.ts`          | PNG 入库与秒传提示；带脚本的 SVG 被拒且点名文件；声明成 JPEG 的 PNG 被拒；扫码上传对未签发 token 的拒绝                                                                                                                                                                                                                                                                |
| `specs/product.spec.ts`         | 后台建商品（含素材选择器上传+选图）→ 商城 API 能读到；草稿商品商城读不到                                                                                                                                                                                                                                                                                               |
| `specs/coupon.spec.ts`          | 建优惠券模板 → 发放给买家 → 「已领取记录」能查到；空发放被前端挡住                                                                                                                                                                                                                                                                                                     |
| `specs/order.spec.ts`           | 快递发货缺物流公司/运单号被 refine 挡住；发货 → 确认收货 → 订单真的流转 + 审计留痕；已发完的单不再出现「发货」（单独跑时也经界面发货，不走服务层）                                                                                                                                                                                                                     |
| `specs/notification.spec.ts`    | 退款申请通知：效果行 → 处理器 → 有 `refund:request:read` 的管理员收件箱恰好一条、重复 `notify` 不加条、标已读计数；无此权限的管理员计数不变、碰别人的消息 404；发送记录「已完成」且站内信「已发送」；模板页改站内信标题后下一条用新标题；SSE 无会话 401、有会话收到具名 `notification` 事件；铃铛显示推送与加载时的未读（USER-003、NOTIF-002、NOTIF-004）              |
| `specs/wechat-oa.spec.ts`       | 对 `@shop/testing` 的假公众号服务：保存草稿不碰微信；未配置时发布被拒且零外呼；配置后发布，微信收到的菜单树与输入逐字段相等、用的是它签发的 token、审计留痕；线上菜单或草稿被拒后页面显示 errcode                                                                                                                                                                      |
| `specs/presale.spec.ts`         | 界面新建预售活动（规格行、日期、金额）→ 商城列表与详情按预售价可买；对话框改标题后规格价不丢；暂停即下架、启用即恢复；草稿不上商城（STOCK-004 的前台一侧）                                                                                                                                                                                                             |
| `specs/statistics.spec.ts`      | 营业额、支付订单数、客单价按 `DEFINITIONS.md` 用本文件的 SQL 独立算出并逐字相等；订单页「订单销售额」「订单量」与之一致；商品统计导出带 BOM、表头固定、名为 `=1+1…` 的商品被 `'` 化解（CONSOLE-003）                                                                                                                                                                   |
| `specs/refund.spec.ts`          | 审核界面根本没有金额字段；拒绝必须填理由；同意后状态离开 `applied` 且效果账本恰好一行                                                                                                                                                                                                                                                                                  |
| `specs/decor.spec.ts`           | 店铺装修：新建 → 改页面标题 → 保存草稿（商城 404）→ 发布（商城读到）→ 带未保存修改再发布（先存后发，第 2 版）→ 回滚到第 1 版成为第 3 版、商城立即读到旧内容、草稿不动；只读查看历史版本；预览先存草稿，iframe 里是凭预览令牌读到的草稿，无令牌仍 404；未发布页不可设为首页，发布后设为首页 → `/api/v1/pages/home` 即是它（DECOR-008、DECOR-011、DECOR-012、DECOR-014） |

套件里没有 `test.fixme`，也没有 `test.fail`。

本套件不覆盖的：

| 范围                     | 说明                                                                |
| ------------------------ | ------------------------------------------------------------------- |
| 客户、注册、短信验证码   | 商城侧流程，属于 `@shop/e2e-storefront`，不在后台套件里             |
| 拼团、运费模板、CMS      | 还没有 spec                                                         |
| 退款「同意」之后真正打款 | 需要 worker + 假网关；本套件**不跑 worker**，断言停在效果账本那一行 |
| HTTPS 下跑一遍           | 见下面「已知的不真」                                                |

## 已知的不真

1. **`Secure` cookie 没有被覆盖**。`handle()` 只在 `NODE_ENV === 'production'` 时给 `admin_session` 打 `Secure`，而 Playwright 的 cookie jar 不会把 Secure cookie 发到 `http://127.0.0.1`。所以栈用**生产构建 + `NODE_ENV=test`** 跑。这一条属性由 `handle.int.test.ts` 直接断言。
2. **不跑 worker**。服务端排进 BullMQ 的任务会留在 Redis 里不动。凡是断言「效果发生了」的地方，这里只断言「效果被记下了」。
3. **`workers: 1`**。一库一 Redis，多 worker 会互相看见对方的订单和审计行。这不是性能套件（性能见 `load`）。
4. **不碰任何真实网关**。种子把 `payment.apiBaseUrl` 写成 `http://127.0.0.1:9/no-gateway`、`wechat.apiBaseUrl` 写成 `http://127.0.0.1:9/no-wechat`：即便某条路径不顾缺失的凭证去调网关，也只会撞上本机的关闭端口，而不是微信。`wechat-oa.spec.ts` 在自己运行期间把后者指向 `@shop/testing` 的假公众号服务，结束时写回黑洞。短信、阿里云一个字都没配。
5. **通知 spec 自己扮演派发器**。不跑 worker，所以它在事务里 `notify`、再对**那一行**调用已注册的处理器并标 `done`——这正是 `dispatchEffectsOnce` 对这一行做的事；不调真正的派发器，是因为它会顺手认领库里所有到期的行（包括退款 spec 的打款效果）。

## 结构

```
scripts/serve.ts     容器 + schema + 种子 + next build/start，写出交接文件
src/stack-file.ts    交接文件的路径与类型（临时目录，不进仓库）
src/stack.ts         按交接文件开一个 Ctx（只用于「界面造不出来的前置」和「界面看不到的回读」）
src/seed.ts          种子：超管、可锁账号、买家、类目、商品、两张已付订单、一张待审退款；`makePaidOrder` 导出给统计 spec
src/fixtures.ts      test.extend：adminPage / adminApi / shop
src/files.ts         上传用的字节（PNG、带脚本的 SVG、谎报类型的 PNG）
specs/*.spec.ts      十五个流程
```

**为什么栈在 `webServer` 里而不是 `globalSetup` 里**：Playwright 先起 `webServer` 再跑 `globalSetup`，所以放在 globalSetup 里建库，服务器早就连过一次并失败了。放一起还有个好处：Ctrl-C 一次，容器和服务器一起走。
