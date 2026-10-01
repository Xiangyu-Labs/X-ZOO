import { ApiError, buildUrl, CLIENT_ERROR_CODES, toApiError } from '@shop/api-client';
import type { UserUploadPurpose, UserUploadResult } from '@shop/contracts/storage/schemas';
import { platform } from '@/platform';
import { authHooks, CLIENT_VERSION } from './api';

const ROUTE_ID = 'storage.userUpload';

/**
 * `POST /api/v1/uploads?purpose=…` with one multipart part named `file` (the storage contract).
 * `wx.uploadFile` is not a `Taro.request`, so the client's transport cannot carry it: this
 * sends the same headers, renews an expired session once like the client does, and turns a
 * failure into the same `ApiError` a page already knows how to show.
 */
export async function uploadImage(
  filePath: string,
  purpose: UserUploadPurpose,
): Promise<UserUploadResult> {
  const url = buildUrl(platform.api.baseUrl, '/api/v1/uploads', undefined, { purpose });
  const send = async (token: string | null) => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Client-Platform': platform.api.clientPlatform,
      'X-Client-Version': CLIENT_VERSION,
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      return await platform.uploadFile({ url, filePath, name: 'file', headers });
    } catch (cause) {
      throw new ApiError({
        status: 0,
        code: CLIENT_ERROR_CODES.network,
        message: '上传失败，请检查网络后重试',
        details: cause instanceof Error ? cause.message : undefined,
        routeId: ROUTE_ID,
      });
    }
  };

  const hooks = authHooks();
  const token = hooks.getToken();
  let response = await send(token);
  if (response.status === 401 && token) {
    const renewed = await hooks.renew(token);
    if (renewed) response = await send(renewed);
  }
  const payload = parse(response.body);
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 401) hooks.onUnauthorized();
    throw toApiError(response.status, payload, ROUTE_ID);
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof (payload as { url?: unknown }).url !== 'string'
  ) {
    throw new ApiError({
      status: response.status,
      code: CLIENT_ERROR_CODES.parse,
      message: '服务器返回的数据无法解析',
      routeId: ROUTE_ID,
    });
  }
  return payload as UserUploadResult;
}

function parse(body: string): unknown {
  if (body === '') return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}
