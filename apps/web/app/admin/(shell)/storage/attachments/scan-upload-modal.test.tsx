import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { storageScanTokenCreate } from '@shop/contracts/storage/storage.admin.contract';

import { resetApiConfig } from '@/admin/api/config';
import { on, respondWithError, stubRoutes } from '@/test/api';
import { renderAdmin } from '@/test/render';

import { ScanUploadModal, qrValue } from './scan-upload-modal';

afterEach(() => {
  resetApiConfig();
});

describe('扫码上传', () => {
  it('says the code could not be had instead of spinning forever', async () => {
    stubRoutes([
      on(storageScanTokenCreate, () =>
        respondWithError(500, { code: 'INTERNAL', message: '服务暂时不可用' }),
      ),
    ]);
    renderAdmin(<ScanUploadModal onClose={vi.fn()} categoryId={undefined} />);

    expect(await screen.findByText('二维码获取失败')).toBeInTheDocument();
    expect(document.querySelector('.ant-spin')).toBeNull();
  });
});

describe('qrValue', () => {
  it('turns a bare route into an address a phone can open', () => {
    expect(qrValue('/scan-upload/abc', 'https://shop.example.com')).toBe(
      'https://shop.example.com/scan-upload/abc',
    );
  });

  it('leaves a full address alone', () => {
    expect(qrValue('https://m.example.com/up/abc', 'https://shop.example.com')).toBe(
      'https://m.example.com/up/abc',
    );
  });

  it('holds a placeholder while the token is being minted', () => {
    expect(qrValue(undefined, 'https://shop.example.com')).toBe('about:blank');
  });
});
