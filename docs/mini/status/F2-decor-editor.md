# F2 — DIY v2 admin editor (店铺装修): status

Branch `storefront/mini-F2-decor-editor`. Updated at every commit so the work can resume after an
interruption.

## Done

- Contracts (reported to the user): `visibility.platforms` is no longer `hidden` — the editor draws
  an array of an enum as a multi-select (`meta.ts` convention 3 says so; radio threshold ≤ 4).
- Editor adapter `apps/web/src/admin/decor/`:
  - `zod-to-puck.ts`: switch / choice (Segmented or Select) / multiChoice / group headings
    (`__group:` pseudo fields) / every semantic kind; `initialPropsOf` (min list items).
  - `document.ts`: v2 document ⇄ Puck data; older blocks migrated in, unknown / newer / failed
    blocks carried through untouched as `__unknown`; `canonicalJson` for the dirty check.
  - `config.tsx`: built from the contracts registry (every block), palette filtered by
    `meta.pages` for the page kind, storefront component or a “画布暂无预览” placeholder,
    phone navbar with the page title.
  - `canvas-data.tsx`: `DecorCanvasData.resolve(need)`, `useCanvasSlots`; admin implementation
    previews products (as the resolver picks them); other needs show the block's empty state.
  - `records.tsx`: `DecorRecordSource` (products, labels, articles, coupons, group-buys via the
    legacy DIY source; presales and 微页面 new).
  - `fields/`: image (AssetPicker), colour (presets), choice, switch, multi-select, group heading,
    link (every kind; `route` covers every linkable catalogue key with param controls —
    `link-routes.ts`, held in step with the catalogue by `link-routes.test.ts`), the five data
    sources (manual ordered list / rule), unsupported fallback.
  - `editor.tsx`: `DecorEditor` (Chinese Puck dictionary, custom toolbar + undo/redo, read-only
    mode) and `DecorPagePreview` (read-only phone frame).
- ESLint: `@puckeditor/*` may only be imported inside `src/admin/decor`.
- `/admin/dev/decor-spike` kept as the **decor component sandbox** (dev-only; the fidelity script
  shoots its canvas), moved to the new interfaces.
- Unit tests: `zod-to-puck`, `document`, `canvas`, `fields/link-routes` (72 green).

- Admin pages (`店铺装修（新版）`, menu `decor.menu.ts`, all gated by `decor:page:*`):
  - `/admin/decor` (`page-list.tsx`): kind filter, 当前首页 / 当前个人中心 card (恢复内置个人中心),
    designation tags, 线上版本 / 有未发布修改, rename / duplicate / delete (not while designated),
    设为首页 / 设为个人中心 with a confirm (only published pages of the matching kind).
  - 新建页面 (`create-document.tsx`): kind, name, 从模板开始 (blank + `templates/`, thumbnails).
  - `/admin/decor/[id]` (`page-editor.tsx`, via `next/dynamic`): full-window editor; explicit
    保存草稿 with the draft token; `DECOR_VERSION_CONFLICT` → 载入对方的版本 / 用我的覆盖;
    发布 with a note (saves first); issues / warnings listed under the toolbar with 定位;
    unsaved guard (back button confirm + `beforeunload`); “草稿已在别处被修改” tag.
  - 发布记录 drawer (`revisions.tsx`): 查看 (read-only editor over the revision), 回滚 (confirm),
    then offer 载入到编辑器.
  - 预览 drawer (`preview.tsx`): preview token; iframe of `DECOR_PREVIEW_URL` (new optional env,
    `{id}` `{previewToken}` `{kind}`) or the 体验版 note + copyable `packages/page/index?…`.

- Page tests: `session.test.ts`, `page-editor.test.tsx`, `page-list.test.tsx` (95 green in
  `src/admin/decor`).
- e2e `e2e/admin/specs/decor.spec.ts` (3 tests, green): create → save (storefront 404) → publish →
  publish with unsaved edits → rollback (new revision, draft untouched) → read-only revision view;
  preview iframe through the token (the e2e stack sets `DECOR_PREVIEW_URL` to the storefront read);
  designate 首页 → `/api/v1/pages/home`. Cited under DECOR-008 / 011 / 012 / 014; README row.
  `coupon.spec.ts` failed twice in one full run (antd Select dropdown over 适用范围) and passes
  alone — not touched by F2; watch it in the final full run.

- `docs/mini/decor.md` §9 (后台编辑器); the platforms open item removed.

- Merged `storefront/mini` (G1 batch 1, H2, A): G1's richText / hotspots fields wired into
  `fields/index.tsx` and `SEMANTIC_FIELD_KINDS`; F2's registry canvas kept (covers product-tab
  slots); G1's `canvas-blocks.test.tsx` ported to F2's APIs.
- Templates (`templates/documents.ts`, 14-block set): 简约首页 (search, carousel, nav grid,
  notice, image cube, title bars, product scroller, product tabs), 简洁个人中心 (user card,
  orders, two service groups incl. 联系客服), 专题活动 (hero, rich text, divider, cube, title,
  grid). Image slots empty by design (publish blocked until picked); the canvas draws them with
  an editor-only placeholder (`canvas-images.ts`). `templates.test.ts` checks each against
  `checkDocument` for its kind.

- G1 follow-up: a new 热区 has no link (was: home); the field says so, and `linkTarget` now reads
  `请选择跳转链接` when a required link is missing (contract message change, reported).

- The issues panel starts closed on load (the toolbar counts them); a save or publish with issues
  opens it — a page fresh from a template is work to do, not an alarm.
- Screenshots in `F2-screens/` (list, create-from-template, editor with 简约首页, 发布记录, 预览),
  taken on the e2e stack with the Windows CJK fonts via a scratch `FONTCONFIG_FILE`.
- Final checks green (2026-09-24): turbo gen/typecheck/lint/test:unit/build; web test:int
  (322); prettier; check:examples; guards (15/0); web build + admin e2e (50 passed).

## In progress

- Nothing — final report.

## Next

- Open questions in the report: `packages/page` in apps/mini (体验版 path), 待评价 count,
  联系客服 host wrapper (stream B), canvas preview beyond products.
