import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { taroFake } from '@/test/taro-fake/taro';
import { ImageUploader } from './image-uploader';

function Harness({ max = 3, initial = [] as string[], onBusy = vi.fn() }) {
  const [urls, setUrls] = useState(initial);
  return (
    <>
      <ImageUploader
        value={urls}
        onChange={setUrls}
        max={max}
        purpose="review"
        onBusyChange={onBusy}
      />
      <output>{urls.join(',')}</output>
    </>
  );
}

describe('ImageUploader', () => {
  it('picks, uploads and lists the pictures, reporting when it is busy', async () => {
    taroFake.media = ['wxfile://tmp/1.jpg', 'wxfile://tmp/2.jpg'];
    let n = 0;
    taroFake.upload = () => ({
      statusCode: 201,
      data: JSON.stringify({ url: `/uploads/${(n += 1)}.jpg` }),
    });
    const onBusy = vi.fn();
    render(<Harness onBusy={onBusy} />);
    fireEvent.click(screen.getByRole('button', { name: '上传图片，还可以添加 3 张' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('/uploads/1.jpg,/uploads/2.jpg'),
    );
    expect(onBusy.mock.calls).toEqual([[true], [false]]);
    expect(screen.getByRole('button', { name: '上传图片，还可以添加 1 张' })).toBeTruthy();
    const chosen = taroFake.calls.find((call) => call.api === 'chooseMedia');
    expect(chosen?.args).toMatchObject({ count: 3 });
  });

  it('hides the add tile at the limit, previews and removes', () => {
    render(<Harness max={2} initial={['/uploads/a.jpg', '/uploads/b.jpg']} />);
    expect(screen.queryByRole('button', { name: /上传图片/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看第 2 张图片' }));
    expect(taroFake.calls).toContainEqual({
      api: 'previewImage',
      args: { urls: ['/uploads/a.jpg', '/uploads/b.jpg'], current: '/uploads/b.jpg' },
    });
    fireEvent.click(screen.getByRole('button', { name: '删除第 1 张图片' }));
    expect(screen.getByRole('status').textContent).toBe('/uploads/b.jpg');
  });

  it('keeps a failed picture with 重试, which uploads it again', async () => {
    taroFake.media = ['wxfile://tmp/1.jpg'];
    taroFake.upload = {
      statusCode: 500,
      data: '{"code":"STORAGE_WRITE_FAILED","message":"保存失败"}',
    };
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /上传图片/ }));
    const retry = await screen.findByRole('button', { name: '上传失败，点击重试' });
    expect(taroFake.calls).toContainEqual({
      api: 'showToast',
      args: expect.objectContaining({ title: '保存失败' }),
    });
    taroFake.upload = { statusCode: 201, data: '{"url":"/uploads/ok.jpg"}' };
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('/uploads/ok.jpg'));
    expect(screen.queryByRole('button', { name: '上传失败，点击重试' })).toBeNull();
  });

  it('does nothing when the shopper cancels the picker', async () => {
    taroFake.media = null;
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /上传图片/ }));
    await Promise.resolve();
    expect(taroFake.calls.some((call) => call.api === 'uploadFile')).toBe(false);
  });
});
