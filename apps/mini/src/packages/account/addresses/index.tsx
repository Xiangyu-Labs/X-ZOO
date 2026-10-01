import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import { useInfiniteRouteQuery, useRouteMutation } from '@shop/api-client/react';
import { useCityTree } from '@/data/cities';
import { ADDRESS_READS } from '@/data/stale-reads';
import { maskPhone } from '@/lib/format';
import { navigate, platform } from '@/platform';
import { LoginGate } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { regionText } from '@/ui/address-card';
import { Button } from '@/ui/button';
import { Radio } from '@/ui/choice';
import { Empty } from '@/ui/empty';
import { confirm, toast } from '@/ui/feedback';
import { Icon } from '@/ui/icon';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { Pressable } from '@/ui/pressable';
import { CellSkeleton } from '@/ui/skeleton';
import { Tag } from '@/ui/tag';
import {
  addressBody,
  checkAddress,
  draftFromChosen,
  handOffImportedAddress,
  type UserAddress,
} from '../shared/address';
import { SubmitBar, errorMessage } from '../shared/form';
import './index.scss';

/**
 * 收货地址 (`addresses`, pages.md §2.6). 导入微信地址 at the top (C04; a refusal still leaves
 * 新增). 确认订单 picks its address in its own sheet (`features/checkout/address-sheet`), so
 * the route's `select` parameter is not used here.
 */
export default function AddressesPage() {
  return (
    <PageShell title="收货地址" withBar>
      <LoginGate reason="登录后可以管理收货地址" redirect={{ route: 'addresses', params: {} }}>
        <AddressBook />
      </LoginGate>
    </PageShell>
  );
}

function AddressBook() {
  const signedIn = useSignedIn();
  const list = useInfiniteRouteQuery(
    'user.addressList',
    { query: { pageSize: 20 } },
    { enabled: signedIn },
  );
  const tree = useCityTree();
  const create = useRouteMutation('user.addressCreate', { invalidate: ADDRESS_READS });
  const remove = useRouteMutation('user.addressDelete', { invalidate: ADDRESS_READS });
  const setDefault = useRouteMutation('user.addressSetDefault', { invalidate: ADDRESS_READS });
  const [importing, setImporting] = useState(false);

  async function importWechat() {
    const chosen = await platform.chooseAddress().catch(() => null);
    if (!chosen) return;
    const draft = draftFromChosen(chosen, tree.data?.items ?? []);
    if (Object.keys(checkAddress(draft)).length > 0 || !draft.region) {
      // The region did not resolve (or a field is off): finish it in the form.
      handOffImportedAddress(draft);
      void navigate({ route: 'addressEdit', params: {} });
      return;
    }
    setImporting(true);
    try {
      await create.mutateAsync({ body: addressBody({ ...draft, region: draft.region }) });
      toast.success('已导入微信地址');
    } catch (error) {
      toast.text(errorMessage(error));
    } finally {
      setImporting(false);
    }
  }

  async function del(address: UserAddress) {
    const ok = await confirm({
      title: '删除地址',
      content: `删除 ${address.receiverName} 的地址？`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync({ params: { id: address.id } });
      toast.success('已删除');
    } catch (error) {
      toast.text(errorMessage(error));
    }
  }

  return (
    <View className="account-page">
      <Pressable
        label="导入微信地址"
        className="addresses__import"
        disabled={importing}
        onClick={() => importWechat()}
      >
        <Icon name="download" />
        <Text className="addresses__import-text">导入微信地址</Text>
        <Icon name="chevron-right" className="addresses__import-arrow" />
      </Pressable>
      <InfiniteList
        query={list}
        itemKey={(address) => address.id}
        skeleton={<CellSkeleton rows={4} />}
        empty={
          <Empty image="general" title="还没有收货地址" description="新增一个，或从微信导入" />
        }
        renderItem={(address) => (
          <View className="address-item">
            <Pressable
              label={`${address.receiverName}，${regionText(address)}${address.detail}，编辑`}
              className="address-item__main"
              onClick={() => navigate({ route: 'addressEdit', params: { id: address.id } })}
            >
              <View className="address-item__who">
                <Text className="address-item__name">{address.receiverName}</Text>
                <Text className="address-item__phone">{maskPhone(address.receiverPhone)}</Text>
                {address.isDefault ? <Tag tone="primary">默认</Tag> : null}
              </View>
              <Text className="address-item__detail">
                {regionText(address)} {address.detail}
              </Text>
            </Pressable>
            <View className="address-item__actions">
              <Radio
                label={address.isDefault ? '默认地址' : '设为默认'}
                checked={address.isDefault}
                onChange={() =>
                  address.isDefault
                    ? undefined
                    : setDefault
                        .mutateAsync({ params: { id: address.id }, body: {} })
                        .catch((error: unknown) => toast.text(errorMessage(error)))
                }
              />
              <View className="address-item__buttons">
                <Button
                  variant="text"
                  size="sm"
                  label={`编辑 ${address.receiverName} 的地址`}
                  onClick={() => navigate({ route: 'addressEdit', params: { id: address.id } })}
                >
                  编辑
                </Button>
                <Button
                  variant="text"
                  size="sm"
                  label={`删除 ${address.receiverName} 的地址`}
                  onClick={() => del(address)}
                >
                  删除
                </Button>
              </View>
            </View>
          </View>
        )}
      />
      <SubmitBar>
        <Button size="lg" block onClick={() => navigate({ route: 'addressEdit', params: {} })}>
          新增收货地址
        </Button>
      </SubmitBar>
    </View>
  );
}
