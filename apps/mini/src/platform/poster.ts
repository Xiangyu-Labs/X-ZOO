import Taro from '@tarojs/taro';
import type { Measure, PosterImageKey, PosterLayout } from '@/features/share/poster-layout';
import {
  canvasMeasure,
  drawPoster,
  POSTER_SCALE,
  type LoadedImage,
  type PosterImages,
} from './poster-draw';
import { isPrivacyRefusal } from './privacy';

/**
 * The share poster on WeChat (design.md §4.4 PosterSheet, C04, C10): a canvas 2D node on the
 * page, pictures through `downloadFile` (the shop's downloadFile domain), the finished image as
 * a temporary file, and 保存到相册 behind the privacy prompt and the 相册 permission.
 *
 * The H5 builds use `poster.h5.ts` (Taro resolves it over this file): a DOM canvas and a
 * download link. Both answer the same functions.
 */

/** How 保存到相册 ended. `denied`: the 相册 permission was refused (去设置 can grant it). */
export type SaveOutcome = 'saved' | 'denied' | 'privacy' | 'cancelled' | 'failed';

/** A failed `saveImageToPhotosAlbum`, by what the shopper can do about it. */
export function saveOutcomeOf(error: unknown): SaveOutcome {
  if (isPrivacyRefusal(error)) return 'privacy';
  const message =
    typeof error === 'object' && error !== null && 'errMsg' in error
      ? String((error as { errMsg: unknown }).errMsg)
      : String(error);
  if (/auth ?den(y|ied)|authorize|permission/i.test(message)) return 'denied';
  if (/cancel/i.test(message)) return 'cancelled';
  return 'failed';
}

/** A picture for the poster as a local file (`null` when it cannot be fetched). */
export async function downloadPosterImage(url: string): Promise<string | null> {
  try {
    const result = await Taro.downloadFile({ url });
    return result.statusCode === 200 ? result.tempFilePath : null;
  } catch {
    return null;
  }
}

interface CanvasNode {
  width: number;
  height: number;
  getContext(kind: '2d'): CanvasRenderingContext2D;
  createImage(): {
    width: number;
    height: number;
    src: string;
    onload: (() => void) | null;
    onerror: (() => void) | null;
  };
}

async function findCanvas(canvasId: string): Promise<CanvasNode> {
  // The sheet has just rendered the canvas: give the view layer a few frames to create it.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const node = await new Promise<CanvasNode | null>((resolve) => {
      Taro.createSelectorQuery()
        .select(`#${canvasId}`)
        .fields({ node: true, size: true })
        .exec((result: Array<{ node?: CanvasNode } | null>) => resolve(result[0]?.node ?? null));
    });
    if (node) return node;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('海报画布未就绪');
}

function loadImage(canvas: CanvasNode, src: string): Promise<LoadedImage | null> {
  return new Promise((resolve) => {
    const image = canvas.createImage();
    image.onload = () =>
      resolve({
        source: image as unknown as CanvasImageSource,
        width: image.width,
        height: image.height,
      });
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/**
 * Draws the poster on the page's `<Canvas type="2d" id={canvasId}>` and returns the picture's
 * temporary file. `build` lays it out with the canvas's own text measure; `sources` are local
 * files from `downloadPosterImage` (a missing one leaves its placeholder).
 */
export async function renderPoster(
  canvasId: string,
  build: (measure: Measure) => PosterLayout,
  sources: Partial<Record<PosterImageKey, string | null>>,
): Promise<string> {
  const canvas = await findCanvas(canvasId);
  const ctx = canvas.getContext('2d');
  const layout = build(canvasMeasure(ctx));
  canvas.width = layout.width * POSTER_SCALE;
  canvas.height = layout.height * POSTER_SCALE;
  const images: PosterImages = {};
  for (const [key, src] of Object.entries(sources) as Array<[PosterImageKey, string | null]>) {
    if (!src) continue;
    const loaded = await loadImage(canvas, src);
    if (loaded) images[key] = loaded;
  }
  drawPoster(ctx, layout, images, POSTER_SCALE);
  const result = await Taro.canvasToTempFilePath({
    canvas: canvas as unknown as Taro.Canvas,
    fileType: 'jpg',
    quality: 0.92,
  } as Taro.canvasToTempFilePath.Option);
  return result.tempFilePath;
}

/** 保存到相册. WeChat shows the privacy prompt and asks for 相册 the first time. */
export async function saveImageToAlbum(filePath: string): Promise<SaveOutcome> {
  try {
    await Taro.saveImageToPhotosAlbum({ filePath });
    return 'saved';
  } catch (error) {
    return saveOutcomeOf(error);
  }
}

/**
 * 去设置 after a refused 相册 permission (must run from a tap). Resolves whether 相册 is now
 * allowed.
 */
export async function openAlbumSetting(): Promise<boolean> {
  try {
    const result = await Taro.openSetting();
    return result.authSetting['scope.writePhotosAlbum'] === true;
  } catch {
    return false;
  }
}
