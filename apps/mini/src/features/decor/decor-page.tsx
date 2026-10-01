import { useMemo } from 'react';
import { View } from '@tarojs/components';
import type { ResponseOf } from '@shop/api-client';
import type { StorefrontRoute } from '@shop/api-client/routes';
import { BlockList, type PersonalSlots } from '@shop/storefront-blocks';
import { fromPairs } from '@/lib/defined';
import { openLinkTarget } from '@/platform';
import { useDecorHost } from './decor-host';
import './decor-page.scss';

export type ResolvedPage = ResponseOf<'decor.pageHome'>;

export interface DecorPageProps {
  page: ResolvedPage;
  /** Where this page lives: 登录 comes back here, and 客服 sees it as the session source. */
  route: StorefrontRoute;
  /**
   * Fetches the page again. After a sign-in or a claim, only a fresh answer's personal layer
   * says what changed (DECOR-015).
   */
  reload: () => unknown;
}

/**
 * A resolved DIY v2 page (首页, 我的, 微页面): the page background, then the blocks in order.
 * Whatever block type this build does not know is skipped by `BlockList`, so an older
 * mini-program keeps working when the admin gains a block (plan §2.1).
 *
 * A block's data arrives inside it (`block.data`, by slot); `BlockList` wants it by block id.
 * The shopper's own slots (`personal`: 我的卡片, 订单入口, 优惠券 states, 新人券) come only with
 * a session.
 *
 * The blocks call no Taro API; `useDecorHost` answers their intents and wraps the ones that need
 * a native control (docs/mini/decor.md §2.4).
 */
export function DecorPage({ page, route, reload }: DecorPageProps) {
  const data = useMemo(
    () => fromPairs(page.blocks.map((block) => [block.id, block.data] as const)),
    [page.blocks],
  );
  const { host, onIntent, renderIntent } = useDecorHost(route, reload);

  return (
    <View className="decor-page" style={{ background: page.root.props.background }}>
      <BlockList
        blocks={page.blocks}
        data={data}
        personal={page.personal as Readonly<Record<string, PersonalSlots>> | null}
        host={host}
        onLink={(link) => openLinkTarget(link)}
        onIntent={onIntent}
        renderIntent={renderIntent}
      />
    </View>
  );
}
