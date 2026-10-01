import { z } from 'zod';
import { defineConfigGroup, type ConfigVisibleWhen } from '../kernel/config-registry';

/** The S3 credentials mean nothing on the local driver, so they are not shown. */
const S3_ONLY: ConfigVisibleWhen = { key: 'driver', equals: 's3' };
const LOCAL_ONLY: ConfigVisibleWhen = { key: 'driver', equals: 'local' };

/**
 * `storage` — where uploaded files go, and what is allowed through the door.
 *
 * There are two drivers: `local` and `s3`. Aliyun OSS, Tencent COS, Qiniu,
 * Huawei OBS and the other Chinese object stores are all S3-compatible, so a
 * shop on any of them fills in the S3 fields with that vendor's endpoint rather
 * than choosing among per-vendor drivers, each with its own config tab and its
 * own half-tested SDK.
 *
 * The limits are here rather than in code because they are the thing an
 * operator actually needs to change — "our photographer's JPEGs are 12MB" is a
 * config change, not a deploy.
 */
export const storageConfig = defineConfigGroup({
  group: 'storage',
  title: '存储设置',
  description: '上传驱动（本地 / S3）、大小上限与扫码上传。',
  category: 'integration',
  permission: 'system:config:read',
  schema: z.object({
    driver: z.enum(['local', 's3']).default('local'),

    /** Public prefix the edge serves the uploads root at. Local driver only. */
    localPublicPrefix: z.string().max(128).default('/uploads'),

    s3Bucket: z.string().max(128).default(''),
    s3Region: z.string().max(64).default(''),
    s3Endpoint: z.string().max(255).default(''),
    s3AccessKeyId: z.string().max(128).default(''),
    s3SecretAccessKey: z.string().max(128).default(''),
    /** Where objects are publicly readable from — usually a CDN domain. */
    s3PublicBaseUrl: z.string().max(255).default(''),
    /** Aliyun OSS and Tencent COS want virtual-host addressing; MinIO wants path. */
    s3Addressing: z.enum(['path', 'virtual']).default('virtual'),

    /** Admin uploads. 10MB by default. */
    maxUploadBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(500 * 1024 * 1024)
      .default(10 * 1024 * 1024),
    /** Storefront uploads, smaller: a review photo is not a video. */
    maxUserUploadBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(50 * 1024 * 1024)
      .default(5 * 1024 * 1024),
    /** Per shopper, per hour. Abuse control, not a quality gate. */
    userUploadsPerHour: z.number().int().min(1).max(500).default(30),

    /** How long a scan-upload QR code is good for. */
    scanTokenTtlSeconds: z.number().int().min(60).max(3600).default(600),

    /** Ceiling for `POST /admin-api/attachments/imports`. */
    remoteImportMaxBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(100 * 1024 * 1024)
      .default(20 * 1024 * 1024),
    remoteImportTimeoutMs: z.number().int().min(1000).max(30_000).default(8000),
    /**
     * Plain `http://` sources for 网址导入. Off: a plaintext fetch is whatever
     * file a man in the middle chose, and nothing would say so.
     */
    remoteImportAllowHttp: z.boolean().default(false),

    /**
     * Days an attachment nothing references may sit before the cleanup job
     * removes it. 0 disables the job.
     */
    orphanRetentionDays: z.number().int().min(0).max(365).default(7),
  }),
  status: (c) => {
    if (c.driver === 'local') return { tone: 'on', text: '本地存储' };
    return c.s3Bucket === '' || c.s3AccessKeyId === '' || c.s3SecretAccessKey === ''
      ? { tone: 'incomplete', text: 'S3 · 未填完' }
      : { tone: 'on', text: `S3 · ${c.s3Bucket}` };
  },
  ui: {
    driver: {
      label: '存储驱动',
      type: 'select',
      options: [
        { label: '本地磁盘', value: 'local' },
        { label: 'S3 兼容对象存储', value: 's3' },
      ],
      help: '阿里云 OSS、腾讯云 COS、七牛、华为 OBS、MinIO 都填 S3',
      order: 1,
    },
    localPublicPrefix: {
      label: '本地访问前缀',
      type: 'text',
      section: '本地',
      visibleWhen: LOCAL_ONLY,
      order: 10,
    },

    s3Bucket: { label: 'Bucket', type: 'text', section: 'S3', visibleWhen: S3_ONLY, order: 20 },
    s3Region: { label: 'Region', type: 'text', section: 'S3', visibleWhen: S3_ONLY, order: 21 },
    s3Endpoint: {
      label: 'Endpoint',
      type: 'text',
      section: 'S3',
      placeholder: 'https://oss-cn-hangzhou.aliyuncs.com',
      visibleWhen: S3_ONLY,
      order: 22,
    },
    s3AccessKeyId: {
      label: 'AccessKeyId',
      type: 'text',
      section: 'S3',
      visibleWhen: S3_ONLY,
      order: 23,
    },
    s3SecretAccessKey: {
      label: 'SecretAccessKey',
      type: 'password',
      secret: true,
      section: 'S3',
      visibleWhen: S3_ONLY,
      order: 24,
    },
    s3PublicBaseUrl: {
      label: '公网访问地址',
      type: 'text',
      section: 'S3',
      placeholder: 'https://cdn.example.com',
      visibleWhen: S3_ONLY,
      order: 25,
    },
    s3Addressing: {
      label: '寻址方式',
      type: 'select',
      section: 'S3',
      options: [
        { label: '虚拟主机（bucket.endpoint）', value: 'virtual' },
        { label: '路径（endpoint/bucket）', value: 'path' },
      ],
      visibleWhen: S3_ONLY,
      order: 26,
    },

    maxUploadBytes: {
      label: '后台上传大小上限',
      type: 'number',
      unit: 'bytes',
      section: '限制',
      order: 30,
    },
    maxUserUploadBytes: {
      label: '用户上传大小上限',
      type: 'number',
      unit: 'bytes',
      section: '限制',
      order: 31,
    },
    userUploadsPerHour: {
      label: '每用户每小时上传次数',
      type: 'number',
      section: '限制',
      order: 32,
    },

    scanTokenTtlSeconds: {
      label: '扫码上传有效期',
      type: 'number',
      unit: 'seconds',
      section: '扫码',
      order: 40,
    },

    remoteImportMaxBytes: {
      label: '网址导入大小上限',
      type: 'number',
      unit: 'bytes',
      section: '网址导入',
      order: 50,
    },
    remoteImportTimeoutMs: {
      label: '网址导入超时',
      type: 'number',
      unit: 'ms',
      section: '网址导入',
      order: 51,
    },
    remoteImportAllowHttp: {
      label: '允许 http 地址导入',
      type: 'switch',
      section: '网址导入',
      help: '默认只允许 https：明文传输的文件可能在途中被替换',
      order: 52,
    },

    orphanRetentionDays: {
      label: '孤儿素材保留天数',
      type: 'number',
      unit: 'days',
      section: '清理',
      help: '0 表示不自动清理',
      order: 60,
    },
  },
});
