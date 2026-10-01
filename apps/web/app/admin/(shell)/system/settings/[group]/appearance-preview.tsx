'use client';

import {
  AppstoreOutlined,
  HomeOutlined,
  SearchOutlined,
  ShoppingCartOutlined,
  StarFilled,
  UserOutlined,
} from '@ant-design/icons';
import { Alert, Card, Segmented, Space, Typography } from 'antd';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { appAppearanceDefaults, type RadiusScale } from '@shop/contracts/system/app.schemas';
import { deriveTheme, RADIUS_FACTOR } from '@shop/contracts/system/theme';

import type { ConfigValues } from '@/admin/kit/config/types';

/**
 * 小程序外观 → the phone on the right.
 *
 * Colours go through the mini-program's own `deriveTheme`, not straight onto
 * the mock, so the preview shows what a shopper will see: a price colour too
 * light to read on white is darkened there, and here, and the note under the
 * phone says so. Radii are the mini-program's tokens at 375 px (half the rpx
 * design size) times `RADIUS_FACTOR`; buttons and tags stay pill-shaped, as
 * they do in the app.
 */

type View = 'home' | 'product' | 'category';

const TABS = [
  { key: 'Home', fallback: '首页', icon: <HomeOutlined /> },
  { key: 'Category', fallback: '分类', icon: <AppstoreOutlined /> },
  { key: 'Cart', fallback: '购物车', icon: <ShoppingCartOutlined /> },
  { key: 'Me', fallback: '我的', icon: <UserOutlined /> },
] as const;

const TAB_FOR_VIEW: Record<View, number> = { home: 0, category: 1, product: 0 };

const INK = '#1A1A1A';
const MUTED = '#999999';
const PAGE = '#F5F5F5';
const PLACEHOLDER = 'linear-gradient(135deg, #ECECEC 0%, #DADADA 100%)';

function str(values: ConfigValues, key: string, fallback: string): string {
  const value = values[key];
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function isHex(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

export function AppearancePreview({ values }: { values: ConfigValues }) {
  const [view, setView] = useState<View>('home');
  const defaults = appAppearanceDefaults;

  const primaryInput = str(values, 'primaryColor', defaults.theme.primaryColor);
  const accentInput = str(values, 'accentColor', '');
  const priceInput = str(values, 'priceColor', defaults.theme.priceColor);
  const theme = deriveTheme({
    primary: primaryInput,
    accent: isHex(accentInput) ? accentInput : null,
    price: isHex(priceInput) ? priceInput : null,
  });
  const radiusKey = str(values, 'radius', defaults.theme.radius) as RadiusScale;
  const factor = RADIUS_FACTOR[radiusKey] ?? 1;
  const cardRadius = 8 * factor;
  const imageRadius = 4 * factor;

  const bar = {
    color: str(values, 'tabBarColor', defaults.tabBar.color),
    selected: str(values, 'tabBarSelectedColor', defaults.tabBar.selectedColor),
    background: str(values, 'tabBarBackgroundColor', defaults.tabBar.backgroundColor),
  };

  const notes: string[] = [];
  if (isHex(priceInput) && theme.price.toUpperCase() !== priceInput.toUpperCase()) {
    notes.push(`价格色在白底上不够清晰，小程序会自动加深为 ${theme.price}。`);
  }
  if (isHex(primaryInput) && theme.primaryText.toUpperCase() !== primaryInput.toUpperCase()) {
    notes.push(`主题色用作小字时不够清晰，小程序会自动加深为 ${theme.primaryText}。`);
  }

  const pill: CSSProperties = { borderRadius: 999, padding: '0 14px', lineHeight: '30px' };

  return (
    <Card
      size="small"
      title="实时预览"
      extra={
        <Segmented<View>
          size="small"
          value={view}
          onChange={setView}
          options={[
            { label: '首页', value: 'home' },
            { label: '分类', value: 'category' },
            { label: '商品', value: 'product' },
          ]}
        />
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div
          data-testid="appearance-preview"
          style={{
            width: 300,
            maxWidth: '100%',
            margin: '0 auto',
            border: '8px solid #1F1F1F',
            borderRadius: 36,
            overflow: 'hidden',
            background: PAGE,
            color: INK,
            fontSize: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
          }}
        >
          {/* status bar + nav */}
          <div style={{ background: '#FFFFFF', padding: '6px 14px 8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
              <span>9:41</span>
              <span>●●● 100%</span>
            </div>
            <div style={{ textAlign: 'center', fontWeight: 600, fontSize: 14, marginTop: 6 }}>
              {view === 'home' ? '首页' : view === 'category' ? '分类' : '商品详情'}
            </div>
          </div>

          <div style={{ height: 380, overflow: 'hidden' }}>
            {view === 'home' ? (
              <HomeView theme={theme} cardRadius={cardRadius} imageRadius={imageRadius} />
            ) : view === 'category' ? (
              <CategoryView
                theme={theme}
                imageRadius={imageRadius}
                subcategories={values.showCategorySubcategories !== false}
              />
            ) : (
              <ProductView
                theme={theme}
                cardRadius={cardRadius}
                imageRadius={imageRadius}
                pill={pill}
                values={values}
              />
            )}
          </div>

          {view === 'product' ? (
            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                padding: '8px 10px',
                background: '#FFFFFF',
                borderTop: '1px solid #EEEEEE',
              }}
            >
              <ShoppingCartOutlined style={{ fontSize: 18, color: MUTED, marginInline: 6 }} />
              <span
                style={{
                  ...pill,
                  flex: 1,
                  textAlign: 'center',
                  background: theme.accent,
                  color: theme.onAccent,
                }}
              >
                加入购物车
              </span>
              <span
                style={{
                  ...pill,
                  flex: 1,
                  textAlign: 'center',
                  background: theme.primary,
                  color: theme.onPrimary,
                }}
              >
                立即购买
              </span>
            </div>
          ) : (
            <div
              data-testid="appearance-preview-tabbar"
              style={{
                display: 'flex',
                background: bar.background,
                borderTop: '1px solid rgba(0,0,0,0.06)',
                padding: '6px 0 10px',
              }}
            >
              {TABS.map((tab, index) => {
                const selected = index === TAB_FOR_VIEW[view];
                const label = str(values, `tab${tab.key}Label`, tab.fallback);
                const icon = str(
                  values,
                  selected ? `tab${tab.key}SelectedIcon` : `tab${tab.key}Icon`,
                  '',
                );
                return (
                  <div
                    key={tab.key}
                    style={{
                      flex: 1,
                      textAlign: 'center',
                      color: selected ? bar.selected : bar.color,
                      fontSize: 10,
                    }}
                  >
                    {icon ? (
                      <img
                        src={icon}
                        alt=""
                        style={{ width: 20, height: 20, display: 'block', margin: '0 auto' }}
                      />
                    ) : (
                      <div style={{ fontSize: 18, lineHeight: '20px' }}>{tab.icon}</div>
                    )}
                    <div>{label}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {notes.length > 0 ? (
          <Alert
            type="info"
            showIcon
            message={
              <Space direction="vertical" size={2}>
                {notes.map((note) => (
                  <span key={note}>{note}</span>
                ))}
              </Space>
            }
          />
        ) : null}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          示意图，未保存的修改也会显示；保存后小程序在一分钟内生效。
        </Typography.Text>
      </Space>
    </Card>
  );
}

type Theme = ReturnType<typeof deriveTheme>;

function Price({ theme, value, size = 14 }: { theme: Theme; value: string; size?: number }) {
  return (
    <span style={{ color: theme.price, fontWeight: 600, fontSize: size }}>
      <span style={{ fontSize: size * 0.7 }}>¥</span>
      {value}
    </span>
  );
}

function HomeView({
  theme,
  cardRadius,
  imageRadius,
}: {
  theme: Theme;
  cardRadius: number;
  imageRadius: number;
}) {
  return (
    <div style={{ padding: 10 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: '#FFFFFF',
          borderRadius: 999,
          padding: '6px 12px',
          color: MUTED,
        }}
      >
        <SearchOutlined /> 搜索商品
      </div>
      <div
        style={{
          marginTop: 10,
          height: 96,
          borderRadius: cardRadius,
          background: `linear-gradient(135deg, ${theme.primary} 0%, ${theme.accent} 100%)`,
          color: theme.onPrimary,
          padding: 14,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700 }}>新品上市</div>
        <div style={{ opacity: 0.85, marginTop: 4 }}>全场满 99 包邮</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
        {['轻薄羽绒服', '纯棉短袖 T 恤', '运动休闲鞋', '保温杯 500ml'].map((name, index) => (
          <div
            key={name}
            style={{ background: '#FFFFFF', borderRadius: cardRadius, overflow: 'hidden' }}
          >
            <div
              style={{
                height: 88,
                background: PLACEHOLDER,
                borderRadius: `${imageRadius}px ${imageRadius}px 0 0`,
              }}
            />
            <div style={{ padding: 8 }}>
              <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                {name}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                <Price theme={theme} value={['299', '59', '189', '79'][index]!} />
                {index === 0 ? (
                  <span
                    style={{
                      background: theme.primarySoft,
                      color: theme.primaryText,
                      borderRadius: 999,
                      padding: '0 6px',
                      fontSize: 10,
                    }}
                  >
                    包邮
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CategoryView({
  theme,
  imageRadius,
  subcategories,
}: {
  theme: Theme;
  imageRadius: number;
  subcategories: boolean;
}) {
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ width: 72, background: PAGE }}>
        {['服装', '鞋包', '家居', '数码', '食品'].map((name, index) => (
          <div
            key={name}
            style={{
              padding: '12px 0',
              textAlign: 'center',
              background: index === 0 ? '#FFFFFF' : 'transparent',
              color: index === 0 ? theme.primaryText : INK,
              fontWeight: index === 0 ? 600 : 400,
              borderInlineStart: `3px solid ${index === 0 ? theme.primary : 'transparent'}`,
            }}
          >
            {name}
          </div>
        ))}
      </div>
      <div style={{ flex: 1, background: '#FFFFFF', padding: 10 }}>
        {subcategories ? (
          <>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>上装</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {['T 恤', '衬衫', '卫衣', '外套', '毛衣', '背心'].map((name) => (
                <div key={name} style={{ textAlign: 'center' }}>
                  <div style={{ height: 48, background: PLACEHOLDER, borderRadius: imageRadius }} />
                  <div style={{ marginTop: 4 }}>{name}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          ['轻薄羽绒服', '纯棉短袖 T 恤', '休闲长裤'].map((name, index) => (
            <div key={name} style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <div
                style={{
                  width: 56,
                  height: 56,
                  background: PLACEHOLDER,
                  borderRadius: imageRadius,
                }}
              />
              <div>
                <div>{name}</div>
                <Price theme={theme} value={['299', '59', '129'][index]!} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ProductView({
  theme,
  cardRadius,
  imageRadius,
  pill,
  values,
}: {
  theme: Theme;
  cardRadius: number;
  imageRadius: number;
  pill: CSSProperties;
  values: ConfigValues;
}) {
  const section = (children: ReactNode, key: string) => (
    <div
      key={key}
      style={{ background: '#FFFFFF', borderRadius: cardRadius, padding: 10, marginTop: 8 }}
    >
      {children}
    </div>
  );
  return (
    <div style={{ padding: '0 0 10px' }}>
      <div style={{ height: 150, background: PLACEHOLDER }} />
      <div style={{ padding: '0 10px' }}>
        {section(
          <>
            <Price theme={theme} value="299.00" size={20} />
            <div style={{ fontWeight: 600, marginTop: 4, fontSize: 13 }}>轻薄羽绒服 90 白鸭绒</div>
            {values.showProductServiceTags !== false ? (
              <div style={{ display: 'flex', gap: 8, marginTop: 6, color: MUTED, fontSize: 11 }}>
                <span>✓ 七天无理由</span>
                <span>✓ 正品保障</span>
                <span>✓ 极速发货</span>
              </div>
            ) : null}
          </>,
          'head',
        )}
        {values.showProductReviews !== false
          ? section(
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 600 }}>评价 (128)</span>
                  <span style={{ color: theme.primaryText }}>好评率 98%</span>
                </div>
                <div style={{ marginTop: 6, color: '#FAAD14', fontSize: 10 }}>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <StarFilled key={i} />
                  ))}
                </div>
                <div style={{ marginTop: 4 }}>很暖和，做工不错，尺码标准。</div>
              </>,
              'reviews',
            )
          : null}
        {values.showProductRecommendations !== false
          ? section(
              <>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>为你推荐</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['59', '189', '79'].map((price) => (
                    <div key={price} style={{ flex: 1 }}>
                      <div
                        style={{ height: 52, background: PLACEHOLDER, borderRadius: imageRadius }}
                      />
                      <Price theme={theme} value={price} size={12} />
                    </div>
                  ))}
                </div>
              </>,
              'recommend',
            )
          : null}
        {values.showProductPoster !== false
          ? section(
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span>分享给好友</span>
                <span
                  style={{
                    ...pill,
                    lineHeight: '24px',
                    background: theme.primarySoft,
                    color: theme.primaryText,
                  }}
                >
                  生成海报
                </span>
              </div>,
              'share',
            )
          : null}
      </div>
    </div>
  );
}
