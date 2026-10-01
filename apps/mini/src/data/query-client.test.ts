import { environmentManager, focusManager, onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { taroFake } from '@/test/taro-fake/taro';
import { ApiError } from '@shop/api-client';
import { installQueryAdapters, retryRead } from './query-client';

describe('installQueryAdapters', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => uninstall?.());

  it('follows the app to the background and back', () => {
    uninstall = installQueryAdapters();
    taroFake.hideApp();
    expect(focusManager.isFocused()).toBe(false);
    taroFake.showApp();
    expect(focusManager.isFocused()).toBe(true);
  });

  it('follows the network, seeded from getNetworkType', async () => {
    uninstall = installQueryAdapters();
    await Promise.resolve();
    expect(taroFake.calls.map((call) => call.api)).toContain('getNetworkType');
    taroFake.setNetwork(false);
    expect(onlineManager.isOnline()).toBe(false);
    taroFake.setNetwork(true);
    expect(onlineManager.isOnline()).toBe(true);
  });

  it('never treats the mini-program as a server', () => {
    uninstall = installQueryAdapters();
    expect(environmentManager.isServer()).toBe(false);
  });

  it('removes its platform listeners on uninstall', () => {
    installQueryAdapters()();
    expect(taroFake.listenerCounts()).toEqual({ appShow: 0, appHide: 0, network: 0 });
  });
});

describe('retryRead', () => {
  const failed = (status: number) => new ApiError({ status, code: 'X', message: '失败' });

  it('tries a read once more after a network failure or a server error', () => {
    expect(retryRead(0, failed(0))).toBe(true);
    expect(retryRead(0, failed(503))).toBe(true);
    expect(retryRead(0, new Error('timeout'))).toBe(true);
    expect(retryRead(1, failed(503))).toBe(false);
  });

  it('does not ask again for an answer that will not change (404 and other 4xx)', () => {
    expect(retryRead(0, failed(404))).toBe(false);
    expect(retryRead(0, failed(409))).toBe(false);
    expect(retryRead(0, failed(422))).toBe(false);
  });
});
