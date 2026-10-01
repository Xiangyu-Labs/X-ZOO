# 新小程序（`apps/mini`）文档

`apps/mini` 是替代 `apps/uni-app` 的微信小程序：Taro 4 + React 18，在 pnpm workspace 里。它怎样搭起来的见
[architecture.md「The mini-program」](../architecture.md#the-mini-program)，写代码的规则见
[conventions.md「The mini-program」](../conventions.md#the-mini-program)。本目录是它的设计文档和操作手册。

## 1. 文档地图

| 文档                                         | 内容                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [pages.md](pages.md)                         | 页面地图、分包、每页调用的接口；路由目录 `storefrontRoute`（链接、小程序码、订阅消息都只存 `{route, params}`） |
| [design.md](design.md)                       | 设计 token、主题、`ui/` 组件清单、页面版式、无障碍                                                             |
| [auth.md](auth.md)                           | 静默登录、手机号快速登录、短信兜底、401 续期与重放、退出                                                       |
| [decor.md](decor.md)                         | 页面装修 v2：文档模型、块、数据源、校验、修订、解析器、预览令牌、后台编辑器                                    |
| [wechat-compliance.md](wechat-compliance.md) | 微信平台规则 C01–C18 各自落在哪里，以及需要运营或老板在公众平台办理的事项                                      |
| [device-check.md](device-check.md)           | 微信开发者工具和真机检查：e2e 看不到的东西（WXML、原生组件、真实的微信接口）                                   |
| [e2e-coverage.md](e2e-coverage.md)           | 旧 uni-app 的 e2e 场景、SMOKE 规则、必测旅程 → 新小程序的 spec，以及还缺什么                                   |
| [cutover.md](cutover.md)                     | 切换清单（一次发布）：当天的顺序、删什么和改什么、删表迁移、兼容基线、公众平台上的操作、回退                   |
| [spikes/](spikes/)                           | 技术预研报告：S1 Taro、S2 api-client、S3 装修、S4 e2e「模拟小程序」                                            |
| [status/](status/)                           | 每个开发流的状态记录和截图                                                                                     |

业务规则（DECOR、SHARE、CLIENT 等开头的条目）和证明它们的测试在 [../invariants.md](../invariants.md)。

## 2. 构建

| 命令（`pnpm --filter @shop/mini …`） | 产物                         | 用途                                                                                      |
| ------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------- |
| `build:weapp`、`dev:weapp`（监听）   | `dist/weapp`                 | 真正发布的微信小程序包，用微信开发者工具打开；`build:weapp` 构建完就跑 `size`，不过就失败 |
| `build:h5`、`dev:h5`（监听）         | `dist/h5`                    | 浏览器预览：没有微信能力（登录、支付提示「不可用」），接口走同源 `/api/v1`                |
| `build:h5:mp-emulation`              | `dist/h5-mp-emulation`       | 只给 e2e 用：以 `wechat-mini` 身份调用接口，微信能力由假件回答                            |
| `build`                              | weapp（含体积检查）+ H5 预览 | CI 和检查清单跑的就是它                                                                   |

每个 `taro build` 都带 `--no-check`（[S1 workaround 1](spikes/S1-taro.md)）。

`size`（`scripts/size-report.mjs`）检查 `dist/weapp`：

- **预算：** 主包 ≤ 1.5 MB，每个分包 ≤ 1 MB，总计 ≤ 8 MB（与 `wechat-compliance.md` C13、`pages.md` §1 一致；微信的上限是主包、分包各 2 MB，总计 20 MB）；
- **不能出现：** `eval`、`new Function`、ES2018 以上的语法、zod、source map、开发用的 `subpackages/`（演示页）、测试代码和夹具、后台路由、e2e 模拟层、疑似密钥；
- **只有分包用到的模块不能留在主包：** 依据 `config/bundle-stats.ts` 记下的每个模块被哪些包的页面引用。

报告最后列出主包按来源分的体积，主包变大时先看这里。基线（K2，2026-09-24）：主包 682.0 KB，总计 1064.7 KB，最大的分包 `account` 120.1 KB；明细见 [status/K2-size-perf.md](status/K2-size-perf.md)。

## 3. 本地开发

### 3.1 浏览器里看页面（H5）

- **只看布局**：`pnpm --filter @shop/mini dev:h5`，Taro 的开发服务器监听改动、重新构建。H5 预览调用同源的
  `/api/v1`，开发配置里没有代理，所以接口请求会失败，页面停在空态或错误态。
- **带真实数据**：起 e2e 全栈（需要 Docker，全是假件，不会访问真实的微信、短信或阿里云）：

  ```sh
  pnpm --filter @shop/e2e-storefront serve
  ```

  它会按需构建「模拟小程序」H5、`next build`，起 web、worker、假网关和 edge；日志里
  `starting edge on :<端口>` 就是入口。用浏览器的手机模拟打开 `http://127.0.0.1:<端口>/`：静默登录、
  支付都由假件回答，种子数据见 `e2e/storefront/src/seed.ts`。改了 `apps/mini` 之后重启它（构建过期时会重建）。

### 3.2 微信开发者工具和真机

按 [device-check.md](device-check.md) 做，要点：

1. 选一个后端（第 3 节）：契约 mock 服务器（`pnpm --filter @shop/testing mock -- --host 0.0.0.0 --port 4010`）、
   e2e 全栈的设备模式（`SHOP_E2E_WECHAT_DEVICE=1`），或本机开发栈加真登录（每次都要先征得本人同意）。
2. 构建：`pnpm --filter @shop/mini exec node scripts/device-build.mjs --origin http://<LAN_IP>:4010`，
   或把 `TARO_APP_API_ORIGIN` 写进 `apps/mini/.env.production.local`（已 gitignore）再 `build:weapp`；
   `dev:weapp` 用于边改边看。
3. 开发者工具「导入项目」选 `apps/mini/dist/weapp`，AppID 是店铺自己的 `wx4f4b772125e155ed`；个人测试
   AppID 放 `.env.*.local`，不提交。
4. 按第 6 节的清单逐项检查，按第 7 节的格式回报。

「预览」「真机调试」和 `scripts/preview.mjs` 都会把代码包上传到微信服务器，只在本人同意那一次时做。
AppSecret 和代码上传密钥从不进仓库。

## 4. 测试

| 层          | 命令                                         | 说明                                                                           |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| 单元        | `pnpm --filter @shop/mini test:unit`         | 组件、平台层、会话、路由场景值；不碰网络                                       |
| 类型和 lint | `pnpm --filter @shop/mini typecheck`、`lint` | lint 管平台边界、契约只导入类型                                                |
| 守卫        | `pnpm guards`                                | `mini` 检查：页面 ⇄ `app.config.ts` ⇄ 路由目录、平台边界、隐私声明、分享、密钥 |
| e2e         | `pnpm --filter @shop/e2e-storefront test`    | `e2e/storefront/specs-mini/`，页面对象在 `src/mini-pages/`；每次起一套新栈     |
| e2e（热栈） | 见下                                         | 反复跑一个 spec 时省去起栈的时间                                               |
| 真机        | [device-check.md](device-check.md)           | e2e 看不到的部分；做不了的项在报告里写明                                       |

热栈：一个终端里起栈，另一个终端里复用它跑 spec：

```sh
cd e2e/storefront
pnpm exec tsx scripts/serve.ts                                   # 终端 1，保持运行
SHOP_E2E_REUSE=1 pnpm exec playwright test specs-mini/login.spec.ts   # 终端 2
```

热栈的端口和交接文件按工作目录区分，不同 worktree 的热栈互不可见。改了 `apps/mini` 或服务端代码后要重启
热栈。旧 uni-app 的套件（`specs/`）已在切换时删除（[cutover.md](cutover.md) 2.2）。

CI（`.github/workflows/ci.yml`）的 `storefront-e2e` 任务跑 `test`，即小程序的 `specs-mini/`，跑完整个目录。
