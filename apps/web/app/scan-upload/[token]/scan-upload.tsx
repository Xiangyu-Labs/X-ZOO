'use client';

import { useRef, useState } from 'react';
import { storageScanUpload } from '@shop/contracts/storage/storage.storefront.contract';

import { ApiError } from '@/admin/api/errors';
import { uploadFile } from '@/admin/storage/upload';

type State =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'done'; url: string }
  | { kind: 'failed'; message: string };

/**
 * The page a phone lands on after scanning the 素材库 QR code.
 *
 * Deliberately not an admin page: no session, no shell, no antd — the phone
 * holds a single-use token in the URL and nothing else. The token is what
 * authorises the upload, it is consumed atomically by the first phone that
 * uses it, and a refused file releases it again so the operator does not have
 * to re-generate the code because they picked the wrong photo.
 *
 * Plain CSS rather than the admin theme: this renders in WeChat's browser on a
 * 360px screen, and pulling in the admin bundle for one file input would be
 * about 400 KB of nothing.
 */
export function ScanUploadPage({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const input = useRef<HTMLInputElement>(null);

  const send = async (file: File): Promise<void> => {
    setState({ kind: 'uploading' });
    try {
      const result = await uploadFile(storageScanUpload, { params: { token } }, file);
      setState({ kind: 'done', url: result.attachment.url });
    } catch (error) {
      setState({
        kind: 'failed',
        message: error instanceof ApiError ? error.message : '上传失败，请重试',
      });
    }
  };

  return (
    <main style={styles.page}>
      <h1 style={styles.title}>上传到素材库</h1>

      {state.kind === 'done' ? (
        <>
          <p style={styles.hint}>上传成功，可以回到电脑上继续操作了。</p>
          <img src={state.url} alt="" style={styles.preview} />
        </>
      ) : (
        <>
          <p style={styles.hint}>选择一张照片上传。这个二维码只能用一次，上传成功后就会失效。</p>
          <input
            ref={input}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void send(file);
            }}
          />
          <button
            type="button"
            style={styles.button}
            disabled={state.kind === 'uploading'}
            onClick={() => input.current?.click()}
          >
            {state.kind === 'uploading' ? '上传中…' : '选择照片'}
          </button>
          {state.kind === 'failed' && <p style={styles.error}>{state.message}</p>}
        </>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 480,
    margin: '0 auto',
    padding: '48px 24px',
    fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    textAlign: 'center',
  },
  title: { fontSize: 20, fontWeight: 600, marginBottom: 12 },
  hint: { color: '#666', fontSize: 14, lineHeight: 1.6, marginBottom: 32 },
  button: {
    width: '100%',
    padding: '14px 0',
    fontSize: 16,
    color: '#fff',
    background: '#1677ff',
    border: 'none',
    borderRadius: 8,
  },
  error: { color: '#cf1322', fontSize: 14, marginTop: 16 },
  preview: { maxWidth: '100%', borderRadius: 8, marginTop: 8 },
};
