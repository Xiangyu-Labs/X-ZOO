import { randomUUID } from 'node:crypto';
import { insertAudit, oauth } from '@shop/core/auth';
import { ADMIN_COOKIE, checkCsrf, readCookie } from '../../../../src/server';
import { getContainer, type Container } from '../../../../src/server/container';
import { clientIp } from '../../../../src/server/request-meta';
import { asAuthorizeRequest, authorizeParams, errorRedirect } from '../params';

/**
 * The consent screen's answer. A cookie-authenticated form post, so it passes
 * the same CSRF check as every console write — otherwise another site could
 * post "allow" on a signed-in admin's behalf and walk off with a code for its
 * own registered client.
 */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

function refuse(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * 「允许」 hands an outside client a token that acts as this admin, so the
 * answer goes to 操作日志 like any other console write — allow and deny both,
 * with the client's name and where the code was sent. This route is not behind
 * `handle()`, which is what writes that log for everything else.
 */
async function auditDecision(
  container: Container,
  request: Request,
  session: { adminId: number; account: string },
  entry: { clientId: string; clientName: string; redirectUri: string; allowed: boolean },
): Promise<void> {
  try {
    await insertAudit(container.db, {
      adminId: session.adminId,
      adminAccount: session.account,
      routeId: 'oauth.authorizeDecision',
      method: 'POST',
      path: new URL(request.url).pathname,
      target: `oauth-client:${entry.clientId}`.slice(0, 128),
      status: 303,
      payload: {
        decision: entry.allowed ? 'allow' : 'deny',
        clientName: entry.clientName,
        redirectUri: entry.redirectUri,
      },
      requestId: request.headers.get('x-request-id') ?? randomUUID(),
      ip: clientIp(request),
      now: container.clock.now(),
    });
  } catch (error) {
    // As in handle(): a failed log line never turns the answer into a 500.
    container.logger.error({ err: error }, 'oauth: failed to write the audit log');
  }
}

export async function POST(request: Request): Promise<Response> {
  const container = getContainer();
  const csrf = checkCsrf(request, [
    container.env.APP_ORIGIN,
    ...container.env.EXTRA_ALLOWED_ORIGINS,
  ]);
  if (!csrf.ok) return refuse('请求来源不可信', 403);

  const form = new URLSearchParams(await request.text());
  const params = authorizeParams(form);
  const checked = await oauth.validateAuthorizeRequest(container.db, asAuthorizeRequest(params));
  if (!checked.ok) {
    return checked.redirectTrusted
      ? seeOther(errorRedirect(params, checked.error, checked.description))
      : refuse(checked.description);
  }

  const session = await container.adminAuth.peek(readCookie(request, ADMIN_COOKIE) ?? '');
  if (!session) return refuse('登录已过期，请返回重新授权', 401);

  const allowed = form.get('decision') === 'allow';
  await auditDecision(container, request, session, {
    clientId: params.client_id,
    clientName: checked.clientName,
    redirectUri: params.redirect_uri,
    allowed,
  });
  if (!allowed) {
    return seeOther(errorRedirect(params, 'access_denied', '管理员拒绝了授权'));
  }

  const code = await oauth.createAuthorizationCode(container.redis, {
    adminId: session.adminId,
    clientId: params.client_id,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
  });
  container.logger.info(
    { adminId: session.adminId, clientId: params.client_id, clientName: checked.clientName },
    'oauth: admin authorised an MCP client',
  );
  const target = new URL(params.redirect_uri);
  target.searchParams.set('code', code);
  if (params.state) target.searchParams.set('state', params.state);
  target.searchParams.set('iss', container.env.APP_ORIGIN.replace(/\/+$/, ''));
  return seeOther(target.toString());
}

export const dynamic = 'force-dynamic';
