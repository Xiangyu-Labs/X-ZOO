import { randomUUID } from 'node:crypto';
import { anonymousActor, createCtx, type Ctx } from '@shop/core/kernel';
import { handleMiniPush, verifyMiniPushUrl, type MiniPushResult } from '@shop/core/wechat';
import { getContainer, searchParamsToObject } from '../../../../../src/server';

/**
 * `/api/v1/webhooks/wechat-mini` — the mini program's 消息推送 (数据格式 JSON).
 *
 * Not `handle()`, for the reasons `webhooks/wechat-oa/route.ts` gives: WeChat
 * wants the bare `echostr` or the word `success` back, and the signature in
 * 安全模式 covers the body's exact bytes, so the body is read as text and the
 * service parses it only after the signature holds. Everything else — the
 * check, the AES envelope, the ledger row — is `core/src/wechat/wechat.mini-push.ts`.
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
    // WeChat is nobody's session; what a push changes is found by the payment
    // or the trace id inside the verified message.
    actor: anonymousActor,
    platform: null,
    requestId,
    routeId,
  });
}

function respond(result: MiniPushResult): Response {
  return new Response(result.body, {
    status: result.status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function queryOf(request: Request): Record<string, string | undefined> {
  return searchParamsToObject(new URL(request.url).searchParams) as Record<
    string,
    string | undefined
  >;
}

export async function GET(request: Request): Promise<Response> {
  return respond(
    await verifyMiniPushUrl(ctxFor(request, 'wechat.miniWebhookVerify'), queryOf(request)),
  );
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  return respond(
    await handleMiniPush(ctxFor(request, 'wechat.miniWebhookEvent'), {
      query: queryOf(request),
      body,
    }),
  );
}

export const dynamic = 'force-dynamic';
