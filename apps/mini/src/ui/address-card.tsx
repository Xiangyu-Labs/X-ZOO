import type { UserAddress } from '@shop/contracts/user/schemas';
import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { maskPhone } from '@/lib/format';
import { platform, type ChosenAddress } from '@/platform';
import { Icon } from './icon';
import { Pressable } from './pressable';
import { Tag } from './tag';
import './address-card.scss';

export type AddressCardData = Pick<
  UserAddress,
  'receiverName' | 'receiverPhone' | 'provinceName' | 'cityName' | 'districtName' | 'detail'
> & { isDefault?: boolean | undefined };

/** 广东省 广州市 天河区 */
export function regionText(
  address: Pick<AddressCardData, 'provinceName' | 'cityName' | 'districtName'>,
): string {
  return (
    [address.provinceName, address.cityName, address.districtName]
      .filter((part): part is string => Boolean(part))
      // A municipality repeats itself (北京市 北京市): say it once.
      .filter((part, index, all) => index === 0 || part !== all[index - 1])
      .join(' ')
  );
}

export interface AddressCardProps {
  /** `null`: no address yet. */
  address: AddressCardData | null;
  /** Checkout: the chosen address cannot be delivered to (the server's reason). */
  undeliverable?: string | undefined;
  /** Change the address (opens the address book in select mode). */
  onClick?: (() => void) | undefined;
  /** 添加收货地址 (no address). */
  onAdd?: (() => void) | undefined;
  /** 导入微信地址 (no address): WeChat's own address picker, already mapped. */
  onImport?: ((address: ChosenAddress) => void | Promise<unknown>) | undefined;
  className?: string | undefined;
}

/**
 * The address at the top of checkout (design.md §4.4): name, phone with the middle four
 * hidden, the address; with none, 添加收货地址 and 导入微信地址. The envelope stripe along the
 * bottom is the familiar cue that this is where it ships.
 */
export function AddressCard({
  address,
  undeliverable,
  onClick,
  onAdd,
  onImport,
  className,
}: AddressCardProps) {
  if (!address) {
    return (
      <View className={cx('shop-address', 'shop-address--empty', className)}>
        <Pressable label="添加收货地址" className="shop-address__add" onClick={onAdd}>
          <Icon name="location" className="shop-address__pin" />
          <Text className="shop-address__add-text">添加收货地址</Text>
          <Icon name="chevron-right" className="shop-address__arrow" />
        </Pressable>
        {onImport ? (
          <Pressable
            label="导入微信地址"
            className="shop-address__import"
            onClick={() => {
              return platform
                .chooseAddress()
                .then((chosen) => (chosen ? onImport(chosen) : undefined));
            }}
          >
            <Icon name="download" className="shop-address__import-icon" />
            <Text>导入微信地址</Text>
          </Pressable>
        ) : null}
        <View className="shop-address__stripe" ariaHidden />
      </View>
    );
  }
  const region = regionText(address);
  return (
    <View className={cx('shop-address', className)}>
      <Pressable
        label={`收货地址：${address.receiverName}，${region}${address.detail}${onClick ? '，点击更换' : ''}`}
        role="link"
        className="shop-address__main"
        onClick={onClick}
      >
        <Icon name="location" className="shop-address__pin" />
        <View className="shop-address__body">
          <View className="shop-address__who">
            <Text className="shop-address__name">{address.receiverName}</Text>
            <Text className="shop-address__phone">{maskPhone(address.receiverPhone)}</Text>
            {address.isDefault ? <Tag tone="primary">默认</Tag> : null}
          </View>
          <Text className="shop-address__region">{region}</Text>
          <Text className="shop-address__detail">{address.detail}</Text>
          {undeliverable ? <Text className="shop-address__warning">{undeliverable}</Text> : null}
        </View>
        {onClick ? <Icon name="chevron-right" className="shop-address__arrow" /> : null}
      </Pressable>
      <View className="shop-address__stripe" ariaHidden />
    </View>
  );
}
