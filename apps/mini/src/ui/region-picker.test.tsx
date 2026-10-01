import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CITY_TREE_KEY } from '@/data/cities';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import { RegionPicker } from './region-picker';

const tree = {
  version: 'v1',
  items: [
    {
      id: '440000',
      name: '广东省',
      level: 0,
      children: [
        {
          id: '440100',
          name: '广州市',
          level: 1,
          children: [
            { id: '440106', name: '天河区', level: 2 },
            { id: '440104', name: '越秀区', level: 2 },
          ],
        },
      ],
    },
    {
      id: '110000',
      name: '北京市',
      level: 0,
      children: [{ id: '110100', name: '北京市', level: 1, children: [] }],
    },
  ],
};

describe('RegionPicker', () => {
  it('walks 省 → 市 → 区 and hands back the ids and names, keeping the tree', async () => {
    const seen = serveApi({ 'GET /api/v1/cities': () => ({ body: tree }) });
    const onChange = vi.fn();
    await renderPage(<RegionPicker value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('link', { name: '所在地区：未选择' }));
    fireEvent.click(await screen.findByRole('radio', { name: '广东省' }));
    fireEvent.click(screen.getByRole('radio', { name: '广州市' }));
    fireEvent.click(screen.getByRole('radio', { name: '越秀区' }));
    expect(onChange).toHaveBeenCalledWith({
      provinceId: '440000',
      provinceName: '广东省',
      cityId: '440100',
      cityName: '广州市',
      districtId: '440104',
      districtName: '越秀区',
    });
    expect(seen).toHaveLength(1);
    await waitFor(() => expect(taroFake.storage.get(CITY_TREE_KEY)).toContain('"version":"v1"'));
  });

  it('stops at a city with no districts, reading the stored tree without asking', async () => {
    taroFake.storage.set(CITY_TREE_KEY, JSON.stringify(tree));
    const seen = serveApi({});
    const onChange = vi.fn();
    await renderPage(<RegionPicker value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('link', { name: '所在地区：未选择' }));
    fireEvent.click(await screen.findByRole('radio', { name: '北京市' }));
    fireEvent.click(screen.getAllByRole('radio', { name: '北京市' })[0] as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ cityId: '110100', districtId: null }),
    );
    expect(seen).toHaveLength(0);
  });

  it('opens on the saved region, and a tab steps back a level', async () => {
    serveApi({ 'GET /api/v1/cities': () => ({ body: tree }) });
    await renderPage(
      <RegionPicker
        value={{
          provinceId: '440000',
          provinceName: '广东省',
          cityId: '440100',
          cityName: '广州市',
          districtId: '440106',
          districtName: '天河区',
        }}
        onChange={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('link', { name: '所在地区：广东省 广州市 天河区' }));
    expect(
      (await screen.findByRole('radio', { name: '天河区' })).getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: '广东省' }));
    expect(screen.getByRole('radio', { name: '北京市' })).toBeTruthy();
  });
});
