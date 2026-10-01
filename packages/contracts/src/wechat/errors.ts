import { defineErrors } from '../_conventions/errors';

/**
 * Errors for the WeChat routes that are not about the Official Account.
 *
 * `wechat-oa/errors.ts` next door covers the OA management surface (menus,
 * auto-replies, channel QR codes). This file is the mini-program's half, and
 * today it has exactly one code.
 *
 * A failed 小程序码 is a **502**, not a 500 and not an empty `url`: our request
 * was well formed and WeChat said no — an unpublished mini program, a page
 * that does not exist in the submitted version, a spent daily quota. The
 * client shows "海报生成失败，请稍后再试" and keeps the share sheet open; a 500
 * would page an engineer for somebody else's outage, and an empty string would
 * render a broken image with no explanation anywhere.
 *
 * WeChat's own `errcode` travels in `details` (its English `errmsg` is logged), because that number is
 * the only thing that distinguishes "the mini program is not published yet"
 * (45009 / 41030) from "we are out of quota today".
 */
export const wechatErrors = defineErrors({
  /** `wxa/getwxacodeunlimit` answered with an `errcode`. `details`: `{ errcode }`. */
  WECHAT_MINI_CODE_FAILED: { status: 502, message: '小程序码生成失败，请稍后重试' },
});
