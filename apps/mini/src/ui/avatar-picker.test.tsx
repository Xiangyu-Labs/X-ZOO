import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { profileFixture } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import { AvatarPicker } from './avatar-picker';

describe('AvatarPicker', () => {
  it("uploads WeChat's avatar and saves it to the profile", async () => {
    taroFake.upload = { statusCode: 201, data: '{"url":"/uploads/avatar/x.png"}' };
    const seen = serveApi({ 'PUT /api/v1/profile': () => ({ body: profileFixture }) });
    const onChange = vi.fn();
    await renderPage(<AvatarPicker src={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '更换头像' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('/uploads/avatar/x.png'));
    const upload = taroFake.calls.find((call) => call.api === 'uploadFile');
    expect(upload?.args).toMatchObject({
      url: '/api/v1/uploads?purpose=avatar',
      filePath: 'wxfile://tmp/avatar.png',
    });
    expect(seen.find((request) => request.key === 'PUT /api/v1/profile')?.body).toEqual({
      avatarUrl: '/uploads/avatar/x.png',
    });
  });

  it('says so when the upload fails, and keeps the old picture', async () => {
    taroFake.upload = {
      statusCode: 429,
      data: '{"code":"STORAGE_UPLOAD_RATE_LIMITED","message":"上传太频繁"}',
    };
    serveApi({});
    const onChange = vi.fn();
    const { container } = await renderPage(
      <AvatarPicker src="/uploads/old.png" onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '更换头像' }));
    expect(await screen.findByText('上传失败')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/uploads/old.png');
  });
});
