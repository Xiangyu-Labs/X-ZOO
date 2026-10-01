import type { AvatarResult, UploadRequest, UploadResponse } from './types';

/**
 * File handling for the H5 builds (dev and e2e): a file input stands in for `chooseMedia`,
 * `fetch` + `FormData` for `uploadFile`. Never part of the WeChat package.
 */

export function pickImages(count: number): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = count > 1;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])].slice(0, count);
      input.remove();
      resolve(files.map((file) => URL.createObjectURL(file)));
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve([]);
    });
    document.body.appendChild(input);
    input.click();
  });
}

export async function uploadWithFetch(request: UploadRequest): Promise<UploadResponse> {
  const blob = await (await fetch(request.filePath)).blob();
  const type = blob.type || 'image/png';
  const extension = type.split('/')[1] ?? 'png';
  const form = new FormData();
  form.append(request.name, new File([blob], `upload.${extension}`, { type }));
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: form,
  });
  return { status: response.status, body: await response.text() };
}

/** A generated avatar (initial on a colour), standing in for WeChat's picker. */
export function generatedAvatar(): Promise<AvatarResult> {
  const canvas = document.createElement('canvas');
  canvas.width = 132;
  canvas.height = 132;
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve({ ok: false, message: '无法生成头像' });
  const hue = Math.floor(Math.random() * 360);
  context.fillStyle = `hsl(${hue} 60% 55%)`;
  context.fillRect(0, 0, 132, 132);
  context.fillStyle = '#fff';
  context.font = '600 64px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('客', 66, 70);
  return new Promise((resolve) =>
    canvas.toBlob((blob) =>
      resolve(
        blob
          ? { ok: true, tempPath: URL.createObjectURL(blob) }
          : { ok: false, message: '无法生成头像' },
      ),
    ),
  );
}
