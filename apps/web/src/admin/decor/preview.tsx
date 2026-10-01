'use client';

import { ReloadOutlined } from '@ant-design/icons';
import type { DocumentKind } from '@shop/contracts/decor/constants';
import { decorPreviewToken } from '@shop/contracts/decor/decor.admin.contract';
import { Alert, Button, Drawer, Space, Spin, Typography } from 'antd';
import { useEffect } from 'react';

import { useRouteMutation } from '../api';
import { InstantText } from '../kit';
import { h5PreviewUrl, miniPreviewPath } from './session';

/**
 * 预览: the saved draft as the storefront renders it.
 *
 * A preview token (read-only, this document's draft, ten minutes) opens
 * `GET /api/v1/pages/:id?previewToken=`. Where an H5 build of the storefront
 * is served (dev, e2e) and `DECOR_PREVIEW_URL` says where, it is framed here
 * at phone width. Everywhere else — production — the operator opens the
 * mini-program 体验版 at the path shown, since the H5 build is not deployed.
 */

const FRAME_WIDTH = 375;
const FRAME_HEIGHT = 720;

export function PreviewDrawer({
  open,
  onClose,
  id,
  kind,
  previewUrl,
}: {
  open: boolean;
  onClose: () => void;
  id: string;
  kind: DocumentKind;
  /** The `DECOR_PREVIEW_URL` template, `null` when unset. */
  previewUrl: string | null;
}) {
  const token = useRouteMutation(decorPreviewToken);
  const { mutate, reset } = token;

  useEffect(() => {
    if (open) mutate({ params: { id } });
    else reset();
  }, [open, id, mutate, reset]);

  const issued = token.data;
  const frameUrl = issued
    ? h5PreviewUrl(previewUrl, { id, previewToken: issued.previewToken, kind })
    : null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="预览草稿"
      size={FRAME_WIDTH + 48}
      destroyOnHidden
      extra={
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={token.isPending}
          onClick={() => mutate({ params: { id } })}
        >
          刷新
        </Button>
      }
    >
      {token.isPending || (!issued && !token.isError) ? (
        <Spin style={{ display: 'block', margin: '80px auto' }} />
      ) : token.isError || !issued ? (
        <Alert type="error" showIcon title="无法生成预览，请稍后重试" />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {frameUrl ? (
            <iframe
              key={issued.previewToken}
              title="H5 预览"
              src={frameUrl}
              data-testid="decor-preview-frame"
              style={{
                width: FRAME_WIDTH,
                height: FRAME_HEIGHT,
                border: '1px solid #f0f0f0',
                borderRadius: 12,
                display: 'block',
              }}
            />
          ) : (
            <Alert
              type="info"
              showIcon
              title="请在小程序体验版中预览"
              description="正式环境不部署 H5 预览。在微信开发者工具或体验版中打开下面的页面路径，即可看到当前已保存的草稿（未发布，顾客看不到）。"
            />
          )}
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              体验版页面路径
            </Typography.Text>
            <Typography.Paragraph
              copyable
              code
              style={{ wordBreak: 'break-all', marginBottom: 0 }}
              data-testid="decor-preview-path"
            >
              {miniPreviewPath(id, issued.previewToken)}
            </Typography.Paragraph>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            预览链接有效期至 <InstantText value={issued.expiresAt} format="datetime" />
            ，只显示已保存的草稿。
          </Typography.Text>
        </Space>
      )}
    </Drawer>
  );
}
