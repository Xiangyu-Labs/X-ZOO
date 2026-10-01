import { isApiError } from '@shop/api-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { taroFake } from '@/test/taro-fake/taro';
import { installAuth } from './api';
import { uploadImage } from './upload';

const noAuth = {
  getToken: () => null,
  renew: () => Promise.resolve(null),
  onUnauthorized: () => undefined,
};

describe('uploadImage', () => {
  afterEach(() => installAuth(noAuth));

  it('posts one `file` part with the client headers and returns the file', async () => {
    installAuth({ ...noAuth, getToken: () => 'tok' });
    const result = await uploadImage('wxfile://tmp/a.jpg', 'review');
    expect(result.url).toBe('/uploads/a.png');
    expect(taroFake.calls[0]).toMatchObject({
      api: 'uploadFile',
      args: {
        url: '/api/v1/uploads?purpose=review',
        filePath: 'wxfile://tmp/a.jpg',
        name: 'file',
        header: { Authorization: 'Bearer tok', 'X-Client-Platform': 'wechat-mini' },
      },
    });
  });

  it('renews an expired session once and sends again', async () => {
    const renew = vi.fn(() => Promise.resolve('fresh'));
    installAuth({ ...noAuth, getToken: () => 'old', renew });
    const answers = [
      { statusCode: 401, data: '{"code":"UNAUTHENTICATED","message":"登录已过期"}' },
      {
        statusCode: 201,
        data: '{"url":"/uploads/b.png","name":"b.png","mime":"image/png","size":1,"width":1,"height":1}',
      },
    ];
    taroFake.upload = () => answers.shift() ?? { statusCode: 500, data: '' };
    await expect(uploadImage('wxfile://tmp/b.png', 'avatar')).resolves.toMatchObject({
      url: '/uploads/b.png',
    });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledWith('old'); // the session replays only as its sender (AUTH-010)
    const headers = taroFake.calls.map(
      (call) => (call.args as { header: Record<string, string> }).header['Authorization'],
    );
    expect(headers).toEqual(['Bearer old', 'Bearer fresh']);
  });

  it("rejects with the server's code and message", async () => {
    taroFake.upload = {
      statusCode: 413,
      data: '{"code":"STORAGE_FILE_TOO_LARGE","message":"图片不能超过 5 MB"}',
    };
    const error: unknown = await uploadImage('wxfile://tmp/c.png', 'refund').catch(
      (e: unknown) => e,
    );
    expect(isApiError(error) && error.code).toBe('STORAGE_FILE_TOO_LARGE');
    expect(isApiError(error) && error.message).toBe('图片不能超过 5 MB');
  });
});
