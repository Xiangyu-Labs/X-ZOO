import { defineErrors } from '../_conventions/errors';

/**
 * WeChat Official Account error codes.
 *
 * Two families live here and they fail very differently:
 *
 * - **Configuration refusals** (`WECHAT_OA_NOT_CONFIGURED`,
 *   `WECHAT_OA_SIGNATURE_INVALID`) are answered without ever touching
 *   `api.weixin.qq.com`. An unconfigured shop asking for a JS-SDK signature is
 *   an ordinary 409, not a 500 and not a silent empty object: the H5 client has
 *   to be able to tell "the shop has no OA" from "the server broke".
 * - **Upstream refusals** (`WECHAT_OA_API_FAILED`) carry WeChat's own
 *   `errcode` in `details` and in the message, because that number is the only
 *   thing that makes a failed menu publish diagnosable. Its English `errmsg`
 *   is logged, never answered. It is a 502: our request was fine,
 *   the other end said no.
 *
 * The webhook has no error codes at all. WeChat retries any non-`success`
 * body three times and then shows the user 该公众号暂时无法提供服务; answering
 * with a JSON error object would be read as a failure and re-delivered. Every
 * webhook refusal is a plain-text body — see `wechat-oa.webhook.contract.ts`.
 */
export const wechatOaErrors = defineErrors({
  /** The `wechat-oa` config group is off, or `appId`/`appSecret` are blank. */
  WECHAT_OA_NOT_CONFIGURED: { status: 409, message: '公众号尚未配置，请先在系统设置中填写' },
  /** WeChat answered with a non-zero `errcode`. The message names it in Chinese; `details` carries `{ errcode }`. */
  WECHAT_OA_API_FAILED: { status: 502, message: '微信接口调用失败，请稍后重试' },

  WECHAT_OA_MENU_NOT_FOUND: { status: 404, message: '菜单不存在' },
  /** A button tree that WeChat would reject: too many buttons, too deep, or a missing target. */
  WECHAT_OA_MENU_INVALID: { status: 422, message: '菜单结构不符合微信的要求' },

  WECHAT_OA_REPLY_NOT_FOUND: { status: 404, message: '自动回复不存在' },
  /** `wechat_auto_replies_singleton_uq`: one subscribe reply and one fallback, no more. */
  WECHAT_OA_REPLY_DUPLICATE: { status: 409, message: '该类型的自动回复已存在' },
  /** `wechat_auto_replies_keyword_uq`. */
  WECHAT_OA_KEYWORD_TAKEN: { status: 409, message: '该关键词已被其他自动回复占用' },

  WECHAT_OA_QRCODE_NOT_FOUND: { status: 404, message: '渠道码不存在' },
  /** `wechat_qrcodes_scene_uq`. A scene string is how a scan is attributed, so it cannot repeat. */
  WECHAT_OA_QRCODE_SCENE_TAKEN: { status: 409, message: '该场景值已被占用' },
  /** A category that still has QR codes filed under it. */
  WECHAT_OA_CATEGORY_NOT_EMPTY: { status: 409, message: '该分类下还有渠道码，无法删除' },
  WECHAT_OA_CATEGORY_NOT_FOUND: { status: 404, message: '渠道码分类不存在' },
  /**
   * `wechat_qrcode_categories_name_uq`, scoped to `deleted_at is null`, so a
   * deleted category never keeps its name taken. The message says the one thing
   * that is true and can be acted on — some live category has the name.
   */
  WECHAT_OA_CATEGORY_NAME_TAKEN: { status: 409, message: '该分类名称已被占用' },

  WECHAT_OA_MEDIA_NOT_FOUND: { status: 404, message: '素材不存在' },
  /** The attachment is not a kind WeChat accepts for that media type. */
  WECHAT_OA_MEDIA_UNSUPPORTED: { status: 422, message: '该文件类型不能上传为微信素材' },

  /**
   * The URL handed to the JS-SDK signature endpoint is not one of ours.
   *
   * Signing an arbitrary URL is signing for somebody else's page: the ticket is
   * ours, the page is not.
   */
  WECHAT_OA_URL_NOT_ALLOWED: { status: 422, message: '该地址不在授权域名内' },
});

export type WechatOaErrorCode = keyof typeof wechatOaErrors;
