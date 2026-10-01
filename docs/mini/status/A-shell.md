# Stream A: mini-program foundation (status)

Branch `storefront/mini-A-shell`. Scope: `apps/mini/src/{app*,platform,session,ui,theme,lib}`
and `apps/mini/config`.

## Done

- **Pages.** R0 route catalogue and I1 guards merged.
  - `src/app.pages.ts` is the page manifest: 51 catalogue pages (7 main, 44 in sub-packages)
    plus the dev-only `demo` sub-package.
  - `app.config.ts` builds pages, subPackages and preloadRule from it.
  - Every page is registered and renders. Pages without a stream yet show `BuildingPage`
    (建设中 + 回到首页).
  - Home is `pages/index/index`, as in the catalogue.
  - The guard's `UNBUILT_ROUTES` / `UNCATALOGUED_PAGES` are empty; the mutation anchors follow
    `app.pages.ts`.
- **Demo sub-package.** Left out of the production weapp build (`taro build --type weapp`
  without `--watch`); kept in dev and H5 builds; `TARO_APP_DEMO=1` forces it in.
- **AppID.** The shop's own AppID `wx4f4b772125e155ed` is committed in `.env.*` and
  `project.config.json`.
- **Navigation.** `platform/nav.ts` provides `navigate`, `toPath`, `readRouteParams`,
  `useRouteParams`, `goBack`, `parseLoginRedirect` and pending tab params. Unknown keys open
  home.
- **Platform capabilities**, each with weapp, h5-mp-emulation and h5-preview versions:
  - subscribe: requested in the tap, ≤3 templates per scene;
  - chooseAddress, the avatar button, chooseImages, uploadFile;
  - share helpers, clipboard, the webview allow-list, the update manager, launch scene;
  - toast/loading/modal;
  - the global privacy handler plus `PrivacyAgreeButton`. `PRIVACY_APIS` is a string array.
- **Session.**
  - Silent login.
  - A 401 renews once and replays once, reads and writes alike.
  - `requireLogin` (toasts in the timeline's single-page mode).
  - The SMS alternative, logout.
  - The query cache is cleared on sign-out.
  - `LoginCard` / `LoginGate`.
  - A working login page: phone quick-login, SMS, 暂不登录, and an agreement box that starts
    unticked.
- **App config.** `app-config/`: storage copy first, then `If-None-Match: W/"version"`. It feeds
  the theme, the tab bar, share defaults and subscribe templates.
- **Tab pages** (`useTabPage`): the native tab bar gets its colours, labels and uploaded icons
  from appearance. The cart badge is the real `GET /cart/count`, signed-in only.
- **Theme.** `deriveTheme` (AA-checked) and `themeStyle` → CSS vars via page-meta on weapp.
- **UI kit** (`src/ui`, one Vitest file per component; no barrel, so a sub-package's
  components and their styles stay out of the main package):
  - basics: PageShell, Button, Pressable, Icon, Image, Price, Tag, Badge, Divider, Skeleton
    (ProductCard/Cell presets), Card, Cell/CellGroup;
  - feedback: toast/confirm/alert, Sheet, PrivacySheet, Empty, ErrorBlock (network, not-found,
    unauthenticated, server), Result;
  - forms: Field, Textarea, Checkbox, Radio, Switch, AgreementCheck, SmsCodeField, Stepper,
    SearchBar (entry / input), RegionPicker (`shipping.cityTree`, stored once),
    ImageUploader (`chooseMedia` → `POST /uploads`, retry), AvatarPicker (chooseAvatar →
    upload → `PUT /profile`);
  - commerce: ProductCard (grid / list / mini; sold out, off shelf, activity), CouponCard (every
    state, picker mode), OrderCard + `orderActions`, OrderItemRow, AddressCard (masked phone,
    导入微信地址), ContactButton / `useContactIcon`, Countdown (server clock);
  - layout: Tabs, ActionBar, InfiniteList (pull-down, reach-bottom, footer states).
- **Data helpers.** `data/upload.ts` (multipart upload with the client headers and one renewal),
  `data/cities.ts`, `lib/format.ts`, `lib/server-clock.ts`, `platform/page-scroll.ts`,
  `platform/device.ts` (call, preview).
- **Found by the gallery, fixed in the kit.**
  - `usePresence` no longer sets state while rendering: the H5 build dropped one of the two
    updates, so a Sheet that started hidden never opened there.
  - Native buttons (`button` in WeChat, `taro-button-core` on H5) arrive 100% (H5) or 184px
    (WeChat style v2) wide: `native-button-width` resets them.
  - H5 inputs are centred vertically, as WeChat already does.
  - An OrderItemRow picture is sized by a wrapper: Image's ratio padding is a share of its
    parent's width.
- **S4 pages.** Product, checkout, cashier and pay-result are on PageShell and the kit and
  navigate by route.

- **Gallery.** `subpackages/demo/pages/ui` (dev and H5 builds only) puts every kit component
  on made-up shop data (`fixtures.ts`: SVG art, no network), in four tabs: 商品, 交易, 表单,
  反馈. Screenshots, 375 px at DPR 2 from the H5 build with the API unreachable, are in
  [`A-gallery/`](A-gallery/).

- **Budgets and checks** (at the gallery commit):
  - The weapp main package is 489.6 KB against a 1.5 MB budget; all packages total 566.5 KB.
  - The production weapp build holds no demo sub-package and no test code.
  - These all pass: `turbo typecheck lint test:unit build` (41 files, 174 tests), e2e
    `test:mini`, `prettier --check`, `pnpm guards`.

## In progress

- Nothing.

## Next

- Pages from streams B–E on this kit.
- The backend gaps in the hand-over report.

## Needs a device check

- CSS mask icons.
- page-meta with its embedded navigation-bar.
- The aria template plugin.
- The privacy flow.
- `setTabBarItem` with downloaded icons.
