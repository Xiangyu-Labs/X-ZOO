import { describe, expect, it } from 'vitest';
import { messageRoute } from './message';

describe('messageRoute', () => {
  it('reads a catalogue route and drops params it does not declare', () => {
    expect(
      messageRoute({ orderId: '1024', route: { route: 'order', params: { id: '1024', x: '1' } } }),
    ).toEqual({ route: 'order', params: { id: '1024' } });
  });

  it('is null for no route, an unknown key or a malformed value', () => {
    expect(messageRoute(null)).toBeNull();
    expect(messageRoute({ link: '/orders/1024' })).toBeNull();
    expect(messageRoute({ route: { route: 'nowhere', params: {} } })).toBeNull();
    expect(messageRoute({ route: 'order' })).toBeNull();
    expect(messageRoute({ route: { route: 'login', params: {} } })).toBeNull();
  });
});
