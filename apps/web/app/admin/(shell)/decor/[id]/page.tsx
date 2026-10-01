import type { Metadata } from 'next';
import { connection } from 'next/server';

import { loadEnv } from '@/server/env';
import { DecorEditorLoader } from './editor-loader';

export const metadata: Metadata = { title: '装修页面' };

/**
 * The editor is client-side end to end. The server contributes one thing: the
 * H5 preview URL template (`DECOR_PREVIEW_URL`), read per request so one build
 * serves both a dev/e2e stack that has an H5 build and production, which has
 * none and previews through the mini-program 体验版.
 */
export default async function DecorEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await connection();
  const previewUrl = loadEnv().DECOR_PREVIEW_URL || null;
  return <DecorEditorLoader id={id} previewUrl={previewUrl} />;
}
