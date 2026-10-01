'use client';

import { Skeleton } from 'antd';
import dynamic from 'next/dynamic';

import type { RichTextEditorProps } from './rich-text-editor';

/**
 * Rich text (HTML in, HTML out), lazy-loaded.
 *
 * ProseMirror and its plugins are ~200 kB; only the pages that actually open a
 * rich-text field pay for them. `ssr: false` because the editor needs a DOM.
 *
 * ```tsx
 * { kind: 'richText', name: 'description', label: '商品详情' }
 * ```
 */
const RichTextField = dynamic<RichTextEditorProps>(() => import('./rich-text-editor'), {
  ssr: false,
  loading: () => <Skeleton active paragraph={{ rows: 6 }} />,
});

export { RichTextField };
export type { RichTextEditorProps as RichTextFieldProps };
