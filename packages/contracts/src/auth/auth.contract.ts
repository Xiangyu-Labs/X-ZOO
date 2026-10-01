import { z } from 'zod';
import { defineRoute } from '../_conventions/route';
import { adminLoginBody, adminProfile, adminProfileExample } from './schemas';

/**
 * Admin sign-in. The session itself never appears in the response body: the
 * handler sets an opaque `admin_session` cookie (httpOnly, SameSite=Lax,
 * Secure in production) and the shell reads identity from this payload.
 *
 * `logout` and `me` need a session but no privilege. `defineRoute` requires a
 * permission for every `auth: 'admin'` route, so they declare the two atoms
 * under `auth:session:*`, which `@shop/core/auth` grants implicitly to every
 * authenticated admin. See `IMPLICIT_ADMIN_PERMISSIONS`.
 */

export const adminLogin = defineRoute({
  id: 'auth.adminLogin',
  method: 'POST',
  path: '/admin-api/auth/login',
  auth: 'public',
  summary: '后台登录',
  tags: ['auth'],
  body: adminLoginBody,
  response: adminProfile,
  errors: [
    'AUTH_INVALID_CREDENTIALS',
    'AUTH_ACCOUNT_DISABLED',
    'AUTH_TOO_MANY_ATTEMPTS',
    'AUTH_CAPTCHA_REQUIRED',
    'AUTH_CAPTCHA_INVALID',
  ],
  examples: [
    {
      name: 'ok',
      body: { account: 'admin', password: 'xzoo123456' },
      response: adminProfileExample,
    },
  ],
});

export const adminLogout = defineRoute({
  id: 'auth.adminLogout',
  method: 'POST',
  path: '/admin-api/auth/logout',
  auth: 'admin',
  permission: 'auth:session:delete',
  summary: '后台退出登录',
  tags: ['auth'],
  response: z.object({ ok: z.literal(true) }),
  examples: [{ name: 'ok', response: { ok: true } }],
});

export const adminMe = defineRoute({
  id: 'auth.adminMe',
  method: 'GET',
  path: '/admin-api/auth/me',
  auth: 'admin',
  permission: 'auth:session:read',
  summary: '当前登录管理员',
  tags: ['auth'],
  response: adminProfile,
  errors: ['AUTH_SESSION_EXPIRED'],
  examples: [
    { name: 'super', response: adminProfileExample },
    {
      name: 'limited',
      response: {
        id: '2',
        account: 'operator',
        name: '运营',
        avatar: null,
        isSuper: false,
        permissions: [
          'auth:profile:read',
          'auth:profile:update',
          'auth:session:delete',
          'auth:session:read',
          'catalog:product:read',
        ],
      },
    },
  ],
});
