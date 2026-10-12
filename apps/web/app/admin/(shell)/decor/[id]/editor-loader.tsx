'use client';

import { Spin } from 'antd';
import dynamic from 'next/dynamic';
import { decorDocumentGet } from '@shop/contracts/decor/decor.admin.contract';

import { useRouteQuery } from '@/admin/api/hooks';

/**
 * Client-only, in its own chunk: the editor library, its CSS and the blocks'
 * stylesheet load when an editor opens and never with the rest of the admin.
 */
const loadDecorEditor = () =>
  import('@/admin/decor/page-editor').then((mod) => mod.DecorPageEditor);

const DecorPageEditor = dynamic(loadDecorEditor, {
  ssr: false,
  loading: () => <Spin style={{ display: 'block', margin: '120px auto' }} />,
});

export function DecorEditorLoader({ id, previewUrl }: { id: string; previewUrl: string | null }) {
  // The document starts loading with the editor's chunk, not after it: the editor asks for the
  // same query and finds it under way or done.
  useRouteQuery(decorDocumentGet, { params: { id } });
  return <DecorPageEditor id={id} previewUrl={previewUrl} />;
}
