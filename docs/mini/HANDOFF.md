# 小程序重写：进度交接（2026-09-24，第三版：已切换）

给接手的会话（本地或云端）看的。读完这一页，再按「先读」列表看其他文档，就能接着干。

## 1. 一句话现状

**代码写完，已切换上线，体验版已上传。** uni-app、旧装修、辅助接口、店员接口都已删除；线上 `/` 是落地页。剩下的都在公众平台和真机上：配域名、真机检查、提交审核、发布（第 4 节）。

- 线上 = `f3311f89a`（2026-09-24 14:45 用 `deploy/ship.sh` 部署，停机迁移到 0009）。升级前的备份：主机上 `data/backups/pre-upgrade-20260924T064442Z-2381635.sql.gz`，回退见 `cutover.md` 第 4 节。
- `master` = `storefront/mini` = `cf779f01a`，比线上多一个只改小程序的提交（去掉 WXSS 不支持的 `*` 选择器，`size-report` 以后会拦）。服务器不用为它重新部署。
- 体验版 1.0.0（备注「首个体验版」）用 miniprogram-ci 上传，用户已在「版本管理」设为体验版。包是 `cf779f01a` 构建的，`TARO_APP_API_ORIGIN=https://x-zoo.vip`，约 900 KB。
- 公众平台的服务器域名**还没配**（用户说先不管），所以体验时要在右上角「…」打开「开发调试」。
- 缩略图补跑过：98 张全是旧系统迁来的旧图，按设计不生成（0 张），新上传的图自动生成 480/960。
- 线上还是内部测试，只有一个测试用户。
- 所有执行者分支和 worktree 已删；远端只剩 `master` 和 `storefront/mini`。

## 2. 这一批做了什么

| 任务 | 结果                                                                                                                                                                                                                                                                                 | 状态文档                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| H6   | `auth.passwordLogin` 可选 `bindToken`，密码登录后把暂存的小程序 openid 绑到该账号（AUTH-009）；客户端带上 bindToken，只是绑定被拒时不带重试一次；登录卡和手机号页的隐私拒绝改为中文提示。                                                                                            | `status/H6-auth-bind.md`     |
| K1   | 安全审查。修了评价图片可填任意外链（CAT-018，线上也有）；补了预售的 kindMeta 测试（ORDER-009）。其余写成文档：P1–P5（线上）、B1–B8（仅新分支）。                                                                                                                                     | `status/K1-security.md`      |
| K2   | 主包 703 → 682 KB，总 1068 KB。`build:weapp` 超预算或混入 source map、demo、测试代码、后台路由、NutUI 整包时直接失败。图标 CSS 减半；倒计时共用一个 1 秒定时器，页面隐藏时停。                                                                                                       | `status/K2-size-perf.md`     |
| K3   | 修了 11 个衔接处缺陷：我的角标过期、短信登录回错页、首个地址不刷新、领券状态不同步、多处缓存、评价列表、倒计时到零不停、订单详情重复入栈、4xx 重试。                                                                                                                                 | `status/K3-client-review.md` |
| R1   | 新守卫 `api-compat`（对比 `/api/v1/**` 与 `guards/baselines/storefront-api.json`，目前只报告不拦截，开关 `guards/src/checks/api-compat.ts` 的 `ENFORCED`）；`apps/web` 的 `/` 改为顾客落地页（店名 + 小程序码 + 「请使用微信扫码打开」），edge 未接，改法见 `cutover.md` §2.10、§5。 | `status/R1-release-prep.md`  |

协调者在合并时做的：

- `countdown.tsx` 冲突（K2 共享定时器 + K3 到零即停）：两者都保留；到零的状态按截止时间记在 ref 里，页面隐藏期间到零的，回到前台时仍会调一次 `onEnd`。
- 并入 `master`：`order.checkout.service.ts` 冲突保留本分支的 `kindSelections`（`master` 的 `508f009` 是同一问题的临时修法，提交说明里写了会被这里替代），`docs/architecture.md`、`docs/contributing.md` 两边内容合并。
- `cutover.md` 里 `drill.sh` 的行号随 `master` 的部署改动更新为 722。
- H6 合入后刷新了 `api-compat` 基线（只增加了 `bindToken` 和两个错误码）。
- 修了 SMOKE-004 暴露的登录页问题（见第 3 节）。

## 3. 最近一次全套检查（@ `9bbe15b` 之后，云端容器）

| 检查                                             | 结果                   |
| ------------------------------------------------ | ---------------------- |
| `prettier --check .`                             | 通过                   |
| `turbo run typecheck lint build --concurrency=4` | 35/35                  |
| `turbo run test:unit --concurrency=2`            | 16/16                  |
| `pnpm guards`                                    | 16 项，0 失败          |
| `@shop/contracts check:examples`                 | 461 条路由通过         |
| `@shop/core test:int`                            | 1556 条通过            |
| `@shop/web test:int`                             | 331 条通过             |
| `e2e/storefront test:mini --workers=1`           | 45/45（见下）          |
| 旧 uni-app storefront e2e、后台 e2e              | **没跑**，本地要跑一次 |

`test:mini`：全套 44 通过、1 失败（SMOKE-004，H6 新加的续期那一段）。原因在应用里：登录页的 effect 每次 `session.status` 变成 `signed-in` 都执行 `returnFromLogin`；登录页作为第一页打开时，在 H5 模拟里会留在 tab 页下面不卸载，401 续期让状态从 `signed-in` 变走再变回来，这个看不见的登录页就又把顾客拉回首页。已修（登录页只离开一次，`apps/mini/src/pages/login/index.tsx`，单测覆盖，去掉修复后单测会失败），之后 `specs-mini/login.spec.ts` 7/7 通过。修复后没有再跑一次全套 `test:mini`，本地跑全套时顺便确认。

云端环境说明（本地不适用，记下备查）：容器是 Node 22，装了 Node 24 + pnpm 12.5.1；没有 Docker，集成测试和 e2e 用本机 PostgreSQL 16 + Redis 7（`SHOP_TEST_PG_URL` / `SHOP_TEST_REDIS_URL`）。**复用一个 Redis 跑两次 e2e 时，第二次必须先 `FLUSHALL`**，否则缓存的微信配置指向上一次假微信服务的端口，所有小程序登录都会 503。本地用 Testcontainers 不会遇到。

**本地复查（2026-09-24，B1、L1、L2、L3 合入之后）：** 全套通过。turbo 45/45；test:int core 1563、web 331；prettier、check:examples（461）、guards（16 项 0 失败，api-compat 0 破坏）通过；后台 e2e 50/50；uni-app `npm test` 477 通过（32 跳过）、重新 `build:h5` 后旧 storefront e2e 34/34；`test:mini` 46/46。
注意：e2e 判断 uni-app H5 是否过期只看源码时间，只改 `package.json` / lock 时不会重建，要手动 `npm ci && npm run build:h5`。

**本地复查（2026-09-24，P1、P2、C1、C2 合入之后，即切换代码已完成）：** turbo 45/45（size-report ok）；test:int core 1422、web 248、worker 6、testing 9（删了 diy / 店员的测试，所以变少）；prettier、check:examples（392）、guards（15 项 0 失败；api-compat 对 release 1.0.0 0 破坏）通过；后台 e2e 46/46；storefront e2e（现在就是小程序）46/46；`drill.sh --only edge/` 2/2；演练构建的 worker 镜像里 `sharp` 能加载。全量演练没跑。

**本地复查（2026-09-24，X1、X2、X3 收尾合入之后）：** turbo 45/45（size-report ok）；test:int core 1418、web 248、worker 6、testing 9；prettier、check:examples（392）、guards（15 项 0 失败，api-compat 0 破坏）通过；后台 e2e 46/46；小程序 e2e 46/46；`drill.sh --only edge/` 2/2（含 favicon、robots.txt）。迁移到 0009，`EXPECTED_MIGRATIONS=10`。`master` 没有新提交，`storefront/mini` 领先 385 个。小程序上传密钥在集成目录根部（已 gitignore，`private.*.key`）。

## 4. 接下来要做的

`cutover.md` 第 1 节第 1–5、7、8 步已完成（第 5 步的只读检查：`/` 是落地页且 `noindex`，旧 H5 路径 302 到 `/`，`/admin` 200，`/api/v1/app/config` 200，已删接口 404，`REVISION` 正确，容器都 healthy）。剩下的：

1. **公众平台和后台配置**（`cutover.md` 3.2，用户或运营做）：服务器域名 request / uploadFile / downloadFile 填 `https://x-zoo.vip`；消息推送；订阅模板；快递编码和同步；内容安全开关；店铺装修发布首页和个人中心；体验成员。配好域名后就不用再开「开发调试」。
2. **真机检查**：`device-check.md` 第 6 节，对着生产，由人做。隐私弹窗（D03）必须在真机上过。
3. **提交审核、发布**：每步单独问用户。审核准备见 `cutover.md` 3.2 第 19 项；发布后按 3.3 做。
4. **改了代码要再发版时：** 只改 `apps/mini` 就重新构建（`TARO_APP_API_ORIGIN=https://x-zoo.vip pnpm --filter @shop/mini build:weapp`，先在该目录跑一次 `pnpm turbo run gen --filter=@shop/mini...`），然后上传：
   `WX_MINI_UPLOAD_KEY_PATH=private.wx4f4b772125e155ed.key pnpm --filter @shop/mini exec node scripts/upload.mjs --confirm`（版本固定 `1.0.0`，先用 `--dry-run` 看一遍）。
   密钥在仓库根目录且被 git 忽略，脚本接受。不要直接调用 miniprogram-ci：脚本会核对 size-report、工作区干净、产物就是 `HEAD`、`HEAD` 在 `origin/master` 上且 CI 通过（`device-check.md` 第 8 节）。每次上传都要问用户。
5. **遗留小项（不急）：**
   - K3：连点「结算」「立即购买」会开两次页面（不会重复下单）；两处重复代码（`cart-view.ts` 的金额函数、`aftersale/apply` 的 `REFUND_READS`）。
   - K1 P4：售后凭证图可填外链，要单开售后方向的任务。
   - Dependabot：`apps/mini` 的 webpack，1 个中危、2 个低危，只在构建时用，不进包。
   - `apps/mini` 构建有 mini-css-extract-plugin 的 CSS 顺序警告（不影响产物）。

## 5. 顾客看得到的变化（这一批，要告诉用户）

- **登录（H6）：** 拒绝隐私保护指引时，登录卡显示「未同意隐私保护指引，可改用短信验证码登录」，手机号页显示「未同意隐私保护指引，可改用其他手机号绑定」（旧：微信的英文报错）。从「需要手机号」状态用密码登录后，会话过期会静默登回同一个账号（旧：落到登录页，或登进持有这个 openid 的另一个账号）。
- **K3：**
  - 我的：每次打开都是最新的角标和数字（旧：别处改动后最多 30 秒不更新）。
  - 确认订单 / 收银台 / 支付结果：在这些页用短信登录后回到原页（旧：回首页，丢了草稿）。
  - 首页 / 微页面 / 我的：别处领的券回来就显示已领（旧：仍显示「领取」）。
  - 确认订单：添加第一个地址回来立即显示（旧：最多 30 秒内仍是「请先添加收货地址」）。
  - 搜索历史包含刚搜的词。
  - 商品详情领券、装修页优惠券块领取失败：用领券中心的说法，如「来晚了，券已抢光」「已达领取上限」（旧：服务端原话，如「该优惠券已被领完」）。
  - 收货地址「已导入微信地址」（旧「已导入」）；申请开票「没有找到这个订单」（旧「订单不存在」）；注销账号结果页「回到首页」（旧「返回首页」）。
  - 收银台 / 支付结果「查看订单」、评价「返回订单」：回到原订单详情（旧：再开一个）。
  - 商品已下架、订单不存在等 404 状态立即显示（旧：约 1 秒后）。
- **K2：** 无。
- **R1：** web 容器上的 `/` 从「商城服务 / 管理后台在 /admin」变成顾客落地页；线上 `/` 仍是 uni-app H5，要等切换时改 edge。edge 改完后，所有未知路径 302 到 `/`，旧 H5 和分享链接都会落到落地页。

## 6. 用户的决定（2026-09-24 本地会话）

背景：小程序**从未发布**，没有公众号，生产只有一个测试用户。所以不需要照顾旧版本或旧 H5 顾客。

**要落实到代码 / 文档的：**

1. **K1 P5 / B3：** 拼团团页的团员昵称打码（如「小*」），接口不再返回团员 `userId`，头像保留。昵称内容安全维持 fail-open。
2. **K1 B2：** 没有小程序 openid 的账号发的评价、图片检测为 `skipped` 的评价，一律进待审核。
3. **K1 B4：** 明文 / 兼容模式下 Redis 不可用时拒绝推送（fail-closed）。
4. **H6：** 绑定被拒后仍登录成功时，加一句轻提示，如「此微信已关联其他账号，本账号需用密码或短信登录」。
5. **K2：** 分包预算定为 **1 MB**（构建门禁从 2 MB 改为 1 MB，文档统一）；删除 `@nutui/nutui-react-taro` 和配色桥接。
6. **切换：一次发布**（不做 I2 提的三次发布）。`cutover.md` 已改成一次发布的写法（L3，`status/L3-cutover-docs.md`）；旧表也在这次删（cutover.md 2.11）。
7. **R1 兼容守卫：** 保持「只报告、不拦截」。新增枚举、删请求字段怎么判，等小程序第一次发布后再定。切换时的删除按 §5 同版本号重刷基线。落地页 `/` 保持 `noindex`。

**不改：**

- K3：我的页每次打开发两个请求，接受；领券文案按领券中心统一（K3 已做）。
- 默认品牌色保持 #E1251B。
- 装修模板里「隐私包装」那句属实，保留。
- 公众号模板消息：没有公众号，不处理。
- 真机测试：用户本人和其他人都会测。
- master 目录的 6 个多余文件：已删。

**之前已定：**

- 线上还没运营（内部测试）。K1 的 P1 kindMeta 价格绕过：本分支已修（ORDER-009），随切换上线；`master` 上的 `508f009` 不用专门部署。
- 原生 tabBar；v1 包含「我的评价」和「我的拼团」；关闭虚拟成团。
- 风险评价进待审核；商品海报加开关，默认开；预售 v1 只做全款。
- 精细首页装修（自由布局）暂时不做。
- 我的评价的状态文字沿用「审核后展示」和「仅自己可见」。

## 7. 规矩（用户明确要求过）

- **机器负载：** 用户的开发机（WSL，14900K，31 GB）曾经因为并行跑测试宕机。
  - 执行者最多 5 个，但只跑自己改动相关的类型检查、lint 和单元测试。
  - 全套检查、集成测试和 e2e 只由协调者来跑：一次只跑一个，限制并发（turbo `--concurrency=4`，Playwright `--workers=1`）；一批合并之后跑一次，不是每合并一个就跑。
  - 不在后台留着没跑完的测试。
- **生产：** 主机 `ubuntu@43.142.105.205` 默认只读。超出只读的操作、拉生产数据、任何推送到 `master`、开 PR，都要先问用户。
- **机密：** 不打印旧系统配置表里的任何密钥值。仓库、日志、截图里不能出现生产数据或真实凭据。
  - 小程序 AppSecret 用户在聊天里贴过，**绝不存储、复述或提交**；已建议用户重置。
  - 代码上传密钥：用户放在 `/home/xiangyu/Projects/x-zoo-mini/private.wx4f4b772125e155ed.key`（已 gitignore），上传 IP 白名单已关（2026-09-24 用户关的）。不读、不打印内容；每次预览或上传都要单独批准。
- **外部接口：** 开发和测试只用 `@shop/testing` 的假实现，不调用真实的微信、短信、阿里云接口。
- **不要碰：** 主目录 `/home/xiangyu/Projects/x-zoo`（用户在里面修后端 bug）。
  - 之前 G1 误写的 6 个草稿文件已于 2026-09-24 按用户同意删除。
- **核心业务逻辑不重写**：订单、支付、退款、库存、优惠券、拼团、预售、鉴权。
- **沟通：** 用中文。

## 8. 上线前需要运营在后台完成的事（摘自 H2）

- 公众平台「消息推送」：URL、Token、EncodingAESKey，JSON 格式，安全模式；这些值同时填进后台的微信设置。
- 每家快递公司填写「微信快递编码」，然后点「同步」。
- 在「待审核」里审核评价。
- 域名必须是 HTTPS 且已备案。
- 先发布小程序版本，再对外发放小程序码。

## 9. 先读

- `docs/mini/README.md`：文档地图和构建方式（§2 有 K2 的新体积基线）
- `docs/mini/pages.md`：页面和页面形态改动
- `docs/mini/cutover.md`：切换方案（§2.10 edge、§5 兼容守卫的开关和刷新）
- `docs/mini/e2e-coverage.md`：测试覆盖
- `docs/mini/decor.md`：装修
- `docs/mini/wechat-compliance.md`、`docs/mini/auth.md`
- `docs/mini/status/{H6-auth-bind,K1-security,K2-size-perf,K3-client-review,R1-release-prep}.md`：这一批的细节
- `docs/conventions.md`、`docs/contributing.md`、`docs/invariants.md`
- 已批准的完整方案（中文）：`docs/mini/plan.md`
- 执行者公共规则：`docs/mini/executor-rules.md`
