import type { Metadata } from 'next';

import { ScanUploadPage } from './scan-upload';

export const metadata: Metadata = { title: '上传到素材库' };

/** The QR code's landing page. The token in the path is the only credential. */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ScanUploadPage token={token} />;
}
