import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  callOperation,
  describeOperation,
  DOMAIN_LABELS,
  GUIDE,
  OperationError,
  searchOperations,
} from '@shop/admin-ops';
import { resolveApiToken, readBearer, type ResolvedApiToken } from '@shop/core/auth';
import type { Container } from './container';
import { clientIp } from './request-meta';

/**
 * `/mcp` — the shop as a remote MCP server, for any MCP client: Claude,
 * ChatGPT, Cursor, Cherry Studio…
 *
 * Authentication is an API token as `Authorization: Bearer shp_…`: either a
 * personal token pasted into the client, or one the client obtained through
 * `/oauth/*` (advertised by `/.well-known/oauth-protected-resource`). A
 * request without a live token gets `401` with the `WWW-Authenticate` header
 * that starts a spec-following client's OAuth flow.
 *
 * Three tools, not one per route: search, describe, call. Two hundred tools
 * would bury the model; these three reach every admin route, and a route
 * added tomorrow is reachable tomorrow. `call_operation` goes back through
 * `/admin-api/**` on this same server with the same token, so validation,
 * the permission check and the audit row are exactly the console's.
 */

/**
 * A path or query value. It ends up as URL text either way, so the schema
 * says `string` — one plain type, which every client's schema dialect takes —
 * and a model that sends `12` or `true` is coerced rather than refused.
 */
const URL_VALUE = z.coerce.string();

const domainList = Object.entries(DOMAIN_LABELS)
  .map(([key, label]) => `${key}=${label}`)
  .join('，');

function text(value: unknown, isError = false) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

export interface McpDeps {
  /** Where `call_operation` sends requests: this very app, over loopback. */
  internalOrigin: string;
  fetch?: typeof fetch;
}

interface Caller {
  token: string;
  admin: ResolvedApiToken;
  /** The edge's `X-Real-IP`, passed on so the audit row keeps the caller's address. */
  realIp: string | null;
}

/** One server per request (stateless): the tools close over the caller's token. */
export function buildShopMcpServer(caller: Caller, deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'shop-admin', title: '商城后台', version: '1.0.0' },
    { instructions: GUIDE },
  );

  server.registerTool(
    'search_operations',
    {
      title: '搜索后台操作',
      description:
        `按中文描述查找商城后台能做的操作，返回操作 id、说明、HTTP 方法。` +
        `例如「新建商品」「保存配置」「管理员列表」「发布页面」。` +
        `可用 domain 只看某个领域：${domainList}。`,
      inputSchema: z.object({
        query: z.string().describe('想做的事，中文即可；只按领域列出时可留空').default(''),
        domain: z.string().optional().describe('领域 key，例如 catalog、decor、system'),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, domain, limit }) =>
      text(
        searchOperations(query, { ...(limit ? { limit } : {}), ...(domain ? { domain } : {}) }).map(
          (op) => ({ id: op.id, summary: op.summary, method: op.method, domain: op.domain }),
        ),
      ),
  );

  server.registerTool(
    'describe_operation',
    {
      title: '查看操作参数',
      description:
        '读取一个操作的参数结构（JSON Schema：params 路径参数、query 查询参数、body 请求体）和官方示例。调用 call_operation 之前先读这里，照示例填写。',
      inputSchema: z.object({ id: z.string().describe('search_operations 返回的操作 id') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const detail = describeOperation(id);
      return detail
        ? text(detail)
        : text(`没有这个操作：${id}。请先用 search_operations 搜索。`, true);
    },
  );

  server.registerTool(
    'call_operation',
    {
      title: '执行后台操作',
      description:
        '以当前管理员身份执行一个后台操作，会真实生效并写入操作日志。返回 HTTP 状态和服务器的回答；出错时回答里有中文原因和出错字段，改正后重试。',
      inputSchema: z.object({
        id: z.string().describe('操作 id'),
        // Every value typed: some clients (Gemini, OpenAI strict mode) refuse
        // or mangle a schema that is a bare "anything".
        params: z
          .record(z.string(), URL_VALUE)
          .optional()
          .describe('路径参数，例如 { "id": "12" }'),
        query: z
          .record(z.string(), z.union([URL_VALUE, z.array(URL_VALUE)]))
          .optional()
          .describe('查询参数，GET 列表的筛选、分页'),
        body: z
          .record(z.string(), z.json())
          .optional()
          .describe('请求体（JSON 对象），POST / PUT / PATCH 用'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ id, params, query, body }) => {
      try {
        const result = await callOperation(
          {
            origin: deps.internalOrigin,
            token: caller.token,
            ...(caller.realIp ? { headers: { 'x-real-ip': caller.realIp } } : {}),
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
          },
          id,
          {
            ...(params ? { params } : {}),
            ...(query ? { query } : {}),
            ...(body === undefined ? {} : { body }),
          },
        );
        return text({ status: result.status, data: result.data }, !result.ok);
      } catch (error) {
        if (error instanceof OperationError) return text(error.message, true);
        throw error;
      }
    },
  );

  server.registerResource(
    'guide',
    'guide://shop',
    { title: '商城后台操作指南', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDE }] }),
  );

  server.registerTool(
    'whoami',
    {
      title: '当前身份',
      description: '当前以哪个管理员身份操作，以及是否为超级管理员。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      text({
        account: caller.admin.account,
        isSuper: caller.admin.isSuper,
        token: caller.admin.tokenName,
        permissionCount: caller.admin.isSuper ? '全部' : caller.admin.permissions.length,
      }),
  );

  return server;
}

/** The `resource_metadata` URL a 401 points at (RFC 9728). */
export function protectedResourceMetadataUrl(appOrigin: string): string {
  return `${appOrigin.replace(/\/+$/, '')}/.well-known/oauth-protected-resource/mcp`;
}

function unauthorized(appOrigin: string, description: string): Response {
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: description }), {
    status: 401,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Header values are Latin-1: the Chinese description stays in the body.
      'www-authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl(appOrigin)}", error="invalid_token"`,
      'cache-control': 'no-store',
    },
  });
}

/**
 * Authenticates, then hands the request to the SDK. The SDK builds a fresh
 * server per request from the factory; the factory reads the caller from
 * `authInfo.extra`, which only this function sets — the SDK never fills
 * `authInfo` from headers itself.
 */
export function createShopMcpEndpoint(
  getContainer: () => Container,
  deps: McpDeps,
): (request: Request) => Promise<Response> {
  const handler: McpHttpHandler = createMcpHandler(
    (ctx) => {
      const caller = ctx.authInfo?.extra?.caller as Caller | undefined;
      if (!caller)
        throw new Error('mcp: request reached the server without an authenticated caller');
      return buildShopMcpServer(caller, deps);
    },
    {
      // Today's clients speak the 2025 protocol, which this answers as a
      // one-event SSE stream per POST; no session is kept between requests.
      legacy: 'stateless',
      onerror: (error) => getContainer().logger.warn({ err: error }, 'mcp request failed'),
    },
  );

  return async (request) => {
    const container = getContainer();
    const token = readBearer(request.headers.get('authorization'));
    if (!token) return unauthorized(container.env.APP_ORIGIN, '需要登录');
    const realIp = clientIp(request);
    const admin = await resolveApiToken(container, token, { ip: realIp });
    if (!admin) return unauthorized(container.env.APP_ORIGIN, '令牌无效或已过期');
    const caller: Caller = { token, admin, realIp };
    return handler.fetch(request, {
      authInfo: {
        token,
        clientId: `token:${admin.tokenId}`,
        scopes: ['shop'],
        resourceMetadataUrl: protectedResourceMetadataUrl(container.env.APP_ORIGIN),
        extra: { caller },
      },
    });
  };
}
