/**
 * The only place that calls platform APIs (`Taro.*` beyond hooks and components). Pages and
 * components import from here.
 *
 * `./runtime` is the WeChat capabilities, one implementation per build (see `types.ts`): the
 * import must stay relative, because Taro's per-platform file resolution (`runtime.h5.tsx` on
 * H5) only applies to relative requests.
 */
export { navBarMetrics, type NavBarMetrics } from './chrome';
export { copyText } from './clipboard';
export { hideLoading, showLoading, showModal, showToast, type ModalOptions } from './feedback';
export {
  decodeEnter,
  installLaunchTracking,
  TIMELINE_SINGLE_PAGE_SCENE,
  useLaunchContext,
  type LaunchContext,
} from './launch';
export { chooseInvoiceTitle } from './invoice-title';
export { fromWechatInvoiceTitle, type ChosenInvoiceTitle } from './invoice-title-map';
export { onAppVisibility } from './lifecycle';
export { openLinkTarget } from './link';
export {
  currentRoute,
  onLoginPage,
  goBack,
  leaveFor,
  loginReturn,
  navigate,
  parseLoginRedirect,
  readRouteParams,
  returnFromLogin,
  routeKeyOfPath,
  takeTabParams,
  toPath,
  usePendingTabParams,
  usePreviewToken,
  useRouteParams,
  type RouteParamsOf,
  type StackPage,
} from './nav';
export { onNetworkReachability } from './network';
export { officialAccountBar } from './official-account';
export {
  agreePrivacy,
  disagreePrivacy,
  installPrivacyHandler,
  isPrivacyRefusal,
  openPrivacyContract,
  PRIVACY_AGREE_BUTTON_ID,
  PRIVACY_APIS,
  PRIVACY_PURPOSES,
  usePrivacyPrompt,
  type PrivacyApi,
} from './privacy';
export { scrollPageToTop, usePullToRefresh, useScrolledToBottom } from './page-scroll';
export { callPhone, previewImages } from './device';
export { PrivacyAgreeButton } from './privacy-button';
export { confirmReceipt, type ReceiptOutcome } from './receipt';
export { platform } from './runtime';
export {
  setShareDefaults,
  shareMessage,
  shareTimeline,
  useShare,
  type ShareContent,
} from './share';
export { NicknameField } from './nickname-field';
export { storage } from './storage';
export {
  MAX_TEMPLATES,
  onSubscribeResult,
  setSubscribeTemplates,
  subscribe,
  type SubscribeScene,
} from './subscribe';
export { applyCartBadge, applyTabBarLook, type TabBarLook } from './tab-bar';
export { TAB_PAGES, tabIndex, type TabKey } from './tab-pages';
export { px } from './units';
export { installUpdateManager } from './update';
export { isWebviewAllowed, openExternalLink, setWebviewDomains } from './webview';
export {
  PlatformUnsupportedError,
  type AvatarButtonProps,
  type AvatarResult,
  type ChosenAddress,
  type JsapiPayParams,
  type MiniPlatform,
  type OrderConfirmOutcome,
  type OrderConfirmTarget,
  type PaymentOutcome,
  type PaymentRequest,
  type PhoneCodeResult,
  type SubscribeResult,
  type UploadRequest,
  type UploadResponse,
} from './types';
export {
  downloadPosterImage,
  openAlbumSetting,
  renderPoster,
  saveImageToAlbum,
  type SaveOutcome,
} from './poster';
