import { Text, View } from '@tarojs/components';

import type { FollowOfficialAccountProps } from '@shop/contracts/decor/all-blocks';
import { BlockFrame } from '../shared/frame';
import type { BlockIntent, BlockProps } from '../shared/types';
import styles from './follow-official-account.module.scss';

const OFFICIAL_ACCOUNT: BlockIntent = { kind: 'officialAccount' };

/**
 * 关注公众号: whatever the host renders for the `officialAccount` intent — in
 * the mini-program WeChat's native `<official-account>`, elsewhere nothing.
 * The block has no content of its own and stays pure: which 公众号, and
 * whether the bar shows at all (only after the 小程序 was opened by scanning
 * a code), is WeChat's decision. See the block's contract for the scenes.
 *
 * In the editor: an explanation instead, since the canvas can show neither.
 */
export function FollowOfficialAccount({
  props,
  renderIntent,
  host,
}: BlockProps<FollowOfficialAccountProps>) {
  if (host?.canvas) {
    return (
      <BlockFrame type="followOfficialAccount" frame={props.style} className={styles.canvas}>
        <View className={styles.placeholder}>
          <Text className={styles.title}>关注公众号</Text>
          <Text className={styles.text}>
            由微信显示，仅在微信小程序中、且从扫码（二维码 / 小程序码）进入时出现，其他入口和 H5
            不显示。公众号在小程序后台「设置 → 关注公众号」中设置，须与小程序同一主体。
          </Text>
        </View>
      </BlockFrame>
    );
  }
  const node = renderIntent ? renderIntent(OFFICIAL_ACCOUNT, null) : null;
  if (node === null || node === undefined || node === false) return null;
  return (
    <BlockFrame type="followOfficialAccount" frame={props.style}>
      {node}
    </BlockFrame>
  );
}
