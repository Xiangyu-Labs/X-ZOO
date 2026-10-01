import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { page, signIn } from '@/test/account-fixture';
import { addressFixture, cityTreeFixture } from '@/test/address-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import AddressesPage from './index';

const second = { ...addressFixture, id: '32', receiverName: '王五', isDefault: false };

describe('收货地址', () => {
  beforeEach(() => {
    signIn();
    taroFake.pageStackDepth = 2;
  });

  it('deletes after a confirmation', async () => {
    const seen = serveApi({
      'GET /api/v1/addresses': () => ({ body: page([addressFixture, second]) }),
      'GET /api/v1/cities': () => ({ body: cityTreeFixture }),
      'DELETE /api/v1/addresses/32': () => ({ status: 204, body: null }),
    });
    await renderPage(<AddressesPage />);

    fireEvent.click(await screen.findByRole('button', { name: '删除 王五 的地址' }));

    await waitFor(() => expect(seen.map((r) => r.key)).toContain('DELETE /api/v1/addresses/32'));
  });

  it('saves a WeChat address whose region resolves in one tap', async () => {
    taroFake.address = {
      userName: '张三',
      telNumber: '13800138000',
      provinceName: '广东省',
      cityName: '深圳市',
      countyName: '南山区',
      detailInfo: '科技园路 9 号',
      postalCode: '518000',
    };
    const seen = serveApi({
      'GET /api/v1/addresses': () => ({ body: page([]) }),
      'GET /api/v1/cities': () => ({ body: cityTreeFixture }),
      'POST /api/v1/addresses': (body) => ({
        status: 201,
        body: { ...addressFixture, ...(body as object) },
      }),
    });
    await renderPage(<AddressesPage />);
    await screen.findByText('还没有收货地址');
    await waitFor(() => expect(seen.map((r) => r.key)).toContain('GET /api/v1/cities'));

    fireEvent.click(screen.getByRole('button', { name: '导入微信地址' }));

    await waitFor(() =>
      expect(seen.find((r) => r.key === 'POST /api/v1/addresses')?.body).toMatchObject({
        receiverName: '张三',
        cityId: '4403',
        districtId: '440305',
        detail: '科技园路 9 号',
      }),
    );
  });

  it('opens the form for an import whose region does not resolve', async () => {
    taroFake.address = {
      userName: '张三',
      telNumber: '13800138000',
      provinceName: '广东省',
      cityName: '广州市',
      countyName: '天河区',
      detailInfo: '体育西路 100 号',
      postalCode: '',
    };
    const seen = serveApi({
      'GET /api/v1/addresses': () => ({ body: page([]) }),
      'GET /api/v1/cities': () => ({ body: cityTreeFixture }),
    });
    await renderPage(<AddressesPage />);
    await screen.findByText('还没有收货地址');
    await waitFor(() => expect(seen.map((r) => r.key)).toContain('GET /api/v1/cities'));

    fireEvent.click(screen.getByRole('button', { name: '导入微信地址' }));

    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/packages/account/address-edit/index' },
      }),
    );
    expect(
      JSON.parse((taroFake.storage.get('shop.address.imported') as string | undefined) ?? 'null'),
    ).toMatchObject({
      receiverName: '张三',
      region: null,
    });
    expect(seen.some((r) => r.key === 'POST /api/v1/addresses')).toBe(false);
  });
});
