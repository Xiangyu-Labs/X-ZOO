import Taro from '@tarojs/taro';
import { create } from 'zustand';
import type { StorefrontRoute } from '@shop/api-client/routes';
import { readRouteParams, routeKeyOfPath } from './nav';

/** The 朋友圈 single-page mode (C10): anonymous, no login, no navigation. */
export const TIMELINE_SINGLE_PAGE_SCENE = 1154;

export interface LaunchContext {
  /** WeChat's scene value (1001 = 发现栏, 1047 = 扫小程序码, 1154 = 朋友圈单页…). */
  scene: number;
  isTimelineSinglePage: boolean;
  /** Where the shopper came in, as a catalogue route (`null` if the path is not one). */
  route: StorefrontRoute | null;
}

interface EnterOptions {
  path?: string;
  query?: Record<string, string | undefined>;
  scene?: number;
}

/** A launch / enter option set (`getEnterOptionsSync`) as a route, decoding a code's scene. */
export function decodeEnter(options: EnterOptions): LaunchContext {
  const scene = typeof options.scene === 'number' ? options.scene : 1001;
  const key = options.path ? routeKeyOfPath(options.path) : null;
  const route = key
    ? ({ route: key, params: readRouteParams(key, options.query ?? {}) } as StorefrontRoute)
    : null;
  return { scene, isTimelineSinglePage: scene === TIMELINE_SINGLE_PAGE_SCENE, route };
}

const WEAPP = process.env.TARO_ENV === 'weapp';

function readEnter(): EnterOptions {
  if (!WEAPP) return {};
  try {
    return Taro.getEnterOptionsSync() as EnterOptions;
  } catch {
    return {};
  }
}

/** The current launch context: set at launch, updated whenever the app comes back (onAppShow). */
export const useLaunchContext = create<LaunchContext>()(() => decodeEnter(readEnter()));

/** Keeps `useLaunchContext` current. Called once, from the app shell. */
export function installLaunchTracking(): void {
  if (!WEAPP) return;
  Taro.onAppShow((options) => useLaunchContext.setState(decodeEnter(options as EnterOptions)));
}
