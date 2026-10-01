import { z } from 'zod';
import { id, instant } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';

/**
 * 「API 令牌」: how an admin lets an AI agent (over MCP) or the `shop` CLI act
 * as them. A token has exactly its owner's permissions, as they are now.
 *
 * Console only — a request made *with* a token gets `AUTH_TOKEN_CONSOLE_ONLY`
 * here, so an agent cannot mint itself a spare. The plain token is in the
 * create response and nowhere else, ever.
 */

export const apiTokenKind = z.enum(['pat', 'oauth']);

export const apiTokenItem = z.object({
  id,
  name: z.string(),
  /** `pat` made on this screen; `oauth` a client that connected through sign-in (Claude, ChatGPT…). */
  kind: apiTokenKind,
  /** The first characters, to tell tokens apart. */
  hint: z.string(),
  adminId: id,
  adminAccount: z.string(),
  expiresAt: instant.nullable(),
  lastUsedAt: instant.nullable(),
  lastUsedIp: z.string().nullable(),
  revokedAt: instant.nullable(),
  createdAt: instant,
});
export type ApiTokenItem = z.infer<typeof apiTokenItem>;

const itemExample: ApiTokenItem = {
  id: '3',
  name: '老板的 Cherry Studio',
  kind: 'pat',
  hint: 'shp_k7m2q9',
  adminId: '1',
  adminAccount: 'admin',
  expiresAt: null,
  lastUsedAt: '2026-09-24T09:30:00.000+00:00',
  lastUsedIp: '203.0.113.7',
  revokedAt: null,
  createdAt: '2026-09-24T08:00:00.000+00:00',
};

export const authApiTokenList = defineRoute({
  id: 'auth.apiTokenList',
  method: 'GET',
  path: '/admin-api/api-tokens',
  auth: 'admin',
  permission: 'auth:api-token:self',
  consoleOnly: true,
  summary: 'API 令牌列表（超级管理员可见全部）',
  tags: ['auth'],
  response: z.object({ items: z.array(apiTokenItem) }),
  errors: ['AUTH_TOKEN_CONSOLE_ONLY'],
  examples: [{ name: 'one', response: { items: [itemExample] } }],
});

export const apiTokenCreateBody = z.object({
  name: z.string().trim().min(1, '请填写名称').max(64),
  /** `null`: never expires. */
  expiresInDays: z.number().int().min(1).max(3650).nullable(),
});
export type ApiTokenCreateBody = z.infer<typeof apiTokenCreateBody>;

export const authApiTokenCreate = defineRoute({
  id: 'auth.apiTokenCreate',
  method: 'POST',
  path: '/admin-api/api-tokens',
  auth: 'admin',
  permission: 'auth:api-token:self',
  consoleOnly: true,
  summary: '新建 API 令牌',
  tags: ['auth'],
  body: apiTokenCreateBody,
  response: z.object({ item: apiTokenItem, token: z.string() }),
  status: 201,
  errors: ['AUTH_TOKEN_CONSOLE_ONLY'],
  examples: [
    {
      name: 'never-expires',
      body: { name: '老板的 Cherry Studio', expiresInDays: null },
      response: {
        item: { ...itemExample, lastUsedAt: null, lastUsedIp: null },
        token: 'shp_k7m2q9xw4t8hn3vcp6r5jd2za9e7ug4bs8ymf3',
      },
    },
  ],
});

export const authApiTokenRevoke = defineRoute({
  id: 'auth.apiTokenRevoke',
  method: 'DELETE',
  path: '/admin-api/api-tokens/:id',
  auth: 'admin',
  permission: 'auth:api-token:self',
  consoleOnly: true,
  summary: '吊销 API 令牌',
  tags: ['auth'],
  params: z.object({ id }),
  response: z.void(),
  status: 204,
  errors: ['AUTH_TOKEN_CONSOLE_ONLY'],
  examples: [{ name: 'ok', params: { id: '3' }, response: undefined }],
});
