import { describe, expect, it } from 'vitest';
import type { CityProvince } from '@/data/cities';
import { addressBody, checkAddress, draftFromChosen, matchRegion } from './address';

const node = (id: string, name: string, level: number) => ({ id, name, level });
const tree: CityProvince[] = [
  {
    ...node('44', '广东省', 0),
    children: [
      { ...node('4403', '深圳市', 1), children: [node('440305', '南山区', 2)] },
      { ...node('4419', '东莞市', 1), children: [] },
    ],
  },
  {
    ...node('11', '北京市', 0),
    children: [{ ...node('1101', '市辖区', 1), children: [node('110101', '东城区', 2)] }],
  },
];

describe('address import', () => {
  it('resolves WeChat’s names to the tree’s ids', () => {
    expect(matchRegion(tree, { province: '广东省', city: '深圳市', district: '南山区' })).toEqual({
      provinceId: '44',
      provinceName: '广东省',
      cityId: '4403',
      cityName: '深圳市',
      districtId: '440305',
      districtName: '南山区',
    });
  });

  it('matches names without their suffix, a municipality, and a city with no districts', () => {
    expect(
      matchRegion(tree, { province: '广东', city: '深圳', district: '南山' })?.districtId,
    ).toBe('440305');
    expect(
      matchRegion(tree, { province: '北京市', city: '北京市', district: '东城区' }),
    ).toMatchObject({
      cityId: '1101',
      districtId: '110101',
    });
    expect(matchRegion(tree, { province: '广东省', city: '东莞市', district: '' })).toMatchObject({
      cityId: '4419',
      districtId: null,
    });
  });

  it('gives no region when a level is missing, for the picker to finish', () => {
    expect(
      matchRegion(tree, { province: '广东省', city: '广州市', district: '天河区' }),
    ).toBeNull();
    expect(
      matchRegion(tree, { province: '广东省', city: '深圳市', district: '福田区' }),
    ).toBeNull();
  });

  it('makes a checked body from an imported address', () => {
    const draft = draftFromChosen(
      {
        name: '张三',
        phone: '+86 138-0013-8000',
        province: '广东省',
        city: '深圳市',
        district: '南山区',
        detail: '科技园路 3 号',
        postCode: '518000',
      },
      tree,
    );
    expect(checkAddress(draft)).toEqual({});
    expect(addressBody({ ...draft, region: draft.region! })).toEqual({
      receiverName: '张三',
      receiverPhone: '13800138000',
      provinceId: '44',
      cityId: '4403',
      districtId: '440305',
      provinceName: '广东省',
      cityName: '深圳市',
      districtName: '南山区',
      detail: '科技园路 3 号',
      postCode: '518000',
      isDefault: false,
    });
  });

  it('says which fields are missing', () => {
    expect(
      checkAddress({
        receiverName: ' ',
        receiverPhone: '123',
        region: null,
        detail: '',
        postCode: null,
        isDefault: false,
      }),
    ).toEqual({
      receiverName: '请填写收货人',
      receiverPhone: '请填写正确的手机号',
      region: '请选择所在地区',
      detail: '请填写详细地址',
    });
  });
});
