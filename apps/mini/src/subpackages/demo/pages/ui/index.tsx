import { useState } from 'react';
import { ScrollView, Text, View } from '@tarojs/components';
import { ApiError } from '@shop/api-client';
import { ActionBar } from '@/ui/action-bar';
import { AddressCard } from '@/ui/address-card';
import { AgreementCheck } from '@/ui/agreement-check';
import { AvatarPicker } from '@/ui/avatar-picker';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Cell, CellGroup } from '@/ui/cell';
import { Checkbox, Radio, Switch } from '@/ui/choice';
import { Countdown } from '@/ui/countdown';
import { CouponCard } from '@/ui/coupon-card';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { confirm, toast } from '@/ui/feedback';
import { Field, Textarea } from '@/ui/field';
import { ImageUploader } from '@/ui/image-uploader';
import { InfiniteList } from '@/ui/infinite-list';
import { OrderCard } from '@/ui/order-card';
import { PageShell } from '@/ui/page-shell';
import { Price } from '@/ui/price';
import { ProductCard } from '@/ui/product-card';
import { RegionPicker, type Region } from '@/ui/region-picker';
import { Result } from '@/ui/result';
import { SearchBar } from '@/ui/search-bar';
import { Sheet } from '@/ui/sheet';
import { CellSkeleton, ProductCardSkeleton } from '@/ui/skeleton';
import { SmsCodeField } from '@/ui/sms-code-field';
import { Stepper } from '@/ui/stepper';
import { Badge, Divider, Tag } from '@/ui/tag';
import { Tabs } from '@/ui/tabs';
import { countdownEnd, orders, presaleEnd, products, uploaded } from './fixtures';
import './index.scss';

type Tab = 'goods' | 'trade' | 'form' | 'feedback';

const TABS = [
  { key: 'goods', label: '商品' },
  { key: 'trade', label: '交易' },
  { key: 'form', label: '表单' },
  { key: 'feedback', label: '反馈' },
] as const;

const noop = () => undefined;

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <View className="gallery-section">
      <View className="gallery-section__head">
        <Text className="gallery-section__title">{title}</Text>
        {note ? <Text className="gallery-section__note">{note}</Text> : null}
      </View>
      {children}
    </View>
  );
}

const productList = {
  data: { pages: [{ items: products }] },
  isPending: false,
  isError: false,
  error: null,
  hasNextPage: false,
  isFetching: false,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  fetchNextPage: () => Promise.resolve(),
  refetch: () => Promise.resolve(),
};

function GoodsTab() {
  return (
    <>
      <Section title="限时活动" note="横滑卡片 · 倒计时">
        <View className="gallery-flash">
          <View className="gallery-flash__head">
            <Text className="gallery-flash__title">限时活动</Text>
            <Text className="gallery-flash__ends">距结束</Text>
            <Countdown endsAt={countdownEnd} variant="boxed" />
          </View>
          <ScrollView scrollX enhanced showScrollbar={false} className="gallery-flash__rail">
            <View className="gallery-flash__row">
              {products.slice(0, 5).map((product, index) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  layout="mini"
                  onClick={noop}
                  activityPrice={index === 0 ? '59.90' : undefined}
                  activity={index === 0 ? '拼团' : undefined}
                />
              ))}
            </View>
          </ScrollView>
        </View>
      </Section>

      <Section title="价格与标签">
        <Card>
          <View className="gallery-row">
            <Price value="199.00" size="lg" />
            <Price value="299.00" size="sm" strike />
            <Price value="89.5" prefix="券后" size="md" />
          </View>
          <View className="gallery-row">
            <Tag>包邮</Tag>
            <Tag tone="warning">预售</Tag>
            <Tag tone="success">已发货</Tag>
            <Tag tone="neutral" variant="outline">
              7 天无理由
            </Tag>
            <Tag variant="solid">拼团</Tag>
          </View>
          <View className="gallery-row gallery-badges">
            <Badge count={3}>
              <View className="gallery-icon-box">购物车</View>
            </Badge>
            <Badge count={128}>
              <View className="gallery-icon-box">消息</View>
            </Badge>
            <Badge>
              <View className="gallery-icon-box">客服</View>
            </Badge>
          </View>
        </Card>
      </Section>

      <Section title="列表样式" note="售罄 · 下架 · 活动">
        <View className="gallery-stack">
          <ProductCard
            product={products[3]!}
            layout="list"
            activity="拼团"
            activityPrice="29.90"
            onAddToCart={noop}
            onClick={noop}
          />
          <ProductCard product={products[2]!} layout="list" onAddToCart={noop} onClick={noop} />
          <ProductCard product={products[4]!} layout="list" unavailable onClick={noop} />
        </View>
      </Section>

      <Section title="猜你喜欢" note="双列网格 · 分页加载">
        <View className="gallery-pad">
          <InfiniteList
            query={productList}
            columns={2}
            active={false}
            itemKey={(product) => product.id}
            renderItem={(product) => (
              <ProductCard
                product={product}
                onAddToCart={() => toast.success('已加入购物车')}
                onClick={noop}
              />
            )}
            empty={<Empty title="暂无商品" />}
          />
        </View>
      </Section>
    </>
  );
}

function TradeTab() {
  const [coupon, setCoupon] = useState('c1');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Section title="收货地址">
        <View className="gallery-stack">
          <AddressCard
            address={{
              receiverName: '林小满',
              receiverPhone: '13800138000',
              provinceName: '浙江省',
              cityName: '杭州市',
              districtName: '西湖区',
              detail: '文三路 90 号 东部软件园 3 号楼 502',
              isDefault: true,
            }}
            onClick={noop}
          />
          <AddressCard address={null} onAdd={noop} onImport={noop} />
        </View>
      </Section>

      <Section title="优惠券" note="领取 · 选择 · 失效">
        <View className="gallery-stack">
          <CouponCard
            title="新人专享券"
            amount="20.00"
            minSpend="99.00"
            scope="all_products"
            validity="2026.09.01 - 2026.10.31"
            state="claimable"
            busy={busy}
            onAction={() => {
              setBusy(true);
              setTimeout(() => setBusy(false), 800);
            }}
          />
          <CouponCard
            title="坚果零食品类券"
            amount="5.00"
            minSpend="0.00"
            scope="categories"
            validity="领取后 7 天内有效"
            state="claimed"
            onAction={noop}
          />
          {(['c1', 'c2'] as const).map((id) => (
            <CouponCard
              key={id}
              title={id === 'c1' ? '满 100 减 15' : '满 200 减 40'}
              amount={id === 'c1' ? '15.00' : '40.00'}
              minSpend={id === 'c1' ? '100.00' : '200.00'}
              scope="all_products"
              validity="2026.09.30 前有效"
              state={id === 'c1' ? 'usable' : 'unusable'}
              reason={id === 'c2' ? '还差 ¥75.10 可用' : undefined}
              selected={coupon === id}
              onAction={() => setCoupon(id)}
            />
          ))}
          <CouponCard
            title="国庆满减券"
            amount="30.00"
            minSpend="199.00"
            scope="products"
            validity="2026.09.01 - 2026.09.10"
            state="expired"
          />
        </View>
      </Section>

      <Section title="我的订单">
        <View className="gallery-stack">
          {orders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              onClick={noop}
              onAction={(key) => toast.text(`点了「${key}」`)}
            />
          ))}
        </View>
      </Section>

      <Section title="结果页">
        <Card>
          <Result
            status="success"
            title="支付成功"
            description={
              <View className="gallery-row gallery-row--center">
                <Text>实付</Text>
                <Price value="114.90" tone="text" />
              </View>
            }
            actions={
              <>
                <Button block>查看订单</Button>
                <Button block variant="outline">
                  继续逛逛
                </Button>
              </>
            }
          />
        </Card>
      </Section>
    </>
  );
}

function FormTab() {
  const [name, setName] = useState('林小满');
  const [phone, setPhone] = useState('138');
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [quantity, setQuantity] = useState(2);
  const [all, setAll] = useState(false);
  const [pay, setPay] = useState<'wechat' | 'balance'>('wechat');
  const [notify, setNotify] = useState(true);
  const [agreed, setAgreed] = useState(false);
  const [region, setRegion] = useState<Region | null>(null);
  const [photos, setPhotos] = useState(uploaded);
  const [keyword, setKeyword] = useState('坚果');
  return (
    <>
      <Section title="按钮">
        <Card>
          <View className="gallery-buttons">
            <Button block size="lg">
              立即购买
            </Button>
            <View className="gallery-row">
              <Button variant="secondary">加入购物车</Button>
              <Button variant="soft">领券</Button>
              <Button variant="outline-primary">再次购买</Button>
            </View>
            <View className="gallery-row">
              <Button variant="outline" size="sm">
                查看物流
              </Button>
              <Button size="sm" loading>
                支付中
              </Button>
              <Button size="sm" disabled>
                已售罄
              </Button>
              <Button variant="text" size="sm">
                更多
              </Button>
              <Button variant="danger" size="sm">
                删除
              </Button>
            </View>
          </View>
        </Card>
      </Section>

      <Section title="搜索">
        <Card padded={false}>
          <SearchBar
            value={keyword}
            onChange={setKeyword}
            onSearch={(value) => toast.text(`搜索「${value}」`)}
          />
        </Card>
      </Section>

      <Section title="收货信息" note="输入框 · 地区 · 验证码">
        <CellGroup>
          <Field label="收货人" required value={name} onChange={setName} placeholder="请输入姓名" />
          <SmsCodeField
            phone={phone}
            onPhoneChange={setPhone}
            code={code}
            onCodeChange={setCode}
            onSend={() => Promise.resolve(60)}
          />
          <RegionPicker value={region} onChange={setRegion} required />
          <Cell
            title="设为默认地址"
            value={<Switch checked={notify} onChange={setNotify} label="设为默认地址" />}
          />
        </CellGroup>
      </Section>

      <Section title="数量与选择">
        <CellGroup>
          <Cell
            title="购买数量"
            description="限购 5 件"
            value={<Stepper value={quantity} onChange={setQuantity} max={5} />}
          />
          <Cell title="支付方式" />
          <View className="gallery-choices">
            <Radio checked={pay === 'wechat'} onChange={() => setPay('wechat')} label="微信支付" />
            <Radio
              checked={pay === 'balance'}
              onChange={() => setPay('balance')}
              label="余额支付"
              disabled
            />
          </View>
          <View className="gallery-choices">
            <Checkbox checked={all} onChange={setAll} indeterminate={!all} label="全选" />
          </View>
        </CellGroup>
      </Section>

      <Section title="评价" note="文本 · 图片上传 · 头像">
        <Card>
          <Textarea
            label="评价内容"
            value={note}
            onChange={setNote}
            placeholder="说说这件商品哪里好，帮助更多人选择"
            maxLength={500}
          />
          <View className="gallery-gap" />
          <ImageUploader value={photos} onChange={setPhotos} max={9} purpose="review" />
          <View className="gallery-gap" />
          <View className="gallery-row">
            <AvatarPicker src={null} size="md" />
            <Text className="gallery-muted">点击头像，用微信头像</Text>
          </View>
        </Card>
      </Section>

      <Section title="协议">
        <Card>
          <AgreementCheck checked={agreed} onChange={setAgreed} />
        </Card>
      </Section>
    </>
  );
}

function FeedbackTab() {
  const [sheet, setSheet] = useState(false);
  return (
    <>
      <Section title="弹层与提示">
        <Card>
          <View className="gallery-row">
            <Button size="sm" variant="outline" onClick={() => setSheet(true)}>
              底部弹层
            </Button>
            <Button size="sm" variant="outline" onClick={() => toast.success('已加入购物车')}>
              轻提示
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                confirm({
                  title: '删除订单',
                  content: '删除后将无法恢复',
                  confirmText: '删除',
                  danger: true,
                })
              }
            >
              确认框
            </Button>
          </View>
        </Card>
      </Section>

      <Section title="预售倒计时">
        <Card>
          <View className="gallery-row">
            <Text className="gallery-muted">尾款开始</Text>
            <Countdown endsAt={presaleEnd} format="dhms" variant="boxed" />
          </View>
        </Card>
      </Section>

      <Section title="空状态">
        <Card>
          <Empty
            image="cart"
            title="购物车还是空的"
            description="去挑几件喜欢的吧"
            actions={
              <Button size="sm" variant="outline-primary">
                去逛逛
              </Button>
            }
            compact
          />
        </Card>
      </Section>

      <Section title="出错了">
        <Card>
          <ErrorBlock
            error={new ApiError({ status: 0, code: 'NETWORK', message: '网络连接失败' })}
            onRetry={noop}
            compact
          />
        </Card>
      </Section>

      <Section title="处理中">
        <Card>
          <Result
            status="pending"
            title="支付确认中"
            description="微信正在确认这笔付款，通常几秒内完成"
          />
        </Card>
      </Section>

      <Section title="骨架屏">
        <View className="gallery-grid">
          <ProductCardSkeleton />
          <ProductCardSkeleton />
        </View>
        <View className="gallery-gap" />
        <Card padded={false}>
          <CellSkeleton rows={3} />
        </Card>
      </Section>

      <Divider>没有更多了</Divider>

      <Sheet
        visible={sheet}
        onClose={() => setSheet(false)}
        title="选择规格"
        footer={
          <Button block size="lg" onClick={() => setSheet(false)}>
            确定
          </Button>
        }
      >
        <View className="gallery-row">
          <Price value="79.90" size="lg" />
          <Text className="gallery-muted">库存 320 件</Text>
        </View>
        <View className="gallery-gap" />
        <View className="gallery-row">
          <Tag size="md" variant="outline">
            混合装 750g
          </Tag>
          <Tag size="md" tone="neutral" variant="outline">
            原味 500g
          </Tag>
        </View>
      </Sheet>
    </>
  );
}

/** The UI kit gallery (dev and H5 builds only): every component, on made-up shop data. */
export default function UiGallery() {
  const [tab, setTab] = useState<Tab>('goods');
  return (
    <PageShell title="组件示例" withBar>
      <View className="gallery-hero">
        <View className="gallery-hero__glow" />
        <Text className="gallery-hero__eyebrow">SHOP UI KIT</Text>
        <Text className="gallery-hero__title">小满良品</Text>
        <Text className="gallery-hero__lead">商城小程序的界面组件，一页看全</Text>
        <SearchBar
          onOpen={noop}
          onColor
          placeholder="搜索坚果、咖啡、蜂蜜"
          className="gallery-hero__search"
        />
      </View>
      <Tabs items={TABS} value={tab} onChange={setTab} sticky />
      <View className="gallery-body">
        {tab === 'goods' ? <GoodsTab /> : null}
        {tab === 'trade' ? <TradeTab /> : null}
        {tab === 'form' ? <FormTab /> : null}
        {tab === 'feedback' ? <FeedbackTab /> : null}
      </View>
      <ActionBar
        icons={[
          { icon: 'service', label: '客服', contact: { sessionFrom: 'route:gallery' } },
          { icon: 'cart', label: '购物车', badge: 3, onClick: noop },
          { icon: 'heart-fill', label: '已收藏', active: true, onClick: noop },
        ]}
      >
        <Button variant="secondary" onClick={() => toast.success('已加入购物车')}>
          加入购物车
        </Button>
        <Button>立即购买</Button>
      </ActionBar>
    </PageShell>
  );
}
