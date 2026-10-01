# P2-images 状态

分支 `storefront/mini-P2-images`（自 `storefront/mini` @ 925a2250c）。两件事：

> X2（`storefront/mini-X2-mini-images`）把缩略图宽度从 360 / 750 改为 480 / 960，下文已同步。服务宫格、订单入口的自定义图标和视频地址也已由 X2 接入 `resolveImage`（见 Pending）。

1. 上传时生成 480 / 960 px 缩略图，列表、宫格、卡片用缩略图；
2. 装修组件的图片懒加载。

## Done

### 1. 缩略图：命名规则（`@shop/contracts/storage/image-variants`）

- 服务端生成的原图键：`<dir>/<yyyy>/<mm>/<32 位十六进制>.(jpg|jpeg|png|webp)`。
- 缩略图就放在原图旁边：`<hash>.w480.<ext>`、`<hash>.w960.<ext>`。
- 客户端按原图 URL 自己推出缩略图 URL（`imageVariantUrl`），所以：
  - **不改任何接口或契约**，也不加字段、不查表；
  - 缩略图加载失败（老图还没补、生成失败、CDN 没同步）时，自动退回原图。原图也失败才显示占位。
- 以下情况推不出缩略图，一律用原图：
  - GIF、BMP；
  - 旧系统路径（`attach/yyyy/mm/yyyymmdd/…`）；
  - 外站地址（微信头像等）；
  - 带 `?` 或 `#` 的地址（签名 URL，或 OSS/COS 的处理参数）；
  - `data:` 地址。
- 为什么不改用 WebP：小程序的 `<image>` 要显式加 `webp` 属性才显示 WebP，iOS 旧基础库还有兼容问题。缩略图保持原格式（JPEG 还是 JPEG，PNG 还是 PNG），扩展名不变，不用做格式判断。

### 2. 缩略图：生成（`packages/core/src/storage/image-variants.ts`）

- **在 worker 里生成**，job 名 `storage.generateImageVariants`（并发 1，重试 3 次）。
  - `storeFile` 在事务提交之后才入队，dedupeKey 为 `storage-variants:<id>`。去重命中的上传和非图片文件不入队。
  - web 进程只负责入队，不解码图片。入队失败只记一条 warn，上传照常成功。
- **sharp** 0.35.4：它本来就通过 Next 在 lockfile 里，这次在 `@shop/core` 和 `@shop/worker` 里显式声明。设置如下：
  - `cache(false)` 和 `concurrency(1)`：worker 容器只有 320M，`--max-old-space-size=224`；
  - `limitInputPixels` 为 4000 万像素，超过的不解码、不写缩略图；
  - `failOn: 'error'`：轻微损坏的 JPEG 照样出图，截断的不出；
  - 单张 20 秒超时。
- 每个宽度写一份：
  - 通常是**缩放后的图**：按 EXIF 方向转正、等比缩放、不放大、去掉元数据。JPEG 用 q80 渐进式，PNG 用压缩级别 9 并保留透明，WebP 用 q80。
  - 以下情况**原样复制原图字节**：
    - 原图本来就不比该宽度宽（且方向正常）；
    - 动图（多帧 WebP，或带 `acTL` 块的 APNG），缩放会只剩第一帧；
    - 压缩后反而更大。

  所以新上传图片推出来的缩略图 URL 一定存在，画质也不会比原图差。

- 一律软失败：解不了码、驱动写入失败、sharp 原生库加载不了，都只记日志（`storage: 未生成缩略图，列表将继续使用原图`），原图和附件记录不受影响。只有存储驱动写入报错时才抛出，让 job 重试。
- 两种驱动都实现了 `Storage.putVariant(key, width, body, contentType)`：
  - local：写在原图旁边；
  - S3 兼容（OSS/COS/MinIO）：用 PUT，带 content-type。
  - 附件的 driver 和当前驱动不同时跳过（`other-driver`）。
- 幂等：已经存在的宽度不重写（`force` 才重写）。重试、重复入队、补生成可以反复跑同一张图。
- 孤儿清理（`storage.cleanOrphans`）删原图时顺带删缩略图，尽力而为，失败只记日志。
- `isStoredImageUrl`（CAT-018 / REFUND-014 / USER-019）：一张仍在库的图片的缩略图 URL 也算"我们的图"。其他任何缩略图形状的 URL 都不算。`docs/invariants.md` 的 CAT-018 已补一句，并引用了新的 int 测试。

### 3. 缩略图：补生成老图（运维命令）

- job 名 `storage.backfillImageVariants`，不定时，只能手动触发。
  - 按附件 id 升序分批，每批默认 50 张（1–500），跑完一批再把下一批入队。worker 重启后从断点继续。
  - 每批写一行日志：examined / written / failed / nextAfterId。
  - 单张失败只计数，然后跳过。
- 新增 worker 子命令 `enqueue`（`apps/worker/src/enqueue.ts`），在 worker 容器里执行，使用容器自己的 `REDIS_URL` 和 `QUEUE_NAME`。不开端口，不改 docker/。它会拒绝以下命令行：未知 job、定时 job、非法 JSON、不符合 schema 的载荷。

```sh
# 补全部老图（已有缩略图的会跳过）
./shop compose exec -T worker node /app/main.mjs enqueue storage.backfillImageVariants
# 可选参数：每批张数、从某个 id 之后开始、强制重写
./shop compose exec -T worker node /app/main.mjs enqueue storage.backfillImageVariants '{"limit":50}'
./shop compose exec -T worker node /app/main.mjs enqueue storage.backfillImageVariants '{"afterId":"12345","force":true}'
```

- 进度看 worker 日志里的 `storage.backfillImageVariants`。只补 `hasImageVariants` 的图：本系统上传的 JPEG/PNG/WebP。旧系统迁移过来的旧路径图片不补，客户端对它们本来就只用原图。

### 4. Docker 与 CI 里的 sharp

- 运行镜像是 `node:24-slim`（Debian，glibc）。sharp 0.35 的预编译包 `@img/sharp-linux-x64` 加 `@img/sharp-libvips-linux-x64` 自带 libvips，不需要 apt 装任何东西。
- worker 的 tsup bundle 把 `sharp` 设为 external，运行时从 `node_modules` 加载原生模块。
- 本地验证过 `pnpm deploy --filter @shop/worker --prod --legacy`：部署目录里带上了 sharp 和两个 `@img` 包，`import('sharp')` 能加载。
- web 镜像不跑生成。Next 本来就把 `sharp` 当 server external 包，standalone 构建会自行 trace。
- CI（ubuntu，glibc，x64）装依赖时，pnpm 按 optionalDependencies 装上预编译二进制。core 的单元测试会真的调用 sharp，CI 里能看到它是否可用。
- **坑**：在工作区里跑 `pnpm deploy … --prod` 会把工作区自己的 `node_modules` 也裁成只剩生产依赖（tsup、根 devDeps 都没了）。之后要跑 `pnpm install --frozen-lockfile` 恢复。

### 5. 小程序：用哪一档

- `apps/mini/src/lib/asset-url.ts` 新增 `imageUrl(path, size)`，`size` 取 `small`（480）、`medium`（960）或 `original`。
- 通用组件 `ui/image.tsx` 新增 `size` 属性，默认 `original`。加载顺序是：缩略图 → 失败退回原图 → 再失败显示占位。
- `small`：
  - 订单卡片、购物车行、售后卡片、售后详情和申请页、物流、确认订单；
  - 我的拼团、拼团队伍、发票、我的评价、文章列表和文章页封面；
  - 评价头像和晒图缩略图、规格弹层（普通和活动）；
  - 列表形态的商品卡片。
- `medium`：两列宫格形态的商品卡片（`ui/product-card.tsx`）。
- 保持原图：
  - 商品详情图库和放大预览、活动主图、开屏、拼团横幅、头像选择、登录 logo；
  - `pages/category`、`pages/product` 页面本身（P1 的范围，没动）。

### 6. 装修组件：缩略图和懒加载（`packages/storefront-blocks`）

- `BlockHost` 新增 `resolveImage?(src, width?: 480 | 960)`。新组件 `shared/block-image.tsx`（`BlockImage`）按 host 的解析结果加载图片，缩略图失败时退回原图。DOM 和 class 不变，盒子尺寸仍由组件自己的样式决定，不会产生布局位移。
- 小程序的 host（`features/decor/decor-host.tsx` 的 `resolveDecorImage`）做两件事：
  - 相对路径 `/uploads/…` 拼上 API 域名。**这是顺手修掉的旧问题**：以前装修图片原样渲染，local 驱动的相对路径在小程序里加载不出来；
  - 按宽度推出缩略图 URL。
- 后台画布（`CANVAS_HOST = { canvas: true }`）不传 `resolveImage`，照旧加载存储的原 URL。
- 各组件：

| 组件                   | 宽度                           | 懒加载                                                             |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------ |
| 轮播                   | 960                            | 只挂载当前页及左右相邻页（环形）的图片，翻到后保留；画布上全部挂载 |
| 图片魔方：格子布局     | 960                            | `lazy-load`（格子有固定高度）                                      |
| 图片魔方：一行 2/3/4   | 2 张 960，3/4 张 480           | `lazy-load`                                                        |
| 热区图                 | 960                            | `lazy-load`                                                        |
| 商品列表 / 商品选项卡  | 两列 960，三列、列表、横滑 480 | 保持原来的 `lazy-load`                                             |
| 拼团 / 预售列表        | 480                            | 保持原来的 `lazy-load`                                             |
| 文章列表               | 大图 960，小图 480             | 保持原来的 `lazy-load`                                             |
| 导航宫格图标           | 480                            | 不懒加载（通常在首屏）                                             |
| 用户卡片背景、视频封面 | 960                            | 不懒加载                                                           |

- 在画布上（`host.canvas`）不开 `lazy-load`：DOM 适配层会把它映射成 `loading="lazy"`，fidelity 截图可能截到还没加载的图。
- 轮播为什么不用微信的 `lazy-load`：它按纵向距离判断，同一个 swiper 里所有页的高度都一样，所以不起作用。现在改为不渲染远处页的 `<image>`，slide 的盒子照样占位（swiper 高度由组件的 `height` 固定），不产生布局位移。
- `widthFix` 的图片（热区图、魔方一行）本来就没有预留高度，懒加载前后都一样。微信大约提前三屏开始加载，高度变化发生在屏幕外。真正的预留需要服务端给出宽高，见"Backend gaps"。

### 7. 包体

`pnpm --filter @shop/mini build:weapp`（跑了一次）：`size-report: ok`。

| 包    | K2 基线   | 本分支        | 预算    |
| ----- | --------- | ------------- | ------- |
| main  | 682.0 KB  | **689.2 KB**  | 1536 KB |
| total | 1064.7 KB | **1071.0 KB** | 8192 KB |

- 基线是 K2 文档里的数字，K2 之后合入的 K1、H6、R1 也可能占了一部分。main 包的增量来自三处：命名规则模块、`BlockImage`、轮播的逻辑。
- 构建输出里有 mini-css-extract 的 "Conflicting order" 提示，没有导致失败，和本分支无关。

## In progress

无。

## Pending

- （X2 已完成）服务宫格、订单入口的**自定义图标**仍然原样渲染，没有经过 `resolveImage`。它们多是内置图标，运营上传的相对路径在小程序里同样加载不出来。改法很小：`host?.resolveImage?.(icon) ?? icon`。
- （X2 已完成）视频组件的 `src` 也没有经过解析：它不是图片，但是相对路径同样有问题。

## Page-form changes（旧→新）

顾客看到的变化：

- 列表、购物车、订单、售后、评价等处的商品图：旧为加载原图（常见 1–3 MB）→ 新为加载 480 / 960 px 缩略图（通常几十 KB），画面内容不变。
- 老图还没补缩略图时：旧为原图 → 新为先请求缩略图（404）再换原图，多一次失败请求，最终显示一致。补完就没有这次请求了。
- 首页轮播：旧为进页面时所有页的图一起下载 → 新为先下当前页和相邻页，其余翻到时再下。
- 装修图片用相对路径（local 驱动）：旧为小程序里加载不出来（空白）→ 新为正常显示。
- 手机竖拍、带 EXIF 方向的照片：缩略图已转正；原图的显示和以前一样。

运营看到的变化：

- 后台装修画布：无变化（加载原图，不懒加载）。
- 上传：无变化。缩略图在后台异步生成，通常几秒内完成。
- 新增一条补生成命令（见 §3）。

## Backend gaps

- **图片宽高**：附件表没有保存宽高，所以 `widthFix` 的块无法预留高度。如果以后要做到零位移，可以在生成缩略图时顺手把宽高写进附件，再由装修数据带给客户端（需要改契约，这次没做）。
- **对象存储自带的图片处理**（OSS `x-oss-process`、COS 数据万象）可以代替自己生成，还不占存储。但是它和服务商绑定，local 驱动也用不了，所以没有采用。客户端遇到带 `?` 的 URL 不会再拼缩略图，两者不冲突。
- 存储成本：每张 JPEG/PNG/WebP 多两份文件，缩放后的通常只有原图的 2%–10%。小图和动图是原样复制，会多占 2 倍。
- CDN：如果对象存储前面有 CDN，老图补生成之前的 404 可能被 CDN 负缓存。补生成后可以视情况刷新 CDN，或者把 404 的缓存时间设短一些。客户端会退回原图，所以不影响显示。

## Open questions

- 宽度取 360 / 750 是否合适：已由 X2 改为 480 / 960（`docs/mini/status/X2-mini-images.md`）。本文其余各处的宽度已同步改为 480 / 960。
- 是否在 web 镜像里也允许生成（例如 worker 不在时同步兜底）。目前不做，生成只在 worker 里跑。
- 老图补生成什么时候跑（建议低峰期，每批 50 张）。

## Tests for the orchestrator to run

- `pnpm --filter @shop/core test:int -- src/storage/storage.int.test.ts`（新增 `describe('image variants')`，我没有运行）：
  - 提交后入队且只入队一次（去重命中和 PDF 不入队）；
  - 写出 480 / 960 且幂等（`skipped: 'present'`）；
  - 解不了码时软失败；
  - `CAT-018 — a thumbnail of a live image counts as ours, a thumbnail of anything else does not`；
  - 孤儿清理删掉缩略图；
  - 补生成按 id 分批，跳过已删除的图。
- worker 的 `main.int`：没改，建议照常跑一遍，确认 `enqueue` 分支不影响启动。
- `pnpm --filter @shop/e2e-storefront test:mini`：没改 spec。它覆盖首页装修和列表页的图片。
- 部署演练：docker/ 没改，可以不跑。但是 worker 的依赖多了 sharp，建议在构建出的 worker 镜像里执行一次 `node -e "import('sharp').then(s=>console.log(s.default.versions))"`。
- 真机检查：
  - 新上传一张大图后，列表是否加载 `.w480` / `.w960`（在网络面板里看）；
  - 老图退回原图；
  - 轮播翻页时后面几页的图能及时出现；
  - iOS 和 Android 各看一次。
- fidelity：可选重跑。画布没有传 `resolveImage`，也不开懒加载，预期无差异。

## Checks run here

- core：typecheck、eslint 通过；vitest 运行了 `image-variants`、`s3`、`kernel` 相关文件，45 个通过。
- contracts：`image-variants.test.ts`，6 个通过。
- worker：typecheck、eslint 通过；`enqueue.test.ts`、`define-job.test.ts` 通过；tsup 产物里 `import("sharp")` 保持 external。
- storefront-blocks：typecheck、eslint 通过；`src/blocks/` 下的测试在 React 19 和 18 两个项目里都跑了，152 个通过；`build` 重新生成了 admin dist。
- mini：typecheck、eslint 通过；运行了改动涉及的 19 个测试文件（image、order-card、product-card、decor-host、decor-page、cart、product 页、各子包页面等），全部通过。
- `pnpm guards`：16 项全部通过。测试里的 32 位十六进制文件名改为运行时拼出来，因为 credentials 检查会把字面量当成 AppSecret 形状。
- prettier `--check`：改动的文件全部通过。
- `build:weapp`：跑了一次，`size-report: ok`，数字见 §7。
