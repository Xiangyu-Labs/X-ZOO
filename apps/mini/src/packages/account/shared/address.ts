import type { InputOf, ResponseOf } from '@shop/api-client';
import type { CityProvince } from '@/data/cities';
import { storage, type ChosenAddress } from '@/platform';
import type { Region } from '@/ui/region-picker';

export type AddressBody = InputOf<'user.addressCreate'>['body'];
export type UserAddress = ResponseOf<'user.addressDetail'>;

/** What the address form holds while it is being filled in. */
export interface AddressDraft {
  receiverName: string;
  receiverPhone: string;
  region: Region | null;
  detail: string;
  postCode: string | null;
  isDefault: boolean;
}

export const EMPTY_DRAFT: AddressDraft = {
  receiverName: '',
  receiverPhone: '',
  region: null,
  detail: '',
  postCode: null,
  isDefault: false,
};

/** 广东省 → 广东, 广州市 → 广州, 天河区 → 天河: how WeChat's names and the tree's can differ. */
function bare(name: string): string {
  return name.trim().replace(/(省|市|自治区|特别行政区|自治州|地区|盟|区|县|自治县|旗)$/, '');
}

function findNamed<T extends { name: string }>(nodes: readonly T[], name: string): T | undefined {
  return nodes.find((node) => node.name === name) ?? nodes.find((n) => bare(n.name) === bare(name));
}

/**
 * The tree's region for WeChat's three names, or `null` when a level cannot be found. Freight
 * is priced on the ids (an address with no `cityId` quotes none), so an import that does not
 * resolve is finished by hand in the region picker.
 *
 * A municipality comes back from WeChat as 北京市 / 北京市 / 东城区; where the tree has a single
 * city under the province, that city is taken whatever its name.
 */
export function matchRegion(
  provinces: readonly CityProvince[],
  names: { province: string; city: string; district: string },
): Region | null {
  const province = findNamed(provinces, names.province);
  if (!province) return null;
  const city =
    findNamed(province.children, names.city) ??
    (province.children.length === 1 ? province.children[0] : undefined);
  if (!city) return null;
  if (city.children.length === 0) {
    return {
      provinceId: province.id,
      provinceName: province.name,
      cityId: city.id,
      cityName: city.name,
      districtId: null,
      districtName: null,
    };
  }
  const district = names.district ? findNamed(city.children, names.district) : undefined;
  if (!district) return null;
  return {
    provinceId: province.id,
    provinceName: province.name,
    cityId: city.id,
    cityName: city.name,
    districtId: district.id,
    districtName: district.name,
  };
}

/** WeChat's address as a form draft; the region only when the tree resolves it. */
export function draftFromChosen(
  chosen: ChosenAddress,
  provinces: readonly CityProvince[],
): AddressDraft {
  return {
    receiverName: chosen.name.slice(0, 32),
    receiverPhone: chosen.phone.replace(/\D/g, '').slice(-11),
    region: matchRegion(provinces, chosen),
    detail: chosen.detail.slice(0, 255),
    postCode: chosen.postCode && /^\d{6}$/.test(chosen.postCode) ? chosen.postCode : null,
    isDefault: false,
  };
}

export function draftFromAddress(address: UserAddress): AddressDraft {
  return {
    receiverName: address.receiverName,
    receiverPhone: address.receiverPhone,
    region:
      address.provinceId && address.cityId
        ? {
            provinceId: address.provinceId,
            provinceName: address.provinceName,
            cityId: address.cityId,
            cityName: address.cityName,
            districtId: address.districtId,
            districtName: address.districtName,
          }
        : null,
    detail: address.detail,
    postCode: address.postCode,
    isDefault: address.isDefault,
  };
}

export type AddressErrors = {
  [K in 'receiverName' | 'receiverPhone' | 'region' | 'detail']?: string | undefined;
};

export const ADDRESS_FIELDS = ['receiverName', 'receiverPhone', 'region', 'detail'] as const;

/** The server's rules (`userAddressForm`), checked before sending. */
export function checkAddress(draft: AddressDraft): AddressErrors {
  const errors: AddressErrors = {};
  const name = draft.receiverName.trim();
  if (!name) errors.receiverName = '请填写收货人';
  else if (name.length > 32) errors.receiverName = '收货人最多 32 个字';
  if (!/^1[3-9]\d{9}$/.test(draft.receiverPhone)) errors.receiverPhone = '请填写正确的手机号';
  if (!draft.region) errors.region = '请选择所在地区';
  const detail = draft.detail.trim();
  if (!detail) errors.detail = '请填写详细地址';
  else if (detail.length > 255) errors.detail = '详细地址最多 255 个字';
  return errors;
}

/** The create / update body for a checked draft. */
export function addressBody(draft: AddressDraft & { region: Region }): AddressBody {
  const { region } = draft;
  return {
    receiverName: draft.receiverName.trim(),
    receiverPhone: draft.receiverPhone,
    provinceId: region.provinceId,
    cityId: region.cityId,
    ...(region.districtId ? { districtId: region.districtId } : {}),
    provinceName: region.provinceName,
    cityName: region.cityName,
    ...(region.districtName ? { districtName: region.districtName } : {}),
    detail: draft.detail.trim(),
    ...(draft.postCode ? { postCode: draft.postCode } : {}),
    isDefault: draft.isDefault,
  };
}

const IMPORTED_KEY = 'shop.address.imported';

/**
 * An imported address that could not be saved as it was (its region did not resolve), handed
 * to the edit page to finish — from 我的地址 or from 确认订单. Through storage, read once and
 * removed, not a store: 确认订单 is in the order sub-package and the edit page in account, and
 * Taro copies a module two sub-packages share into each of them (`sub-common`), so each side
 * would hold its own store and the address would never arrive. Never in a URL.
 */
export function handOffImportedAddress(draft: AddressDraft): void {
  storage.set(IMPORTED_KEY, JSON.stringify(draft));
}

const NEW_ADDRESS_KEY = 'shop.address.new';
const WAITING = 'waiting';

/**
 * 确认订单 sent the shopper to add an address (新增收货地址, or an import finished by hand) and
 * picks it when shown again: the edit page leaves the new address's id here. Through storage for
 * the reason `handOffImportedAddress` gives. Only a wait 确认订单 started is answered, so an
 * address added from 我的地址 never lands on a later order.
 */
export function awaitNewAddress(): void {
  storage.set(NEW_ADDRESS_KEY, WAITING);
}

/** The edit page saved a new address: hand it to 确认订单 if it is waiting for one. */
export function handBackNewAddress(id: string): void {
  if (storage.get(NEW_ADDRESS_KEY) === WAITING) storage.set(NEW_ADDRESS_KEY, id);
}

/** The address added while 确认订单 waited, once; `null` when none was. Ends the wait. */
export function takeNewAddress(): string | null {
  const value = storage.get(NEW_ADDRESS_KEY);
  if (value === null) return null;
  storage.remove(NEW_ADDRESS_KEY);
  return value === WAITING ? null : value;
}

/** The handed-over import, once; `null` when there is none. */
export function takeImportedAddress(): AddressDraft | null {
  const raw = storage.get(IMPORTED_KEY);
  if (!raw) return null;
  storage.remove(IMPORTED_KEY);
  try {
    return JSON.parse(raw) as AddressDraft;
  } catch {
    return null;
  }
}
