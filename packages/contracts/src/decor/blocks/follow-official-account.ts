import type { z } from 'zod';

import { blockProps } from '../base';
import { defineBlock } from '../registry';

/**
 * 关注公众号: WeChat's own 「关注公众号」 bar (`<official-account>`).
 *
 * The block holds no content: which 公众号, and whether the bar shows at all,
 * is WeChat's decision, not the shop's. The block only asks the host for the
 * `officialAccount` intent; the mini-program host renders the native
 * component, every other client renders nothing. Per WeChat's documentation
 * (to be confirmed on a device):
 *
 * - it can show only when the 小程序 was opened by scanning a QR code (scene
 *   1011) or a 小程序码 (1047, 1124); reopened from 「最近使用」 (1089) or
 *   returning from another 小程序 (1038) it keeps the state of the previous
 *   open, and from anywhere else (search, a shared card, the 发现 list) it
 *   does not show;
 * - the 公众号 is set in the 小程序 admin (设置 → 关注公众号) and must share
 *   the 小程序's 主体;
 * - one per page, at least 300 px wide and 84 px high, not styleable;
 * - H5 and the 公众号 web page have no equivalent.
 *
 * One per page (DECOR-018), as WeChat allows.
 */
export const followOfficialAccountProps = blockProps({});
export type FollowOfficialAccountProps = z.infer<typeof followOfficialAccountProps>;

export const followOfficialAccountBlock = defineBlock({
  type: 'followOfficialAccount',
  v: 1,
  props: followOfficialAccountProps,
  meta: { label: '关注公众号', pages: ['home', 'custom', 'user_center'], maxPerPage: 1 },
});
