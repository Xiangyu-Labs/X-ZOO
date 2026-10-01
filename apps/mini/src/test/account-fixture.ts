import type { ResponseOf } from '@shop/api-client';
import { TOKEN_KEY, USER_KEY, useSession } from '@/session/session';
import { taroFake } from './taro-fake/taro';

/**
 * A signed-in shopper, as a stored token would leave the app (no wx.login, no request): the
 * token of account 7 (`profileFixture`), its account stored beside it.
 */
export function signIn(token = 't1'): void {
  taroFake.storage.set(TOKEN_KEY, token);
  taroFake.storage.set(USER_KEY, '7');
  useSession.setState({ session: { status: 'signed-in', token } });
}

export function signOut(): void {
  useSession.setState({ session: { status: 'signed-out' } });
}

export const profileFixture: ResponseOf<'user.getProfile'> = {
  id: '7',
  account: 'u7',
  phone: '13800138000',
  nickname: '小明',
  avatarUrl: null,
  realName: null,
  birthday: null,
  registerSource: 'wechat_mini',
  hasPassword: true,
  boundWechat: ['mini'],
  createdAt: '2026-09-01T10:00:00+08:00',
};

/** A `{ items, total, page, pageSize }` page of `items`. */
export function page<T>(items: T[]) {
  return { items, total: items.length, page: 1, pageSize: 20 };
}

/** A 422 body the way `handle()` sends one. */
export function rejected(code: string, message: string, status = 422) {
  return { status, body: { code, message } };
}

export const productFixture: ResponseOf<'catalog.favoriteList'>['items'][number]['product'] = {
  id: '11',
  name: '纯棉毛巾',
  subtitle: null,
  imageUrl: '/uploads/p/11.jpg',
  cardImageUrl: null,
  price: '19.90',
  originalPrice: null,
  stock: 20,
  salesDisplay: 3,
  unitName: '条',
  kind: 'physical',
  labels: [],
  canAddToCart: true,
};
