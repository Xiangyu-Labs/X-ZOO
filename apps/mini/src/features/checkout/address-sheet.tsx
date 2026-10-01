import { Text, View } from '@tarojs/components';
import { useRouteQuery } from '@shop/api-client/react';
import { maskPhone } from '@/lib/format';
import { platform, type ChosenAddress } from '@/platform';
import { regionText } from '@/ui/address-card';
import { Button } from '@/ui/button';
import { Radio } from '@/ui/choice';
import { ErrorBlock } from '@/ui/error-block';
import { CellSkeleton } from '@/ui/skeleton';
import { Sheet } from '@/ui/sheet';
import { Tag } from '@/ui/tag';
import './checkout-sheets.scss';

export interface AddressSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The address priced with now. */
  selectedId: string | null;
  onPick: (id: string) => void;
  /** 新增收货地址: open the address form (the sheet closes first). */
  onAdd: () => Promise<unknown>;
  /** 导入微信地址: WeChat's picker answered. */
  onImport: (chosen: ChosenAddress) => void | Promise<unknown>;
  importing?: boolean | undefined;
}

/**
 * 选择收货地址 at checkout: the address book as radios, 新增收货地址 (the address form, then back
 * here) and 导入微信地址 (`chooseAddress`, C04).
 */
export function AddressSheet({
  visible,
  onClose,
  selectedId,
  onPick,
  onAdd,
  onImport,
  importing,
}: AddressSheetProps) {
  const list = useRouteQuery('user.addressList', { query: { pageSize: 50 } }, { enabled: visible });
  const addresses = list.data?.items ?? [];
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="选择收货地址"
      height="tall"
      footer={
        <View className="checkout-sheet__actions">
          <Button
            variant="outline"
            block
            loading={importing}
            onClick={() => {
              return platform
                .chooseAddress()
                .then((chosen) => (chosen ? onImport(chosen) : undefined));
            }}
          >
            导入微信地址
          </Button>
          <Button
            block
            onClick={() => {
              onClose();
              return onAdd();
            }}
          >
            新增收货地址
          </Button>
        </View>
      }
    >
      <View className="checkout-sheet__list" id="address-sheet">
        {list.isPending ? (
          <CellSkeleton rows={2} />
        ) : list.isError ? (
          <ErrorBlock error={list.error} onRetry={() => list.refetch()} />
        ) : addresses.length === 0 ? (
          <Text className="checkout-sheet__empty">还没有收货地址</Text>
        ) : (
          addresses.map((address) => (
            <Radio
              key={address.id}
              label={`${address.receiverName}，${regionText(address)}${address.detail}`}
              checked={address.id === selectedId}
              onChange={() => onPick(address.id)}
              className="checkout-sheet__address"
            >
              <View className="checkout-sheet__address-body">
                <View className="checkout-sheet__address-who">
                  <Text className="checkout-sheet__address-name">{address.receiverName}</Text>
                  <Text className="checkout-sheet__address-phone">
                    {maskPhone(address.receiverPhone)}
                  </Text>
                  {address.isDefault ? <Tag tone="primary">默认</Tag> : null}
                </View>
                <Text className="checkout-sheet__address-text">
                  {regionText(address)} {address.detail}
                </Text>
              </View>
            </Radio>
          ))
        )}
      </View>
    </Sheet>
  );
}
