import {
  descriptionHtmlOf,
  storedDescriptionBlocks,
  type DescriptionBlock,
} from '@shop/contracts/catalog/description';
import type { AdminProductForm } from '@shop/contracts/catalog/schemas';

import { sanitizeHtml } from '../kernel/sanitize-html';

export { descriptionHtmlOf };

/**
 * The blocks a product form saves: its `descriptionBlocks`, or, from a client
 * that sends only `descriptionHtml`, that HTML as one rich-text block. Every
 * rich-text block is sanitised; a block id the form repeats is made unique, so
 * the editor can tell the blocks apart when it reads them back.
 */
export function descriptionBlocksOf(
  body: Pick<AdminProductForm, 'descriptionHtml' | 'descriptionBlocks'>,
): DescriptionBlock[] {
  const input =
    body.descriptionBlocks ??
    (body.descriptionHtml.trim() === ''
      ? []
      : [{ id: 'html', type: 'richText' as const, html: body.descriptionHtml }]);
  const seen = new Set<string>();
  return input.map((block, index) => {
    const id = seen.has(block.id) ? `${block.id}-${index}` : block.id;
    seen.add(id);
    return block.type === 'richText'
      ? { id, type: 'richText', html: sanitizeHtml(block.html) }
      : { id, type: 'video', src: block.src, posterUrl: block.posterUrl ?? null };
  });
}

/** `descriptionHtml` and `descriptionBlocks` of a detail, from the stored row. */
export function descriptionOut(stored: { html: string; blocks: readonly DescriptionBlock[] }): {
  descriptionHtml: string;
  descriptionBlocks: DescriptionBlock[];
} {
  return {
    descriptionHtml: stored.html,
    descriptionBlocks: storedDescriptionBlocks(stored.html, stored.blocks),
  };
}
