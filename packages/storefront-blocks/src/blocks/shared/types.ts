import type { ReactNode } from 'react';

import type { LinkTarget } from '@shop/contracts/decor/link';

/**
 * Something a tap asks the host to do that is not opening a page. The block
 * only names it and calls no API; the host decides how — the mini-program
 * draws WeChat's `<button open-type="contact">` for `contact`, runs its
 * sign-in for `login`, and so on; the editor ignores them all.
 *
 * - `contact`: start a 客服 conversation (服务宫格, 悬浮客服).
 * - `login`: sign the shopper in (用户卡片).
 * - `claimCoupon`: claim one coupon template (优惠券). The host signs a guest
 *   in first, claims, shows the result and reloads the page, whose
 *   per-shopper state then says 已领取.
 * - `claimNewcomerCoupons`: a guest asks for the 新人券 (新人券). They are
 *   granted when the account is created, so this is the sign-in / register
 *   flow; the host reloads the page afterwards.
 * - `officialAccount`: WeChat's 关注公众号 bar (关注公众号). Only meaningful to
 *   `renderIntent`: the mini-program returns `<OfficialAccount />`, every
 *   other host `null`.
 */
export type BlockIntent =
  | { kind: 'contact' }
  | { kind: 'login' }
  | { kind: 'claimCoupon'; templateId: string }
  | { kind: 'claimNewcomerCoupons' }
  | { kind: 'officialAccount' };

/**
 * What the host tells every block about where it is drawn. All optional: a
 * block works without any of it.
 *
 * - `signedIn`: a shopper session came with the page (`ResolvedPage.personal`
 *   is not `null`). `BlockList` derives it from `personal` when not given.
 *   A block that shows guests something else (新人券) reads this, not the
 *   presence of its own `personal` slot, which a failed lookup also leaves out.
 * - `serverNow`: the server's clock in ms (the mini-program passes
 *   `lib/server-clock`'s `serverNow`). Countdowns (预售) tick only when it is
 *   given; without it they show the end time instead, never the device clock.
 * - `canvas`: drawn in the editor. Blocks that are invisible or native on the
 *   storefront (悬浮客服, 关注公众号, 视频) draw an in-flow stand-in the
 *   operator can select, and an empty list says so instead of vanishing.
 * - `overlayOpen`: a popup or sheet covers the page. A native `<video>` draws
 *   above every view, so the 视频 block unmounts its player (which stops it)
 *   and shows the poster until the overlay closes (design.md §2.6).
 * - `hidden`: the page is not on screen (a page opened over it, a tab
 *   switched away from) but stays mounted. Timers (预售's countdown) stop
 *   until it is shown again, rather than rendering into a view no one sees.
 * - `resolveImage`: turns a stored picture URL into the one to load. `width`
 *   asks for the server's smaller copy (480 or 960 px wide) where one exists;
 *   without it, the original — which is also how the 视频 block resolves its
 *   video URL (never with a width). The mini-program resolves `/uploads/…` against
 *   the API origin and derives the copy's URL; without it (the editor) a block
 *   loads the stored URL as it is. A block always falls back to the original
 *   when a copy fails to load (`BlockImage`).
 */
export interface BlockHost {
  signedIn?: boolean | undefined;
  serverNow?: (() => number) | undefined;
  canvas?: boolean | undefined;
  overlayOpen?: boolean | undefined;
  hidden?: boolean | undefined;
  resolveImage?: ImageResolver | undefined;
}

/** The two copy widths a block may ask for; see `BlockHost.resolveImage`. */
export type BlockImageWidth = 480 | 960;
export type ImageResolver = (src: string, width?: BlockImageWidth) => string;

/**
 * What every block component receives.
 *
 * - `props` are the block's stored props, already parsed (defaults filled in).
 * - `data` is whatever the server resolved for it (products for a product
 *   grid); a block never fetches.
 * - `personal` is the signed-in shopper's own state for it (order counts, the
 *   profile), by slot; absent for a guest and in the editor.
 * - `onLink` reports a tap on something that links somewhere. The host decides
 *   what that means: the mini-program navigates through its route table, the
 *   editor ignores it.
 * - `onIntent` reports a tap that asks for something other than a page.
 * - `renderIntent`, when the host gives it, wraps the element that triggers an
 *   intent, for an intent that needs a native control rather than a tap
 *   handler (WeChat opens 客服 only from `<button open-type="contact">`). The
 *   block then attaches no tap handler of its own to that element.
 * - `host` says where the block is drawn (`BlockHost`).
 */
export interface BlockProps<Props, Data = undefined, Personal = undefined> {
  props: Props;
  data?: Data | undefined;
  personal?: Personal | undefined;
  onLink?: ((target: LinkTarget) => void) | undefined;
  onIntent?: ((intent: BlockIntent) => void) | undefined;
  renderIntent?: ((intent: BlockIntent, children: ReactNode) => ReactNode) | undefined;
  host?: BlockHost | undefined;
}
