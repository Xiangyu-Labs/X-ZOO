# 切换清单：一次发布，从 uni-app 到新小程序

**这是计划，不是已经做了的事。** 本文按顺序列出切换那一次要做的全部事情：删什么、改什么、迁移、兼容基线、
发布当天的步骤、公众平台上要办什么、出了问题怎样回退。编写时（2026-09-24，`storefront/mini` @ `c3afbac0a`）
一行代码都没有删；每一项动手前都要重新核对路径和行号。

**一次发布**（用户 2026-09-24 的决定，[HANDOFF.md](HANDOFF.md) 第 6 节第 6 条）：小程序从未发布，生产只有一个
测试用户、没有交易，也**没有公众号**。所以不需要照顾手机上的旧版本、旧 H5 顾客或公众号里的链接：删除、迁移、
edge 改动和新后端在**同一次部署**里上线，部署之后再上传小程序、提交审核。I2 提过的三次发布（A：新后端不删；
B：删除加落地页；C：删表）不再采用。

依据：[plan.md](plan.md)「后端接口调整 → 切换时删除」和第 10 节的决定（3：删店员接口；4：新小程序发布那次同时删
旧 uni-app；5：生产的 `/` 改成落地页；6 原定「旧表下一次发布再删」，现并入本次，理由见 2.11）、[pages.md](pages.md)
第 2.8、2.9、3.4、4 节、[wechat-compliance.md](wechat-compliance.md)、[H2 的状态记录](status/H2-backend.md)。

**需要你单独批准的动作**，下文都标了 **【需批准】**：合并到 `master`、push、部署到生产（`deploy/ship.sh`）、
上传小程序代码（体验版和正式版都算，开发者工具的「预览」「真机调试」也会上传）、提交审核、发布。

---

## 0. 开始前必须成立的条件

- [x] [e2e-coverage.md](e2e-coverage.md) 第 4 节没有缺口（2026-09-24 已为「无」）。
- [x] `coupons.spec.ts` 里预售叠加优惠券的 `test.fail` 已修复并删除（J1）。
- [ ] [HANDOFF.md](HANDOFF.md) 第 6 节「要落实到代码 / 文档的」第 1–5 条已做完并合入 `storefront/mini`；第 4 节
      第 3–6 条已处理，或你明确推迟到切换之后。
- [ ] 真机清单（[device-check.md](device-check.md) 第 6 节）有人跑过，结果已回报；隐私弹窗（D03）必须在真机上过。
- [ ] 第 3.1 节的平台事项已办完。没有认证、类目、小程序备案和支付商户号，部署之后也提交不了审核。

## 1. 发布当天的顺序

一次发布，按下面的顺序走完。每一步做完再做下一步；标【需批准】的，每次都要你当场同意。

> **2026-09-24 进度：** 第 1–5、7、8 步已完成（部署 `f3311f89a`，体验版 1.0.0 来自 `cf779f01a`）。剩第 6、9、10 步，见 [HANDOFF](HANDOFF.md) 第 4 节。

1. [ ] **在 `storefront/mini` 上做完第 2 节**（执行者，分小提交，每一小节一个提交）：删除、CI、edge、守卫、文档、
       迁移（2.11），最后刷新兼容基线（5.1）。
2. [ ] **构建和检查**（协调者，一次，不并行）：
   - [ ] [contributing.md](../contributing.md) 的合并清单全绿，加上 `test:mini`（2.2 之后它就是 `test`）；
         `pnpm --filter @shop/mini build` 通过体积门禁。
   - [ ] 部署演练 `deploy/rehearsal/drill.sh` 通过（它会构建三个镜像，约半小时）。本次改了 `docker/` 和 `deploy/`，
         这一步不能省；不想占本机时，可以在 `storefront/mini` 上手动触发 CI（`workflow_dispatch`，包含 `rehearsal`
         任务），但要先 push 这个分支 **【需批准】**。
3. [ ] **合并到 `master`** **【需批准】**，**push `master`** **【需批准】**。CI 的 push 运行跑全部检查并发布三个镜像
       （`sha-<commit>`），摘要里打印 `deploy/ship.sh <commit>`。等它全绿；摘要里不再有「storefront in the edge
       image」一行（2.9 删了）。
4. [ ] **部署** **【需批准】**：
   - [ ] 先 `deploy/ship.sh <commit> --dry-run`：应报告有待执行的迁移（2.11 的删表），即
         `would stop web, worker and edge to migrate`。
   - [ ] 再 `deploy/ship.sh <commit>`。有迁移，站点从停机到就绪约十几秒；升级前的备份在
         `data/backups/pre-upgrade-<时间>.sql.gz`，记下文件名（回退要用，见第 4 节）。
   - [ ] 退出码必须是 0；是 1 或 3 时按第 4 节处理，不要接着往下做。
5. [ ] **部署后检查**（只读）：
   - [ ] `deploy/ship.sh status`：`readiness gate: passed`，`REVISION` 是这次的提交。
   - [ ] `https://<域名>/` 是落地页（店名、小程序码或「请在微信中搜索…」的文字、页脚备案号），页面带
         `noindex`（继承 `apps/web/app/layout.tsx` 的 `robots`，保持不变，HANDOFF 第 6 节第 7 条）。
   - [ ] 旧 H5 路径（如 `https://<域名>/pages/index/index`）返回 302 到 `/`；`/admin` 能登录；
         `/api/v1/app/config` 返回 200；已删的接口（如 `/api/v1/catalog/categories/version`）返回 404。
6. [ ] **公众平台和后台配置**：第 3.2 节（服务器域名、消息推送、订阅模板、快递编码、新版装修发布……）。
7. [ ] **构建小程序正式包**：在第 3 步合并后的那个提交上，
       `TARO_APP_API_ORIGIN=https://<生产域名> pnpm --filter @shop/mini build:weapp`。版本号是
       `apps/mini/package.json` 的 `version`，必须等于兼容基线记下的版本（5.1）。不要用 `scripts/device-build.mjs`：
       它只接受本机或隧道地址，不接受生产。
8. [ ] **上传体验版** **【需批准】**：微信开发者工具导入 `apps/mini/dist/weapp`，「上传」，在「版本管理」里设为体验版。
       对着生产按 device-check 第 6 节做一遍真机检查。
9. [ ] **提交审核** **【需批准】**（审核准备见 3.2 第 19 项）。审核通过后 **发布** **【需批准】**。
10. [ ] **发布之后**：第 3.3 节（纳入发货管理确认、0.01 元真实交易、对外发码）。

**审核被拒：** 按意见在 `storefront/mini` 上修改，再从第 2 步走一遍。只改了 `apps/mini` 时跳过第 4、5 步；
`/api/v1` 有改动时，用**同一个版本号**重刷兼容基线（5.1）。

---

## 2. 代码删除与改动（都在 `storefront/mini` 上）

每一小节一个提交，删完跑一次 `pnpm guards`：它会指出遗漏的引用（契约与路由对不上、权限原子没人用、
规则目录引用的测试不存在）。`pnpm gen` 在删了契约或领域之后要重跑。

### 2.1 uni-app

- [x] `apps/uni-app/` 整个目录。
- [x] `pnpm-workspace.yaml` 里的 `'!apps/uni-app'` 和它上面的注释。
- [x] 根目录 `README.md`：技术栈表里的 `apps/uni-app` 行（第 35 行）、第 38 行「Everything but the uni-app」、
      目录树里的 `uni-app/`（第 48 行）、第 113 行起「`apps/uni-app` is an npm project…」一节、清单里的
      `(cd apps/uni-app && npm test && npm run build:h5)`（第 140 行）。
- [x] `docs/contributing.md`：`pnpm guards` 说明里的「the uni-app resolves every call and page」（第 40 行）、
      storefront e2e 一行的「The H5 storefront」、`apps/uni-app/**` 的检查项（第 46 行）、「the uni-app's `npm test`」
      （第 64 行）、「Adding a route」第 8 步「在 `apps/uni-app/api/` 加调用和 mapper」（第 101 行起）。
- [x] `docs/architecture.md`、`docs/conventions.md` 中标为 legacy 的 uni-app 小节，以及 Processes 表、Edge 说明里的
      「uni-app H5」（architecture 第 13、24、375 行附近）。

### 2.2 旧 uni-app 的 e2e

- [x] `e2e/storefront/specs/`（10 个 spec），`src/uni.ts`、`src/known-gaps.ts`，`src/h5.ts`、`src/stack-file.ts`、
      `scripts/serve.ts` 中 `uniapp` 的分支（`SHOP_E2E_CLIENT` 只剩 `mini`，或者去掉这个开关）。
- [x] `src/seed.ts` 里给旧装修建页面的部分（`@shop/core/diy` 的 `createPage`、`setHomePage`，`diyPages`、
      `diyHomePageId`）和 `stack-file.ts` 的对应字段：2.3 删掉 `core/diy` 后它编译不过。
- [x] `playwright.config.ts`：去掉 `mobile-chromium` 项目，`testDir` 固定为 `./specs-mini`；`package.json` 的 `test`
      改为跑小程序（`test:mini` 并入 `test`）。
- [x] `docs/invariants.md`：SMOKE-002…005 删去 `e2e/storefront/specs/` 的引用，陈述只写小程序；其他只引用旧 spec 的行
      （用 `grep -n "e2e/storefront/specs/" docs/invariants.md` 找）改引小程序的测试。
- [x] [e2e-coverage.md](e2e-coverage.md) 标注「旧套件已删除」，第 1 节作为历史保留或删去。

### 2.3 旧装修（`diy` 域）和旧后台编辑器

- [x] **先搬走被新编辑器复用的代码**（已完成，H5-backend）：选择器数据源已在 `apps/web/src/admin/decor/`
      （`record-types.ts`、`catalog-records.ts`、`record-kinds.ts`，测试随之搬来），`records.tsx` 不再引用 `admin/diy`；
      ESLint 的 `no-restricted-imports`（`apps/web/eslint.config.mjs` 的 `NO_LEGACY_DIY`）禁止 `src/admin/decor/**` 与
      `app/admin/(shell)/decor/**` 引用 `diy`。旧目录里剩下的只是转接：`diy/data-source.tsx` 的 `DiyPicker*` 类型是 decor
      类型的别名，`diy/record-source.ts` 把旧的 `labels`、`combination` 映射到 decor 的实现，`diy/catalog-source.ts` 转导出
      选择器函数、自留旧 uni 路径的 `catalogLinkTargets`。整个目录可直接删除，decor 不受影响。
- [x] 后台：`apps/web/app/admin/(shell)/diy/`、`apps/web/src/admin/diy/`（含上面的转接文件及其测试）、只供旧面板测试用的
      `apps/web/src/test/diy-data-source.ts`、菜单 `apps/web/src/admin/menu/diy.menu.ts`、`diy:*` 权限原子（`permissions`
      守卫会提示没人用的原子）。`NO_LEGACY_DIY` 规则删不删都可以（目录没了就不会再命中）。删完跑一遍
      `grep -rn "admin/diy\|/diy/" apps/web/src apps/web/app` 确认无残留引用。
- [x] 接口：`apps/web/app/api/v1/diy/**`（`diy.layout`、`diy.navigation`、`diy.pageVersion`、`diy.theme`、`diy.homePage`、
      `diy.userCenterPage`、`diy.productDetailPage`、`diy.page`）、`apps/web/app/admin-api/diy/**`（页面、主题、链接库）。
- [x] 契约 `packages/contracts/src/diy/`（含 `removed.ts` 的 `REMOVED_STOREFRONT_PAGES`、默认 JSON、`__fixtures__`），
      领域 `packages/core/src/diy/`（`pnpm gen` 重新生成 `domains.gen.ts`）。表的删除见 2.11。
- [x] `packages/api-client` 的测试拿 `diy.homePage`、`system.siteConfigGet` 当例子（`client.test.ts`、`bundle.test.ts`、
      `contract.test.ts`），换成保留的接口。
- [x] `e2e/admin/specs/diy.spec.ts`。
- [x] `docs/invariants.md` 的 DIY-001…009 行（逐条确认只关于旧装修；编号不再复用），以及 SMOKE-010
      （引用旧装修测试的是它；RISK-D-008、RISK-D-009 并不引用，原先写错）；`docs/architecture.md` Domains 表的 `diy` 一行。
- [x] 后台菜单「店铺装修（新版）」改回「店铺装修」（用户 2026-09-24 已定要改）（`apps/web/src/admin/menu/decor.menu.ts`、
      `apps/web/src/admin/decor/page-list.tsx`、`e2e/admin/specs/decor.spec.ts`、`e2e/admin/README.md`、
      [decor.md](decor.md)）。后台看得到的文案变化，改了要告诉你。

### 2.4 只为旧前端存在的辅助接口

| 路由 id                                           | 方法与路径                               |
| ------------------------------------------------- | ---------------------------------------- |
| `catalog.categoryVersion`                         | `GET /api/v1/catalog/categories/version` |
| `catalog.skuPrice`                                | `GET /api/v1/catalog/skus/:skuCode`      |
| `cart.decrementItem`                              | `POST /api/v1/cart/items/decrements`     |
| `system.attachmentDataUrl`                        | `POST /api/v1/attachments/base64`        |
| `system.siteConfigGet`                            | `GET /api/v1/site/config`                |
| `diy.layout`、`diy.navigation`、`diy.pageVersion` | 随 2.3 一起删                            |

- [x] 删契约、路由文件、只为它们存在的 service 函数和测试。
- [x] `system.siteConfigGet` 已由 `app/config` 取代；小程序、后台都不调用它，没有公众号 H5 页面要照顾。删之前对
      `packages/core/src/system/site.service.ts` 的 `siteConfigGet` `grep` 一遍调用方（落地页、`app/config` 若复用则
      保留函数，只删路由和契约）；SYS-020 的陈述和测试标题里提到 `site/config`，要一起改。
      （C1 结果：`app/config` 复用 `site.service.ts` 的 `paymentsOf`、`authOf`、`supportOf` 和两个探针注册表；
      `siteConfigGet` 本身只剩测试在用——`system.int.test.ts` 通过它断言探针和密钥规则，SYS-016 拿它对照——所以保留函数、
      不再从 `@shop/core/system` 导出，只删了路由、契约和 `apps/web/app/api/v1/site/config.int.test.ts`。）
      （X1：`siteConfigGet` 连同它的 Redis 缓存和 `invalidateSiteConfigCache` 已删；探针、密钥、缓存测试改读 `appConfigGet`，
      SYS-016 改为直接断言保存的站点值。）

### 2.5 店员接口（计划第 10 节第 3 项：你已同意）

- [x] `apps/web/app/api/v1/staff/**`（32 个路由文件，共 36 个接口），契约 `order/order.staff.contract.ts`、
      `user/user.staff.contract.ts`、`catalog/catalog.staff.contract.ts`、`catalog/catalog.staff.schemas.ts`、
      `shipping/shipping.express.contract.ts` 的 `staffExpressCompanyPicker`（`shipping.staffExpressCompanies`）。
      （C1 补充：清单漏了 `coupon/coupon.staff.contract.ts` 里的三个店员接口 `GET /api/v1/staff/coupons`、
      `POST /api/v1/staff/coupon-grants`、`GET /api/v1/staff/users/:uid/coupons`，一并删除；同一文件里的
      `coupon.orderGiftCoupons`（`GET /api/v1/orders/:id/gift-coupons`，顾客自己的订单页在用）保留，文件改名为
      `coupon/coupon.gift.contract.ts`，对应测试改名为 `apps/web/app/api/v1/gift-coupons.int.test.ts`。）
- [x] `StaffCheck`（`packages/core/src/auth/user-lookup.ts`）和只被店员接口调用的 service（`order.staff.service.ts`、
      `user-staff.service.ts`）。**后台也在用的 service 保留**：删之前对每个导出 `grep` 一遍调用方。
      （C1 结果：还删了 `catalog.staff.service.ts`、`refund.admin.ts` 的 `staff*` 函数和 `StaffRefundPort`、
      `coupon.service.ts` 的店员发券函数、只给店员用的 schema 和错误码；`AuthMode` 和 `ActorKind` 去掉了 `staff`。
      后台已无调用方但保留的：`UserOrderStatsPort`（和 `order.repo.statsForUsers`）、`refund.admin.ts` 的
      `Reviewer` 里的 `staff` 分支、`coupon` 的 `activeOnly` 选项、`order.console.service.ts` 的 `operatorOf` 的
      `user` 分支——都是订单、退款、优惠券逻辑，不在本次改写范围。）
      （X1：以上四项已删。退款审核只记管理员；后台发券不查状态（与原来 `activeOnly: false` 相同）；订单后台操作只认管理员，
      用户身份被拒（`UNAUTHENTICATED`）。历史日志里的 `user`/`staff` 行照常读出。CONSOLE-004 随之退役。）
- [x] `order.fulfil.config.ts`、`storage.service.ts` 中与店员相关的分支；`audit_logs.actor_kind = 'staff'` 的约束和已有数据保留。
      （C1 结果：配置组「店员与订单提醒」（`order-staff`）和存储设置里的「店员上传大小上限」「每店员每小时上传次数」
      从后台消失；库里已存的这些配置行没有删。后台操作日志的「店员」筛选保留，用来看历史行。）
      （X1：迁移 `0009_drop_cutover_leftover_config.sql` 删除这些配置行。）

### 2.6 写死的旧小程序路径和旧小程序码接口

- [x] `MINI_CODE_PAGES` 和 `miniCodePage`（`packages/contracts/src/wechat/schemas.ts`）。
      （C1：连同只为它们存在的 `miniCodeQuery`、`miniCodeScene` 和 core 的 `miniCodeUrl`、`SCENE_MAX_BYTES` 一起删。）
- [x] `wechat.miniCode`：`GET /api/v1/wechat/mini-qrcodes`（`wechat.storefront.contract.ts`、
      `apps/web/app/api/v1/wechat/mini-qrcodes/route.ts`），以及 `wechat.share.contract.ts` 注释中的引用
      （`system.attachment.contract.ts` 已在 2.4 随 `system.attachmentDataUrl` 删除）。
      `wechat_mini_codes` 缓存表保留（新接口 `share/mini-codes` 和落地页也用它）。
      （C1：缓存、拒绝、限额、并发四组测试原来走 `miniCodeUrl`，已改走 `shareMiniCodeUrl`；只测旧接口的
      「scene 超过 32 字节」「与旧接口共用缓存」「旧接口也按版本」三条删除，SHARE-001、SHARE-003 的陈述相应改写。）
- [x] `packages/core/src/diy/link.service.ts`、`page_links` 的读取随 2.3 删除；[pages.md](pages.md) 第 4.2、4.3 节列出的
      默认数据和契约示例里的旧路径一并清掉。
      （C1：4.2 的默认数据随 2.3 删除；4.3 的契约示例改为新路径——开屏广告、拼团横幅、`user.recordVisit`。
      `site.config.ts` 的 `splashLink`、`groupbuy.config.ts` 的 `banners[].link` 改成 `LinkTarget` 不是删除，不在 C1 范围；
      测试里故意用旧路径的断言（旧值仍能读出、`linkTarget` 拒绝旧路径）保留。）

### 2.7 通知的旧 `link` 和 `wechatMini.page`

- [x] 事件定义里的 `link`（`packages/core/src/notification/notification.registry.ts`、
      `packages/core/src/groupbuy/groupbuy.notifications.ts`、`packages/core/src/presale/presale.notifications.ts`），只留 `route`。
- [x] `wechatMiniChannelConfig.page`（`packages/contracts/src/notification/schemas.ts`），后台
      `apps/web/app/admin/(shell)/notification/templates/notification-templates.tsx` 中 `['channels', 'wechatMini', 'page']`
      字段，`packages/core/src/notification/notification.send.ts` 中 `subscribePage` 的旧值回退。已保存的配置里多出的
      `page` 键在读取时忽略即可，不必迁移。
- [x] 公众号模板消息（`sendWechatOa`）的链接原来回退到事件的 `link`；删掉之后只剩后台配置的 `linkUrl`。没有公众号，
      这个渠道不会被用到，不另做处理（HANDOFF 第 6 节「不改」）。
      （C1 结果：用户事件的 `link` 全部删除，后台事件（订单、售后、库存、支付异常、小程序交易）的 `link` 是后台铃铛的
      跳转路径，保留；注册时对带 `link` 的用户事件直接报错（NOTIF-006 加了一条测试）。站内信 `data` 里不再有 `link`。
      后台「通知管理」的「小程序页面」输入框删除。）
      （X1：迁移 `0009_drop_cutover_leftover_config.sql` 删除库里已存的 `wechatMini.page` 键，渠道其余字段不动。）

### 2.8 守卫

- [x] `uniapp` 检查：`guards/src/checks/uniapp.ts`、`guards/src/lib/uniapp.ts`（及测试）、`guards/src/cli.ts` 中的注册、
      `guards/src/lib/paths.ts` 的 `uniApp`；`guards/README.md` 的 `uniapp` 一行和 `checks/uniapp.ts` 的说明。
- [x] `retired` 检查（`guards/src/checks/retired.ts`）：`ALLOWED` 中的 `apps/uni-app/api/mappers/` 和
      `apps/uni-app/api/README.md`，检查名称和 RISK 行陈述里的「the uni-app API layer」。
- [x] `mini` 检查中为过渡期保留的允许列表（如仍有）清空；`guards/README.md`「next to `uniapp` until the cutover」一句。

### 2.9 CI（`.github/workflows/ci.yml`）

- [x] 文件头注释里的「the uni-app storefront」。
- [x] `storefront-e2e` 任务（uni-app 的 `npm ci`、`uni-app unit tests`、`test`）删除；`storefront-e2e-mini` 改名为
      `storefront-e2e`，跑合并后的 `test`。
- [x] `images` 任务：删除 uni-app 的 `actions/setup-node`（npm 缓存指向 `apps/uni-app/package-lock.json`）、
      「Build the H5 storefront」「Resolve the H5 bundle」两步，edge 步骤的 `build-args: H5_DIST=…` 和「the storefront
      from `apps/uni-app/`」注释，「Release summary」里 `storefront in the edge image` 那一行。落地页由 `web` 回答
      （见 2.10），edge 镜像不再带任何前端产物。
- [x] `REL-*` 规则和 `pipeline` 守卫若提到这些步骤，同步修改（改完跑 `pnpm guards`）。

（C2，`status/C2-cutover-infra.md`）：`pipeline` 守卫和 `REL-*` 规则都不提这些步骤，没有改；`pnpm guards` 通过。
`storefront-e2e` 跑的是 `test`，要和 C1 的 2.2（`test:mini` 并入 `test`）一起合入才对。

### 2.10 edge：`/` 改为落地页

落地页已经写好（R1）：`apps/web/app/page.tsx`，由 `web` 容器回答，**还没有接到 edge 上**——现在 edge 的 `/`
仍是 uni-app H5，落地页只在直接访问 `web:3000/` 时看得到。它显示店名（「站点设置 → 商城名称」）、首页的小程序码和
「请使用微信扫码打开」；小程序未启用或 AppID、AppSecret 没填时，显示「请在微信中搜索「<小程序名称>」小程序」的文字；
页脚是「站点设置 → 备案」里填了的 ICP 备案号和公安备案号。小程序码走 `shareMiniCodeUrl`（与分享海报同一个缓存表），
结果在 Redis 缓存一天；微信拒绝时显示文字并暂停十分钟再试，匿名访问最多每十分钟触发一次微信调用
（`apps/web/src/server/landing.ts`）。页面继承根布局的 `robots: noindex`，保持不变。

- [ ] **部署前确认**（只读）：生产上后台「小程序设置」已启用、AppID 和 AppSecret 已填、「小程序码打开的版本」是
      「正式版」。小程序码在正式版发布之前扫不开（3.3）；这段时间没有顾客，落地页照常显示码，不另做处理。
- [x] `docker/edge/nginx.conf`，一处不多一处不少：

  ```diff
   # The `edge` server block: static H5, the shared uploads volume, and a proxy to
   # the Next standalone server.
   #
   # Three surfaces behind one port:
  -#   /                the uni-app H5 build, a history-mode SPA
  +#   /                the landing page, answered by `web` (apps/web/app/page.tsx)
   #   /admin, /admin-api, /api, /scan-upload    the `web` container
   #   /uploads/        the shared volume, as inert bytes
  @@ server {
       listen 80;
       server_name _;
  -    root /srv/h5;
  -    index index.html;
       charset utf-8;
  @@
  -    # Every Next route needs its prefix here, or a location of its own: a
  -    # path nothing above matches falls through to the storefront's
  -    # history-mode fallback and is answered with its `index.html`, not a 404.
  +    # Every Next route needs its prefix here, or a location of its own: a
  +    # path nothing above matches is redirected to the landing page at `/`,
  +    # not a 404.
  @@
  -    # --- the H5 storefront --------------------------------------------------
  -
  -    location = /index.html {
  -        add_header Cache-Control "no-cache, must-revalidate" always;
  -        add_header X-Content-Type-Options nosniff always;
  -    }
  -
  -    location ~* "\.[a-f0-9]{8,}\.(js|css|woff2?|ttf|svg|jpe?g|png|webp)$" {
  -        try_files $uri =404;
  -        expires 1y;
  -        add_header Cache-Control "public, immutable";
  -        add_header X-Content-Type-Options nosniff always;
  -        access_log off;
  -    }
  +    # --- the landing page ---------------------------------------------------
  +
  +    # `/` is the web app's landing page: the shop's name and the 小程序码.
  +    location = / {
  +        proxy_pass http://web;
  +        proxy_http_version 1.1;
  +        proxy_set_header Host $host;
  +        proxy_set_header X-Real-IP $remote_addr;
  +        proxy_set_header X-Forwarded-For $remote_addr;
  +        proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
  +        proxy_set_header Connection "";
  +        proxy_connect_timeout 5s;
  +        proxy_read_timeout 30s;
  +    }

       location ~ /\. {
           deny all;
           access_log off;
           log_not_found off;
       }

  -    # History-mode fallback, last so every rule above wins over it.
  -    location / {
  -        try_files $uri $uri/ /index.html;
  -        add_header X-Content-Type-Options nosniff always;
  -    }
  +    # Anything else — an old H5 link, an old share link — goes to the landing
  +    # page. Last, so every rule above wins over it.
  +    location / {
  +        return 302 /;
  +    }
   }
  ```

  `location = /` 是精确匹配，所以 `/api/…`、`/admin/…` 等前缀规则不受影响。它不写 `add_header`，好继承 server 级的
  `nosniff`、`X-Frame-Options`、`Referrer-Policy`（写了任何一条 `add_header` 就要把这三条重抄一遍）；缓存头由 Next 给
  （页面是 `force-dynamic`）。落地页不需要别的静态文件：样式内联，Next 的运行时在已经代理的 `/_next/static/` 下，
  小程序码图片在 `/uploads/` 下。

- [x] **店铺域名本身要配成「业务域名」**（C12，web-view 打开本店网页；用户 2026-09-24 已定要加）：改完之后根目录的任何文件都会 302，
      微信的校验文件 `/<文件名>.txt` 放不上去。那就在同一个提交里按 wechat-compliance.md C12 的建议加一段
      `location ~ ^/[A-Za-z0-9_-]+\.txt$`，从一个只读挂载目录提供，并在 `deploy/README.md` 写明放置方法。
- [x] `docker/edge/Dockerfile`：删除 `ARG H5_DIST=docker/edge/h5-placeholder`、`FROM` 下面的 `ARG H5_DIST`、
      `COPY ${H5_DIST}/ /srv/h5/` 和文件头关于 H5 的说明（镜像只剩 nginx 配置）；删除 `docker/edge/h5-placeholder/`；
      `Dockerfile.dockerignore` 删去 `!apps/uni-app/dist` 和关于 uni-app 的注释。
- [x] `deploy/rehearsal/drill.sh` 的 `case_edge_proxies_every_page`（第 722 行起）：「没有被代理」的判据从「回答等于
      storefront 的 `index.html`」改为「回答是 302、`Location` 为 `/`」；去掉跳过 `/` 的那一行
      （`[ "$url" != '/' ] || continue`）和第 715–721 行注释里「`/` is the storefront's on purpose」——`/` 现在也必须由
      `web` 回答；开头取 `index.html` 的那段删除。
- [x] `deploy/README.md`：服务表 `edge` 一行（第 11 行「the H5 storefront at `/`」）、第 136–138 行关于
      `storefront in the edge image` 和 `placeholder` 的说明、「What the edge sends to `web`」一节（第 476 行起）。
- [x] `e2e/storefront` 不受影响（它用自己的 Node 版 edge，`src/edge.ts`，根目录是小程序的模拟构建）。

（C2 已做，`status/C2-cutover-infra.md`；演练**没有跑**，第 1 节第 2 步由协调者跑。）与上面的 diff 相比多了三处：
`location /` 里加了 `absolute_redirect off`，`Location` 就是 `/`，不会被 nginx 拼成 `http://<host>/` 再绕一次 Traefik 的
https 跳转；校验文件目录是 `deploy/compose.yml` 里 edge 的只读绑定挂载
`${NEXT_DOMAIN_VERIFICATION_DIR:-./data/domain-verification}:/srv/domain-verification:ro`，`shop upgrade` 在目录不存在时
建好（755），免得 Docker 以 root 建；演练多了一个用例 `edge/serves-verification-files`。`deploy/README.md` 新增
「Domain verification files」一节写放置方法。「部署前确认」一项是对生产的只读检查，留给发布当天。

### 2.11 迁移：删旧表（同一次发布）

**决定：旧表在这次发布里删。** 原计划（plan 第 10 节第 6 项）推迟到下一次发布，是为了让回退后的上一版镜像还能用这些表；
现在它们只服务已经下线的 uni-app 和旧装修，生产里没有要保住的数据，推迟只会多留一份死的 schema 定义。代价写在第 4 节：
部署失败自动回到上一版镜像时，旧 H5 首页和旧后台装修会报错（其余功能照常），要完全回到部署前就用备份恢复。

- [x] 删 `packages/db/src/schema/diy.ts`（`diy_pages`、`themes`、`page_link_categories`、`page_links` 四张表和
      `diy_pages_kind`、`diy_pages_status`、`themes_kind` 三个枚举），再 `pnpm --filter @shop/db db:generate`，
      生成 `packages/db/migrations/0008_*.sql`。删之前确认没有别的表引用它们（2026-09-24 核对：没有外键指向这四张表）。
- [x] 每条 `DROP TABLE` 前加一行 `-- destructive: approved — <理由>`（按语句标注，`migrations` 守卫 OPS-007 检查）。
      理由写明：只有已删除的旧装修代码读这些表，生产没有要保留的数据，自动回退到上一版时旧装修会报错、已接受。
- [x] `apps/web/src/server/health.ts` 的 `EXPECTED_MIGRATIONS` 从 8 改为 9（`health.test.ts` 按迁移日志核对它）。
- [x] `packages/db/docs/SCHEMA.md`：`diy` 一行（第 37 行）、第 230 行的 `diy_pages_home_uq`、「6.9 `page_links` /
      `page_link_categories`」一节。
      （C1 结果：生成的是 `packages/db/migrations/0008_drop_legacy_diy.sql`，四条 `DROP TABLE … CASCADE` 各带标注，
      三条 `DROP TYPE` 不在守卫的检查范围内、未标注；`scripts/check-constraints.sql` 删了第 15 条「两个 DIY 首页」，
      `schema/decor.ts` 的注释同步。SCHEMA.md 的表数 86→82，约束表删第 21 行、原第 22 行改为 21，6.9 节删除、原 6.10 改为 6.9。）
- [ ] 协调者在本地用 `pnpm --filter @shop/db db:migrate` 对一个临时库跑一遍，再跑集成测试（第 1 节第 2 步里一起跑）。

店员没有自己的表：`audit_logs.actor_kind = 'staff'` 的约束和已有的行保留，不迁移。

### 2.12 这次**不删**的东西

- **公众号和 H5 专用接口**（计划「保留不动」）：`auth.oaAuthorizeUrl`、`auth.oaLogin`、`auth.oaPhoneLogin`、
  `wechatOa.jssdkConfig`、`wechatOa.subscribeTemplates`、`wechat_h5` 支付通道、公众号后台功能。现在没有公众号，
  它们没人调用；用户 2026-09-24 定为**一直保留**（以后可能开公众号），不删。
- `auth.sendSmsCode`、`auth.smsLogin`、密码登录接口：后端保留，小程序在用。
- `wechat_mini_codes` 表、`content_security_checks`、`wechat_trade_orders` 等新表。

---

## 3. 微信公众平台和其他平台上的事项（运营或老板办理）

完整说明和依赖顺序见 [wechat-compliance.md「需要运营或老板办理的事项」](wechat-compliance.md#需要运营或老板办理的事项)，
编号与那张表一致。这里按发布当天的时间线重排，勾选时注明日期。

### 3.1 部署之前（关键路径，越早越好）

- [ ] 1 营业执照、法人、对公账户；确认商品需要的前置资质。
- [ ] 2 域名 ICP 备案（最长、最不可控）。
- [ ] 3 企业主体注册小程序，AppID 和 AppSecret 交给技术填入后台「小程序设置」。
- [ ] 4 微信认证（C01）。
- [ ] 5 服务类目和资质（C02）。
- [ ] 6 小程序备案（C03）。
- [ ] 7 微信支付商户号：开通 JSAPI、关联小程序 AppID、APIv3 密钥和证书（C06）。
- [ ] 8 用户隐私保护指引，按 C04 的表填写。
- [ ] 9 申请 `wx.chooseAddress` 接口权限（C04）。
- [ ] 13 手机号快速验证资源包和余额提醒（C05）。
- [ ] 14 绑定客服人员（C15）。
- [ ] 15 阿里云短信签名和模板（C05）。
- [ ] 16 代码上传密钥和 IP 白名单；真机测试人员加为体验成员。上传密钥只放在仓库外，每次用都要你批准。
- [ ] 17 基础库最低版本设为 3.0.0（C14）。

### 3.2 部署之后、提交审核之前（第 1 节第 6 步）

- [ ] 10 服务器域名（request、uploadFile、downloadFile）和业务域名（web-view），放校验文件（C03、C12；店铺域名本身
      做业务域名时见 2.10）；后台「小程序设置」的业务域名列表与公众平台一致（CLIENT-002）。
- [ ] 11 消息推送：URL `https://<域名>/api/v1/webhooks/wechat-mini`，Token 和 EncodingAESKey，**数据格式 JSON、安全模式**；
      同样的值填入后台「小程序设置」（C07、C09）。
- [ ] 12 订阅消息模板：按 C08 的场景表选模板，模板 ID 填入后台（C08）。
- [ ] 18 后台「快递公司」逐个填写微信快递编码（C07）；「系统设置 → 小程序发货信息管理」打开「录入发货信息」并点一次「同步」。
- [ ] 后台「内容安全」开关打开；安排人每天处理评价管理中的「待审核」（CONTENT-001）。
- [ ] 后台「店铺装修」发布首页和个人中心（旧装修数据不迁移，用预置模板）。
- [ ] 19 审核准备：测试账号、清理测试数据、审核备注（C16）。
- [ ] 上传体验版 **【需批准】**，对着生产按 device-check 第 6 节做一遍真机检查（第 1 节第 8 步）。
- [ ] 20 提交审核 **【需批准】**；通过后发布 **【需批准】**。

### 3.3 发布之后

- [ ] 确认已纳入发货管理（`is_trade_managed`），用 0.01 元商品走一次真实的支付、发货、确认收货和结算（C06、C07）。
- [ ] 扫落地页和海报上的小程序码，能打开对应页面（正式版发布之前生成的码扫不开，所以发布前不对外发码）。
- [ ] 之后才对外发小程序码、海报；如有线下物料，按需印小程序码。旧 H5 链接都会 302 到落地页。

---

## 4. 回退方案

### 4.1 后端和 edge

- **部署失败**（`ship.sh` 退出码 1）：`shop upgrade` 已自动回到上一版的三个镜像，`REVISION` 仍是上一版。迁移已经执行，
  2.11 删掉的四张表不在了，所以回来的旧 uni-app H5 首页和旧后台「页面装修」会报错；后台、订单等其余功能照常。
  修好后重新从第 1 节第 2 步开始。要连数据一起回到部署前：
  `deploy/ship.sh rollback --last-upgrade --restore data/backups/pre-upgrade-<时间>.sql.gz`（会要求输入 `restore` 确认；
  部署之后写入的数据全部丢失——目前只有测试数据）。退出码 3 表示自动回退也失败了，需要人看，不要再自动操作。
- **部署成功，小程序发布之前发现问题**：先在公众平台撤回审核（旧后端没有小程序要调的接口），再用上面带 `--restore` 的
  命令回到部署前，或者修复后前进。只回镜像不恢复数据（`deploy/ship.sh rollback --last-upgrade`）也能跑，但旧装修同样报错。
- **小程序发布之后**：后端不能再回到切换之前，否则小程序调用的接口（`app/config`、`pages`、`share/mini-codes`……）会消失；
  只能修复后前进（新提交，再走一遍第 1 节第 2–5 步）。
- 回退后按 `deploy/README.md` 的 readiness gate 确认 `deploy/ship.sh status` 通过。

### 4.2 小程序

- 公众平台「版本管理」可以把线上版本回退到**上一个线上版本**；第一次发布没有上一版可退。问题严重时用加急审核发修复版，
  必要时在后台关掉相关功能开关（例如「录入发货信息」、分享海报）。

### 4.3 回退后要做的

- [ ] 记录原因和时间点，写进 `docs/mini/HANDOFF.md`。
- [ ] 修复后重新走第 0 节的条件，再按第 1 节发布一次。

---

## 5. 商城接口兼容守卫（`api-compat`）

小程序一旦发布，旧版本会在用户手机上留很久（微信择机更新，不重启就一直是旧版）。所以从第一个版本发布起，
`/api/v1/**` 原则上只能增加，不能删除或收窄。R1 加了这个守卫，说明见 [guards/README.md](../../guards/README.md#the-api-compat-check)。

- **比较什么**：`pnpm gen` 生成的 OpenAPI 里 `/api/v1/**` 那部分，与 `guards/baselines/storefront-api.json`（上一个已发布
  版本看到的接口）比较。删除路径或方法、响应字段被删除或变为可选或可为 null、响应枚举值被删除、请求字段变为必填或被收窄，
  都算破坏；新增的一律通过。
- **开关**：`guards/src/checks/api-compat.ts` 顶部的 `export const ENFORCED = false`。`false` 时破坏性改动只作为
  note 打印（`[breaking, report-only]`），`pnpm guards` 仍通过；`true` 时让 `pnpm guards` 失败。开关打开而基线还是
  未发布的快照（`"release": null`）时，守卫本身报错。**本次发布保持 `false`**（HANDOFF 第 6 节第 7 条）：
  新增枚举值、删除请求字段怎么判，打不打开开关，等小程序第一次发布之后再定。
- **刷新命令**：

  ```sh
  pnpm --filter @shop/guards api-compat:refresh --release <版本号>   # apps/mini/package.json 的 version
  pnpm --filter @shop/guards api-compat:refresh --unreleased        # 仅限记下发布版本之前
  ```

  它先重新生成 OpenAPI，再打印新基线「原谅」了哪些破坏性改动（写进提交说明），最后重写基线文件。基线记录了发布版本号之后，
  `--unreleased` 会被拒绝。基线是生成的文件，不手改。

### 5.1 什么时候做什么

- [x] **动手删除之前**：在 `storefront/mini` 上跑 `pnpm guards`，`api-compat` 不应打印任何 `[breaking, report-only]`。
      有的话说明基线过时了，先 `api-compat:refresh --unreleased` 单独提交一次，让下一步的清单只含本次的删除。
- [x] **第 2 节的删除都做完之后**（第 1 节第 1 步的最后一个提交）：用这次要上传的版本号跑
      `api-compat:refresh --release <版本号>`。核对它打印出的「原谅」清单**只包含** 2.3–2.6 节列出的接口（旧装修、
      辅助接口含 `site/config`、店员、`wechat/mini-qrcodes`），没有一条是新小程序调用的；清单写进提交说明。
      你已同意按这个办法处理切换时的删除。
      （C1：删除前 `api-compat` 为 0 条；删完后以 `--release 1.0.0` 刷新，原谅 51 条：`/api/v1/diy/*` 8 条、
      辅助接口 5 条（`attachments/base64`、`cart/items/decrements`、`catalog/categories/version`、`catalog/skus/{skuCode}`、
      `site/config`）、`/api/v1/staff/*` 36 条、`wechat/mini-qrcodes` 1 条，外加 `POST /api/v1/uploads` 的
      `purpose` 不再接受 `staff`（店员上传分支，2.5）。新小程序不调用其中任何一条（`apps/mini` 类型检查通过）。
      刷新后 `api-compat` 对 release 1.0.0 为 0 条。）
- [ ] **审核被拒、修改后重新提交，且 `/api/v1` 有改动**：版本号没有发布过，就用**同一个版本号**再刷一次，清单同样要逐条核对。
- [ ] **之后每次发布小程序**：先按 device-check 第 9 节改版本号，再 `api-compat:refresh --release <新版本号>`，
      清单应该为空；不为空说明有破坏性改动混了进来，要么改回去，要么确认旧版本已不再使用（微信后台「版本管理」里
      旧版本的使用占比）后再接受。
