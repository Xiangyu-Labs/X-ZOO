import { create } from 'zustand';
import { isApiError, type ResponseOf } from '@shop/api-client';
import type { StorefrontRoute } from '@shop/api-client/routes';
import { api, installAuth } from '@/data/api';
import {
  currentRoute,
  navigate,
  onLoginPage,
  platform,
  showToast,
  storage,
  useLaunchContext,
} from '@/platform';
import { errorMessage } from '@/lib/error-message';

/**
 * The shopper's session (docs/mini/auth.md): silent WeChat sign-in at launch, the phone-number
 * step when the shop requires one, renewal on a 401, and sign-out.
 *
 *   launch ── wx.login ──▶ POST /auth/sessions/wechat-mini
 *                              ├─ signed-in ──────────────────────────────▶ token stored
 *                              └─ phone-required (bindToken, 10 min)
 *                                   ├─ 手机号快速登录 ─▶ POST …/wechat-mini/phone ─▶ token stored
 *                                   └─ 短信验证码 ─────▶ POST …/wechat-oa/phone ───▶ token stored
 *   其他方式 · 密码登录 (any state) ──▶ POST /auth/sessions/password ──▶ token stored
 *                                      (from phone-required: + bindToken, openid linked)
 *
 * Browsing never needs a session (C05): a page shows `<LoginCard>` where signed-in content
 * would be, and an action that needs one calls `requireLogin()` first. Nothing here navigates
 * on its own, except `requireLogin` opening the login page when the shopper must act.
 */

export type Session =
  | { status: 'idle' }
  | { status: 'signing-in' }
  | { status: 'signed-in'; token: string }
  | { status: 'phone-required'; bindToken: string }
  | { status: 'failed'; message: string }
  /** Signed out on purpose: no silent sign-in until an action asks for one. */
  | { status: 'signed-out' };

export const TOKEN_KEY = 'shop.session.token';
/** The account the stored token belongs to (its user id), kept beside it (AUTH-010). */
export const USER_KEY = 'shop.session.user';

export const useSession = create<{ session: Session }>()(() => ({
  session: { status: 'idle' },
}));

type Listener = (session: Session, previous: Session) => void;
const listeners = new Set<Listener>();

/** Called on every change; the query cache uses it to drop a signed-out shopper's data. */
export function onSessionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(session: Session): void {
  const previous = current();
  useSession.setState({ session });
  for (const listener of listeners) listener(session, previous);
}

function current(): Session {
  return useSession.getState().session;
}

/** The bearer token, or `null` when not signed in. */
export function currentToken(): string | null {
  const session = current();
  return session.status === 'signed-in' ? session.token : null;
}

/** Whether the shopper is signed in (a hook). */
export function useSignedIn(): boolean {
  return useSession((state) => state.session.status === 'signed-in');
}

/**
 * Which account each token this launch has held belongs to, so a request that met a 401 is
 * replayed only as the account that sent it (AUTH-010). A handful of entries per launch.
 */
const owners = new Map<string, string>();

/** The account `token` was issued to, or `null` when this launch cannot tell. */
function ownerOf(token: string): string | null {
  const known = owners.get(token);
  if (known) return known;
  // Not seen by `signedIn` this launch: a stored token's account is stored beside it.
  return storage.get(TOKEN_KEY) === token ? storage.get(USER_KEY) : null;
}

/** What the last sign-in left to tell the shopper (`takeSignInHint`). */
let signInHint: string | null = null;

function signedIn(token: string, userId: string, hint: string | null = null): void {
  clearSessionNotice();
  signInHint = hint;
  storage.set(TOKEN_KEY, token);
  if (userId) {
    owners.set(token, userId);
    storage.set(USER_KEY, userId);
  } else {
    storage.remove(USER_KEY);
  }
  set({ status: 'signed-in', token });
}

/** Forget the stored session (the in-memory state is the caller's to set). */
function forgetStored(): void {
  storage.remove(TOKEN_KEY);
  storage.remove(USER_KEY);
}

type WechatLoginResult = ResponseOf<'auth.miniLogin'>;

function apply(result: WechatLoginResult): void {
  if (result.status === 'signed-in' && result.session) {
    signedIn(result.session.token, result.session.user.id);
  } else if (result.status === 'phone-required' && result.bindToken) {
    set({ status: 'phone-required', bindToken: result.bindToken });
  } else {
    set({ status: 'failed', message: '登录失败，请重试' });
  }
}

function messageOf(error: unknown): string {
  return errorMessage(error, '登录失败，请重试');
}

let inFlight: Promise<void> | null = null;

/** Sign in if not already: a stored token, else `wx.login`. Concurrent calls share one run. */
export function startSession(): Promise<void> {
  inFlight ??= signIn().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function signIn(): Promise<void> {
  // A renewal is signing in already (its `wx.login` under way, the stored token forgotten): its
  // answer is this one's, not a second `wx.login` racing it.
  if (renewing) {
    await renewing;
    return;
  }
  const state = current();
  if (state.status === 'signed-in' || state.status === 'phone-required') return;
  const stored = storage.get(TOKEN_KEY);
  if (stored) {
    // A token stored before AUTH-010 has no account beside it: `ownerOf` says `null`, and its
    // first renewal replays nothing (see `renew`).
    const owner = storage.get(USER_KEY);
    if (owner) owners.set(stored, owner);
    set({ status: 'signed-in', token: stored });
    return;
  }
  await wechatSignIn();
}

async function wechatSignIn(): Promise<void> {
  set({ status: 'signing-in' });
  try {
    const code = await platform.login();
    apply(await api.call('auth.miniLogin', { body: { code } }));
  } catch (error) {
    set({ status: 'failed', message: messageOf(error) });
  }
}

interface Renewal {
  /** The renewed session's token, or `null`: nothing is replayed. */
  token: string | null;
  /** WeChat signed in to another account (or one this launch could not match), and was undone. */
  accountChanged: boolean;
  /** The login page was opened for it; once per renewal, however many requests shared it. */
  sentToLogin?: boolean;
}

let renewing: Promise<Renewal> | null = null;

/**
 * Sign in again with a fresh `wx.login` code after the session's token stopped working. Calls
 * made meanwhile share the one run. Renewal calls only public routes, so it cannot recurse.
 *
 * `wx.login` signs in to whichever account holds this phone's openid, which need not be the one
 * whose session ended: a password sign-in whose link was refused, an openid bound to another
 * account since (AUTH-010). When the account is not the same one — or the ended session's
 * account is unknown (a token stored before AUTH-010) — the new session is not kept: it is
 * revoked, nothing is stored, and the shopper is signed out, so no request runs as the other
 * account and its data never reaches the screen.
 */
function renew(): Promise<Renewal> {
  renewing ??= (async (): Promise<Renewal> => {
    const before = currentToken();
    const owner = before ? ownerOf(before) : null;
    forgetStored();
    set({ status: 'signing-in' });
    let result: WechatLoginResult;
    try {
      const code = await platform.login();
      result = await api.call('auth.miniLogin', { body: { code } });
    } catch (error) {
      set({ status: 'failed', message: messageOf(error) });
      return { token: null, accountChanged: false };
    }
    const session = result.status === 'signed-in' ? result.session : null;
    if (session && (owner === null || session.user.id !== owner)) {
      revoke(session.token);
      set({ status: 'signed-out' });
      return { token: null, accountChanged: true };
    }
    apply(result);
    return { token: currentToken(), accountChanged: false };
  })().finally(() => {
    renewing = null;
  });
  return renewing;
}

/** End a session this client will not use. Best effort: unused, it expires on its own. */
function revoke(token: string): void {
  api
    .call('auth.logout', undefined, { headers: { Authorization: `Bearer ${token}` } })
    .catch(() => undefined);
}

/**
 * Renew the session (auth.md「401：续期」): drop the token and sign in again with `wx.login`.
 * The new token, or `null` (phone-required, the renewal failed, or it reached another account
 * and was undone: signed out). For a caller that knows the session just ended (修改密码).
 */
export async function renewSession(): Promise<string | null> {
  return (await renew()).token;
}

/** What the login page says when a renewal reached another account (AUTH-010). */
export const SESSION_ENDED = '登录已过期，请重新登录';

/**
 * Why the login page was opened for the shopper, if the session opened it: the login page shows
 * it as a line of its own until the shopper signs in or leaves. Not a toast: the failed request's
 * caller shows its own error toast about then, and a toast replaces the one before it (on H5 even
 * a `hideLoading` hides it), so a toast here was not reliably seen.
 */
export const useSessionNotice = create<{ notice: string | null }>()(() => ({ notice: null }));

export function clearSessionNotice(): void {
  useSessionNotice.setState({ notice: null });
}

function sendToLogin(renewal: Renewal): void {
  if (renewal.sentToLogin) return;
  renewal.sentToLogin = true;
  useSessionNotice.setState({ notice: SESSION_ENDED });
  // Back to this page once signed in again; without a redirect the login page leaves for 首页.
  // Already there (a call the login page itself made met the 401): the notice is enough, a
  // second login page on top of it is not.
  if (onLoginPage()) return;
  const here = currentRoute();
  // Not awaited: the failed request's 401 reaches its caller meanwhile.
  void navigate({
    route: 'login',
    params: here ? { redirect: JSON.stringify(here) } : {},
  }).catch(() => undefined);
}

/**
 * The transport's renewal hook (`renewing-transport`): the token to send again a request that
 * went out with `sent` and met a 401, or `null` to let the 401 stand. Replays only as the
 * account that sent it (AUTH-010):
 *
 * - `sent` is the session's token (or a renewal is under way): renew, sharing one renewal with
 *   every request that failed alongside; they all get its one answer.
 * - The session moved on meanwhile: its token, if it is the same account's; else `null`.
 * - Not signed in (signed out, or a renewal already ended without a session): `null`, no
 *   second `wx.login`.
 *
 * When the renewal reached another account the shopper is signed out and sent to the login
 * page, once, which says「登录已过期，请重新登录」(`useSessionNotice`); the request is not replayed.
 */
export async function renewFor(sent: string): Promise<string | null> {
  // Before renewing: the renewal forgets the stored token, and with it a stored token's account.
  const owner = ownerOf(sent);
  let token: string | null;
  if (renewing || currentToken() === sent) {
    const renewal = await renew();
    if (renewal.accountChanged) sendToLogin(renewal);
    token = renewal.token;
  } else {
    token = currentToken();
  }
  if (!token) return null;
  return owner !== null && ownerOf(token) === owner ? token : null;
}

installAuth({
  getToken: currentToken,
  renew: renewFor,
  onUnauthorized: () => {
    // Renewal already ran (or there was no token to renew): do not loop. The next action that
    // needs a session starts again through `requireLogin`. `signed-out`, not `idle`: nothing is
    // signing in now, and an idle session reads as 登录中… with no 登录 to tap.
    if (current().status === 'signed-in') {
      forgetStored();
      set({ status: 'signed-out' });
    }
  },
});

/**
 * Finish a `phone-required` sign-in with the code from the phone-number button. Rejects only
 * when the shopper can act on it (tap again, or switch to SMS): the caller shows why.
 */
export async function bindPhone(phoneCode: string): Promise<void> {
  const state = current();
  if (state.status !== 'phone-required') return;
  set({ status: 'signing-in' });
  try {
    apply(
      await api.call('auth.miniPhoneLogin', {
        body: { bindToken: state.bindToken, phoneCode },
      }),
    );
  } catch (error) {
    await afterBindFailure(error, state.bindToken);
  }
}

/**
 * The SMS alternative (auth.md 方式二): the code must be minted with `scene: 'login'`, there
 * being no session yet. Resolves with the seconds before another code may be asked for.
 */
export async function sendLoginSms(phone: string): Promise<number> {
  const result = await api.call('auth.sendSmsCode', { body: { phone, scene: 'login' } });
  return result.resendAfterSec;
}

/**
 * Finish a `phone-required` sign-in with an SMS code. `auth.oaPhoneLogin` completes any parked
 * WeChat sign-in and binds the mini-program openid, so the next launch is silent; do not use
 * `auth.smsLogin`, which would not bind it (auth.md).
 */
export async function bindPhoneWithSms(phone: string, code: string): Promise<void> {
  const state = current();
  if (state.status !== 'phone-required') return;
  set({ status: 'signing-in' });
  try {
    apply(
      await api.call('auth.oaPhoneLogin', { body: { bindToken: state.bindToken, phone, code } }),
    );
  } catch (error) {
    await afterBindFailure(error, state.bindToken);
  }
}

/** A password login refused only for its `bindToken`; the password itself was right. */
const LINK_REFUSED = new Set(['AUTH_WECHAT_BIND_EXPIRED', 'AUTH_WECHAT_ALREADY_BOUND']);

/**
 * What the shopper is told after a password sign-in whose link was refused because this phone's
 * WeChat already belongs to another account (or this account to another WeChat): the next
 * launch signs in silently to that other account, so this one takes 密码登录 again. Not said for
 * an expired `bindToken`: nothing is bound yet, and the next launch asks again.
 */
export const LINK_REFUSED_HINT = '此微信已关联其他账号，本账号需用密码登录';

/**
 * The hint the last sign-in left for the shopper, once (then `null`). The login page shows it
 * after it has left for the page the shopper was going to: shown on the login page it would go
 * with the page, and shown during the navigation WeChat may drop it.
 */
export function takeSignInHint(): string | null {
  const hint = signInHint;
  signInHint = null;
  return hint;
}

/**
 * 密码登录 (the login page's 其他方式, auth.md「密码登录」). Signs in to the account the
 * password belongs to. From a parked `phone-required` sign-in the `bindToken` goes along, and the
 * server links the mini-program openid to that account once the password is right (AUTH-009), so
 * the next `wx.login` renewal signs in to the same account. When the link is refused — the token
 * expired (`AUTH_WECHAT_BIND_EXPIRED`) or the openid or the account's mini slot is taken
 * (`AUTH_WECHAT_ALREADY_BOUND`) — the password was right, so it signs in once more without the
 * token, linking nothing, rather than stranding the shopper on the login page. Other failures
 * (wrong password, too many attempts…) reject with the server's error and leave the session as
 * it was.
 */
export async function signInWithPassword(account: string, password: string): Promise<void> {
  const state = current();
  const bindToken = state.status === 'phone-required' ? state.bindToken : undefined;
  let result: ResponseOf<'auth.passwordLogin'>;
  let hint: string | null = null;
  try {
    result = await api.call('auth.passwordLogin', {
      body: bindToken ? { account, password, bindToken } : { account, password },
    });
  } catch (error) {
    if (!bindToken || !isApiError(error) || !LINK_REFUSED.has(error.code)) throw error;
    result = await api.call('auth.passwordLogin', { body: { account, password } });
    if (error.code === 'AUTH_WECHAT_ALREADY_BOUND') hint = LINK_REFUSED_HINT;
  }
  signedIn(result.token, result.user.id, hint);
}

/** Codes after which the parked sign-in is still good and the shopper can try again. */
const RETRYABLE = new Set([
  'AUTH_WECHAT_CODE_INVALID',
  'AUTH_WECHAT_UNAVAILABLE',
  'AUTH_SMS_CODE_INVALID',
  'AUTH_SMS_CODE_ATTEMPTS_EXCEEDED',
  'AUTH_WECHAT_ALREADY_BOUND',
]);

/** What a failed bind leaves behind (AUTH-007: most failures keep the bindToken). */
async function afterBindFailure(error: unknown, bindToken: string): Promise<void> {
  if (isApiError(error) && error.code === 'AUTH_WECHAT_BIND_EXPIRED') {
    // The parked sign-in timed out: start over with a fresh wx.login code.
    await wechatSignIn();
    return;
  }
  if (isApiError(error) && (RETRYABLE.has(error.code) || error.status === 0)) {
    set({ status: 'phone-required', bindToken });
    throw error;
  }
  set({ status: 'failed', message: messageOf(error) });
}

/**
 * Before an action that needs a session (加入购物车, 立即购买, 领券…). Resolves `true` when
 * signed in, silently signing in first if it can. Otherwise, when the shopper must act (bind a
 * phone number), opens the login page, which comes back to `redirect` afterwards, and resolves
 * `false`: the caller stops there.
 */
export async function requireLogin(redirect?: StorefrontRoute): Promise<boolean> {
  if (useLaunchContext.getState().isTimelineSinglePage) {
    // 朋友圈单页 (C10): no login there; WeChat's bottom bar offers 「前往小程序」.
    showToast('请前往小程序使用完整服务');
    return false;
  }
  const before = current().status;
  if (before !== 'signed-in' && before !== 'phone-required') await startSession();
  if (current().status === 'signed-in') return true;
  await navigate({
    route: 'login',
    params: redirect ? { redirect: JSON.stringify(redirect) } : {},
  });
  return false;
}

/**
 * Sign out (auth.md「退出」): revoke the token on the server, forget it here. `everywhere`
 * revokes every device's session. A server failure still signs out locally.
 */
export async function logout({ everywhere = false }: { everywhere?: boolean } = {}): Promise<void> {
  if (current().status === 'signed-in') {
    try {
      if (everywhere) await api.call('auth.logoutEverywhere');
      else await api.call('auth.logout');
    } catch {
      // The token may already be dead; signing out locally is what the shopper asked for.
    }
  }
  forgetStored();
  clearSessionNotice();
  signInHint = null;
  set({ status: 'signed-out' });
}
