import type { ReactNode } from 'react';
import { OfficialAccount } from '@tarojs/components';

/**
 * WeChat's 关注公众号 bar (`<official-account>`), for the decor block of that name
 * (docs/mini/decor.md §2.3). WeChat decides whether it shows: only in the mini-program, only
 * after a scan (scenes 1011, 1047, 1124, and 1089 / 1038 back from those), for the account set
 * under 「设置 → 关注公众号」. Its size and look are WeChat's.
 *
 * `null` on the H5 builds, which have no such component: the block then draws nothing at all
 * (it hides itself on `null`, not on an element that renders nothing).
 */
export function officialAccountBar(): ReactNode {
  if (process.env.TARO_ENV !== 'weapp') return null;
  return <OfficialAccount />;
}
