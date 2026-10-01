import type {
  DrawOp,
  Font,
  Measure,
  PosterImageKey,
  PosterLayout,
} from '@/features/share/poster-layout';

/**
 * Replays a poster layout (`features/share/poster-layout.ts`) onto a 2D context: the one piece
 * of drawing both builds share (the WeChat canvas node and the H5 DOM canvas speak the same
 * CanvasRenderingContext2D).
 */

/** CSS font shorthand for a layout `Font`, as the canvas takes it. */
export function fontString(font: Font): string {
  return `${font.weight === 'bold' ? 'bold ' : ''}${font.size}px sans-serif`;
}

/** A loaded picture and its natural size, for `cover` cropping. */
export interface LoadedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
}

export type PosterImages = Partial<Record<PosterImageKey, LoadedImage>>;

/** A `Measure` on a real context. */
export function canvasMeasure(ctx: CanvasRenderingContext2D): Measure {
  return (text, font) => {
    ctx.font = fontString(font);
    return ctx.measureText(text).width;
  };
}

function roundedPath(
  ctx: CanvasRenderingContext2D,
  op: { x: number; y: number; w: number; h: number; radius?: number },
) {
  const r = Math.min(op.radius ?? 0, op.w / 2, op.h / 2);
  ctx.beginPath();
  ctx.moveTo(op.x + r, op.y);
  ctx.arcTo(op.x + op.w, op.y, op.x + op.w, op.y + op.h, r);
  ctx.arcTo(op.x + op.w, op.y + op.h, op.x, op.y + op.h, r);
  ctx.arcTo(op.x, op.y + op.h, op.x, op.y, r);
  ctx.arcTo(op.x, op.y, op.x + op.w, op.y, r);
  ctx.closePath();
}

/** The source rectangle that fills `w × h` like CSS `object-fit: cover`. */
export function coverCrop(
  image: { width: number; height: number },
  w: number,
  h: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const scale = Math.max(w / image.width, h / image.height);
  const sw = w / scale;
  const sh = h / scale;
  return { sx: (image.width - sw) / 2, sy: (image.height - sh) / 2, sw, sh };
}

function drawOne(ctx: CanvasRenderingContext2D, op: DrawOp, images: PosterImages): void {
  switch (op.op) {
    case 'rect':
      ctx.fillStyle = op.color;
      if (op.radius) {
        roundedPath(ctx, op);
        ctx.fill();
      } else {
        ctx.fillRect(op.x, op.y, op.w, op.h);
      }
      return;
    case 'image': {
      const image = images[op.key];
      if (!image || image.width <= 0 || image.height <= 0) return;
      const crop = coverCrop(image, op.w, op.h);
      ctx.save();
      if (op.radius) {
        roundedPath(ctx, op);
        ctx.clip();
      }
      ctx.drawImage(image.source, crop.sx, crop.sy, crop.sw, crop.sh, op.x, op.y, op.w, op.h);
      ctx.restore();
      return;
    }
    case 'text':
      ctx.font = fontString(op.font);
      ctx.fillStyle = op.color;
      ctx.textAlign = op.align ?? 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(op.text, op.x, op.y);
      return;
    case 'line':
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y1);
      ctx.lineTo(op.x2, op.y2);
      ctx.stroke();
      return;
  }
}

/** Draws `layout` at `scale` device pixels per layout unit. */
export function drawPoster(
  ctx: CanvasRenderingContext2D,
  layout: PosterLayout,
  images: PosterImages,
  scale: number,
): void {
  ctx.save();
  ctx.scale(scale, scale);
  for (const op of layout.ops) drawOne(ctx, op, images);
  ctx.restore();
}

/** Device pixels per layout unit: a 600-wide layout becomes a 1200-pixel-wide picture. */
export const POSTER_SCALE = 2;
