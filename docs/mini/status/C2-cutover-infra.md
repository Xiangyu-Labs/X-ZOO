# C2 — 切换：CI 与 edge（cutover.md 2.9、2.10）

分支 `storefront/mini-C2-cutover-infra`，基于 `storefront/mini` @ `925a2250c`。已完成，没有进行中的工作。

## 已完成

- **edge**（`docker/edge/nginx.conf`）：
  - `location = /` 代理到 `web`（落地页 `apps/web/app/page.tsx`），不写 `add_header`，继承 server 级的三条安全头；
    落地页继承根布局的 `robots: noindex`，没有改。
  - 其他没有匹配的路径 `302` 到 `/`，并加了 `absolute_redirect off`，响应头就是 `Location: /`（cutover 的 diff
    里没有这一行：不加时 nginx 会写成 `http://<host>/`，https 访问者要多绕一次 Traefik 的跳转）。
  - 新增 `location ~ ^/[A-Za-z0-9_-]+\.txt$`，从只读目录 `/srv/domain-verification` 提供微信业务域名校验文件
    （C12）；文件不存在时是 404，不跳转；只认根目录下的纯文件名。
  - 删除 `root /srv/h5`、`index`、H5 的缓存规则和 history 回退。`/admin`、`/admin-api`、`/api`、`/scan-upload`、
    `/_next/static/`、`/uploads/`、`/healthz`、`/readyz` 不变。
- **镜像**：`docker/edge/Dockerfile` 删除 `H5_DIST` 和 `COPY … /srv/h5/`，只剩 nginx 配置，另建空目录
  `/srv/domain-verification`；删除 `docker/edge/h5-placeholder/`；`Dockerfile.dockerignore` 只放行 `docker/edge`；
  `docker/worker.Dockerfile.dockerignore` 去掉 `apps/uni-app` 一行和「built into the edge image」注释。
- **挂载**：`deploy/compose.yml` 的 edge 加
  `${NEXT_DOMAIN_VERIFICATION_DIR:-./data/domain-verification}:/srv/domain-verification:ro`（相对 `shop` 所在目录，
  即生产的 `/home/ubuntu/apps/X-ZOO/data/domain-verification/`；发布从不碰 `data/`）。`deployment.env.example`
  加了这个键（空值即默认）。`deploy/lib/common.sh` 新增 `verification_dir`；`shop upgrade` 在目录不存在时建好
  （755），免得 Docker 以 root 建；已存在的目录和里面的文件不动。
- **演练**（`deploy/rehearsal/drill.sh`，**没有跑**）：
  - `edge/proxies-every-page-route`：「没有被代理」的判据改为「302 且 Location 为 `/`」；`/` 也要检查
    （必须由 `web` 回答）；开头改为先证明一个旧 H5 路径 `/pages/index/index` 得到 302、`Location: /`（相对）。
  - 新用例 `edge/serves-verification-files`：`shop upgrade` 建了 755 的目录；放进去的 `.txt` 原样返回、
    `text/plain`；不存在的是 404；子目录下的 `.txt` 是 302；edge 容器写不了这个目录（只读挂载）。
  - 演练把 `NEXT_DOMAIN_VERIFICATION_DIR` 指到自己的临时目录，`ship/` 用例复制同一份设置，不会写进仓库。
- **CI**（`.github/workflows/ci.yml`）：删除 uni-app 的 `storefront-e2e`（`npm ci`、uni-app 单测、H5 旅程）；
  `storefront-e2e-mini` 改名 `storefront-e2e`，跑 `test`，报告产物名改为 `storefront-playwright-report` /
  `storefront-test-results`；`images` 任务删除 uni-app 的 Node、「Build the H5 storefront」「Resolve the H5 bundle」、
  edge 的 `build-args: H5_DIST=…`、摘要里的 `storefront in the edge image`。`pipeline` 守卫和 `REL-*` 规则不涉及
  这些步骤，没有改。`build` 任务不变（仍跑小程序 `build:weapp` 和体积门禁）。
- **文档**：`deploy/README.md`（服务表、ship 第 7 步、首次部署冒烟、新键、「What the edge sends to `web`」重写、
  新增「Domain verification files」写放置方法、演练覆盖范围、删去 placeholder 说明）；`docs/architecture.md` 的
  Edge 一节；`docs/mini/wechat-compliance.md` C12 的 edge 一句；`docs/mini/README.md` 的 CI 一句；
  `apps/web/app/page.tsx` 的注释；cutover.md 2.9、2.10 已勾选并注明差异。

## 进行中

无。

## 待办

- cutover 2.10「部署前确认」（生产后台「小程序设置」已启用、AppID/AppSecret 已填、码版本是正式版）：对生产的只读检查，
  留给发布当天，本任务不碰生产。
- 部署演练和 CI 没有跑（见下）。

## 页面形态变化

- 生产的 `/` 从 uni-app H5 变为落地页（R1 已写好，现在接上 edge）；旧 H5 路径一律 302 到 `/`。
- 运维可见：业务域名校验文件放在主机 `/home/ubuntu/apps/X-ZOO/data/domain-verification/<文件名>.txt`，权限 644，
  无需重启（`deploy/README.md`「Domain verification files」）。

## 后端缺口

无。

## 待定问题

- **合并顺序**：CI 的 `storefront-e2e` 跑 `test`，要和 C1 的 cutover 2.2（`test:mini` 并入 `test`、删旧 spec）一起合入；
  单独合入本分支时，`test` 仍是旧 uni-app 套件，且 CI 已不装 uni-app 依赖，这个任务会失败。
- **可能的合并冲突**：`docs/architecture.md` 的 Edge 一节（C1 的 2.1 也列了第 375 行附近）、`docs/mini/README.md`
  第 95–97 行（C1 的 2.2 可能改相邻行）、`cutover.md` 的勾选。冲突时 Edge 一节以本分支为准。
- 根目录的 `/robots.txt` 也落在校验文件规则里，目录里没有就是 404。要不要放一个 `robots.txt`（`Disallow: /`）？
  落地页已有 `noindex`，本任务没有放。
- `/favicon.ico` 现在是 302 到 `/`（以前是 H5 的文件）。浏览器只会显示默认图标，无害；要图标就得加一个 location 或 Next 的
  `app/icon`。

## 请协调者跑的检查

本任务只跑了：`shellcheck`（与 CI 相同的参数，通过）、`pnpm guards`（16 项通过）、`prettier --check`（改过的文件都通过）、
YAML 解析、以及一次临时 nginx 容器（`nginx:alpine` 1.31）里的 `nginx -t` 和冒烟：`/pages/index/index`、`/index.html`、
`/x/a.txt` → `302 Location: /`；放入的 `.txt` → 200 `text/plain` 原样；缺失的 `.txt` → 404；`/healthz` → 200；
`/` → 代理到 `web`（容器里没有 web，所以 502）。

1. 部署演练（构建三个镜像，约半小时；和其他重任务错开，只跑一次）：

   ```sh
   deploy/rehearsal/drill.sh
   ```

   只想先看 edge 两个用例（仍需构建镜像）：`deploy/rehearsal/drill.sh --only edge/`。
   重点：`edge/proxies-every-page-route`、`edge/serves-verification-files`、`ship/*`。

2. 和 C1 合并之后，合并清单里的 `pnpm --filter @shop/e2e-storefront test`（即小程序 e2e）和
   `pnpm --filter @shop/mini build`（体积门禁），按 cutover 第 1 节第 2 步，一次、不并行。
3. CI 期望（push 到 `master` 之后）：没有显示名为「storefront e2e (playwright, H5)」的任务；小程序 e2e 的任务 id
   是 `storefront-e2e`；`images` 摘要只有 `deploy/ship.sh <commit>` 和三个摘要，没有「storefront in the edge image」。若仓库设置里的必需检查列了旧任务名，要在 GitHub 上同步调整。
