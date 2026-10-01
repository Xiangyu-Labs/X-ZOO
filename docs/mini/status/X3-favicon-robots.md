# X3 — 网站图标与 robots.txt

分支 `storefront/mini-X3-favicon-robots`，基于 `storefront/mini` @ `d98f2ce23`。已完成，没有进行中的工作。
解决 C2 留下的两个待定问题（`/favicon.ico` 被 302 到 `/`，`/robots.txt` 落进校验文件规则成了 404）。

## 已完成

- **`apps/web/app`**（Next 的文件约定，根布局下所有页面都会带上，后台也一样）：
  - `icon.svg`：品牌红 `#E1251B` 的圆角方块（圆角 = 边长 1/4，和后台侧栏左上角的方块同形），没有文字和图案。
    Next 在每个页面输出 `<link rel="icon" href="/icon.svg?…">`。
  - `favicon.ico`：同一图形的 16/32/48 三档 PNG 帧，给直接请求 `/favicon.ico` 的浏览器和工具。仓库里没有现成的
    品牌图形，也没有 PIL/ImageMagick，是用 Python 标准库按 `icon.svg` 的形状画的（4×4 超采样抗锯齿）；改图形时
    两个文件要一起换。
  - `robots.ts`：`User-Agent: *` / `Disallow: /`，与根布局的 `noindex` 一致。
- **edge**（`docker/edge/nginx.conf`）：新增三条精确匹配 `location = /favicon.ico`、`= /icon.svg`、
  `= /robots.txt`，代理到 `web`（与落地页相同的 `X-Real-IP` / `X-Forwarded-For` 处理；两个图标不写访问日志）。
  精确匹配优先于所有正则，所以 `/robots.txt` 不再走校验文件目录；其他根目录 `.txt` 照旧从校验目录提供。
- **演练**（`deploy/rehearsal/drill.sh`，**没有跑**）：
  - `edge/proxies-every-page-route`：另查 `/favicon.ico`，以及 `/`、`/admin/login` 页面里每个
    `rel="icon"` / `apple-touch-icon` 链接，都必须 200 且 `image/*`（不是 302，也不是落地页 HTML）；两页都必须链接图标。
  - `edge/serves-verification-files`：在校验目录里放一个 `robots.txt`，`/robots.txt` 仍须由 `web` 回答
    （有 `Disallow: /` 一行）且是 `text/plain`；用完删除。
- **文档**：`docs/architecture.md` 的 Edge 一节；`deploy/README.md`「What the edge sends to `web`」、
  「Domain verification files」末段、演练覆盖范围。

## 进行中

无。

## 待办

- 部署演练的 edge 用例（见下）。

## 页面形态变化

- 浏览器标签页：落地页和后台从默认图标变为红色圆角方块。
- `/robots.txt`：404 → `Disallow: /`。

## 后端缺口

无。

## 待定问题

- 后台主题色是 antd 默认蓝 `#1677ff`，侧栏方块是蓝的；图标按要求用了店铺品牌红。要统一的话改哪一边由用户定。
- 没有做 `apple-icon.png`（iOS「添加到主屏幕」会请求 `/apple-touch-icon.png`，现在是 302 到 `/`，无害）。
  要加的话，edge 也要加一条精确 location（nginx.conf 注释里写了）。
- `e2e/storefront/src/edge.ts`（测试用的 edge）没有镜像这三条路由：它在 `/` 提供小程序 H5，不涉及落地页，没有改。

## 检查结果

- `pnpm gen`、`pnpm --filter @shop/web typecheck`：通过。
- `eslint app/robots.ts`（经 `scripts/eslint-ts6.mjs`）：0 错误 0 警告。
- `prettier --check`：`robots.ts`、`docs/architecture.md`、`deploy/README.md` 通过（svg/sh 无解析器，不适用）。
- `shellcheck --source-path=SCRIPTDIR -x deploy/rehearsal/drill.sh`（与 CI 相同参数）：通过；`bash -n` 通过。
- `pnpm guards`：15 项通过。
- 一次临时 `nginx:alpine`（1.31.6）容器，挂上本分支的 `nginx.conf`，用网络别名 `web` 指向同容器里一个假的 3000 端口，
  `nginx -t` 通过；curl：`/favicon.ico`、`/icon.svg`、`/icon.svg?abc123`、`/robots.txt`（目录里另放了一个
  `robots.txt`）→ 200 来自 `web`；`/abc123.txt` → 200 校验文件原文；`/missing.txt` → 404；`/x/robots.txt`、
  `/pages/index/index` → 302；`/`、`/admin` → `web`；`/healthz` → 200。容器和网络已删除。
- 没有跑 `next build`，Next 实际输出的图标链接由演练验证。

## 请协调者跑的检查

1. 部署演练的 edge 用例（要构建三个镜像；和其他重任务错开，只跑一次）：

   ```sh
   deploy/rehearsal/drill.sh --only edge/
   ```

   重点：`edge/proxies-every-page-route`（图标）、`edge/serves-verification-files`（robots.txt）。
