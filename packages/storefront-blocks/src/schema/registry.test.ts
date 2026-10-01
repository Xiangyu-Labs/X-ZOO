import { describe, expect, it } from 'vitest';

import { BLOCK_COMPONENTS } from '../blocks';
import * as fixtures from '../fixtures';
import { BLOCKS, decorBlocks } from './index';

/** Each block type's fixture, by type. */
const BLOCK_FIXTURES: Record<string, unknown> = {
  searchBar: fixtures.fixtureSearchBar,
  carousel: fixtures.fixtureCarousel,
  navGrid: fixtures.fixtureNavGrid,
  notice: fixtures.fixtureNotice,
  imageCube: fixtures.fixtureImageCube,
  hotspotImage: fixtures.fixtureHotspotImage,
  titleBar: fixtures.fixtureTitleBar,
  productGrid: fixtures.fixtureProductGrid,
  productTabs: fixtures.fixtureProductTabs,
  richText: fixtures.fixtureRichText,
  spacer: fixtures.fixtureSpacer,
  userCard: fixtures.fixtureUserCard,
  orderEntry: fixtures.fixtureOrderEntry,
  serviceGrid: fixtures.fixtureServiceGrid,
  couponList: fixtures.fixtureCouponList,
  newcomerCoupon: fixtures.fixtureNewcomerCoupon,
  groupbuyList: fixtures.fixtureGroupbuyList,
  presaleList: fixtures.fixturePresaleList,
  articleList: fixtures.fixtureArticleList,
  video: fixtures.fixtureVideo,
  floatingContact: fixtures.fixtureFloatingContact,
  followOfficialAccount: fixtures.fixtureFollowOfficialAccount,
};

describe('the contracts block registry', () => {
  it('accepts every fixture unchanged, one per registered type', () => {
    expect(Object.keys(BLOCK_FIXTURES).sort()).toEqual([...decorBlocks.types].sort());
    for (const [type, fixture] of Object.entries(BLOCK_FIXTURES)) {
      expect(decorBlocks.get(type)?.props.parse(fixture), type).toEqual(fixture);
    }
    expect(fixtures.fixtureImageCubeRow).toEqual(
      decorBlocks.get('imageCube')?.props.parse(fixtures.fixtureImageCubeRow),
    );
  });

  it('has a component for every type this package claims, at the registry version', () => {
    for (const [type, spec] of Object.entries(BLOCKS)) {
      expect(BLOCK_COMPONENTS[type as keyof typeof BLOCKS]).toBeDefined();
      expect(spec.v).toBe(decorBlocks.get(type)?.v);
    }
  });

  it('has a component for every registered type', () => {
    expect(decorBlocks.types.filter((type) => !Object.hasOwn(BLOCK_COMPONENTS, type))).toEqual([]);
    expect(Object.keys(BLOCKS).sort()).toEqual([...decorBlocks.types].sort());
  });
});
