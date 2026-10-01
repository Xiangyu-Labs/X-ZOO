'use client';

import { decorBlocks } from '@shop/contracts/decor/all-blocks';
import { DOCUMENT_KINDS, type DocumentKind } from '@shop/contracts/decor/constants';
import { checkDocument, pageRootProps, type StoredDocument } from '@shop/contracts/decor/document';
import {
  fixtureArticleList,
  fixtureArticles,
  fixtureCarousel,
  fixtureCouponList,
  fixtureCoupons,
  fixtureFloatingContact,
  fixtureFollowOfficialAccount,
  fixtureGroupbuyList,
  fixtureGroupbuys,
  fixtureHotspotImage,
  fixtureImageCube,
  fixtureNavGrid,
  fixtureNewcomerCoupon,
  fixtureNewUserCoupons,
  fixtureNotice,
  fixtureOrderEntry,
  fixturePresaleList,
  fixturePresales,
  fixtureProductGrid,
  fixtureProductTabs,
  fixtureRichText,
  fixtureSearchBar,
  fixtureServiceGrid,
  fixtureSpacer,
  fixtureTitleBar,
  fixtureUserCard,
  fixtureVideo,
  resolveFixtureProducts,
} from '@shop/storefront-blocks/fixtures';
import { BLOCKS, type BlockType } from '@shop/storefront-blocks/schema';
import { Alert, Card, Segmented, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';

import {
  DecorCanvasDataProvider,
  DecorRecordSourceProvider,
  toPageDocument,
  toPuckData,
  type DecorCanvasData,
  type DecorData,
} from '@/admin/decor';
import { DecorEditor } from '@/admin/decor/editor';
import { AssetSourceProvider } from '@/admin/kit/asset/asset-source-context';
import { PageContainer } from '@/admin/kit/page-container';
import { createDemoAssetSource } from '../kit/demo-asset-source';
import { createDecorDemoRecordSource } from './demo-data-source';

/**
 * `/admin/dev/decor-spike` — the decor component sandbox (was spike S3).
 *
 * The real editor (`DecorEditor`, every registered block, every inspector
 * control) over in-memory sources: fixture records for the canvas, fixture
 * records for the pickers, the demo 素材库. Beside it, the document the editor
 * would save and what `checkDocument` says of it. No route is called, so a
 * block or a control can be tried without a shop behind it; the storefront
 * fidelity script (`packages/storefront-blocks/fidelity`) shoots its canvas.
 */

/** One of every block, each from its fixture, at the version this build writes. */
const FIXTURE_BLOCKS: [BlockType, string, Record<string, unknown>][] = [
  ['searchBar', 'search-bar-1', fixtureSearchBar],
  ['carousel', 'carousel-1', fixtureCarousel],
  ['navGrid', 'nav-grid-1', fixtureNavGrid],
  ['notice', 'notice-1', fixtureNotice],
  ['titleBar', 'title-bar-1', fixtureTitleBar],
  ['productGrid', 'product-grid-1', fixtureProductGrid],
  ['imageCube', 'image-cube-1', fixtureImageCube],
  ['hotspotImage', 'hotspot-image-1', fixtureHotspotImage],
  ['productTabs', 'product-tabs-1', fixtureProductTabs],
  ['spacer', 'spacer-1', fixtureSpacer],
  ['richText', 'rich-text-1', fixtureRichText],
  ['userCard', 'user-card-1', fixtureUserCard],
  ['orderEntry', 'order-entry-1', fixtureOrderEntry],
  ['serviceGrid', 'service-grid-1', fixtureServiceGrid],
  ['couponList', 'coupon-list-1', fixtureCouponList],
  ['newcomerCoupon', 'newcomer-coupon-1', fixtureNewcomerCoupon],
  ['groupbuyList', 'groupbuy-list-1', fixtureGroupbuyList],
  ['presaleList', 'presale-list-1', fixturePresaleList],
  ['articleList', 'article-list-1', fixtureArticleList],
  ['video', 'video-1', fixtureVideo],
  ['floatingContact', 'floating-contact-1', fixtureFloatingContact],
  ['followOfficialAccount', 'follow-official-account-1', fixtureFollowOfficialAccount],
];

const FIXTURE_DOCUMENT: StoredDocument = {
  schemaVersion: 2,
  root: { props: pageRootProps.parse({ title: '装修试验页' }) },
  blocks: FIXTURE_BLOCKS.map(([type, id, props]) => ({ id, type, v: BLOCKS[type].v, props })),
};

/** Each need answered from the fixtures, as the storefront resolver would a guest. */
const canvasData: DecorCanvasData = {
  resolve: async (need) => {
    switch (need.kind) {
      case 'products':
        return resolveFixtureProducts(need.source);
      case 'coupons':
        return fixtureCoupons;
      case 'newUserCoupons':
        return fixtureNewUserCoupons.slice(0, need.limit);
      case 'groupbuys':
        return fixtureGroupbuys;
      case 'presales':
        return fixturePresales;
      case 'articles':
        return fixtureArticles;
      default:
        return null;
    }
  },
};
const assets = createDemoAssetSource();
const records = createDecorDemoRecordSource();

function DocumentPanel({ data, kind }: { data: DecorData; kind: DocumentKind }) {
  const result = useMemo(() => {
    try {
      const document = toPageDocument(data);
      return { document, check: checkDocument(document, { registry: decorBlocks, kind }) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [data, kind]);

  if ('error' in result) {
    return <Alert type="error" showIcon message="无法转换为页面文档" description={result.error} />;
  }
  const { document, check } = result;
  const issues = check.issues;
  return (
    <>
      {issues.length === 0 ? (
        <Alert
          type="success"
          showIcon
          message={`文档可发布：${document.blocks.length} 个组件`}
          style={{ marginBottom: 12 }}
        />
      ) : (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={`文档有 ${issues.length} 处问题`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }} data-testid="decor-issues">
              {issues.map((issue) => (
                <li key={`${issue.path}:${issue.message}`}>
                  <Typography.Text code>{issue.path}</Typography.Text> {issue.message}
                </li>
              ))}
            </ul>
          }
        />
      )}
      <pre
        data-testid="decor-document"
        style={{ fontSize: 12, maxHeight: 480, overflow: 'auto', margin: 0 }}
      >
        {JSON.stringify(document, null, 2)}
      </pre>
    </>
  );
}

export default function DecorSpike() {
  const [kind, setKind] = useState<DocumentKind>('custom');
  const [data, setData] = useState<DecorData>(() => toPuckData(FIXTURE_DOCUMENT));

  return (
    <AssetSourceProvider source={assets}>
      <DecorRecordSourceProvider source={records}>
        <DecorCanvasDataProvider value={canvasData}>
          <PageContainer
            title="装修组件沙盒"
            subTitle="真实编辑器 + 共享组件 + 375px 画布；数据全部来自内存"
            extra={<Tag color="orange">仅开发</Tag>}
          >
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="用于试组件与属性控件，不读写任何店铺数据"
              description="下方是店铺装修的同一个编辑器；切换页面类型可查看各类页面可用的组件。正式装修请到「店铺装修（新版）」。"
            />
            <Segmented
              style={{ marginBottom: 12 }}
              value={kind}
              options={Object.entries(DOCUMENT_KINDS).map(([value, label]) => ({ value, label }))}
              onChange={(value) => setKind(value as DocumentKind)}
            />
            {/* The editor gets the full width: Puck's two side panels plus a 375 px
                canvas need ~1100 px before it has to zoom the canvas out. */}
            <div
              style={{ height: 820, border: '1px solid #f0f0f0', marginBottom: 16 }}
              data-testid="decor-editor"
            >
              <DecorEditor
                key={kind}
                kind={kind}
                data={data}
                onChange={setData}
                toolbar={<Typography.Text strong>{DOCUMENT_KINDS[kind]}（沙盒）</Typography.Text>}
              />
            </div>
            <Card size="small" title="页面文档（schemaVersion 2）">
              <DocumentPanel data={data} kind={kind} />
            </Card>
          </PageContainer>
        </DecorCanvasDataProvider>
      </DecorRecordSourceProvider>
    </AssetSourceProvider>
  );
}
