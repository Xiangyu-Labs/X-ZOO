# P1-perf 状态

分支 `storefront/mini-P1-perf`（自 `storefront/mini` @ 925a2250c）。来源：K2 写出来的运行时问题
（`docs/mini/status/K2-size-perf.md`「Written up」第 1–3 条，`docs/mini/HANDOFF.md` §4 第 5 条），用户已批准改动顾客看得到的行为。
缩略图和装修图片懒加载归 P2，不在这里。

## Done

1. **分类：两次串行请求改为并行**（3c168a386）。
   - 原来：`catalog.categoryTree` 回来后才知道第一个一级分类的子树 id（`subtreeIds`），再发 `catalog.productList`，冷启动两次往返。
   - 现在：每次拿到分类树，把**第一个一级分类**的子树 id 存到本机（新存储键 `shop.category.first`，
     `features/catalog/first-category.ts`）。下次冷启动打开分类、分类树还没回来时，用存下的 id 立刻预取商品列表
     （`queryClient.prefetchInfiniteQuery`），和分类树同时发出。分类树回来后，右侧列表的查询键与预取一致就直接用它，不再请求。
   - 只是猜测：显示的列表永远按最新的分类树取。分类树变了（第一个分类或其子树改了）就多一次没用上的请求，然后按新树请求，
     本机存的 id 同时更新。
   - 从装修链接或分享打开到别的分类（`categoryId` 不在存下的子树里）不预取，照旧先等分类树。
   - 第一次打开（本机没有存过）仍是两次串行：不改后端就不知道第一个分类是谁（见「后端缺口」）。
   - 新增 `@shop/api-client/react` 的 `infiniteRouteQueryOptions`（d2720183c），`useInfiniteRouteQuery` 也改为用它构造选项，
     保证预取和页面读到的是同一个缓存项。
2. **商品详情：附属请求不再等主请求**（c5037804c）。
   - 原来：拼团 / 预售入口、领券、评价（前两条）、为你推荐要等 `catalog.productDetail` 返回、下半页挂载后才发。
   - 现在：`features/product/secondary-reads.ts` 的 `usePrefetchProductReads(id)` 在商品页一打开就按路由里的 id 预取这几项，
     与商品详情同时发出。各区块的入参也从这个模块取（`activityListInput`、`claimableInput`、`firstReviewsInput`、
     `RECOMMENDED_INPUT`），查询键一致，区块挂载时直接用预取的结果。
   - 评价、为你推荐仍受 `app/config.display` 开关控制：关掉的不预取。
   - 评价在商品还没返回时不知道有没有评价，所以总是预取前两条：没有评价的商品多一个小请求，换来有评价的商品少一次往返。
   - 错误处理不变：
     - 商品 404 仍显示「商品已下架」，与附属请求结果无关；
     - 预取不会抛错，附属请求失败时，区块挂载会再请求一次，再失败就和原来一样不显示该区块，页面其他部分正常。
3. **我的订单 / 我的售后：30 秒后回来只刷新第一页**（b042762c6）。
   - 原来：列表过了 30 秒 staleTime，从别的页面回来时，TanStack 会把翻过的每一页依次重新请求（翻了 10 页就是 10 次）。
   - 现在：`useRefetchOnShow(key, { pages: 'first' })`（`data/use-refetch-on-show.ts` 的 `refetchFirstPage`）只重新请求第 1 页，
     替换缓存里的第 1 页，后面各页保持原样。列表长度和顾客的滚动位置都不变。
   - **选这个行为的理由**：顾客通常是翻到某一单、点进详情、再返回，期望回到原来的位置。另一个做法是「回到第 1 页并滚到顶部」，
     会把翻到第 5 页的顾客甩回顶部，更意外。第 1 页是最新的订单，状态变化（自动取消、发货）也最常出现在这里。
   - 和 K3 的缓存规则保持一致：
     - 只是「过了 30 秒」→ 只刷新第 1 页；
     - 被改动标记过期的（`invalidated`，例如取消订单、确认收货、申请售后后的 `invalidate`）→ 仍然全部重取，因为改动的那一单
       可能在任何一页（实际上页面在下面挂着时，`invalidateQueries` 已经当场全部重取了）；
     - 已经在请求中的（下拉刷新、加载下一页）不再重复发；
     - 第 1 页在路上时列表被别的请求更新了，丢弃这份第 1 页，以较新的为准。
   - 第 2 页以后的内容保持加载时的样子，直到下拉刷新（全部重取）或有改动使列表失效。
   - 分页按偏移，第 1 页刷新后，一条记录可能同时出现在第 1 页末尾和第 2 页开头（例如待付款里前面有单被自动取消）。
     `ui/infinite-list.tsx` 现在按 `itemKey` 去重，同一条只显示一次。这对原来「加载下一页时上面插入了新单」的重复同样有效。

## In progress

无。

## Pending

无。

## 页面形态变化（旧→新）

- 分类（第二次及以后冷启动）：右侧商品列表**更早出现**（旧：分类树回来后再等一次商品列表请求；新：两者同时请求，约少一次往返）。
  显示的内容不变。
- 商品详情：拼团 / 预售入口条、领券行、评价、为你推荐**更早出现**（旧：商品回来后再等一次往返；新：和商品同时请求）。
  首屏布局不变。
- 我的订单 / 我的售后：30 秒后从别的页面回来，**只刷新第 1 页**，列表不变短、位置不变（旧：翻过的每一页依次重新请求，
  下面各页的内容也会更新；新：第 2 页以后保持原样，要最新的请下拉刷新）。
- 所有分页列表：同一条记录不再因为分页重叠显示两次（旧：偶尔重复一条）。

## 后端缺口

- **分类首次打开仍是两次往返。** 本机没有存过第一个分类时，只能先拿分类树。可选：`GET /catalog/categories` 同时带回第一个
  一级分类的第一页商品（改契约），或商品列表支持「某分类及其子类」的单个参数（仍要先知道第一个分类是谁，帮助有限）。本任务不改后端。

## 未决问题

- 商品详情的评价预取对没有评价的商品是一次多余的小请求（`pageSize: 2`，返回空）。接受，还是改为只预取不依赖商品数据的
  四项（拼团、预售、领券、为你推荐）？
- 附属请求预取失败后，区块挂载会再请求一次（服务端出错时同一个接口最多 4 次：预取 1 次 + 重试 1 次，挂载 1 次 + 重试 1 次；
  原来是 2 次）。只在服务端出错时发生，暂不处理。
- 订单 / 售后列表回来后第 2 页以后不刷新。若希望「翻得很深也要全部最新」，可以改为只在顾客离开超过更长时间（例如 5 分钟）
  时全部重取，需要用户决定。
  **已由 X2 实现**：离开满 5 分钟回来，所有已加载的页从第 1 页起全部重取；30 秒到 5 分钟之间仍只刷新第 1 页
  （`docs/mini/status/X2-mini-images.md`）。

## 给 orchestrator 跑的测试

- `pnpm --filter @shop/e2e-storefront test:mini` 一次。我没有改任何 e2e spec，但请求时序变了，重点看：
  - 商品详情相关（拼团 / 预售入口、领券、评价、为你推荐；商品已下架）：`promo.spec.ts`、`coupons.spec.ts`、`reviews.spec.ts`、
    `shopping.spec.ts`、`shop-journey.spec.ts`；
  - 分类：`shop-journey.spec.ts`、`coupons.spec.ts`（第一次打开本机没有存储，走原路径；同一浏览器上下文第二次打开会预取）；
  - 我的订单 / 我的售后：`orders.spec.ts`、`aftersale.spec.ts`（回到列表的刷新）。
- 可选：`pnpm --filter @shop/api-client test:unit`（我只跑了 `src/react.test.ts`）。

## 本地已跑的检查

- `pnpm --filter @shop/api-client typecheck`、`lint`：通过；`vitest run src/react.test.ts`（unit + unit-react18，`--maxWorkers=2`）：
  18 通过（新增 1 条：`infiniteRouteQueryOptions` 预取后 hook 直接读缓存）。
- `pnpm --filter @shop/mini typecheck`、`lint`：通过；`pnpm guards`：16 项 0 失败；改动文件 `prettier --check` 通过。
- 新增单元测试：
  - `pages/category/index.test.tsx` +4：记住第一个分类；冷启动在分类树返回前就请求商品且只请求一次；存的 id 过期时按新树请求并更新；
    链接到别的分类时不预取。
  - `pages/product/index.test.tsx` +3：商品还在路上时附属请求已发出且各只一次；附属请求全失败页面照常；商品 404 仍显示「商品已下架」。
    原有「guest」用例的「已售 128」改为在商品摘要里查（为你推荐现在可能先到，卡片上也有「已售」）。
  - `data/use-refetch-on-show.test.tsx` +5：只重取第 1 页并保留后面各页；新鲜的不动；被标记过期的全部重取；只有一页的照常重取；
    第 1 页在路上时列表被下拉刷新，丢弃旧的第 1 页（用去掉保护的代码验证过该用例会失败）。
  - `ui/infinite-list.test.tsx` +1：重叠的两页里同一条只显示一次。
  - `packages/order/list/index.test.tsx`、`packages/aftersale/list/index.test.tsx` 各 +1：翻到第 2 页后回来只请求第 1 页，第 2 页内容还在。
  - 测试工具：`test/fake-api.ts` 新增 `holdRequests(path)`（挂起某路径的应答，用来断言哪些请求并行发出）。
- 最后一次跑全部 `@shop/mini` 单元测试（`--project unit --maxWorkers=2`）：120 个文件、621 条，全部通过。
