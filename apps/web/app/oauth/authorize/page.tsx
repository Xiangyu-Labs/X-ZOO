import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { oauth } from '@shop/core/auth';
import { ADMIN_COOKIE } from '../../../src/server';
import { getContainer } from '../../../src/server/container';
import { Consent, ConsentError } from './consent';
import { asAuthorizeRequest, authorizeParams, errorRedirect } from './params';

export const metadata: Metadata = { title: '授权 AI 助手' };

/**
 * The consent screen of the OAuth flow an MCP client (Claude, ChatGPT…) starts.
 *
 * Not signed in → the ordinary console login, which comes back here. Signed
 * in → "let this client act as you?"; the answer is a same-origin form post to
 * `./decision`, which re-checks everything and issues the code. Nothing is
 * issued by merely rendering this page.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = authorizeParams(raw);
  const container = getContainer();

  const checked = await oauth.validateAuthorizeRequest(container.db, asAuthorizeRequest(params));
  if (!checked.ok) {
    if (checked.redirectTrusted)
      redirect(errorRedirect(params, checked.error, checked.description));
    return <ConsentError description={checked.description} />;
  }

  const session = await container.adminAuth.peek((await cookies()).get(ADMIN_COOKIE)?.value ?? '');
  if (!session) {
    const query = new URLSearchParams(
      Object.entries(raw).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value] as [string, string]] : [],
      ),
    );
    redirect(`/admin/login?next=${encodeURIComponent(`/oauth/authorize?${query.toString()}`)}`);
  }

  return (
    <Consent
      clientName={checked.clientName}
      adminName={session.name || session.account}
      account={session.account}
      params={params}
    />
  );
}

export const dynamic = 'force-dynamic';
