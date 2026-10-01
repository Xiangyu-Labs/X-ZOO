import type { ResponseOf } from '@shop/api-client';

/** Test data for the address pages: one address and a one-branch city tree (深圳 南山). */
export const addressFixture: ResponseOf<'user.addressDetail'> = {
  id: '31',
  receiverName: '李四',
  receiverPhone: '13900139000',
  provinceId: '44',
  cityId: '4403',
  districtId: '440305',
  provinceName: '广东省',
  cityName: '深圳市',
  districtName: '南山区',
  detail: '科技园路 3 号',
  postCode: null,
  lng: null,
  lat: null,
  isDefault: true,
  createdAt: '2026-09-01T10:00:00+08:00',
  updatedAt: '2026-09-01T10:00:00+08:00',
};

export const cityTreeFixture: ResponseOf<'shipping.cityTree'> = {
  version: 'v1',
  items: [
    {
      id: '44',
      name: '广东省',
      level: 0,
      children: [
        {
          id: '4403',
          name: '深圳市',
          level: 1,
          children: [{ id: '440305', name: '南山区', level: 2 }],
        },
      ],
    },
  ],
};
