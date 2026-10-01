import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSession } from '@/session/session';
import { cardFixture, pageOf } from '@/test/catalog-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import Featured from './index';

const byFeature: Record<string, string> = {
  best: '柔雾丝绒礼盒',
  hot: '温感按摩油',
  new: '新款香氛蜡烛',
  benefit: '清洁护理套装',
};

describe('精品推荐', () => {
  beforeEach(() => useSession.setState({ session: { status: 'idle' } }));

  function serve() {
    const seen = serveApi({
      'GET /api/v1/catalog/products': () => ({
        body: pageOf([cardFixture({ name: byFeature[lastFeature()] ?? '?' })]),
      }),
    });
    const lastFeature = () =>
      seen.filter((r) => r.key === 'GET /api/v1/catalog/products').at(-1)?.query.feature ?? '';
    return seen;
  }

  it('opens on the tab the link asks for, and switches tabs', async () => {
    taroFake.routerParams = { tab: 'hot' };
    const seen = serve();
    await renderPage(<Featured />);

    expect(await screen.findByText('温感按摩油')).toBeTruthy();
    expect(seen.at(-1)?.query).toMatchObject({ feature: 'hot', sortBy: 'sales' });

    fireEvent.click(screen.getByRole('tab', { name: /新品首发/ }));
    expect(await screen.findByText('新款香氛蜡烛')).toBeTruthy();
    await waitFor(() =>
      expect(seen.at(-1)?.query).toMatchObject({ feature: 'new', sortBy: 'createdAt' }),
    );
  });

  it('starts on 精品推荐 without a tab (or with an unknown one)', async () => {
    taroFake.routerParams = { tab: 'bogus' };
    serve();
    await renderPage(<Featured />);
    expect(await screen.findByText('柔雾丝绒礼盒')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /精品推荐/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
});
