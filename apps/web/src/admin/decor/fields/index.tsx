'use client';

import { HotspotField } from '../hotspot-field';
import { RichTextField } from '../rich-text-field';
import type { CustomFieldRenderers } from '../zod-to-puck';
import {
  ChoiceField,
  ColorField,
  GroupHeading,
  ImageField,
  MultiChoiceField,
  SwitchField,
  UnsupportedField,
  VideoField,
} from './basic';
import { LinkField } from './link';
import {
  ArticleSourceField,
  CouponSourceField,
  GroupbuySourceField,
  PresaleSourceField,
  ProductSourceField,
} from './sources';

/**
 * The inspector's own controls, by the kind `zodToPuckFields` asks for.
 *
 * They reuse the admin's pickers — `AssetPicker` (素材库) for images and videos, and the
 * record pickers over `DecorRecordSource` (`../records.tsx`) for products,
 * categories, labels, articles, coupons, campaigns and 微页面. The editor page
 * mounts the providers (`AssetSourceProvider` in the admin shell,
 * `DecorRecordSourceProvider` on the page).
 *
 * A new semantic kind is one renderer here plus its entry in
 * `SEMANTIC_FIELD_KINDS`; the type below does not compile until both exist.
 */
export const DECOR_CUSTOM_FIELDS: CustomFieldRenderers = {
  image: (props) => <ImageField {...props} />,
  video: (props) => <VideoField {...props} />,
  color: (props) => <ColorField {...props} />,
  link: (props) => <LinkField {...props} />,
  productSource: (props) => <ProductSourceField {...props} />,
  couponSource: (props) => <CouponSourceField {...props} />,
  groupbuySource: (props) => <GroupbuySourceField {...props} />,
  presaleSource: (props) => <PresaleSourceField {...props} />,
  articleSource: (props) => <ArticleSourceField {...props} />,
  richText: (props) => <RichTextField {...props} />,
  hotspots: (props) => <HotspotField {...props} renderLink={(link) => <LinkField {...link} />} />,
  switch: (props) => <SwitchField {...props} />,
  choice: (props) => <ChoiceField {...props} />,
  multiChoice: (props) => <MultiChoiceField {...props} />,
  groupHeading: (props) => <GroupHeading {...props} />,
  unsupported: (props) => <UnsupportedField {...props} />,
};
