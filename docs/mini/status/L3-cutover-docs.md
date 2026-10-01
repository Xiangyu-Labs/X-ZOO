# L3 — 切换文档改为一次发布：状态

分支 `storefront/mini-L3-cutover-docs`，基于 `storefront/mini` @ `c3afbac0a`。只改文档（外加 `api-compat.ts` 的一段注释）。已完成。

## 已完成

- `docs/mini/cutover.md` 重写为一次发布：
  - 第 1 节是当天的顺序：做完第 2 节 → 构建和检查（含部署演练）→ 合并 `master`、push → `deploy/ship.sh` 部署
    → 部署后检查 → 平台配置 → 正式包构建 → 上传体验版 → 提交审核 → 发布；每个要批准的动作都标了【需批准】。
  - 删掉三次发布（A/B/C）、公众号菜单和模板消息的决定（没有公众号，开头说明一次）。
  - 旧表的 DROP 放进同一次发布（2.11），理由和回退代价都写了。
  - `site/config` 从「确认后再删」改为计划内删除（2.4）。
  - 兼容基线：删除做完后用上传的版本号 `--release` 刷一次，清单只能是计划内的删除；`ENFORCED` 保持 `false`（第 5 节）。
  - 回退改写为一次发布的三种情况（第 4 节）。
- 路径和行号逐条核对后修正：
  - `eslint.config.mjs` 实为 `apps/web/eslint.config.mjs`；
  - `EXPECTED_MIGRATIONS` 在 `apps/web/src/server/health.ts`，不在 `migrations` 守卫；
  - 部署命令是 `deploy/ship.sh`，仓库里没有 `deploy/upgrade.sh`、`deploy/rollback.sh`；
  - contributing 的 uni-app 步骤在第 101 行起；
  - 补上漏掉的文件：`e2e/storefront/src/seed.ts` 的旧装修种子、`api-client` 测试里的旧接口 id、CI 的 uni-app
    `setup-node` 和 Release summary 一行、`deploy/README.md` 的三处、`packages/db/docs/SCHEMA.md`。
- 其他文档对齐：`HANDOFF.md` 第 4 节第 7 条和第 6 节第 6 条、`docs/mini/README.md` 文档地图、`plan.md`（第 3 节删表那句和
  第 10 节第 6 项加了改动说明）、`pages.md` 第 4 节 `page_links` 一行、`status/I2-e2e-docs.md` 和
  `status/R1-release-prep.md` 加历史说明、`guards/README.md` 与 `guards/src/checks/api-compat.ts` 注释（开关在第一次发布时
  不打开）。

## 进行中

无。

## 待办

无（切换本身是另一个任务）。

## 页面形态变化

无。cutover 2.3 里「店铺装修（新版）」改回「店铺装修」是可选项，做了要告诉用户。

## 后端缺口

- 生产 edge 改完后，根目录的任何文件都会 302 到 `/`。如果要把店铺域名本身配成小程序「业务域名」（C12），微信的校验文件
  放不上去。需要的话，在切换的 edge 提交里加 `location ~ ^/[A-Za-z0-9_-]+\.txt$`（cutover 2.10）。

## 待用户决定

- 旧表在切换当次删除，推翻了计划第 10 节第 6 项（原定下一次发布删）。想保留原来的安排就说一声，2.11 改回「下一次发布」即可。
- 店铺域名要不要做业务域名（见上面的后端缺口）。
- 公众号、H5 专用接口（`auth.oa*`、`wechatOa.*`、`wechat_h5` 支付通道）现在没有调用方。计划写的是「保留不动」，本次不删；
  要不要以后另开任务删掉。

## 给协调者跑的测试

无。只跑了 `pnpm exec prettier --check` 和 `pnpm guards`。
