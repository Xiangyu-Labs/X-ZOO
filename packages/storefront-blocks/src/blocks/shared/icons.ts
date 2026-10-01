/**
 * The default icons of the 个人中心 blocks and the search field: thin line
 * icons as inline SVG data URIs, so they need no upload, no network and no
 * icon font, and render identically in the mini-program, the admin canvas and
 * a test. Neutral ink (`#1A1A1A`, the text colour) — deliberately plain.
 *
 * Base64, not a URL-encoded `charset=utf-8` URI: WeChat's `<image>` on a phone
 * does not reliably draw the latter, and the mini-program runtime has no
 * `btoa`, hence the encoder below (the markup is ASCII).
 */

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64Ascii(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i);
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) : NaN;
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) : NaN;
    const bits = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += BASE64[(bits >> 18) & 63]! + BASE64[(bits >> 12) & 63]!;
    out += Number.isNaN(b) ? '=' : BASE64[(bits >> 6) & 63]!;
    out += Number.isNaN(c) ? '=' : BASE64[bits & 63]!;
  }
  return out;
}

function icon(body: string, stroke = '#1A1A1A'): string {
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  return `data:image/svg+xml;base64,${base64Ascii(markup)}`;
}

export const ICONS = {
  /** 待付款: a wallet. */
  unpaid: icon(
    '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M16 14.5h2"/>',
  ),
  /** 待发货: a parcel. */
  unshipped: icon(
    '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5"/><path d="M12 12v9"/>',
  ),
  /** 待收货: a van. */
  unreceived: icon(
    '<path d="M2.5 6h11v10h-11z"/><path d="M13.5 9.5h4l3 3.5v3h-7"/><circle cx="6.5" cy="17.5" r="1.5"/><circle cx="17" cy="17.5" r="1.5"/>',
  ),
  /** 待评价: a speech bubble. */
  unreviewed: icon(
    '<path d="M4 5h16v11H9l-4 3.5V16H4z"/><path d="M8 9.5h8"/><path d="M8 12.5h5"/>',
  ),
  /** 售后/退款: a circular arrow. */
  aftersale: icon(
    '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v3.5H8"/><path d="M9.5 12h5"/>',
  ),
  /** 搜索: a magnifier, in the tertiary text colour. */
  search: icon('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>', '#707070'),
  /** 公告: a speaker. */
  notice: icon(
    '<path d="M4 9.5h3l5-4v13l-5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    '#666666',
  ),
  /** A guest's avatar. */
  avatar: icon(
    '<circle cx="12" cy="9" r="3.5"/><path d="M5 19.5c1.2-3.3 3.8-5 7-5s5.8 1.7 7 5"/>',
    '#B2B2B2',
  ),
  /** 客服: a headset. */
  contact: icon(
    '<path d="M4.5 13.5v-2a7.5 7.5 0 0 1 15 0v2"/><rect x="3.5" y="13" width="4" height="5.5" rx="1.5"/><rect x="16.5" y="13" width="4" height="5.5" rx="1.5"/><path d="M18.5 18.5c0 1.5-1.5 2.5-4 2.5h-1.5"/>',
    '#666666',
  ),
} as const;
