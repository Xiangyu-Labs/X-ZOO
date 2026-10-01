/**
 * A fake `@tarojs/taro` for Vitest (aliased in vitest.config.mts). It implements the part of
 * the API the app uses and lets a test drive what the platform would: app show/hide, network
 * changes, page show/hide. Every platform call is recorded in `taroFake.calls`.
 *
 * Why a fake and not Taro's H5 implementation (`@tarojs/taro-h5`): the H5 build wires its
 * hooks and router up at app start, inside the webpack build; outside it `useDidShow` has no
 * page to attach to. A fake is also deterministic, which the lifecycle tests need.
 *
 * Grow it as the platform layer grows; plan: move it to `@shop/testing/taro` once
 * `packages/storefront-blocks` needs it too.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';

type Listener<T> = (value: T) => void;

class Channel<T> {
  private readonly listeners = new Set<Listener<T>>();
  on = (listener: Listener<T>): void => {
    this.listeners.add(listener);
  };
  off = (listener: Listener<T>): void => {
    this.listeners.delete(listener);
  };
  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
  get size(): number {
    return this.listeners.size;
  }
  clear(): void {
    this.listeners.clear();
  }
}

export interface NetworkStatus {
  isConnected: boolean;
  networkType: string;
}

const appShow = new Channel<unknown>();
const appHide = new Channel<void>();
const network = new Channel<NetworkStatus>();
const pageShow = new Channel<void>();
const pageHide = new Channel<void>();
/** Never emitted by a test: `useLoad` runs once, on mount. */
const pageLoad = new Channel<void>();
const pullDown = new Channel<void>();
const reachBottom = new Channel<void>();
const events = new Map<string, Set<(...args: unknown[]) => void>>();
let networkType = 'wifi';
type PrivacyResolve = (option: { event: string; buttonId?: string }) => void;
let privacyListener: ((resolve: PrivacyResolve, info: { referrer: string }) => void) | null = null;
const storageMap = new Map<string, unknown>();

/** What `Taro.request` answers; a test replaces it (`taroFake.onRequest = …`). */
export type RequestHandler = (option: {
  url: string;
  method: string;
  header: Record<string, string>;
  data?: string | undefined;
}) => RequestAnswer | Promise<RequestAnswer>;

interface RequestAnswer {
  statusCode: number;
  data: unknown;
  header?: Record<string, string>;
}

const unhandledRequest: RequestHandler = (option) => {
  throw new Error(`taro-fake: no request handler for ${option.method} ${option.url}`);
};
const DEFAULT_LOGIN_CODE = 'fake-login-code';

interface UploadAnswer {
  statusCode: number;
  data: string;
}

export interface RecordedCall {
  api: string;
  args: unknown;
}

/** The test-side controls. */
export const taroFake = {
  calls: [] as RecordedCall[],
  /** `Taro.login()` answers `{ code: loginCode }`. */
  loginCode: DEFAULT_LOGIN_CODE,
  /** `Taro.login()` rejects with WeChat's plain `{ errMsg }` object (not an `Error`). */
  loginError: null as string | null,
  onRequest: unhandledRequest,
  /** `Taro.requestPayment()` resolves, or rejects with this `errMsg`. */
  paymentError: null as string | null,
  /** `useRouter().params`. */
  routerParams: {} as Record<string, string>,
  /** What a tap on `<Button openType="getPhoneNumber">` reports. */
  phoneNumberDetail: { code: 'fake-phone-code', errMsg: 'getPhoneNumber:ok' } as {
    code?: string;
    errMsg: string;
    errno?: number;
  },
  /** What a tap on `<Button openType="chooseAvatar">` reports. */
  avatarDetail: { avatarUrl: 'wxfile://tmp/avatar.png', errMsg: 'chooseAvatar:ok' } as {
    avatarUrl?: string;
    errMsg: string;
  },
  /** How many pages `getCurrentPages()` reports (the stack depth; WeChat's limit is 10). */
  pageStackDepth: 1,
  /** What `getCurrentPages()` returns when a test needs routes (else `pageStackDepth` blanks). */
  pageStack: null as Array<Record<string, unknown>> | null,
  /** `showModal` answers confirm (`true`) or cancel. */
  modalConfirm: true,
  /** `setClipboardData` fails with this `errMsg`. */
  clipboardError: null as string | null,
  /** What `requestSubscribeMessage` answers per template id. */
  subscribeAnswer: 'accept' as 'accept' | 'reject' | 'ban' | 'filter',
  /** `chooseAddress` resolves with this, or rejects (`null`: the shopper cancelled). */
  address: null as Record<string, string> | null,
  /** `chooseInvoiceTitle` resolves with this, or rejects (`null`: the shopper cancelled). */
  invoiceTitle: null as Record<string, string> | null,
  /**
   * What the 确认收货 component (`openBusinessView`) reports as `extraData.status`; `hang`: its
   * callback never comes (the shopper is back through `onAppShow` only).
   */
  businessViewStatus: 'success' as 'success' | 'fail' | 'cancel' | 'hang',
  /** `chooseMedia` temp paths, or `null` for a cancel. */
  media: ['wxfile://tmp/1.jpg'] as string[] | null,
  /** How `saveImageToPhotosAlbum` ends: saved, 相册 refused, privacy refused, or cancelled. */
  album: 'ok' as 'ok' | 'deny' | 'privacy' | 'cancel',
  /** Whether 相册 is allowed after `openSetting` (the shopper flipped the switch). */
  albumSettingGranted: true,
  /** `uploadFile` answers this (a function: called per upload, for a sequence). */
  upload: { statusCode: 201, data: '{"url":"/uploads/a.png"}' } as
    | UploadAnswer
    | ((args: { filePath: string; url: string }) => UploadAnswer | Promise<UploadAnswer>),
  /** `getEnterOptionsSync()` / the next `onAppShow` payload. */
  enterOptions: { path: 'pages/index/index', query: {}, scene: 1001 } as {
    path: string;
    query: Record<string, string>;
    scene: number;
  },
  /** The share handlers the page registered (`useShareAppMessage` / `useShareTimeline`). */
  shareHandlers: { message: null, timeline: null } as {
    message: (() => unknown) | null;
    timeline: (() => unknown) | null;
  },
  storage: storageMap,
  /** The app comes back to the foreground, with WeChat's `onAppShow` options if given. */
  showApp: (options?: Record<string, unknown>) => appShow.emit(options),
  hideApp: () => appHide.emit(undefined),
  setNetwork(isConnected: boolean, type = isConnected ? 'wifi' : 'none') {
    networkType = type;
    network.emit({ isConnected, networkType: type });
  },
  /** Every mounted component's `useDidShow` runs, as when its page comes back. */
  showPage: () => pageShow.emit(undefined),
  pullDown: () => pullDown.emit(undefined),
  reachBottom: () => reachBottom.emit(undefined),
  hidePage: () => pageHide.emit(undefined),
  /**
   * WeChat raising `onNeedPrivacyAuthorization` (a private API called before consent). Returns
   * what the app resolved it with, as it arrives.
   */
  needPrivacy(referrer = 'chooseAddress') {
    const resolved: Array<{ event: string; buttonId?: string }> = [];
    privacyListener?.((option) => resolved.push(option), { referrer });
    return resolved;
  },
  listenerCounts: () => ({ appShow: appShow.size, appHide: appHide.size, network: network.size }),
  reset() {
    this.calls = [];
    this.loginCode = DEFAULT_LOGIN_CODE;
    this.loginError = null;
    this.onRequest = unhandledRequest;
    this.paymentError = null;
    this.routerParams = {};
    this.phoneNumberDetail = { code: 'fake-phone-code', errMsg: 'getPhoneNumber:ok' };
    this.avatarDetail = { avatarUrl: 'wxfile://tmp/avatar.png', errMsg: 'chooseAvatar:ok' };
    this.pageStackDepth = 1;
    this.pageStack = null;
    this.modalConfirm = true;
    this.clipboardError = null;
    this.subscribeAnswer = 'accept';
    this.address = null;
    this.invoiceTitle = null;
    this.media = ['wxfile://tmp/1.jpg'];
    this.album = 'ok';
    this.albumSettingGranted = true;
    this.businessViewStatus = 'success';
    this.upload = { statusCode: 201, data: '{"url":"/uploads/a.png"}' };
    this.enterOptions = { path: 'pages/index/index', query: {}, scene: 1001 };
    this.shareHandlers = { message: null, timeline: null };
    storageMap.clear();
    networkType = 'wifi';
    privacyListener = null;
    for (const channel of [
      appShow,
      appHide,
      network,
      pageShow,
      pageHide,
      pageLoad,
      pullDown,
      reachBottom,
    ])
      channel.clear();
    events.clear();
  },
};

/** A canvas 2D context that records nothing and measures every character 10 wide. */
function fakeContext2d(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, name) =>
        name === 'measureText'
          ? (text: string) => ({ width: [...text].length * 10 })
          : () => undefined,
      set: () => true,
    },
  );
}

function fakeCanvasNode() {
  return {
    width: 300,
    height: 150,
    getContext: () => fakeContext2d(),
    createImage() {
      const image = {
        width: 100,
        height: 100,
        onload: null as (() => void) | null,
        onerror: null as (() => void) | null,
        set src(_value: string) {
          void Promise.resolve().then(() => image.onload?.());
        },
      };
      return image;
    },
  };
}

function record<T>(api: string, args: unknown, result: T): Promise<T> {
  taroFake.calls.push({ api, args });
  return Promise.resolve(result);
}

function usePageLifecycle(channel: Channel<void>, callback: () => void, runOnMount: boolean) {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  useEffect(() => {
    const listener = () => latest.current();
    channel.on(listener);
    // A page's first onShow follows its onLoad.
    if (runOnMount) listener();
    return () => channel.off(listener);
  }, [channel, runOnMount]);
}

export function useDidShow(callback: () => void): void {
  usePageLifecycle(pageShow, callback, true);
}

export function useDidHide(callback: () => void): void {
  usePageLifecycle(pageHide, callback, false);
}

export function useLoad(callback: () => void): void {
  usePageLifecycle(pageLoad, callback, true);
}

export function useLaunch(callback: () => void): void {
  usePageLifecycle(pageLoad, callback, true);
}

/** `usePullDownRefresh` / `useReachBottom`: tests fire them with `taroFake.pullDown()` / `reachBottom()`. */
export function usePullDownRefresh(callback: () => void): void {
  usePageLifecycle(pullDown, callback, false);
}

export function useReachBottom(callback: () => void): void {
  usePageLifecycle(reachBottom, callback, false);
}

export function useShareAppMessage(handler: () => unknown): void {
  taroFake.shareHandlers.message = handler;
}

export function useShareTimeline(handler: () => unknown): void {
  taroFake.shareHandlers.timeline = handler;
}

function rejectWith(errMsg: string): Promise<never> {
  return Promise.reject(Object.assign(new Error(errMsg), { errMsg }));
}

export function useRouter() {
  return { path: '/pages/test/index', params: taroFake.routerParams };
}

export const eventCenter = {
  on(name: string, handler: (...args: unknown[]) => void) {
    const set = events.get(name) ?? new Set();
    set.add(handler);
    events.set(name, set);
  },
  off(name: string, handler?: (...args: unknown[]) => void) {
    if (handler) events.get(name)?.delete(handler);
    else events.delete(name);
  },
  trigger(name: string, ...args: unknown[]) {
    for (const handler of events.get(name) ?? []) handler(...args);
  },
};

export function getCurrentInstance() {
  return { router: { path: '/pages/test/index', params: {} }, page: null };
}

export function nextTick(callback: () => void): void {
  void Promise.resolve().then(callback);
}

const Taro = {
  onAppShow: appShow.on,
  offAppShow: appShow.off,
  onAppHide: appHide.on,
  offAppHide: appHide.off,
  onNetworkStatusChange: network.on,
  offNetworkStatusChange: network.off,
  getNetworkType: () => record('getNetworkType', undefined, { networkType }),
  setTabBarStyle: (args: unknown) => record('setTabBarStyle', args, {}),
  setTabBarBadge: (args: unknown) => record('setTabBarBadge', args, {}),
  removeTabBarBadge: (args: unknown) => record('removeTabBarBadge', args, {}),
  setTabBarItem: (args: unknown) => record('setTabBarItem', args, {}),
  navigateTo: (args: unknown) => record('navigateTo', args, {}),
  navigateToMiniProgram: (args: unknown) => record('navigateToMiniProgram', args, {}),
  redirectTo: (args: unknown) => record('redirectTo', args, {}),
  switchTab: (args: unknown) => record('switchTab', args, {}),
  reLaunch: (args: unknown) => record('reLaunch', args, {}),
  navigateBack: (args: unknown) => record('navigateBack', args, {}),
  getCurrentPages: () =>
    taroFake.pageStack ?? Array.from({ length: taroFake.pageStackDepth }, () => ({})),
  showModal: (args: unknown) =>
    record('showModal', args, { confirm: taroFake.modalConfirm, cancel: !taroFake.modalConfirm }),
  showLoading: (args: unknown) => record('showLoading', args, {}),
  hideLoading: () => record('hideLoading', undefined, {}),
  setClipboardData(args: unknown) {
    taroFake.calls.push({ api: 'setClipboardData', args });
    const errMsg = taroFake.clipboardError;
    return errMsg === null ? Promise.resolve({}) : rejectWith(errMsg);
  },
  requestSubscribeMessage(args: { tmplIds: string[] }) {
    taroFake.calls.push({ api: 'requestSubscribeMessage', args });
    const result: Record<string, string> = { errMsg: 'requestSubscribeMessage:ok' };
    for (const id of args.tmplIds) result[id] = taroFake.subscribeAnswer;
    return Promise.resolve(result);
  },
  chooseAddress() {
    taroFake.calls.push({ api: 'chooseAddress', args: undefined });
    const address = taroFake.address;
    return address ? Promise.resolve(address) : rejectWith('chooseAddress:fail cancel');
  },
  chooseInvoiceTitle() {
    taroFake.calls.push({ api: 'chooseInvoiceTitle', args: undefined });
    const title = taroFake.invoiceTitle;
    return title ? Promise.resolve(title) : rejectWith('chooseInvoiceTitle:fail cancel');
  },
  chooseMedia(args: unknown) {
    taroFake.calls.push({ api: 'chooseMedia', args });
    const media = taroFake.media;
    return media
      ? Promise.resolve({ tempFiles: media.map((tempFilePath) => ({ tempFilePath, size: 1 })) })
      : rejectWith('chooseMedia:fail cancel');
  },
  saveImageToPhotosAlbum(args: unknown) {
    taroFake.calls.push({ api: 'saveImageToPhotosAlbum', args });
    const errMsg = {
      ok: null,
      deny: 'saveImageToPhotosAlbum:fail auth deny',
      privacy: 'saveImageToPhotosAlbum:fail privacy permission is not authorized',
      cancel: 'saveImageToPhotosAlbum:fail cancel',
    }[taroFake.album];
    return errMsg === null ? Promise.resolve({}) : rejectWith(errMsg);
  },
  openSetting: () =>
    record('openSetting', undefined, {
      authSetting: { 'scope.writePhotosAlbum': taroFake.albumSettingGranted },
    }),
  /** `select('#id').fields({ node }).exec(cb)`: a canvas 2D node whose context draws nothing. */
  createSelectorQuery() {
    const query = {
      select: (selector: string) => ({
        fields: () => ({
          exec(callback: (result: unknown[]) => void) {
            taroFake.calls.push({ api: 'createSelectorQuery', args: selector });
            callback([{ node: fakeCanvasNode(), width: 300, height: 300 }]);
            return query;
          },
        }),
      }),
    };
    return query;
  },
  canvasToTempFilePath: (args: unknown) =>
    record('canvasToTempFilePath', args, { tempFilePath: 'wxfile://tmp/poster.jpg' }),
  uploadFile: async (args: { filePath: string; url: string }) => {
    const answer = taroFake.upload;
    return record('uploadFile', args, typeof answer === 'function' ? await answer(args) : answer);
  },
  downloadFile: (args: { url: string }) =>
    record('downloadFile', args, {
      statusCode: 200,
      tempFilePath: `wxfile://tmp/${args.url.split('/').pop()}`,
    }),
  openBusinessView: (args: unknown) =>
    taroFake.businessViewStatus === 'hang'
      ? (taroFake.calls.push({ api: 'openBusinessView', args }), new Promise<never>(() => {}))
      : record('openBusinessView', args, {
          errMsg: 'openBusinessView:ok',
          extraData: { status: taroFake.businessViewStatus },
        }),
  getEnterOptionsSync: () => taroFake.enterOptions,
  makePhoneCall: (args: unknown) => record('makePhoneCall', args, {}),
  getWindowInfo: () => ({ statusBarHeight: 20, windowWidth: 375, windowHeight: 812 }),
  getMenuButtonBoundingClientRect: () => ({ top: 24, left: 281, height: 32, width: 87 }),
  previewImage: (args: unknown) => record('previewImage', args, {}),
  stopPullDownRefresh: () => record('stopPullDownRefresh', undefined, {}),
  pageScrollTo: (args: unknown) => record('pageScrollTo', args, {}),
  getUpdateManager: () => ({
    onCheckForUpdate: () => undefined,
    onUpdateReady: () => undefined,
    onUpdateFailed: () => undefined,
    applyUpdate: () => undefined,
  }),
  login() {
    if (taroFake.loginError !== null) {
      taroFake.calls.push({ api: 'login', args: undefined });
      return Promise.reject({ errMsg: taroFake.loginError });
    }
    return record('login', undefined, { code: taroFake.loginCode, errMsg: 'login:ok' });
  },
  requestPayment(args: unknown) {
    taroFake.calls.push({ api: 'requestPayment', args });
    const errMsg = taroFake.paymentError;
    return errMsg === null
      ? Promise.resolve({ errMsg: 'requestPayment:ok' })
      : Promise.reject(Object.assign(new Error(errMsg), { errMsg }));
  },
  request(option: Parameters<RequestHandler>[0]) {
    taroFake.calls.push({ api: 'request', args: option });
    return Promise.resolve().then(() => taroFake.onRequest(option));
  },
  getStorageSync: (key: string): unknown => storageMap.get(key) ?? '',
  setStorageSync: (key: string, value: unknown) => void storageMap.set(key, value),
  removeStorageSync: (key: string) => void storageMap.delete(key),
  showToast: (args: unknown) => record('showToast', args, {}),
  pxTransform: (size: number) => `${size}rpx`,
  canIUse: (_schema: string) => true,
  onNeedPrivacyAuthorization(listener: typeof privacyListener) {
    privacyListener = listener;
  },
  openPrivacyContract: (args: unknown) => record('openPrivacyContract', args, {}),
  eventCenter,
  getCurrentInstance,
  nextTick,
  useDidShow,
  useDidHide,
  useLoad,
  useLaunch,
  useRouter,
  useShareAppMessage,
  useShareTimeline,
  usePullDownRefresh,
  useReachBottom,
};

export default Taro;
