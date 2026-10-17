'use client';

import { Form, type FormInstance } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ProductParam, ProductSkuInput } from '@shop/contracts/catalog/schemas';
import type { RichTextProps } from '@shop/storefront-blocks';
import { RichText } from '@shop/storefront-blocks/admin';
import blocksCss from '@shop/storefront-blocks/admin-css';

import { CopyImage } from '@/admin/kit/image-copy';
import { isMoney, moneyToFen } from '@/admin/kit/money';

/**
 * 商品详情 as the mini-program draws it (`apps/mini/src/pages/product/index.tsx`), from what is
 * in the form right now: gallery, price, name, 参数 and the description.
 *
 * The description goes through the storefront's own 富文本 block — the same parser, allow-list
 * and picture style the mini-program uses (`RichContent`), not the editor's HTML — so a picture
 * that is cut or a paragraph that collapses there does so here too. It is drawn in its own
 * 375 px iframe, like the 装修 canvas: the blocks' sizes are in vw, which must measure the
 * phone, and the admin's styles must not reach in. Everything else is the page's layout at half
 * its 750-wide design px.
 */

type Slide = { video: string; poster: string | undefined } | { image: string };

const WIDTH = 375;
const HEIGHT = 720;

const FLAT: RichTextProps['style'] = { marginY: 'none', paddingX: 'none', radius: 'none' };
const EVERYONE: RichTextProps['visibility'] = { audience: 'all', platforms: [] };

const PAGE_CSS = `
html, body { margin: 0; padding: 0; }
body {
  -webkit-font-smoothing: antialiased;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', 'Microsoft YaHei', sans-serif;
  background: #f5f5f5;
  color: #1a1a1a;
}
*, *::before, *::after { box-sizing: border-box; }
.pp-nav { position: sticky; top: 0; z-index: 2; height: 44px; display: flex; align-items: center; justify-content: center; background: #fff; font-size: 16px; font-weight: 600; }
.pp-gallery { position: relative; width: 375px; height: 375px; background: #fff; cursor: pointer; }
.pp-gallery img, .pp-gallery video { display: block; width: 100%; height: 100%; object-fit: cover; }
.pp-gallery-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: #bbb; font-size: 13px; }
.pp-counter { position: absolute; right: 12px; bottom: 12px; padding: 1px 8px; border-radius: 999px; background: rgba(0,0,0,.45); color: #fff; font-size: 11px; line-height: 15px; }
.pp-summary { display: flex; flex-direction: column; gap: 6px; padding: 12px; background: #fff; }
.pp-price-row { display: flex; align-items: baseline; gap: 8px; }
.pp-price { color: #e1251b; font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
.pp-price small { font-size: 16px; }
.pp-price b { font-size: 26px; line-height: 1.1; font-weight: 600; }
.pp-strike { color: #707070; font-size: 12px; text-decoration: line-through; }
.pp-sales { margin-left: auto; color: #666; font-size: 12px; }
.pp-name { font-size: 16px; line-height: 22px; font-weight: 600; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.pp-subtitle { color: #666; font-size: 12px; line-height: 17px; }
.pp-cells { margin: 10px 12px 0; border-radius: 8px; background: #fff; overflow: hidden; }
.pp-cell { display: flex; gap: 12px; padding: 12px; font-size: 14px; line-height: 20px; }
.pp-cell + .pp-cell { border-top: 1px solid #f0f0f0; }
.pp-cell-title { flex: none; color: #666; }
.pp-cell-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-card { margin: 10px 12px 0; padding: 12px; border-radius: 8px; background: #fff; overflow: hidden; }
.pp-card-title { margin-bottom: 8px; font-size: 16px; line-height: 22px; font-weight: 600; }
.pp-muted { color: #707070; font-size: 14px; }
.pp-bar { position: sticky; bottom: 0; display: flex; gap: 8px; margin-top: 12px; padding: 8px 12px; background: #fff; box-shadow: 0 -1px 6px rgba(0,0,0,.06); }
.pp-bar span { flex: 1; height: 40px; border-radius: 999px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 15px; font-weight: 600; }
.pp-cart { background: #ff7e00; }
.pp-buy { background: #e1251b; }
`;

/** The lowest price among the SKUs a shopper can pick, as the storefront shows it. */
export function shownPrice(skus: readonly ProductSkuInput[]): string | null {
  let lowest: string | null = null;
  for (const sku of skus) {
    if (!sku.isVisible || !isMoney(sku.price)) continue;
    if (lowest === null || moneyToFen(sku.price) < moneyToFen(lowest)) lowest = sku.price;
  }
  return lowest;
}

/** 划线价 only when it is above the price, as `strikePrice` in the mini-program. */
function strikeOf(price: string | null, original: string | undefined): string | null {
  if (!price || !original || !isMoney(original)) return null;
  return moneyToFen(original) > moneyToFen(price) ? original : null;
}

/** `formatSales` in the mini-program. */
function salesText(count: number): string {
  if (count >= 10000) return `${(Math.floor(count / 1000) / 10).toString()}万`;
  return String(count);
}

function Price({ value }: { value: string }) {
  const [whole, fraction] = value.split('.');
  return (
    <span className="pp-price">
      <small>¥</small>
      <b>{whole}</b>
      <small>.{fraction}</small>
    </span>
  );
}

/** A 375 px document of its own, holding the storefront blocks' stylesheet. */
function PhoneFrame({ children }: { children: ReactNode }) {
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!frame) return;
    const attach = () => {
      const document = frame.contentDocument;
      if (!document?.body) return;
      if (!document.head.querySelector('style[data-product-preview]')) {
        const style = document.createElement('style');
        style.dataset.productPreview = '';
        style.textContent = PAGE_CSS + blocksCss;
        document.head.append(style);
      }
      setBody(document.body);
    };
    if (frame.contentDocument?.readyState === 'complete') attach();
    frame.addEventListener('load', attach);
    return () => frame.removeEventListener('load', attach);
  }, [frame]);
  return (
    <iframe
      ref={setFrame}
      title="商品详情预览"
      srcDoc="<!DOCTYPE html><html><head></head><body></body></html>"
      style={{
        width: WIDTH + 2,
        // A phone's height, or what the window leaves below the header and above the footer.
        height: `min(${HEIGHT}px, calc(100vh - 180px))`,
        border: '1px solid var(--ant-color-border-secondary)',
        borderRadius: 16,
        background: '#f5f5f5',
        display: 'block',
      }}
    >
      {body ? createPortal(children, body) : null}
    </iframe>
  );
}

export function ProductPreview({ form, sales = 0 }: { form: FormInstance; sales?: number }) {
  const name = Form.useWatch<string | undefined>('name', form);
  const subtitle = Form.useWatch<string | undefined>('subtitle', form);
  const imageUrl = Form.useWatch<string | undefined>('imageUrl', form);
  const sliderImages = Form.useWatch<string[] | undefined>('sliderImages', form);
  const videoUrl = Form.useWatch<string | undefined>('videoUrl', form);
  const videoPosterUrl = Form.useWatch<string | undefined>('videoPosterUrl', form);
  const originalPrice = Form.useWatch<string | undefined>('originalPrice', form);
  const boost = Form.useWatch<number | undefined>('displaySalesBoost', form);
  const skus = Form.useWatch<ProductSkuInput[] | undefined>('skus', form);
  const params = Form.useWatch<ProductParam[] | undefined>('params', form);
  const html = Form.useWatch<string | undefined>('descriptionHtml', form);
  const [slide, setSlide] = useState(0);

  const images =
    (sliderImages ?? []).length > 0 ? (sliderImages ?? []) : imageUrl ? [imageUrl] : [];
  // The main video is the first slide, as on the phone.
  const slides: Slide[] = [
    ...(videoUrl ? [{ video: videoUrl, poster: videoPosterUrl || imageUrl || undefined }] : []),
    ...images.map((image) => ({ image })),
  ];
  const current = slides.length > 0 ? slide % slides.length : 0;
  const shown = slides[current];
  const price = shownPrice(skus ?? []);
  const strike = strikeOf(price, originalPrice);
  const shownSales = sales + (boost ?? 0);
  const namedParams = (params ?? []).filter((param) => param.name.trim() !== '');

  return (
    <PhoneFrame>
      <div className="pp-nav">商品详情</div>
      <div
        className="pp-gallery"
        title={slides.length > 1 ? '点击看下一张' : undefined}
        onClick={() => setSlide(current + 1)}
      >
        {shown === undefined ? (
          <div className="pp-gallery-empty">还没有商品缩略图</div>
        ) : 'video' in shown ? (
          // Its own controls play and seek; a click on it does not turn the page.
          <video
            key={shown.video}
            src={shown.video}
            {...(shown.poster ? { poster: shown.poster } : {})}
            controls
            playsInline
            preload="metadata"
            data-testid="preview-video"
            onClick={(event) => event.stopPropagation()}
          />
        ) : (
          <CopyImage src={shown.image} copy={960} alt="" />
        )}
        {slides.length > 1 ? (
          <span className="pp-counter">
            {current + 1}/{slides.length}
          </span>
        ) : null}
      </div>

      <div className="pp-summary">
        <div className="pp-price-row">
          {price ? <Price value={price} /> : <span className="pp-muted">售价未填</span>}
          {strike ? <span className="pp-strike">¥{strike}</span> : null}
          {shownSales > 0 ? <span className="pp-sales">已售 {salesText(shownSales)}</span> : null}
        </div>
        <div className="pp-name">{name?.trim() || '商品名称'}</div>
        {subtitle?.trim() ? <div className="pp-subtitle">{subtitle}</div> : null}
      </div>

      <div className="pp-cells">
        <div className="pp-cell">
          <span className="pp-cell-title">已选</span>
          <span className="pp-cell-value">
            {(skus ?? []).length > 1 ? '请选择规格' : '默认规格'}
          </span>
        </div>
        {namedParams.length > 0 ? (
          <div className="pp-cell">
            <span className="pp-cell-title">参数</span>
            <span className="pp-cell-value">
              {namedParams
                .slice(0, 2)
                .map((param) => param.name)
                .join(' ')}
            </span>
          </div>
        ) : null}
      </div>

      <div className="pp-card">
        <div className="pp-card-title">商品详情</div>
        {html?.trim() ? (
          <RichText props={{ html, style: FLAT, visibility: EVERYONE }} />
        ) : (
          <span className="pp-muted">暂无图文详情</span>
        )}
      </div>

      <div className="pp-bar">
        <span className="pp-cart">加入购物车</span>
        <span className="pp-buy">立即购买</span>
      </div>
    </PhoneFrame>
  );
}

export default ProductPreview;
