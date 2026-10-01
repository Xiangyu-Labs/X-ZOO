/**
 * `@shop/storefront-blocks` — the DIY v2 blocks, written once.
 *
 * Each block is a pure presentational Taro-React component: it renders the
 * props and resolved data it is given and reports taps through `onLink`. It
 * calls no Taro API and fetches nothing. The mini-program renders them
 * natively; the admin renders the same source in the Puck canvas through the
 * DOM shim (`@shop/storefront-blocks/dom`, bundled as `…/admin`).
 *
 * The prop schemas are under `./schema` (a separate entry: the blocks import
 * only their types, so no zod reaches a client bundle through here).
 */
export * from './blocks';
export type {
  ArticleListProps,
  ArticleSummary,
  BlockStyle,
  BlockType,
  CarouselProps,
  CouponListProps,
  CouponSummary,
  CouponUserState,
  FloatingContactProps,
  FollowOfficialAccountProps,
  GroupbuyListProps,
  GroupbuySummary,
  HeldCoupon,
  HotspotImageProps,
  ImageCubeProps,
  LinkTarget,
  NavGridProps,
  NewcomerCouponProps,
  NoticeProps,
  OrderEntryCounts,
  OrderEntryProps,
  PageDocument,
  PersonalSlot,
  PresaleListProps,
  PresaleSummary,
  ProductGridProps,
  ProductSummary,
  ProductTabsProps,
  RichTextProps,
  SearchBarProps,
  ServiceGridProps,
  SpacerProps,
  TitleBarProps,
  UserCardProps,
  UserSummary,
  VideoProps,
} from './schema';
