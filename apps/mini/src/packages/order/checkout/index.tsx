import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDidShow } from '@tarojs/taro';
import { Text, View } from '@tarojs/components';
import { isApiError } from '@shop/api-client';
import { routeKey, useRouteMutation, useRouteQuery } from '@shop/api-client/react';
import { AddressSheet } from '@/features/checkout/address-sheet';
import {
  checkoutPrices,
  checkoutRefusal,
  couponLinesOf,
  customFormBody,
  customFormProblem,
  freightText,
  receiverCard,
  resolveCoupon,
  type CouponChoice,
  type CustomAnswers,
} from '@/features/checkout/checkout-view';
import { CouponSheet } from '@/features/checkout/coupon-sheet';
import { CustomForm } from '@/features/checkout/custom-form';
import {
  checkoutBody,
  newIdempotencyKey,
  subscribeSceneOf,
  useCheckoutDraft,
  type CheckoutDraft,
} from '@/features/checkout/draft';
import { useCityTree } from '@/data/cities';
import { ADDRESS_READS, COUPON_READS, DECOR_PAGE_READS, markStale } from '@/data/stale-reads';
import { useRefetchOnShow } from '@/data/use-refetch-on-show';
import { errorMessage } from '@/lib/error-message';
import { formatSpec } from '@/lib/spec';
import {
  addressBody,
  checkAddress,
  awaitNewAddress,
  draftFromChosen,
  handOffImportedAddress,
  takeNewAddress,
} from '@/packages/account/shared/address';
import { goBack, navigate, subscribe, type ChosenAddress } from '@/platform';
import { LoginCard } from '@/session/login-card';
import { AddressCard } from '@/ui/address-card';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Cell } from '@/ui/cell';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { toast } from '@/ui/feedback';
import { Textarea } from '@/ui/field';
import { Image } from '@/ui/image';
import { PageShell } from '@/ui/page-shell';
import { Price } from '@/ui/price';
import { CellSkeleton, Skeleton } from '@/ui/skeleton';
import './index.scss';

/**
 * 确认订单 (`checkout`, pages.md §2.3; not linkable: the draft is in memory). The address
 * (the default, the address book, 导入微信地址), the lines, the coupon (the best usable one
 * unless the shopper picks another or none), the remark and the product's custom form; the
 * presale ship time; 提交订单 asks for the subscribe messages in the tap (C08), then
 * `order.create` with the amount shown, then the cashier.
 */
export default function CheckoutPage() {
  const draft = useCheckoutDraft((state) => state.draft);
  if (!draft) {
    return (
      <PageShell title="确认订单">
        <Empty
          image="cart"
          title="没有待结算的商品"
          description="订单可能已经提交，或者结算信息已失效"
          actions={
            <Button
              size="md"
              variant="outline"
              onClick={() => navigate({ route: 'home', params: {} })}
            >
              回到首页
            </Button>
          }
        />
      </PageShell>
    );
  }
  return (
    <PageShell title="确认订单" withBar>
      {/* 登录 comes back here: the draft is still in memory. */}
      <LoginCard reason="登录后即可结算" redirect={{ route: 'checkout', params: {} }}>
        <Checkout draft={draft} />
      </LoginCard>
    </PageShell>
  );
}

/** The presale ship time, from the preview (`shipAfterDays`, H4; `null` from an older server). */
function presaleNote(shipAfterDays: number | null): string {
  if (shipAfterDays === null) return '预售商品：发货时间以活动说明为准';
  return shipAfterDays > 0
    ? `预售商品：付款后 ${shipAfterDays} 天内发货`
    : '预售商品：付款后尽快发货';
}

function Checkout({ draft }: { draft: CheckoutDraft }) {
  const queryClient = useQueryClient();
  const setDraft = useCheckoutDraft((state) => state.setDraft);
  const [addressId, setAddressId] = useState<string | undefined>(undefined);
  const [choice, setChoice] = useState<CouponChoice>({ mode: 'auto' });
  const [remark, setRemark] = useState('');
  const [answers, setAnswers] = useState<CustomAnswers>({});
  const [sheet, setSheet] = useState<'address' | 'coupon' | null>(null);
  const [idempotencyKey] = useState(newIdempotencyKey);

  // 1. Priced without a coupon: the lines the coupon list is asked about.
  const base = useRouteQuery('order.checkoutPreview', {
    body: checkoutBody(draft, { addressId }),
  });
  useRefetchOnShow(routeKey('order.checkoutPreview'));
  const lines = base.data ? couponLinesOf(base.data) : null;
  // 2. The shopper's coupons for those lines.
  const coupons = useRouteQuery(
    'coupon.applicableList',
    { body: { lines: lines ?? [] } },
    { enabled: lines !== null },
  );
  const couponId = resolveCoupon(choice, coupons.data);
  // 3. Priced with the coupon, when there is one.
  const priced = useRouteQuery(
    'order.checkoutPreview',
    { body: checkoutBody(draft, { addressId, userCouponId: couponId }) },
    { enabled: couponId !== null && base.isSuccess },
  );
  const withCoupon = couponId !== null && priced.isSuccess;
  const preview = withCoupon ? priced.data : base.data;
  const settling = (lines !== null && coupons.isPending) || (couponId !== null && priced.isPending);

  const cities = useCityTree(sheet === 'address');

  const addAddress = useRouteMutation('user.addressCreate', { invalidate: ADDRESS_READS });
  const create = useRouteMutation('order.create', {
    // The coupon now sits on the order: out of the wallet's 可使用, and no longer usable in the
    // cart's hint or on another 确认订单.
    // A 拼团 or 预售 order changes its activity page too: the shopper's own open team (查看我的团
    // instead of 发起拼团), the team's seats, the units left.
    invalidate: [
      'cart.list',
      'cart.count',
      'order.list',
      'order.counts',
      'groupbuy.detail',
      'groupbuy.groupDetail',
      'groupbuy.myGroups',
      'presale.detail',
      ...COUPON_READS,
    ],
    // 待付款 on the decorated pages' 订单入口, the coupon's state on their 优惠券 blocks.
    onSuccess: () => markStale(queryClient, ...DECOR_PAGE_READS),
  });

  // 导入微信地址, as 我的地址 does it: the city tree turns WeChat's names into the ids freight is
  // priced on. Here the tree loads only with the sheet, so an import from the card fetches it
  // first; an address it cannot resolve is finished in the form, not saved without its ids.
  const importChosen = async (chosen: ChosenAddress) => {
    const tree = cities.data ?? (await cities.refetch()).data;
    const imported = draftFromChosen(chosen, tree?.items ?? []);
    const { region } = imported;
    if (!region || Object.keys(checkAddress(imported)).length > 0) {
      handOffImportedAddress(imported);
      setSheet(null);
      await addNewAddress();
      return;
    }
    await addAddress.mutateAsync({ body: addressBody({ ...imported, region }) }).then(
      (address) => {
        setAddressId(address.id);
        setSheet(null);
        toast.success('已导入微信地址');
      },
      (error: unknown) => toast.text(errorMessage(error)),
    );
  };
  const importAddress = (chosen: ChosenAddress) => importChosen(chosen);
  // The address form, then back here with the new address picked, not the default one.
  const addNewAddress = () => {
    awaitNewAddress();
    return navigate({ route: 'addressEdit', params: {} });
  };
  useDidShow(() => {
    const added = takeNewAddress();
    if (added) setAddressId(added);
  });

  if (base.isPending) {
    return (
      <View className="checkout" id="checkout-loading">
        <Skeleton className="checkout__address-skeleton" />
        <CellSkeleton rows={3} />
      </View>
    );
  }
  const addressSheet = (selectedId: string | null) => (
    <AddressSheet
      visible={sheet === 'address'}
      onClose={() => setSheet(null)}
      selectedId={selectedId}
      importing={addAddress.isPending}
      onPick={(id) => {
        setAddressId(id);
        setSheet(null);
      }}
      onAdd={addNewAddress}
      onImport={importAddress}
    />
  );

  if (base.isError) {
    // Widened: SHIPPING_NOT_DELIVERABLE is thrown by the freight quote, not yet in the contract.
    const code: string | null = isApiError(base.error) ? base.error.code : null;
    if (code === 'ORDER_ADDRESS_NOT_FOUND') {
      return (
        <Empty
          title="收货地址已失效"
          description="请重新选择收货地址"
          actions={
            <Button size="md" onClick={() => setAddressId(undefined)}>
              使用默认地址
            </Button>
          }
        />
      );
    }
    if (code === 'SHIPPING_NOT_DELIVERABLE') {
      // The address stays on the page, marked, and can be changed right here.
      return (
        <View className="checkout">
          <UndeliverableAddress
            addressId={addressId}
            reason={errorMessage(base.error, '该地址暂不支持配送')}
            onChange={() => setSheet('address')}
          />
          {addressSheet(addressId ?? null)}
        </View>
      );
    }
    const refusal = checkoutRefusal(base.error, draft);
    if (refusal) {
      return (
        <Empty
          title={refusal.title}
          description={refusal.description}
          actions={
            draft.source === 'cart' ? (
              <Button size="md" onClick={() => leaveCheckout({ route: 'cart', params: {} })}>
                返回购物车
              </Button>
            ) : (
              <Button size="md" variant="outline" onClick={() => leaveCheckout(null)}>
                返回
              </Button>
            )
          }
        />
      );
    }
    return <ErrorBlock error={base.error} onRetry={() => base.refetch()} />;
  }
  if (!preview) return null;

  const fields = preview.customFormFields ?? [];
  const receiver = preview.receiver;
  const couponRows = coupons.data?.items ?? [];
  const usableCount = couponRows.filter((row) => row.usable).length;
  const prices = checkoutPrices(preview);
  const couponValue = withCoupon
    ? `-¥${prices.couponDiscount}`
    : choice.mode === 'none' && usableCount > 0
      ? '不使用'
      : usableCount > 0
        ? `${usableCount} 张可用`
        : '无可用';

  const submit = () => {
    if (settling || create.isPending) return;
    if (preview.addressRequired && !receiver) {
      toast.text('请先添加收货地址');
      setSheet('address');
      return;
    }
    const problem = customFormProblem(fields, answers);
    if (problem) {
      toast.text(problem);
      return;
    }
    // In the tap, before anything is awaited (C08).
    const asked = subscribe(subscribeSceneOf(draft));
    const customForm = customFormBody(fields, answers);
    return create
      .mutateAsync({
        body: {
          ...checkoutBody(draft, {
            addressId: receiver?.addressId ?? addressId,
            userCouponId: withCoupon ? couponId : null,
          }),
          idempotencyKey,
          expectedPayableAmount: preview.payableAmount,
          ...(remark.trim() ? { buyerRemark: remark.trim() } : {}),
          ...(customForm ? { customForm } : {}),
        },
      })
      .then(
        async (order) => {
          await asked;
          await navigate(
            order.status === 'pending_payment'
              ? { route: 'cashier', params: { orderId: order.id } }
              : { route: 'order', params: { id: order.id } },
            { replace: true },
          );
          setDraft(null);
        },
        (error: unknown) => {
          if (isApiError(error) && error.code === 'ORDER_PRICE_CHANGED') {
            toast.text('商品价格有变动，请确认后重新提交');
            void base.refetch();
            if (couponId !== null) void priced.refetch();
            return;
          }
          if (isApiError(error) && error.code.startsWith('COUPON_')) {
            // Used on another order, expired, or no longer fits: drop it, so the next tap is
            // not the same refusal, and ask again which coupons are usable.
            toast.text('优惠券已不可用，已为你取消使用，请确认金额后重新提交');
            setChoice({ mode: 'none' });
            void coupons.refetch();
            void base.refetch();
            return;
          }
          const refusal = checkoutRefusal(error, draft);
          if (refusal) {
            toast.text(refusal.title);
            void base.refetch();
            return;
          }
          toast.text(errorMessage(error));
        },
      );
  };

  return (
    <View className="checkout">
      {preview.addressRequired ? (
        <AddressCard
          className="checkout__address"
          address={receiver ? receiverCard(receiver) : null}
          onClick={() => setSheet('address')}
          onAdd={() => setSheet('address')}
          onImport={importAddress}
        />
      ) : (
        <Text className="checkout__virtual">虚拟商品无需收货地址，购买后在订单详情查看</Text>
      )}

      <Card className="checkout__card" id="checkout-lines">
        {draft.kind === 'presale' ? (
          <Text className="checkout__kind-note" id="checkout-presale-note">
            {presaleNote(preview.shipAfterDays)}
          </Text>
        ) : draft.kind === 'groupbuy' ? (
          <Text className="checkout__kind-note">拼团商品：支付后邀请好友参团，成团后发货</Text>
        ) : null}
        {preview.lines.map((line) => (
          <View key={line.itemKey} className="checkout__line">
            <View className="checkout__line-image">
              <Image
                src={line.skuImageUrl ?? line.productImageUrl}
                ratio={1}
                radius="sm"
                size="small"
              />
            </View>
            <View className="checkout__line-body">
              <Text className="checkout__line-name">{line.productName}</Text>
              {line.specText ? (
                <Text className="checkout__line-spec">{formatSpec(line.specText)}</Text>
              ) : null}
              <View className="checkout__line-foot">
                <Price value={prices.unitPrices[line.itemKey] ?? line.unitPrice} size="sm" />
                <Text className="checkout__line-qty">×{line.quantity}</Text>
              </View>
            </View>
          </View>
        ))}
      </Card>

      <Card className="checkout__card" padded={false}>
        <Cell title="商品金额" value={<Price value={prices.itemsAmount} size="sm" tone="text" />} />
        <Cell title="运费" value={freightText(preview)} />
        {prices.otherAdjustments.map((adjustment) => (
          <Cell
            key={`${adjustment.source}-${adjustment.label}`}
            title={adjustment.label}
            value={`${adjustment.amount.startsWith('-') ? '-¥' : '¥'}${adjustment.amount.replace(/^-/, '')}`}
          />
        ))}
        <Cell
          title="优惠券"
          label={`优惠券，${couponValue}`}
          value={
            <Text
              className={withCoupon ? 'checkout__coupon checkout__coupon--on' : 'checkout__coupon'}
            >
              {couponValue}
            </Text>
          }
          onClick={couponRows.length > 0 ? () => setSheet('coupon') : undefined}
        />
        <Cell title="发票" value="支付后可在订单详情申请" />
      </Card>

      {fields.length > 0 ? (
        <Card className="checkout__card" title="购买信息">
          <CustomForm
            fields={fields}
            answers={answers}
            onChange={(key, answer) => setAnswers((now) => ({ ...now, [key]: answer }))}
          />
        </Card>
      ) : null}

      <Card className="checkout__card" title="订单备注">
        <Textarea
          label="订单备注"
          value={remark}
          maxLength={200}
          placeholder="选填，可以告诉商家你的特殊要求"
          onChange={setRemark}
        />
      </Card>

      <Text className="checkout__privacy">所有商品均为隐私包装发货，外包装不显示商品信息</Text>

      <View className="checkout__bar" id="checkout-bar">
        <View className="checkout__total">
          <Text className="checkout__total-label">共 {preview.totalQuantity} 件，合计</Text>
          <Price value={preview.payableAmount} />
          {withCoupon && prices.couponDiscount !== '0.00' ? (
            <Text className="checkout__saved">已优惠 ¥{prices.couponDiscount}</Text>
          ) : null}
        </View>
        <Button
          size="md"
          id="checkout-submit"
          loading={create.isPending}
          disabled={settling}
          onClick={() => submit()}
        >
          提交订单
        </Button>
      </View>

      {addressSheet(receiver?.addressId ?? null)}
      <CouponSheet
        visible={sheet === 'coupon'}
        onClose={() => setSheet(null)}
        coupons={coupons.data}
        selectedId={withCoupon ? couponId : null}
        onPick={(id) => {
          setChoice(id === null ? { mode: 'none' } : { mode: 'picked', id });
          setSheet(null);
        }}
      />
    </View>
  );
}

/** Leaves 确认订单 for the cart (a tab), or back to where the purchase started. */
async function leaveCheckout(target: { route: 'cart'; params: Record<string, never> } | null) {
  if (target) await navigate(target);
  else await goBack();
}

/**
 * The address the preview could not deliver to, still on the page with the server's reason,
 * so the shopper changes it here instead of meeting a dead end (加载失败).
 */
function UndeliverableAddress({
  addressId,
  reason,
  onChange,
}: {
  addressId: string | undefined;
  reason: string;
  onChange: () => void;
}) {
  const list = useRouteQuery('user.addressList', { query: { pageSize: 50 } });
  const items = list.data?.items ?? [];
  const address =
    items.find((row) => row.id === addressId) ?? items.find((row) => row.isDefault) ?? null;
  return (
    <>
      {address ? (
        <AddressCard
          className="checkout__address"
          address={address}
          undeliverable={reason}
          onClick={onChange}
        />
      ) : null}
      <Empty
        title="该地址暂不支持配送"
        description={address ? '请更换收货地址后继续结算' : reason}
        actions={
          <Button size="md" onClick={onChange}>
            更换收货地址
          </Button>
        }
      />
    </>
  );
}
