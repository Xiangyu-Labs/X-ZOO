import type { Measure, PosterImageKey, PosterLayout } from '@/features/share/poster-layout';
import {
  canvasMeasure,
  drawPoster,
  POSTER_SCALE,
  type LoadedImage,
  type PosterImages,
} from './poster-draw';

/**
 * The share poster on the H5 builds (dev preview and the e2e mini emulation; never in the
 * WeChat package): an off-document canvas, pictures loaded directly (same origin, or CORS),
 * the picture as a data URL, and 保存到相册 as a download. Same functions as `poster.ts`.
 */

export type SaveOutcome = 'saved' | 'denied' | 'privacy' | 'cancelled' | 'failed';

export function saveOutcomeOf(_error: unknown): SaveOutcome {
  return 'failed';
}

export async function downloadPosterImage(url: string): Promise<string | null> {
  return url;
}

function loadImage(src: string): Promise<LoadedImage | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () =>
      resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

export async function renderPoster(
  _canvasId: string,
  build: (measure: Measure) => PosterLayout,
  sources: Partial<Record<PosterImageKey, string | null>>,
): Promise<string> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持画布');
  const layout = build(canvasMeasure(ctx));
  canvas.width = layout.width * POSTER_SCALE;
  canvas.height = layout.height * POSTER_SCALE;
  const images: PosterImages = {};
  for (const [key, src] of Object.entries(sources) as Array<[PosterImageKey, string | null]>) {
    if (!src) continue;
    const loaded = await loadImage(src);
    if (loaded) images[key] = loaded;
  }
  drawPoster(ctx, layout, images, POSTER_SCALE);
  return canvas.toDataURL('image/jpeg', 0.92);
}

export async function saveImageToAlbum(filePath: string): Promise<SaveOutcome> {
  const link = document.createElement('a');
  link.href = filePath;
  link.download = 'poster.jpg';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  return 'saved';
}

export async function openAlbumSetting(): Promise<boolean> {
  return false;
}
