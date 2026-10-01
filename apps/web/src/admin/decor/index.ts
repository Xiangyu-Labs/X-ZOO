/**
 * DIY v2 page decoration (店铺装修). The editor library (Puck) is an
 * implementation detail of this folder: the routes use `DecorEditor` /
 * `DecorPagePreview` (from `./editor`, loaded with `next/dynamic` — it carries
 * Puck and its CSS), the document conversion, the canvas-data and record
 * providers, never `@puckeditor/core` (an ESLint rule holds that).
 */
export {
  DecorCanvasDataProvider,
  createAdminCanvasData,
  type DecorCanvasData,
} from './canvas-data';
export type { DecorData } from './config';
export {
  DecorConversionError,
  UNKNOWN_BLOCK,
  canonicalJson,
  toPageDocument,
  toPuckData,
} from './document';
export {
  DecorRecordSourceProvider,
  createDecorRecordSource,
  type DecorRecord,
  type DecorRecordSource,
  type DecorTreeNode,
} from './records';
