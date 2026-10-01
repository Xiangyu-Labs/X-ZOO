/**
 * What WeChat's token and configuration errcodes mean, in the words of the
 * screen the operator has to go and fix them on.
 *
 * WeChat's own `errmsg` is English with a request id (`invalid appsecret, rid:
 * …`), so it goes to the log and never into a sentence a person reads (AGENTS
 * rule 1). The errcode does go in, as （错误码 N）: it is what staff search the
 * 公众平台 documentation for.
 *
 * Only what an operator fixes by changing the settings lives here. The codes
 * of a *send* (a user who never followed the account, a template that was
 * deleted) are `notification.send.ts`'s `WECHAT_CODES`, which falls back to
 * this table, so a code is explained in one place.
 */
const HINTS: Record<number, string> = {
  40013: 'AppID 不正确',
  40125: 'AppSecret 不正确',
  40001: 'AppSecret 不正确，或已在公众平台重置',
  40164: '本服务器的出口 IP 不在「IP 白名单」里，请到公众平台「开发 → 基本配置」添加',
  61004: '本服务器的出口 IP 不在「IP 白名单」里，请到公众平台「开发 → 基本配置」添加',
  41002: '缺少 AppID',
  41004: '缺少 AppSecret',
  45009: '接口今天的调用次数已达上限',
  48001: '这个公众号或小程序没有该接口的权限（账号类型或认证状态不满足）',
};

/** The Chinese reason for a token or configuration errcode, or `undefined` when it is not one. */
export function wechatErrcodeHint(errcode: number | undefined | null): string | undefined {
  return errcode === undefined || errcode === null ? undefined : HINTS[errcode];
}

/**
 * `获取微信接口凭证失败：AppSecret 不正确（错误码 40125）`: what failed, why when
 * we know, and the errcode. Never the errmsg. A code that is not in the table
 * (or no code at all, `-1` being the client's "no answer") still gets a
 * sentence that is true.
 */
export function wechatRefusal(what: string, errcode: number | undefined | null): string {
  const hint = wechatErrcodeHint(errcode);
  const code =
    errcode === undefined || errcode === null || errcode < 0 ? '' : `（错误码 ${errcode}）`;
  return `${what}${hint === undefined ? '' : `：${hint}`}${code}`;
}
