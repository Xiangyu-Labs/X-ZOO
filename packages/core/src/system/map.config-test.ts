import { registerConfigTest, testSteps } from '../kernel/config-test';
import { safeFetch } from '../storage/index';
import { mapConfig } from './map.config';

/** Tencent's `status`, for the ones a key misconfiguration produces. */
const TENCENT_HINTS: Record<number, string> = {
  110: 'Key 设置了域名白名单，服务端调用请在控制台改成「授权 IP」或不限制',
  111: 'Key 开启了签名校验（SK），本系统不带签名，请在控制台关闭',
  112: '本服务器的 IP 不在 Key 的授权 IP 里',
  120: 'Key 每秒请求量已达上限',
  121: 'Key 今日调用量已达上限',
  190: 'Key 无效',
  199: 'Key 没有开启 WebServiceAPI',
  311: 'Key 格式错误',
};

/** Amap's `info`, same idea. */
const AMAP_HINTS: Record<string, string> = {
  INVALID_USER_KEY: 'Key 无效',
  USERKEY_PLAT_NOMATCH: '这是「Web 端（JS API）」的 Key，服务端 Key 要选「Web 服务」类型',
  INVALID_USER_IP: '本服务器的 IP 不在 Key 的 IP 白名单里',
  INVALID_USER_SIGNATURE: 'Key 开启了数字签名，本系统不带签名，请在控制台关闭',
  DAILY_QUERY_OVER_LIMIT: 'Key 今日调用量已达上限',
  SERVICE_NOT_AVAILABLE: 'Key 没有开通地理编码服务',
};

const TIMEOUT_MS = 5000;

/**
 * 地图设置 → 「测试服务端 Key」.
 *
 * Geocodes the default city with the server key: the call backend features
 * make with it, so the key's type, IP whitelist and quota are all checked at
 * once. The web key is restricted to the shop's domain, so it cannot be checked
 * from the server, and this test does not try.
 */
export function registerMapConfigTest(): void {
  registerConfigTest(mapConfig, {
    label: '测试服务端 Key',
    async run(ctx, config) {
      const t = testSteps(ctx);
      if (config.provider === 'none') {
        t.fail('检查配置', '「地图服务商」为不启用');
        return t.result();
      }
      const key = config.serverKey.trim();
      if (key === '') {
        t.fail('检查配置', '没有填写「服务端 Key」');
        return t.result();
      }
      const city = config.defaultCity.trim() || '北京市';

      await t.step(`查询「${city}」的坐标`, async () => {
        const query = new URLSearchParams({ address: city, key });
        const url =
          config.provider === 'tencent'
            ? `https://apis.map.qq.com/ws/geocoder/v1/?${query.toString()}`
            : `https://restapi.amap.com/v3/geocode/geo?${query.toString()}`;
        // The URL carries the key, so no error message may repeat it.
        const fetched = await safeFetch(url, { timeoutMs: TIMEOUT_MS, maxBytes: 64 * 1024 }).catch(
          (error: unknown) => {
            throw new Error(
              `连不上地图服务：${error instanceof Error ? error.message.replaceAll(key, '***') : '未知错误'}`,
            );
          },
        );
        const body = JSON.parse(Buffer.from(fetched.bytes).toString('utf8')) as Record<
          string,
          unknown
        >;
        return config.provider === 'tencent'
          ? readTencentGeocode(body, city)
          : readAmapGeocode(body, city);
      });
      return t.result();
    },
  });
}

export function readTencentGeocode(body: Record<string, unknown>, city: string): string {
  const status = Number(body['status'] ?? -1);
  if (status === 347) throw new Error(`Key 可用，但查不到「${city}」，检查「默认城市」`);
  if (status !== 0) {
    const hint = TENCENT_HINTS[status];
    throw new Error(
      `${hint ? `${hint}。` : ''}腾讯地图返回 ${status} ${String(body['message'] ?? '')}`,
    );
  }
  const result = (body['result'] ?? {}) as { location?: { lng?: number; lat?: number } };
  return `Key 可用；${city}：${result.location?.lng ?? '?'}, ${result.location?.lat ?? '?'}`;
}

export function readAmapGeocode(body: Record<string, unknown>, city: string): string {
  const info = String(body['info'] ?? '');
  if (String(body['status'] ?? '') !== '1') {
    const hint = AMAP_HINTS[info];
    throw new Error(`${hint ? `${hint}。` : ''}高德返回 ${String(body['infocode'] ?? '')} ${info}`);
  }
  const geocodes = (body['geocodes'] ?? []) as Array<{ location?: string }>;
  if (geocodes.length === 0) throw new Error(`Key 可用，但查不到「${city}」，检查「默认城市」`);
  return `Key 可用；${city}：${geocodes[0]!.location ?? '?'}`;
}
