import { describe, expect, it, vi } from 'vitest';

/**
 * A fresh session module per test (its store and single-flight live at module level), with the
 * Taro fake, the fake API and the client of the same module generation.
 */
async function load() {
  vi.resetModules();
  const { taroFake } = await import('@/test/taro-fake/taro');
  const { serveApi } = await import('@/test/fake-api');
  taroFake.loginCode = 'code-1';
  return { ...(await import('./session')), taroFake, serveApi };
}

const user = { id: '7', nickname: '微信用户', avatarUrl: null, phone: '13900000000' };
/** Another account: the one this phone's openid is bound to in the AUTH-010 cases. */
const other = { ...user, id: '8', phone: '13900000008' };
const signedIn = (token: string, as = user) => ({
  status: 'signed-in',
  session: { token, expiresAt: '2026-10-23T00:00:00.000Z', user: as },
  registered: false,
  bindToken: null,
  bindTokenExpiresInSec: null,
});
const passwordSession = { token: 'pw1', expiresAt: '2026-10-23T00:00:00.000Z', user };
const phoneRequired = {
  status: 'phone-required',
  session: null,
  registered: false,
  bindToken: 'bind-1',
  bindTokenExpiresInSec: 600,
};

describe('session', () => {
  it('signs a known shopper in silently with the wx.login code, as wechat-mini', async () => {
    const { serveApi, startSession, taroFake, useSession } = await load();
    const seen = serveApi({
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ body: signedIn('t1') }),
    });

    await Promise.all([startSession(), startSession()]);

    expect(useSession.getState().session).toEqual({ status: 'signed-in', token: 't1' });
    expect(seen).toHaveLength(1); // one run for concurrent callers
    expect(seen[0]?.body).toEqual({ code: 'code-1' });
    expect(seen[0]?.headers['X-Client-Platform'] ?? seen[0]?.headers['x-client-platform']).toBe(
      'wechat-mini',
    );
    expect(taroFake.storage.get('shop.session.token')).toBe('t1');
    expect(taroFake.storage.get('shop.session.user')).toBe('7');
  });

  it('reuses a stored token without calling wx.login', async () => {
    const { serveApi, startSession, taroFake, useSession } = await load();
    taroFake.storage.set('shop.session.token', 'stored');
    const seen = serveApi({});

    await startSession();

    expect(useSession.getState().session).toEqual({ status: 'signed-in', token: 'stored' });
    expect(seen).toHaveLength(0);
    expect(taroFake.calls.some((call) => call.api === 'login')).toBe(false);
  });

  it('parks a new shopper on phone-required, then binds the phone code', async () => {
    const { bindPhone, serveApi, startSession, useSession } = await load();
    const seen = serveApi({
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ body: phoneRequired }),
      'POST /api/v1/auth/sessions/wechat-mini/phone': () => ({ body: signedIn('t2') }),
    });

    await startSession();
    expect(useSession.getState().session).toEqual({
      status: 'phone-required',
      bindToken: 'bind-1',
    });

    await bindPhone('phone-code');
    expect(useSession.getState().session).toEqual({ status: 'signed-in', token: 't2' });
    expect(seen[1]?.body).toEqual({ bindToken: 'bind-1', phoneCode: 'phone-code' });
  });

  it('keeps the bindToken when WeChat refuses the phone code (AUTH-007)', async () => {
    const { bindPhone, serveApi, startSession, useSession } = await load();
    serveApi({
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ body: phoneRequired }),
      'POST /api/v1/auth/sessions/wechat-mini/phone': () => ({
        status: 400,
        body: { code: 'AUTH_WECHAT_CODE_INVALID', message: '授权已失效，请重试' },
      }),
    });

    await startSession();
    await expect(bindPhone('stale')).rejects.toThrow('授权已失效，请重试');
    expect(useSession.getState().session).toEqual({
      status: 'phone-required',
      bindToken: 'bind-1',
    });
  });

  it('starts over with a new wx.login when the bindToken expired', async () => {
    const { bindPhone, serveApi, startSession, useSession } = await load();
    let logins = 0;
    serveApi({
      'POST /api/v1/auth/sessions/wechat-mini': () => {
        logins += 1;
        return { body: logins === 1 ? phoneRequired : { ...phoneRequired, bindToken: 'bind-2' } };
      },
      'POST /api/v1/auth/sessions/wechat-mini/phone': () => ({
        status: 400,
        body: { code: 'AUTH_WECHAT_BIND_EXPIRED', message: '登录已过期' },
      }),
    });

    await startSession();
    await bindPhone('late');
    expect(useSession.getState().session).toEqual({
      status: 'phone-required',
      bindToken: 'bind-2',
    });
  });

  it('renews an expired token once and replays the read that met it', async () => {
    const { serveApi, startSession, taroFake, useSession } = await load();
    taroFake.storage.set('shop.session.token', 'expired');
    taroFake.storage.set('shop.session.user', '7');
    const count = { items: 2, quantity: 3, availableCount: 2, unavailableCount: 0 };
    const seen = serveApi({
      'GET /api/v1/cart/count': () =>
        seen.at(-1)?.headers['Authorization'] === 'Bearer fresh'
          ? { body: count }
          : { status: 401, body: { code: 'UNAUTHENTICATED', message: '请先登录' } },
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ body: signedIn('fresh') }),
    });
    const { api } = await import('@/data/api');

    await startSession();
    await expect(api.call('cart.count')).resolves.toEqual(count);

    expect(seen.map((request) => request.key)).toEqual([
      'GET /api/v1/cart/count',
      'POST /api/v1/auth/sessions/wechat-mini',
      'GET /api/v1/cart/count',
    ]);
    expect(useSession.getState().session).toEqual({ status: 'signed-in', token: 'fresh' });
    expect(taroFake.storage.get('shop.session.token')).toBe('fresh');
  });

  it('replays a write too, and requests that 401 together share one renewal', async () => {
    const { serveApi, startSession, taroFake } = await load();
    taroFake.storage.set('shop.session.token', 'expired');
    taroFake.storage.set('shop.session.user', '7');
    const seen = serveApi({
      'DELETE /api/v1/cart/items/5': () =>
        seen.at(-1)?.headers['Authorization'] === 'Bearer fresh'
          ? { status: 204, body: null }
          : { status: 401, body: { code: 'UNAUTHENTICATED', message: '请先登录' } },
      'DELETE /api/v1/cart/items/6': () =>
        seen.at(-1)?.headers['Authorization'] === 'Bearer fresh'
          ? { status: 204, body: null }
          : { status: 401, body: { code: 'UNAUTHENTICATED', message: '请先登录' } },
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ body: signedIn('fresh') }),
    });
    const { api } = await import('@/data/api');

    await startSession();
    await Promise.all([
      api.call('cart.removeItem', { params: { id: '5' } }),
      api.call('cart.removeItem', { params: { id: '6' } }),
    ]);

    const keys = seen.map((request) => request.key);
    expect(keys.filter((key) => key.startsWith('POST'))).toHaveLength(1);
    expect(keys.filter((key) => key === 'DELETE /api/v1/cart/items/5')).toHaveLength(2);
    expect(keys.filter((key) => key === 'DELETE /api/v1/cart/items/6')).toHaveLength(2);
  });

  it('gives up after one replay: a second 401 stands and the shopper is signed out', async () => {
    const { serveApi, startSession, taroFake, useSession } = await load();
    taroFake.storage.set('shop.session.token', 'revoked');
    taroFake.storage.set('shop.session.user', '7');
    const seen = serveApi({
      'GET /api/v1/cart/count': () => ({
        status: 401,
        body: { code: 'UNAUTHENTICATED', message: '请先登录' },
      }),
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ body: signedIn('fresh') }),
    });
    const { api } = await import('@/data/api');

    await startSession();
    await expect(api.call('cart.count')).rejects.toMatchObject({ status: 401 });

    expect(seen.map((request) => request.key)).toEqual([
      'GET /api/v1/cart/count',
      'POST /api/v1/auth/sessions/wechat-mini',
      'GET /api/v1/cart/count',
    ]);
    // Not `idle`: nothing is signing in, and the login card must offer 登录, not 登录中….
    expect(useSession.getState().session).toEqual({ status: 'signed-out' });
  });

  it('signs in once when an action asks for a session while a renewal is under way', async () => {
    const { serveApi, startSession, taroFake, useSession } = await load();
    const { holdRequests } = await import('@/test/fake-api');
    taroFake.storage.set('shop.session.token', 'expired');
    taroFake.storage.set('shop.session.user', '7');
    const seen = serveApi({
      'GET /api/v1/cart/count': (_body, request) =>
        request.headers.Authorization === 'Bearer fresh'
          ? { body: { items: 0, quantity: 0, availableCount: 0, unavailableCount: 0 } }
          : { status: 401, body: { code: 'UNAUTHENTICATED', message: '请先登录' } },
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ body: signedIn('fresh') }),
    });
    const { api } = await import('@/data/api');
    await startSession();
    const held = holdRequests('/auth/sessions/wechat-mini');

    const count = api.call('cart.count');
    await vi.waitFor(() => expect(useSession.getState().session.status).toBe('signing-in'));
    // 加入购物车 tapped meanwhile: `requireLogin` starts a session.
    const tapped = startSession();
    await vi.waitFor(() => {
      held.release();
      expect(useSession.getState().session).toEqual({ status: 'signed-in', token: 'fresh' });
    });
    await Promise.all([count, tapped]);

    expect(seen.filter((r) => r.key === 'POST /api/v1/auth/sessions/wechat-mini')).toHaveLength(1);
  });

  it('does not renew when renewal ends at the phone step', async () => {
    const { serveApi, startSession, taroFake, useSession } = await load();
    taroFake.storage.set('shop.session.token', 'expired');
    taroFake.storage.set('shop.session.user', '7');
    const seen = serveApi({
      'GET /api/v1/cart/count': () => ({
        status: 401,
        body: { code: 'UNAUTHENTICATED', message: '请先登录' },
      }),
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ body: phoneRequired }),
    });
    const { api } = await import('@/data/api');

    await startSession();
    await expect(api.call('cart.count')).rejects.toMatchObject({ status: 401 });

    expect(seen).toHaveLength(2); // no replay without a token
    expect(useSession.getState().session).toEqual({
      status: 'phone-required',
      bindToken: 'bind-1',
    });
  });

  it('reports a failed wx.login', async () => {
    const { serveApi, startSession, useSession } = await load();
    serveApi({
      'POST /api/v1/auth/sessions/wechat-mini': () => ({
        status: 502,
        body: { code: 'AUTH_WECHAT_UNAVAILABLE', message: '微信服务暂不可用' },
      }),
    });
    await startSession();
    expect(useSession.getState().session).toEqual({
      status: 'failed',
      message: '微信服务暂不可用',
    });
  });

  it("says 登录失败 in Chinese when wx.login itself fails with WeChat's plain errMsg object", async () => {
    const { startSession, taroFake, useSession } = await load();
    taroFake.loginError = 'login:fail timeout';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await startSession();
    expect(useSession.getState().session).toEqual({
      status: 'failed',
      message: '登录失败，请重试',
    });
  });

  it('signs in with a password from a parked sign-in, as wechat-mini, passing its bindToken (AUTH-009)', async () => {
    const { serveApi, signInWithPassword, startSession, taroFake, useSession } = await load();
    const seen = serveApi({
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ body: phoneRequired }),
      'POST /api/v1/auth/sessions/password': () => ({ status: 201, body: passwordSession }),
    });
    await startSession();

    await signInWithPassword('13900000000', 'secret-1');

    expect(useSession.getState().session).toEqual({ status: 'signed-in', token: 'pw1' });
    expect(taroFake.storage.get('shop.session.token')).toBe('pw1');
    expect(seen).toHaveLength(2);
    expect(seen[1]?.body).toEqual({
      account: '13900000000',
      password: 'secret-1',
      bindToken: 'bind-1',
    });
    expect(seen[1]?.headers['X-Client-Platform'] ?? seen[1]?.headers['x-client-platform']).toBe(
      'wechat-mini',
    );
  });

  it('sends no bindToken when nothing is parked', async () => {
    const { serveApi, signInWithPassword, useSession } = await load();
    const seen = serveApi({
      'POST /api/v1/auth/sessions/password': () => ({ status: 201, body: passwordSession }),
    });
    useSession.setState({ session: { status: 'signed-out' } });

    await signInWithPassword('u7', 'secret-1');

    expect(seen.map((request) => request.body)).toEqual([{ account: 'u7', password: 'secret-1' }]);
    expect(useSession.getState().session).toEqual({ status: 'signed-in', token: 'pw1' });
  });

  it.each(['AUTH_WECHAT_ALREADY_BOUND', 'AUTH_WECHAT_BIND_EXPIRED'])(
    'signs in once more without the bindToken when only the link is refused (%s)',
    async (code) => {
      const { serveApi, signInWithPassword, takeSignInHint, useSession } = await load();
      const seen = serveApi({
        'POST /api/v1/auth/sessions/password': (body) =>
          (body as { bindToken?: string }).bindToken
            ? {
                status: code === 'AUTH_WECHAT_ALREADY_BOUND' ? 409 : 400,
                body: { code, message: '-' },
              }
            : { status: 201, body: passwordSession },
      });
      useSession.setState({ session: { status: 'phone-required', bindToken: 'bind-1' } });

      await signInWithPassword('u7', 'secret-1');

      expect(seen.map((request) => request.body)).toEqual([
        { account: 'u7', password: 'secret-1', bindToken: 'bind-1' },
        { account: 'u7', password: 'secret-1' },
      ]);
      expect(useSession.getState().session).toEqual({ status: 'signed-in', token: 'pw1' });
      // The shopper hears why only when the WeChat belongs elsewhere (next launch signs in
      // there); an expired bindToken bound nothing, and the next launch asks again. Once.
      expect(takeSignInHint()).toBe(
        code === 'AUTH_WECHAT_ALREADY_BOUND' ? '此微信已关联其他账号，本账号需用密码登录' : null,
      );
      expect(takeSignInHint()).toBeNull();
    },
  );

  it('leaves no hint after a linked password sign-in, and drops an untaken one on the next sign-in', async () => {
    const { serveApi, signInWithPassword, takeSignInHint, useSession } = await load();
    let refuse = true;
    serveApi({
      'POST /api/v1/auth/sessions/password': (body) =>
        refuse && (body as { bindToken?: string }).bindToken
          ? { status: 409, body: { code: 'AUTH_WECHAT_ALREADY_BOUND', message: '-' } }
          : { status: 201, body: passwordSession },
    });
    useSession.setState({ session: { status: 'phone-required', bindToken: 'bind-1' } });
    await signInWithPassword('u7', 'secret-1');

    refuse = false;
    useSession.setState({ session: { status: 'phone-required', bindToken: 'bind-2' } });
    await signInWithPassword('u7', 'secret-1');

    expect(takeSignInHint()).toBeNull();
  });

  it('does not retry a wrong password, and keeps the parked sign-in', async () => {
    const { serveApi, signInWithPassword, useSession } = await load();
    const seen = serveApi({
      'POST /api/v1/auth/sessions/password': () => ({
        status: 401,
        body: { code: 'AUTH_INVALID_CREDENTIALS', message: '账号或密码不正确' },
      }),
    });
    useSession.setState({ session: { status: 'phone-required', bindToken: 'bind-1' } });

    await expect(signInWithPassword('u7', 'wrong')).rejects.toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
    });
    expect(seen).toHaveLength(1);
    expect(useSession.getState().session).toEqual({
      status: 'phone-required',
      bindToken: 'bind-1',
    });
  });

  it('leaves the session alone when the password is refused', async () => {
    const { serveApi, signInWithPassword, useSession } = await load();
    serveApi({
      'POST /api/v1/auth/sessions/password': () => ({
        status: 401,
        body: { code: 'AUTH_INVALID_CREDENTIALS', message: '账号或密码不正确' },
      }),
    });
    useSession.setState({ session: { status: 'signed-out' } });

    await expect(signInWithPassword('u7', 'wrong')).rejects.toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
    });
    expect(useSession.getState().session).toEqual({ status: 'signed-out' });
  });
});

describe('AUTH-010 — a request that met a 401 is replayed only as the account that sent it', () => {
  const unauthenticated = { status: 401, body: { code: 'UNAUTHENTICATED', message: '请先登录' } };
  const added = { status: 201, body: { item: {}, cart: {} } };
  const addToCart = { body: { skuId: '21', quantity: 1 } };

  /** A shopper of account 7 whose stored token the server no longer honours. */
  async function expiredAs7() {
    const loaded = await load();
    loaded.taroFake.storage.set('shop.session.token', 'a-expired');
    loaded.taroFake.storage.set('shop.session.user', '7');
    return loaded;
  }

  function loginPages(calls: { api: string; args: unknown }[]) {
    return calls.filter(
      (call) =>
        call.api === 'navigateTo' && (call.args as { url: string }).url.includes('pages/login/'),
    );
  }

  it('replays a write as the same account, and opens no login page', async () => {
    const { serveApi, startSession, taroFake, useSession, useSessionNotice } = await expiredAs7();
    const seen = serveApi({
      'POST /api/v1/cart/items': () =>
        seen.at(-1)?.headers['Authorization'] === 'Bearer a-fresh' ? added : unauthenticated,
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ body: signedIn('a-fresh') }),
    });
    const { api } = await import('@/data/api');

    await startSession();
    await api.call('cart.addItem', addToCart);

    expect(seen.map((request) => request.key)).toEqual([
      'POST /api/v1/cart/items',
      'POST /api/v1/auth/sessions/wechat-mini',
      'POST /api/v1/cart/items',
    ]);
    expect(useSession.getState().session).toEqual({ status: 'signed-in', token: 'a-fresh' });
    expect(taroFake.storage.get('shop.session.user')).toBe('7');
    expect(loginPages(taroFake.calls)).toEqual([]);
    expect(useSessionNotice.getState().notice).toBeNull();
  });

  it('sends a write once when WeChat signs in to another account: signed out, that session revoked, the 401 raised, the login page opened with a hint', async () => {
    const { serveApi, startSession, taroFake, useSession, useSessionNotice } = await expiredAs7();
    const seen = serveApi({
      'POST /api/v1/cart/items': () => unauthenticated,
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ body: signedIn('b-token', other) }),
      'DELETE /api/v1/auth/sessions/current': () => ({ status: 204, body: null }),
    });
    const { api } = await import('@/data/api');

    await startSession();
    await expect(api.call('cart.addItem', addToCart)).rejects.toMatchObject({ status: 401 });

    const writes = seen.filter((request) => request.key === 'POST /api/v1/cart/items');
    expect(writes.map((request) => request.headers['Authorization'])).toEqual(['Bearer a-expired']);
    expect(useSession.getState().session).toEqual({ status: 'signed-out' });
    expect(taroFake.storage.has('shop.session.token')).toBe(false);
    expect(taroFake.storage.has('shop.session.user')).toBe(false);
    await vi.waitFor(() => expect(loginPages(taroFake.calls)).toHaveLength(1));
    // What the login page says, set before it opens (not a toast the failed call's own replaces).
    expect(useSessionNotice.getState().notice).toBe('登录已过期，请重新登录');
    // The other account's new session is ended, not kept.
    const revoked = seen.filter(
      (request) => request.key === 'DELETE /api/v1/auth/sessions/current',
    );
    expect(revoked.map((request) => request.headers['Authorization'])).toEqual(['Bearer b-token']);
  });

  it('opens the login page with the page the shopper was on, so signing in comes back to it', async () => {
    const { serveApi, startSession, taroFake } = await expiredAs7();
    taroFake.pageStack = [{ route: 'pages/product/index', options: { id: '12' } }];
    serveApi({
      'POST /api/v1/cart/items': () => unauthenticated,
      'POST /api/v1/auth/sessions/wechat-mini': () => ({
        status: 201,
        body: signedIn('b-token', other),
      }),
      'DELETE /api/v1/auth/sessions/current': () => ({ body: { ok: true } }),
    });
    const { api } = await import('@/data/api');

    await startSession();
    await expect(api.call('cart.addItem', addToCart)).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(loginPages(taroFake.calls)).toHaveLength(1));
    const url = (loginPages(taroFake.calls)[0]?.args as { url: string }).url;
    const redirect = new URLSearchParams(url.split('?')[1]).get('redirect');
    expect(JSON.parse(redirect ?? 'null')).toEqual({ route: 'product', params: { id: '12' } });
  });

  it('opens no second login page when the 401 came from the login page itself', async () => {
    const { serveApi, startSession, taroFake, useSessionNotice } = await expiredAs7();
    taroFake.pageStack = [{ route: 'pages/login/index', options: {} }];
    serveApi({
      'POST /api/v1/cart/items': () => unauthenticated,
      'POST /api/v1/auth/sessions/wechat-mini': () => ({
        status: 201,
        body: signedIn('b-token', other),
      }),
      'DELETE /api/v1/auth/sessions/current': () => ({ body: { ok: true } }),
    });
    const { api } = await import('@/data/api');

    await startSession();
    await expect(api.call('cart.addItem', addToCart)).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() =>
      expect(useSessionNotice.getState().notice).toBe('登录已过期，请重新登录'),
    );
    expect(loginPages(taroFake.calls)).toEqual([]);
  });

  it('gives every request that failed alongside the same answer: one wx.login, none replayed, one login page', async () => {
    const { serveApi, startSession, taroFake, useSession, useSessionNotice } = await expiredAs7();
    const seen = serveApi({
      'GET /api/v1/cart/count': () => unauthenticated,
      'POST /api/v1/cart/items': () => unauthenticated,
      'DELETE /api/v1/cart/items/5': () => unauthenticated,
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ body: signedIn('b-token', other) }),
      'DELETE /api/v1/auth/sessions/current': () => ({ status: 204, body: null }),
    });
    const { api } = await import('@/data/api');

    await startSession();
    const results = await Promise.allSettled([
      api.call('cart.count'),
      api.call('cart.addItem', addToCart),
      api.call('cart.removeItem', { params: { id: '5' } }),
    ]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    const keys = seen.map((request) => request.key);
    expect(keys.filter((key) => key === 'POST /api/v1/auth/sessions/wechat-mini')).toHaveLength(1);
    for (const key of [
      'GET /api/v1/cart/count',
      'POST /api/v1/cart/items',
      'DELETE /api/v1/cart/items/5',
    ])
      expect(
        keys.filter((seenKey) => seenKey === key),
        key,
      ).toHaveLength(1);
    expect(
      seen.some(
        (request) =>
          request.headers['Authorization'] === 'Bearer b-token' && !request.key.includes('/auth/'),
      ),
    ).toBe(false);
    expect(useSession.getState().session).toEqual({ status: 'signed-out' });
    await vi.waitFor(() => expect(loginPages(taroFake.calls)).toHaveLength(1));
    expect(useSessionNotice.getState().notice).toBe('登录已过期，请重新登录');
  });

  it('drops the notice once the shopper signs in again', async () => {
    const { serveApi, signInWithPassword, startSession, useSessionNotice } = await expiredAs7();
    serveApi({
      'POST /api/v1/cart/items': () => unauthenticated,
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ body: signedIn('b-token', other) }),
      'DELETE /api/v1/auth/sessions/current': () => ({ status: 204, body: null }),
      'POST /api/v1/auth/sessions/password': () => ({ status: 201, body: passwordSession }),
    });
    const { api } = await import('@/data/api');

    await startSession();
    await expect(api.call('cart.addItem', addToCart)).rejects.toMatchObject({ status: 401 });
    expect(useSessionNotice.getState().notice).toBe('登录已过期，请重新登录');

    await signInWithPassword('u7', 'secret-1');
    expect(useSessionNotice.getState().notice).toBeNull();
  });

  it('replays nothing after renewing a token stored with no account beside it', async () => {
    const { serveApi, startSession, taroFake, useSession } = await load();
    taroFake.storage.set('shop.session.token', 'legacy');
    const seen = serveApi({
      'POST /api/v1/cart/items': () => unauthenticated,
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ body: signedIn('fresh') }),
      'DELETE /api/v1/auth/sessions/current': () => ({ status: 204, body: null }),
    });
    const { api } = await import('@/data/api');

    await startSession();
    await expect(api.call('cart.addItem', addToCart)).rejects.toMatchObject({ status: 401 });

    expect(seen.filter((request) => request.key === 'POST /api/v1/cart/items')).toHaveLength(1);
    expect(useSession.getState().session).toEqual({ status: 'signed-out' });
    await vi.waitFor(() => expect(loginPages(taroFake.calls)).toHaveLength(1));
  });

  it("does not replay a stale token's request with another account's session, nor renew for it", async () => {
    const { serveApi, startSession, taroFake } = await expiredAs7();
    const seen = serveApi({
      'POST /api/v1/cart/items': () => {
        // Meanwhile account 8 signed in on this phone (退出, then 密码登录).
        taroFake.storage.set('shop.session.token', 'c-token');
        taroFake.storage.set('shop.session.user', '8');
        return unauthenticated;
      },
    });
    const { api } = await import('@/data/api');
    const { useSession } = await import('./session');

    await startSession();
    const sent = api.call('cart.addItem', addToCart);
    useSession.setState({ session: { status: 'signed-in', token: 'c-token' } });
    await expect(sent).rejects.toMatchObject({ status: 401 });

    expect(seen.map((request) => request.headers['Authorization'])).toEqual(['Bearer a-expired']);
    expect(taroFake.calls.some((call) => call.api === 'login')).toBe(false);
  });

  it('undoes another account the same way for 修改密码, which leaves the page itself', async () => {
    const { renewSession, serveApi, startSession, taroFake, useSession, useSessionNotice } =
      await expiredAs7();
    serveApi({
      'POST /api/v1/auth/sessions/wechat-mini': () => ({ body: signedIn('b-token', other) }),
      'DELETE /api/v1/auth/sessions/current': () => ({ status: 204, body: null }),
    });

    await startSession();
    await expect(renewSession()).resolves.toBeNull();

    expect(useSession.getState().session).toEqual({ status: 'signed-out' });
    expect(taroFake.storage.has('shop.session.token')).toBe(false);
    expect(loginPages(taroFake.calls)).toEqual([]);
    expect(useSessionNotice.getState().notice).toBeNull();
  });
});
