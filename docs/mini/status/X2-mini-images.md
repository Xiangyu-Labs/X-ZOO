# X2-mini-images 状态

分支 `storefront/mini-X2-mini-images`（自 `storefront/mini` @ d98f2ce23）。三件事，用户已批准：

1. 缩略图宽度 360 / 750 → 480 / 960；
2. 服务宫格、订单入口的自定义图标，以及视频组件的地址，经过 host 的 `resolveImage`；
3. 我的订单 / 我的售后：离开满 5 分钟回来，整个列表从第 1 页起重取。

## Done

### 1. 缩略图宽度改为 480 / 960（48a763557）

- 命名规则 `@shop/contracts/storage/image-variants`：`IMAGE_VARIANT_WIDTHS = [480, 960]`，文件名 `<hash>.w480.<ext>`、`<hash>.w960.<ext>`。
  - 480：3 倍屏上约三分之一屏宽（列表行、三列格子）；
  - 960：3 倍屏上的半屏（两列卡片），或约 2.5 倍的整屏宽（横幅）。
- 生成（worker 的 `storage.generateImageVariants`）、补生成、孤儿清理都从这个常量取宽度，逻辑没改。
- `isStoredImageUrl`（CAT-018 / REFUND-014 / USER-019）只认 `.w480` / `.w960`。**不兼容旧名**：线上还没有缩略图，`.w360` / `.w750` 现在和任何别的宽度一样被拒绝（int 测试加了一条断言）。`docs/invariants.md` 的 CAT-018 已改。
- 客户端：
  - 小程序 `lib/asset-url.ts`：`small` = 480，`medium` = 960；`ui/image.tsx` 的 `size` 用法不变；
  - storefront-blocks：`BlockImageWidth = 480 | 960`，各组件原来要 360 的改要 480，要 750 的改要 960；小程序 host 的 `resolveDecorImage` 按 480 → `small`、960 → `medium` 映射。
- `P2-images.md` 里的宽度已同步改为 480 / 960，并在开头注明。
- core 的 PNG 单元测试：原来的测试图是伪随机噪点，缩到 480 后反而比原图大，按规则会原样复制，断言失败。改为半透明渐变图，测的仍是"PNG 还是 PNG、保留透明"。

### 2. 装修：自定义图标和视频地址（ab8d49180）

- 服务宫格：自定义图标改用 `BlockImage`，经 `host.resolveImage` 要 480 的缩略图，失败退回原图。没有图标的格子照旧显示文字首字。
- 订单入口：**只有运营上传的自定义图标**经过 `resolveImage`（480，失败退回原图）。内置图标是内联 SVG 的 data URI，照原样加载。
- 视频：`src` 和播放器的 `poster` 都经 `resolveImage(src)`（不带宽度，即原图解析：相对路径 `/uploads/…` 拼上 API 域名），从不要缩略图。封面在静止态（画布、弹层打开时）照旧用 960 缩略图。
- 后台画布不传 `resolveImage`：三处都按存储的原 URL 加载，和以前一样。
- `BlockHost.resolveImage` 的注释补了一句：不带宽度的调用也用于视频地址。

### 3. 订单 / 售后列表：离开满 5 分钟整表重取（9f832ab09）

- `useRefetchOnShow` 新增选项 `allPagesAfter`（毫秒），只和 `pages: 'first'` 一起起作用。页面隐藏（`useDidHide`，包括切到后台）时记下时间，再显示时算离开了多久：
  - 离开 < 5 分钟（且列表已过 30 秒 staleTime）：同 P1，只刷新第 1 页；
  - 离开 ≥ 5 分钟：已加载的每一页从第 1 页起依次重取，和下拉刷新一样（TanStack 的 refetch）。列表长度不变，所以滚动位置也不变；
  - 列表仍然新鲜（未过 staleTime）：两种情况都不请求。
- 常量 `LIST_FULL_RELOAD_AFTER_MS = 5 * 60_000`，我的订单（`order.list`）和我的售后（`refund.myList`）使用。
- K3 的语义不变：被改动标记过期的列表（`invalidated`）无论离开多久都整表重取；已在请求中的不重复发。
- 离开时间按每次隐藏计算：没有隐藏记录（例如只收到 show）按"没离开"处理，走第 1 页刷新。设备时钟往回调时同样按"没离开"处理。
- `P1-perf.md` 的对应未决问题已注明由 X2 实现。

## In progress

无。

## Pending

无。

## Page-form changes（旧→新）

顾客看到的变化：

- 列表、购物车、订单、售后、评价、装修组件里的缩略图：旧为 360 / 750 px → 新为 480 / 960 px。3 倍屏上的两列卡片、横幅更清晰；单张缩略图略大（像素约为原来的 1.7 倍，仍远小于原图）。
- 个人中心的服务宫格、订单入口：运营上传的自定义图标用相对路径时，旧为小程序里空白 → 新为正常显示（并加载 480 缩略图）。
- 视频组件：视频地址或封面用相对路径时，旧为小程序里播放不了 → 新为正常播放。
- 我的订单 / 我的售后：离开 5 分钟以上再回来，旧为只刷新第 1 页（后面各页保持旧内容）→ 新为所有已加载的页都刷新（请求数等于已翻的页数），列表长度和位置不变。30 秒到 5 分钟之间回来，和 P1 一样只刷新第 1 页。

运营看到的变化：

- 后台装修画布：无变化。
- 服务器上每张图多出的两份缩略图略大一些（480 / 960 比 360 / 750）。

## Backend gaps

无新增。

## Open questions

- 上线前的老图补生成照 P2 §3 的命令跑即可，生成的就是 480 / 960。如果有环境已经按 360 / 750 跑过补生成（按说还没有），那些 `.w360` / `.w750` 文件不会再被用到，也不会被孤儿清理删掉（清理只删当前宽度的缩略图），需要时手动删除。
- 5 分钟阈值对订单和售后两个列表共用一个常量。是否要不同的阈值，由用户决定。

## Tests for the orchestrator to run

- `pnpm --filter @shop/core test:int -- src/storage/storage.int.test.ts`（我没有运行）：`image variants` 这组的宽度都改成了 480 / 960；CAT-018 用例新增一条断言：`.w360.jpg` 不再算"我们的图"。
- `pnpm --filter @shop/e2e-storefront test:mini` 一次（没改 spec）。重点看：
  - `decor.spec.ts`（装修图片、个人中心的服务宫格和订单入口、视频）；
  - `orders.spec.ts`、`aftersale.spec.ts`（回到列表的刷新；e2e 里离开时间都短，应走第 1 页刷新）。
- fidelity：可选。画布不传 `resolveImage`，预期无差异。
- 真机：新上传一张大图，网络面板里看列表加载 `.w480` / `.w960`；个人中心用一个上传的自定义图标；订单列表翻到第 2 页，切到后台 5 分钟以上再回来，应看到第 1、2 页都重新请求。

## Checks run here

- typecheck、eslint：contracts、core、worker、storefront-blocks、mini 全部通过。
- vitest（`--maxWorkers=2`，只跑改动涉及的文件）：
  - contracts `image-variants.test.ts`：6 通过；
  - core `image-variants.test.ts`、`s3.test.ts`、`kernel.test.ts`：45 通过；
  - storefront-blocks `blocks.test.tsx`、`user-center.test.tsx`、`marketing-blocks.test.tsx`（React 19 和 18 两个项目）：全部通过。新增 5 条：订单入口自定义图标经 host（480，失败退回原图，内置图标不动）/ 无 resolver 时原样；服务宫格同上两条；视频 `src` 和 `poster` 经 host 且不带宽度；
  - mini `data/use-refetch-on-show.test.tsx` +3（满 5 分钟整表重取；不足 5 分钟只刷第 1 页且按每次离开计时；列表仍新鲜时不请求。第一条用去掉判断的代码验证过会失败），`packages/order/list`、`packages/aftersale/list` 各 +1（离开 5 分钟后第 1、2 页都重新请求），`features/decor/decor-host.test.tsx` +1（服务宫格自定义图标在小程序 host 下加载 `.w480`，失败退回原图）。
- 最后一次跑全部 `@shop/mini` 单元测试（`--project unit --maxWorkers=2`）：120 个文件、630 条，全部通过。
- `pnpm guards`：15 项 0 失败。改动文件 `prettier --check` 通过。
- `pnpm --filter @shop/mini build:weapp`（跑了一次）：`size-report: ok`。

| 包    | P2 记录   | 本分支        | 预算    |
| ----- | --------- | ------------- | ------- |
| main  | 689.2 KB  | **691.0 KB**  | 1536 KB |
| total | 1071.0 KB | **1072.8 KB** | 8192 KB |

P2 之后合入的 C1、C2 等也可能占了一部分；本分支自身的增量是 `useDidHide` 和两处图标改用 `BlockImage`。构建输出里仍有 mini-css-extract 的 "Conflicting order" 提示，和本分支无关。
