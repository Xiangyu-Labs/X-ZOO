import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import { isApiError } from '@shop/api-client';
import { useRouteMutation, useRouteQuery } from '@shop/api-client/react';
import { useCityTree } from '@/data/cities';
import { ADDRESS_READS } from '@/data/stale-reads';
import { goBack, platform, useRouteParams } from '@/platform';
import { LoginGate } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Cell, CellGroup } from '@/ui/cell';
import { Switch } from '@/ui/choice';
import { ErrorBlock } from '@/ui/error-block';
import { toast } from '@/ui/feedback';
import { Field } from '@/ui/field';
import { Icon } from '@/ui/icon';
import { PageShell } from '@/ui/page-shell';
import { RegionPicker } from '@/ui/region-picker';
import { CellSkeleton } from '@/ui/skeleton';
import {
  ADDRESS_FIELDS,
  EMPTY_DRAFT,
  addressBody,
  checkAddress,
  draftFromAddress,
  draftFromChosen,
  handBackNewAddress,
  takeImportedAddress,
  type AddressDraft,
  type AddressErrors,
} from '../shared/address';
import { SubmitBar, errorMessage, firstError } from '../shared/form';
import './index.scss';

/**
 * 新增 / 编辑地址 (`addressEdit { id? }`, pages.md §2.6): 收货人, 手机号, 所在地区 (the
 * `shipping.cityTree` picker, whose ids freight is priced on), 详细地址, 默认. 导入微信地址
 * (`chooseAddress`, C04) fills the form for checking; a refusal leaves it for typing.
 */
export default function AddressEditPage() {
  const { id } = useRouteParams('addressEdit');
  return (
    <PageShell title={id ? '编辑地址' : '新增地址'} withBar>
      <LoginGate
        reason="登录后可以管理收货地址"
        redirect={{ route: 'addressEdit', params: id ? { id } : {} }}
      >
        {id ? <ExistingAddress id={id} /> : <AddressForm initial={null} />}
      </LoginGate>
    </PageShell>
  );
}

function ExistingAddress({ id }: { id: string }) {
  const signedIn = useSignedIn();
  const address = useRouteQuery('user.addressDetail', { params: { id } }, { enabled: signedIn });
  if (address.isPending) return <CellSkeleton rows={5} />;
  if (address.isError) {
    return <ErrorBlock error={address.error} onRetry={() => address.refetch()} />;
  }
  return <AddressForm id={id} initial={draftFromAddress(address.data)} />;
}

function AddressForm({ id, initial }: { id?: string; initial: AddressDraft | null }) {
  const [draft, setDraft] = useState<AddressDraft>(() => {
    if (initial) return initial;
    // An import the list could not save as it was: finish it here.
    return takeImportedAddress() ?? EMPTY_DRAFT;
  });
  const [errors, setErrors] = useState<AddressErrors>(() =>
    draft.region || !draft.detail ? {} : { region: '请选择所在地区' },
  );
  // Cleared on blur: a second failed save on the same field must change it to focus again.
  const [focus, setFocus] = useState<keyof AddressErrors | null>(null);
  const blurred = () => setFocus(null);
  const tree = useCityTree();
  // The default stays the default until another address takes over (USER-020): its switch
  // cannot be turned off here, and says so, rather than seeming to save a change it never makes.
  const keepsDefault = id !== undefined && initial?.isDefault === true;
  const create = useRouteMutation('user.addressCreate', { invalidate: ADDRESS_READS });
  const update = useRouteMutation('user.addressUpdate', { invalidate: ADDRESS_READS });

  const change = <K extends keyof AddressDraft>(key: K, value: AddressDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (key !== 'postCode' && key !== 'isDefault') {
      const field = key as keyof AddressErrors;
      setErrors((current) => ({ ...current, [field]: undefined }));
    }
  };

  async function importWechat() {
    const chosen = await platform.chooseAddress().catch(() => null);
    if (!chosen) return;
    const next = draftFromChosen(chosen, tree.data?.items ?? []);
    setDraft({ ...next, isDefault: draft.isDefault });
    setErrors(next.region ? {} : { region: '请选择所在地区' });
  }

  async function submit() {
    const found = checkAddress(draft);
    setErrors(found);
    const first = firstError(found, ADDRESS_FIELDS);
    if (first || !draft.region) {
      setFocus(first);
      toast.text(found[first ?? 'region'] ?? '请检查填写的内容');
      return;
    }
    const body = addressBody({ ...draft, region: draft.region });
    try {
      if (id) await update.mutateAsync({ params: { id }, body });
      else handBackNewAddress((await create.mutateAsync({ body })).id);
    } catch (error) {
      const fields = isApiError(error) ? error.fieldErrors : null;
      if (fields) {
        setErrors({
          receiverName: fields['receiverName'],
          receiverPhone: fields['receiverPhone'],
          detail: fields['detail'],
          region: fields['provinceName'] ?? fields['cityName'] ?? fields['cityId'],
        });
      }
      toast.text(errorMessage(error));
      return;
    }
    toast.success('已保存');
    void goBack();
  }

  return (
    <View className="account-page">
      <CellGroup>
        <Cell
          title={
            <View className="address-edit__import">
              <Icon name="download" />
              <Text>导入微信地址</Text>
            </View>
          }
          label="导入微信地址"
          onClick={() => importWechat()}
        />
      </CellGroup>
      <CellGroup>
        <Field
          label="收货人"
          placeholder="姓名"
          value={draft.receiverName}
          maxLength={32}
          error={errors.receiverName}
          focus={focus === 'receiverName'}
          onBlur={blurred}
          onChange={(value) => change('receiverName', value)}
        />
        <Field
          label="手机号"
          type="tel"
          placeholder="收货人手机号"
          value={draft.receiverPhone}
          error={errors.receiverPhone}
          focus={focus === 'receiverPhone'}
          onBlur={blurred}
          onChange={(value) => change('receiverPhone', value)}
        />
        <RegionPicker
          value={draft.region}
          required
          error={errors.region}
          onChange={(region) => change('region', region)}
        />
        <Field
          label="详细地址"
          placeholder="街道、楼牌号等"
          value={draft.detail}
          maxLength={255}
          error={errors.detail}
          focus={focus === 'detail'}
          onBlur={blurred}
          onChange={(value) => change('detail', value)}
        />
      </CellGroup>
      <CellGroup>
        <Cell
          title="设为默认地址"
          description={keepsDefault ? '这是默认地址；要换默认，请把其他地址设为默认' : undefined}
          value={
            <Switch
              label="设为默认地址"
              checked={keepsDefault || draft.isDefault}
              disabled={keepsDefault}
              onChange={(checked) => change('isDefault', checked)}
            />
          }
        />
      </CellGroup>
      <SubmitBar>
        <Button size="lg" block loading={create.isPending || update.isPending} onClick={submit}>
          保存
        </Button>
      </SubmitBar>
    </View>
  );
}
