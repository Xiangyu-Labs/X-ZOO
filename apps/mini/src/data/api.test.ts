import { describe, expect, it } from 'vitest';
import { serveApi } from '@/test/fake-api';
import { api, CLIENT_VERSION } from './api';

describe('X-Client-Version', () => {
  it('is the version the build fixed (TARO_APP_VERSION), on every request', async () => {
    expect(CLIENT_VERSION).toBe('1.0.0-test');
    const seen = serveApi({
      'GET /api/v1/cart/count': () => ({
        body: { items: 0, quantity: 0, availableCount: 0, unavailableCount: 0 },
      }),
    });
    await api.call('cart.count');
    expect(seen[0]?.headers['X-Client-Version']).toBe('1.0.0-test');
  });
});
