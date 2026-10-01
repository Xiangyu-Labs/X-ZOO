# G2 fidelity: admin canvas vs Taro H5, all 22 blocks

Run on 2026-09-24 with G1's method (`../G1-fidelity/README.md`), extended to the eight batch-2
blocks. Ports 3482 / 10482, so it does not clash with other runs:

```sh
pnpm --filter @shop/storefront-blocks build
pnpm --filter @shop/web build && (cd apps/web && npx next start -p 3482)
pnpm --filter @shop/mini build            # weapp + H5; serve apps/mini/dist/h5 statically
(cd apps/mini/dist/h5 && python3 -m http.server 10482 --bind 127.0.0.1)
pnpm --filter @shop/storefront-blocks fidelity --admin http://localhost:3482 \
  --h5 'http://127.0.0.1:10482/#/subpackages/demo/pages/blocks/index?canvas=1' \
  --out ../../docs/mini/status/G2-fidelity
```

- **Admin side:** the Puck canvas at `/admin/dev/decor-spike`. Every data need is answered from
  the fixtures (products, coupons, 新人券, 拼团, 预售, 资讯), and `/admin-api` is stubbed.
- **H5 side:** the mini demo page `subpackages/demo/pages/blocks` with `?canvas=1`. It draws what
  the canvas draws: a guest, the video's poster, 悬浮客服 in the flow, the 关注公众号 explanation,
  and the 预售 end time instead of a countdown. Without `?canvas=1` the page shows the live look.
- **Shared setup:** both sides use the same fixtures and the same order, at 375 px and DPR 2,
  compared with pixelmatch at threshold 0.1. A block is flagged above **3 %**, as in G1.
- **Files:** `admin-*.png`, `h5-*.png`, `diff-*.png`, `admin-editor.png` and `fidelity.json`.

| Block                 | Size (device px, both) | Mismatched |    % | Flag | What differs                                                                       |
| --------------------- | ---------------------- | ---------: | ---: | ---- | ---------------------------------------------------------------------------------- |
| searchBar             | 750 × 168              |      1 896 | 1.50 |      | glyph edges                                                                        |
| carousel              | 750 × 340              |      1 974 | 0.77 |      | indicator dots (Taro H5 bullet opacity)                                            |
| navGrid               | 750 × 332              |      3 420 | 1.37 |      | glyph and icon edges                                                               |
| notice                | 750 × 160              |      3 528 | 2.94 |      | glyph edges; the speaker icon 1 device px left                                     |
| titleBar              | 750 × 112              |      1 977 | 2.35 |      | glyph edges                                                                        |
| productGrid           | 750 × 1570             |     19 256 | 1.64 |      | glyph edges, card edges ≤ 1 device px                                              |
| imageCube             | 750 × 380              |      7 273 | 2.55 |      | Taro H5 `aspectFill` letterboxes the large cell                                    |
| hotspotImage          | 750 × 360              |      2 109 | 0.78 |      | picture edge anti-aliasing                                                         |
| productTabs           | 750 × 1142             |     14 280 | 1.67 |      | as productGrid                                                                     |
| spacer                | 750 × 40               |          0 | 0.00 |      | —                                                                                  |
| richText              | 750 × 290              |      7 999 | 3.68 | over | G1's known residual: h3 and last-item glyphs 1 CSS px lower (em)                   |
| userCard              | 750 × 292              |      4 276 | 1.95 |      | glyph edges                                                                        |
| orderEntry            | 750 × 254              |      5 314 | 2.79 |      | glyph and icon edges                                                               |
| serviceGrid           | 750 × 280              |      3 376 | 1.61 |      | glyph edges                                                                        |
| couponList            | 750 × 260              |      4 390 | 2.25 |      | glyph edges; the 领取 button's outline; one device column at the left edge         |
| newcomerCoupon        | 750 × 306              |      3 377 | 1.47 |      | glyph edges                                                                        |
| groupbuyList          | 750 × 564              |      6 242 | 1.48 |      | glyph edges, picture edge anti-aliasing                                            |
| presaleList           | 750 × 564              |      9 987 | 2.36 |      | glyph edges (the most text of the lists: price, end time, note)                    |
| articleList           | 750 × 450              |      9 062 | 2.69 |      | glyph edges, thumbnail corner anti-aliasing                                        |
| video                 | 750 × 422              |      4 672 | 1.48 |      | the poster's shape edges and the play badge (image scaling); a one-device-px frame |
| floatingContact       | 750 × 128              |      2 735 | 2.85 |      | glyph and icon edges; the top device row (the video above, H5 half-px offset)      |
| followOfficialAccount | 750 × 200              |      5 797 | 3.86 | over | glyph edges only: the block is two lines of small text                             |

All 22 blocks are the same size on both sides, down to the device pixel.

**followOfficialAccount (3.86 %, flagged).** The card, the dashed border and the text boxes line
up exactly. `diff-followOfficialAccount.png` shows mismatches only on glyph outlines. The admin
iframe renders text with grayscale anti-aliasing, while H5 renders it with sub-pixel colour
fringes. This block is almost nothing but small text on white, the same situation as richText in
G1. The block is also editor-only: in the store it is WeChat's own `<official-account>`, which
neither side draws.

**richText (3.68 %; 3.28 % in G1).** This is the same residual as in G1: `em` font sizes resolve
to 13.99999 px in vw and 14 px in rem. Its layout has not changed since G1. The run-to-run spread
of the glyph-edge noise, about ±0.8 points on the G1 blocks, accounts for the difference.

**Caveat, as in G1.** The headless Chromium on this machine has no CJK font. Chinese text renders
as tofu boxes on both sides, so the text is compared by box outline, not by glyph. Neither side is
a real WeChat renderer.

**Fixed during this run.**

- The script now waits for every record list to receive its records (the canvas resolves its
  data needs asynchronously).
- The script now waits for images only after stretching the editor to the full page. The list
  pictures are `lazyLoad`, and those in the lower part of the canvas only load once they are in
  range.

**Live mode (checked separately, H5, no `?canvas=1`).**

- The coupon tickets read `use / again / claim` from the fixture shopper.
- 新人券 shows the held coupons (`data-state="held"`).
- 悬浮客服 is `position: fixed`.
- 关注公众号 renders nothing on H5.
- The countdown reads `距结束 2天 03:04:05` from the fixture server time. The fixture's
  `serverNow` is a constant, so the display does not advance; a real host's `serverNow` does.
