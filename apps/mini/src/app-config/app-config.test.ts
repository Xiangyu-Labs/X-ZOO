import { beforeEach, describe, expect, it } from 'vitest';
import { serverNow } from '@/lib/server-clock';
import { isWebviewAllowed, subscribe } from '@/platform';
import { appConfigFixture } from '@/test/app-config-fixture';
import { serveApi } from '@/test/fake-api';
import { taroFake } from '@/test/taro-fake/taro';
import { useThemeStore } from '@/theme/store';
import { APP_CONFIG_KEY, displayOf, loadAppConfig, useAppConfigStore } from './app-config';

const config = appConfigFixture;

describe('app config', () => {
  beforeEach(() => useAppConfigStore.setState({ config: null, source: 'none' }));

  it('fetches, stores and applies the config on a first launch', async () => {
    const seen = serveApi({ 'GET /api/v1/app/config': () => ({ body: config }) });
    await loadAppConfig();
    expect(seen[0]?.headers['If-None-Match']).toBeUndefined();
    expect(useAppConfigStore.getState()).toMatchObject({
      source: 'network',
      config: { name: config.name },
    });
    expect(JSON.parse(taroFake.storage.get(APP_CONFIG_KEY) as string)).toMatchObject({
      version: config.version,
    });
    expect(useThemeStore.getState().revision).toBeGreaterThan(0);
  });

  it('paints from the stored copy, then keeps it on a 304', async () => {
    taroFake.storage.set(APP_CONFIG_KEY, JSON.stringify(config));
    const seen = serveApi({ 'GET /api/v1/app/config': () => ({ status: 304, body: '' }) });
    await loadAppConfig();
    expect(seen[0]?.headers['If-None-Match']).toBe(`W/"${config.version}"`);
    expect(useAppConfigStore.getState()).toMatchObject({
      source: 'network',
      config: { version: config.version },
    });
  });

  it('keeps the stored copy when the network fails, and ignores a copy from an older build', async () => {
    taroFake.storage.set(APP_CONFIG_KEY, JSON.stringify(config));
    serveApi({
      'GET /api/v1/app/config': () => ({ status: 502, body: '<html>502 Bad Gateway</html>' }),
    });
    await loadAppConfig();
    expect(useAppConfigStore.getState()).toMatchObject({ source: 'cache' });

    useAppConfigStore.setState({ config: null, source: 'none' });
    taroFake.storage.set(APP_CONFIG_KEY, JSON.stringify({ version: 'old' }));
    const seen = serveApi({
      'GET /api/v1/app/config': () => ({ status: 502, body: '<html>502 Bad Gateway</html>' }),
    });
    await loadAppConfig();
    expect(seen[0]?.headers['If-None-Match']).toBeUndefined();
    expect(useAppConfigStore.getState().config).toBeNull();
  });

  it('shares one request between launches that ask together', async () => {
    const seen = serveApi({ 'GET /api/v1/app/config': () => ({ body: config }) });
    await Promise.all([loadAppConfig(), loadAppConfig()]);
    expect(seen).toHaveLength(1);
  });

  it('hands the server-built subscribe scenes to subscribe()', async () => {
    serveApi({ 'GET /api/v1/app/config': () => ({ body: config }) });
    await loadAppConfig();
    await subscribe('refundApply');
    expect(taroFake.calls.find((call) => call.api === 'requestSubscribeMessage')).toMatchObject({
      args: { tmplIds: config.subscribeScenes.refundApply },
    });
  });

  it('opens only the configured web-view domains', async () => {
    serveApi({
      'GET /api/v1/app/config': () => ({
        body: { ...config, webviewDomains: ['h5.example.com'] },
      }),
    });
    await loadAppConfig();
    expect(isWebviewAllowed('https://h5.example.com/a')).toBe(true);
    expect(isWebviewAllowed('https://other.example.com/a')).toBe(false);
  });

  it('sets the server clock from a 200 body, and from the header of a bodyless 304', async () => {
    serveApi({ 'GET /api/v1/app/config': () => ({ body: config }) });
    await loadAppConfig();
    expect(Math.abs(serverNow() - Date.parse(config.serverTime))).toBeLessThan(5_000);

    const later = '2030-01-01T00:00:00.000Z';
    serveApi({
      'GET /api/v1/app/config': () => ({
        status: 304,
        body: '',
        headers: { 'X-Server-Time': later },
      }),
    });
    await loadAppConfig();
    expect(Math.abs(serverNow() - Date.parse(later))).toBeLessThan(5_000);
  });
});

describe('页面显示 switches', () => {
  it('reads each switch from the config', () => {
    const display = { ...config.display, productReviews: false, productPoster: false };
    expect(displayOf({ ...config, display })).toEqual(display);
  });

  it('shows everything a copy from an older server does not say', () => {
    expect(displayOf(null).productPoster).toBe(true);
    const { display: _dropped, ...older } = config;
    expect(Object.values(displayOf(older as typeof config)).every(Boolean)).toBe(true);
    const partial = { ...config, display: { categorySubcategories: false } };
    expect(displayOf(partial as unknown as typeof config)).toMatchObject({
      categorySubcategories: false,
      productPoster: true,
    });
  });
});
