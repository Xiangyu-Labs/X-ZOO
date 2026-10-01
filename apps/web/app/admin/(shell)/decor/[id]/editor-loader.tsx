'use client';

import { Spin } from 'antd';
import dynamic from 'next/dynamic';

/**
 * Client-only, in its own chunk: the editor library, its CSS and the blocks'
 * stylesheet load when an editor opens and never with the rest of the admin.
 */
const DecorPageEditor = dynamic(
  () => import('@/admin/decor/page-editor').then((mod) => mod.DecorPageEditor),
  { ssr: false, loading: () => <Spin style={{ display: 'block', margin: '120px auto' }} /> },
);

export function DecorEditorLoader({ id, previewUrl }: { id: string; previewUrl: string | null }) {
  return <DecorPageEditor id={id} previewUrl={previewUrl} />;
}
