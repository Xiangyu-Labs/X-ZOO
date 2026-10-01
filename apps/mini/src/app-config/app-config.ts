import { create } from 'zustand';
import { isApiError, type ResponseOf } from '@shop/api-client';
import { api } from '@/data/api';
import { assetUrl } from '@/lib/asset-url';
import { setServerTime } from '@/lib/server-clock';
import { setShareDefaults, setSubscribeTemplates, setWebviewDomains, storage } from '@/platform';
import { useThemeStore } from '@/theme/store';

/**
 * `GET /api/v1/app/config`: the launch payload (theme, tab bar, sign-in options, share card,
 * subscribe templates, web-view domains, 客服, splash).
 *
 * Cold start paints from the copy kept in storage, then asks the server with
 * `If-None-Match: W/"<version>"`: a 304 keeps the copy, a 200 replaces it. Offline, the copy
 * (or the built-in defaults) stands. Nothing waits on it: every consumer has a default.
 */
export type AppConfig = ResponseOf<'system.appConfigGet'>;

export const APP_CONFIG_KEY = 'shop.app-config';

interface AppConfigState {
  config: AppConfig | null;
  /** Where `config` came from; `none` until the storage copy or the server answered. */
  source: 'none' | 'cache' | 'network';
}

export const useAppConfigStore = create<AppConfigState>()(() => ({ config: null, source: 'none' }));

/** The app config, or `null` before any copy exists (first launch, still loading). */
export function useAppConfig(): AppConfig | null {
  return useAppConfigStore((state) => state.config);
}

export type AppDisplay = AppConfig['display'];

/** What the pages showed before the 页面显示 switches existed: everything. */
const DISPLAY_SHOWN: AppDisplay = {
  categorySubcategories: true,
  productReviews: true,
  productRecommendations: true,
  productServiceTags: true,
  productPoster: true,
};

/**
 * The 页面显示 switches (`storefront-appearance`). A copy stored by an older build, or sent by
 * an older server, may lack `display` or one of its keys: what is missing shows.
 */
export function displayOf(config: AppConfig | null): AppDisplay {
  const display: Partial<AppDisplay> | undefined = config?.display;
  return { ...DISPLAY_SHOWN, ...display };
}

/** `displayOf` the current app config. */
export function useDisplay(): AppDisplay {
  return displayOf(useAppConfig());
}

/** Hand a config to everything that reads it. */
export function applyAppConfig(config: AppConfig, source: 'cache' | 'network'): void {
  useAppConfigStore.setState({ config, source });
  useThemeStore.getState().applyAppearance(config.appearance);
  setSubscribeTemplates(config.subscribeScenes);
  setWebviewDomains(config.webviewDomains);
  const title = config.share.title || config.name;
  const imageUrl = assetUrl(config.share.image);
  setShareDefaults({ ...(title ? { title } : {}), ...(imageUrl ? { imageUrl } : {}) });
}

function readCache(): AppConfig | null {
  const raw = storage.get(APP_CONFIG_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    // A copy from an older build that lacks what this one reads is no copy.
    return typeof parsed.version === 'string' && parsed.appearance && parsed.subscribeScenes
      ? (parsed as AppConfig)
      : null;
  } catch {
    return null;
  }
}

let loading: Promise<void> | null = null;

/** Paint from storage, then refresh from the server. Concurrent calls share one run. */
export function loadAppConfig(): Promise<void> {
  loading ??= load().finally(() => {
    loading = null;
  });
  return loading;
}

async function load(): Promise<void> {
  const state = useAppConfigStore.getState();
  const cached = state.config ?? readCache();
  if (cached && state.source === 'none') applyAppConfig(cached, 'cache');
  try {
    const fresh = await api.call('system.appConfigGet', undefined, {
      headers: cached ? { 'If-None-Match': `W/"${cached.version}"` } : undefined,
    });
    // Only a fresh answer's time counts: the stored copy's is as old as the copy. A 304 has no
    // body; its `X-Server-Time` header is read by the transport (lib/server-clock).
    setServerTime(Date.parse(fresh.serverTime));
    storage.set(APP_CONFIG_KEY, JSON.stringify(fresh));
    applyAppConfig(fresh, 'network');
  } catch (error) {
    if (isApiError(error) && error.status === 304 && cached) {
      useAppConfigStore.setState({ source: 'network' });
    }
    // Anything else: the copy or the defaults stand; the next launch asks again.
  }
}
