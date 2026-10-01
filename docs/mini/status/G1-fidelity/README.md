# G1 fidelity: admin canvas vs Taro H5, every block

Run on 2026-09-24 with S3's method (`docs/mini/spikes/S3-decor.md` § Fidelity), extended to all
14 blocks:

```sh
pnpm --filter @shop/storefront-blocks build
pnpm --filter @shop/web build && (cd apps/web && npx next start -p 3471)
pnpm --filter @shop/mini build            # weapp + H5; serve apps/mini/dist/h5 statically
pnpm --filter @shop/storefront-blocks fidelity --admin http://localhost:3471 \
  --h5 'http://127.0.0.1:10471/#/subpackages/demo/pages/blocks/index' \
  --out ../../docs/mini/status/G1-fidelity
```

- **Admin side:** the Puck canvas at `/admin/dev/decor-spike`. Its `/admin-api` calls are stubbed, so no database is needed.
- **H5 side:** the mini demo page `subpackages/demo/pages/blocks`.
- **Shared setup:** both sides render the same fixtures in the same order, at 375 px and DPR 2, compared with pixelmatch at threshold 0.1.
- **Files:** `admin-*.png`, `h5-*.png`, `diff-*.png`, `admin-editor.png` and `fidelity.json`.

**Flag:** a block is flagged when more than **3 %** of its pixels differ. S3's three blocks
measured 0.18–2.67 %, and those differences were all explained as rasterisation and Taro H5
quirks. 3 % is just above that range.

| Block        | Size (device px, both) | Mismatched |    % | Flag | What differs                                                                            |
| ------------ | ---------------------- | ---------: | ---: | ---- | --------------------------------------------------------------------------------------- |
| searchBar    | 750 × 168              |      1 481 | 1.18 |      | glyph edges                                                                             |
| carousel     | 750 × 340              |        458 | 0.18 |      | indicator dots (Taro H5 bullet opacity, as in S3)                                       |
| navGrid      | 750 × 332              |      2 092 | 0.84 |      | glyph and icon edges                                                                    |
| notice       | 750 × 160              |      2 549 | 2.12 |      | glyph edges; the speaker icon 1 device px left                                          |
| titleBar     | 750 × 112              |      1 520 | 1.81 |      | glyph edges                                                                             |
| productGrid  | 750 × 1570             |     21 132 | 1.79 |      | glyph edges, card edges ≤ 1 device px (vw vs rem rounding, as in S3)                    |
| imageCube    | 750 × 380              |      8 357 | 2.93 |      | Taro H5 `aspectFill` letterboxes the large cell (S3's known H5 quirk)                   |
| hotspotImage | 750 × 360              |      3 708 | 1.37 |      | picture edge anti-aliasing                                                              |
| productTabs  | 750 × 1142             |     14 354 | 1.68 |      | as productGrid                                                                          |
| spacer       | 750 × 40               |          0 | 0.00 |      | —                                                                                       |
| richText     | 750 × 290              |      7 125 | 3.28 | over | the h3 and last-item glyphs sit 1 CSS px lower in H5 inside equal line boxes; see below |
| userCard     | 750 × 292              |      3 479 | 1.59 |      | glyph edges                                                                             |
| orderEntry   | 750 × 254              |      3 978 | 2.09 |      | glyph and icon edges                                                                    |
| serviceGrid  | 750 × 280              |      3 213 | 1.53 |      | glyph edges                                                                             |

Every block is the same size on both sides, down to the device pixel.

**richText (3.28 %, flagged).** The block, paragraph and list boxes are identical, and the
paragraph and first list item start on the same device row. Two lines drift:

- The `<h3>` glyphs are 1 CSS px lower in H5.
- The last list item is 1 CSS px lower in H5.

Both come from the rich-text node styles, which are in `em` so that they need no px transform. The
admin's 28 design px resolve to 13.99999 px (vw), while H5 gives exactly 14 px (rem). The
fractional line heights (`1.14em × 1.4`) then round the half-leading differently. This is a
glyph-position residual, not a layout difference. It is also the text-heaviest block, which is why
it is the one to cross 3 %.

**Caveat.** The headless Chromium on this machine has no CJK font. Chinese text renders as tofu
boxes on both sides alike, so the text comparison is of box outlines, not real glyphs. As in S3,
neither side is a real WeChat renderer.

**Fixed during this run.** The first pass flagged three blocks:

- **hotspotImage, 26 %.** Taro H5 keeps an `<Image mode="widthFix">` at its default 240 px height;
  WeChat sizes it. Fixed with `height: auto` on the picture. `imageCube`'s row layouts had the same
  latent bug and were fixed the same way.
- **notice, 3.71 %** (orderEntry and serviceGrid were also 1 CSS px taller in H5). Two causes:
  - The hairlines had been lower-cased from `1PX` to `1px` by Prettier, which made them scaled
    design px.
  - The canvas sets `box-sizing: border-box` everywhere, while H5 and WeChat use `content-box`.

  Fixed with a Prettier-ignored `$hairline: 1PX` token, and `box-sizing: border-box` on rows that
  have both a fixed height and a hairline.
