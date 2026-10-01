# X-ZOO 商城

简体中文 | [English](./README.md)

面向国内市场的单商户网上商城。顾客通过微信小程序购物，商家在网页管理后台经营店铺。

功能：

- **商品**：规格与 SKU、分类、标签、参数、评价、关键词搜索。
- **下单**：购物车；结算时计算运费模板与优惠券分摊；订单；按需开票；自动取消与自动收货。
- **支付与售后**：微信支付 v3（JSAPI、小程序、H5）、超时支付对账、退款申请与审核。
- **营销**：优惠券、拼团、预售。
- **履约**：发货、拆单发货、物流查询。
- **内容**：小程序的积木式店铺装修、文章、协议。
- **用户**：短信、密码、小程序、公众号登录；地址、标签、分组。
- **公众号**：菜单、自动回复、二维码、素材。
- **运营**：由权限原子组成的角色、操作日志、通知（站内信、消息模板、订阅消息）、统计看板、本地或 S3 兼容存储。

## 技术栈

| 组成          | 说明                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`    | Next.js 16（App Router，standalone）。管理后台在 `/admin`（React 19、Ant Design 6），其接口在 `/admin-api/*`，商城接口在 `/api/v1/*`。 |
| `apps/worker` | BullMQ worker：定时任务、按需任务，以及提交后副作用的派发器。                                                                          |
| PostgreSQL 17 | 唯一的数据库。schema 与迁移由 Drizzle 管理。                                                                                           |
| Redis 7       | 后台会话、配置缓存、限流、任务队列、后台实时通知的 pub/sub。                                                                           |
| `apps/mini`   | 微信小程序商城（Taro 4、React 18）。它的「模拟小程序」H5 构建只用于 e2e 和装修预览。                                                   |
| edge          | 最前面的 nginx：把 `/`（落地页）、`/admin`、`/admin-api`、`/api`、`/scan-upload` 转发给 `web`，并提供 `/uploads/`。                    |

全部是严格模式的 TypeScript，运行在 Node 24 上，用 pnpm 管理。每个接口只声明一次，即 `packages/contracts` 里的 zod 契约；OpenAPI 文档、类型化的后台客户端、mock server 和守卫都由它派生。详见 [docs/architecture.md](docs/architecture.md)。

## 目录结构

```
apps/
  web/          Next.js：后台页面、/admin-api、/api/v1
  worker/       BullMQ worker 及其任务
  mini/         微信小程序（Taro）
packages/
  config/       共享的 ESLint、TypeScript、Vitest 预设
  contracts/    路由契约（zod）→ OpenAPI；接口的唯一事实来源
  core/         领域逻辑，每个领域一个目录，另有 kernel/
  db/           Drizzle schema、迁移、基础数据种子
  testing/      Testcontainers 测试基座、工厂、假微信与假短信网关、mock server
  api-client/   小程序使用的类型化 /api/v1 客户端
  storefront-blocks/  小程序与后台装修共用的装修块
e2e/            Playwright 套件：admin/ 与 storefront/
guards/         全仓静态检查（pnpm guards）
load/           负载冒烟
docker/         web、worker、edge 三个镜像
deploy/         生产 Compose 栈及其脚本
docs/           架构、约定、贡献指南、业务规则目录
```

## 本地开发

### 前置条件

- Node 24 与 pnpm 12（`corepack enable` 即可得到锁定的版本）。
- Docker：用于 PostgreSQL、Redis、集成测试和端到端套件。

### 启动

```sh
pnpm install
pnpm gen          # 生成的聚合文件（*.gen.ts、openapi.json）不入库

docker run -d --name shop-pg -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=shop -e POSTGRES_PASSWORD=shop -e POSTGRES_DB=shop postgres:17
docker run -d --name shop-redis -p 127.0.0.1:6379:6379 redis:7 \
  redis-server --maxmemory-policy noeviction

export DATABASE_URL=postgres://shop:shop@127.0.0.1:5432/shop
export REDIS_URL=redis://127.0.0.1:6379
export UPLOADS_DIR="$PWD/.uploads"
export VALIDATE_RESPONSES=1       # 每个响应都按契约校验

pnpm --filter @shop/db db:migrate   # 建表
pnpm --filter @shop/db db:seed      # 基础数据：城市、快递公司、模板
pnpm dev                            # web 在 http://localhost:3000，同时启动 worker
```

种子只灌基础数据，不创建管理员；产品内也没有任何途径能授予 `is_super`，所以第一个超级管理员要直接写库。密码哈希用 bcrypt，密码从终端读入，不出现在命令行上：

```sh
(cd packages/core && read -rs PW && PW="$PW" node --input-type=module \
  -e "import b from 'bcryptjs'; console.log(await b.hash(process.env.PW, 10))")
docker exec -i shop-pg psql -U shop shop <<'SQL'
insert into admins (account, password_hash, name, is_super)
values ('admin', '<上面的哈希>', '超级管理员', true);
SQL
```

然后在 <http://localhost:3000/admin> 登录。`/admin/dev/kit` 实时展示后台 kit 的全部组件。

如果想要一个已经带有管理员、商品、优惠券和买家的环境，改用后台端到端套件的服务：`pnpm --filter @shop/e2e-admin exec tsx scripts/serve.ts`。它在 Testcontainers 里自带 PostgreSQL 与 Redis，登录账号 `e2e-super` / `e2e-Passw0rd!`。

### 小程序

`apps/mini` 和其他包一样在 pnpm workspace 里：

```sh
pnpm --filter @shop/mini dev:weapp     # 产物在 dist/weapp，用微信开发者工具导入
pnpm --filter @shop/mini build         # 微信包、H5 预览和体积门禁
```

接口源来自 `TARO_APP_API_ORIGIN`；开发者自己的 AppID 和接口源放在 `apps/mini/.env.*.local`。设计见 [docs/mini/](docs/mini/README.md)，在开发者工具和真机上试用见 [docs/mini/device-check.md](docs/mini/device-check.md)。

## 检查

以下全部通过才能合并。完整清单及每一步证明什么，见 [docs/contributing.md](docs/contributing.md)。

```sh
pnpm turbo run gen typecheck lint test:unit build
pnpm turbo run test:int --force --concurrency=4     # 需要 Docker
pnpm --filter @shop/contracts check:examples
pnpm exec prettier --check .
pnpm guards                                          # 0 failures
pnpm --filter @shop/e2e-admin e2e                    # 使用 apps/web 的构建产物
pnpm --filter @shop/e2e-storefront test            # 小程序的「模拟小程序」H5 构建
```

CI（`.github/workflows/ci.yml`）跑上面的全部内容，另加 shellcheck、部署演练，以及在 push 时构建三个生产镜像。

## 部署

商城在一台主机上以一个 Docker Compose 项目运行：PostgreSQL、Redis、`web`、`worker` 与 nginx `edge`，前面是 Traefik。镜像在 CI 中构建，按 digest 部署。首次部署、升级、回滚、备份与恢复见 [deploy/README.md](deploy/README.md)。

## 文档

- [docs/architecture.md](docs/architecture.md)：系统如何组成。
- [docs/conventions.md](docs/conventions.md)：代码遵循的工程约定。
- [docs/contributing.md](docs/contributing.md)：合并清单；如何新增领域、路由或契约。
- [docs/invariants.md](docs/invariants.md)：业务规则，每条附证明它的测试。
- [deploy/README.md](deploy/README.md)：生产栈的运维。

## 许可证

专有软件。版权所有 (c) 2026 XIANGYU MOU，保留所有权利。见 [LICENSE](LICENSE)。
