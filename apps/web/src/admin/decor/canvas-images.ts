import { collectFields } from '@shop/contracts/decor/document';
import type { z } from 'zod';

/**
 * An image slot the operator has not filled yet (`image: ''`, as a new slide
 * or a template leaves it) is drawn on the canvas as a quiet placeholder, not
 * as a hole: the storefront component gets a picture to lay out, and the
 * operator sees where one goes. Canvas only — the document keeps `''`, which
 * the publish check refuses (`请选择图片`).
 */
export const IMAGE_PLACEHOLDER = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="750" height="400" viewBox="0 0 750 400">' +
    '<rect width="750" height="400" fill="#eeebe6"/>' +
    '<g fill="none" stroke="#b9b3aa" stroke-width="6" stroke-linejoin="round">' +
    '<rect x="327" y="140" width="96" height="76" rx="10"/>' +
    '<path d="M335 206l26-28 20 20 14-14 20 22"/></g>' +
    '<circle cx="400" cy="162" r="8" fill="#b9b3aa"/>' +
    '<text x="375" y="262" text-anchor="middle" font-family="sans-serif" font-size="26" fill="#9c958b">请选择图片</text>' +
    '</svg>',
)}`;

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let node: unknown = target;
  for (const key of keys.slice(0, -1)) {
    if (typeof node !== 'object' || node === null) return;
    node = (node as Record<string, unknown>)[key];
  }
  if (typeof node === 'object' && node !== null) {
    (node as Record<string, unknown>)[keys[keys.length - 1]!] = value;
  }
}

/** `props` with every empty image slot drawn as the placeholder; `props` itself when none is empty. */
export function withImagePlaceholders(
  schema: z.ZodType,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const empty = collectFields(schema, props, ['image']).filter((field) => field.value === '');
  if (empty.length === 0) return props;
  const copy = structuredClone(props);
  for (const field of empty) setPath(copy, field.path, IMAGE_PLACEHOLDER);
  return copy;
}
