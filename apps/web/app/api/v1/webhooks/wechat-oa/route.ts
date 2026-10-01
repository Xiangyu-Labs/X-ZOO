import { randomUUID } from 'node:crypto';
import { anonymousActor, createCtx, type Ctx } from '@shop/core/kernel';
import { handleEvent, verifyUrl, type OaWebhookResult } from '@shop/core/wechat-oa';
import { getContainer, searchParamsToObject } from '../../../../../src/server';

/**
 * `/api/v1/webhooks/wechat-oa` — 公众号服务器配置 points here.
 *
 * ## Why these two handlers are not `handle()`
 *
 * Every other endpoint in the system speaks JSON, and `handle()` serialises
 * JSON. WeChat does not: the verification handshake wants the bare `echostr`
 * back as text, and an event wants either the five ASCII letters `success` or an
 * XML reply document. A `{"echostr":"…"}` answer fails the handshake with a
 * message that says only 配置失败, so these two build their `Response`
 * themselves. They are declared in `wechat-oa.webhook.contract.ts` anyway,
 * because the OpenAPI document is what tells an operator which URL to paste
 * into 公众平台.
 *
 * Everything else stays out of here. The signature check, the AES envelope, the
 * deduplication and the reply engine are `core/src/wechat-oa/…webhook.service`;
 * this file reads the request, builds a `Ctx` and writes the bytes back.
 *
 * ## Why the body is `text()` and never parsed here
 *
 * In 安全模式 the signature covers the exact bytes, and any round trip through a
 * parser changes them. The service parses — after it has checked the signature,
 * which is the order the whole security model rests on.
 */

function ctxFor(request: Request, routeId: string): Ctx {
  const container = getContainer();
  const requestId = request.headers.get('x-request-id') ?? randomUUID();
  return createCtx({
    db: container.db,
    redis: container.redis,
    clock: container.clock,
    config: container.config,
    logger: container.logger.child({ requestId, routeId }),
    queue: container.queue,
    storage: container.storage,
    // WeChat is nobody's session. The webhook service scopes everything it
    // writes by the openid inside the (verified) envelope, never by an actor.
    actor: anonymousActor,
    platform: null,
    requestId,
    routeId,
  });
}

/** WeChat reads the body as bytes; the charset has to be spelled out or 中文 arrives mangled. */
function respond(result: OaWebhookResult, contentType: string): Response {
  return new Response(result.body, {
    status: result.status,
    headers: { 'content-type': contentType },
  });
}

export async function GET(request: Request): Promise<Response> {
  const query = searchParamsToObject(new URL(request.url).searchParams) as Record<
    string,
    string | undefined
  >;
  const result = await verifyUrl(ctxFor(request, 'wechatOa.webhookVerify'), query);
  return respond(result, 'text/plain; charset=utf-8');
}

export async function POST(request: Request): Promise<Response> {
  const query = searchParamsToObject(new URL(request.url).searchParams) as Record<
    string,
    string | undefined
  >;
  const body = await request.text();
  const result = await handleEvent(ctxFor(request, 'wechatOa.webhookEvent'), { query, body });
  // `success` under `text/xml` is accepted by WeChat, and one content type for
  // both answers removes the branch that gets the header wrong.
  return respond(result, 'text/xml; charset=utf-8');
}

export const dynamic = 'force-dynamic';
