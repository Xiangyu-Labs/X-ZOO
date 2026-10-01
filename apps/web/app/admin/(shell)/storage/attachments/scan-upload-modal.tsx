'use client';

import { Alert, Modal, QRCode, Space, Spin, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import {
  storageAttachmentList,
  storageScanTokenCreate,
  storageScanTokenStatus,
} from '@shop/contracts/storage/storage.admin.contract';

import { useInvalidateRoutes, useRouteMutation, useRouteQuery } from '@/admin/api/hooks';

/**
 * 扫码上传 — put a photo from your phone into the library.
 *
 * One **global token** in a cache key would let whoever scanned any QR code
 * upload into whoever had asked for one last. Here the token is
 * minted per admin, is single-use and expires in minutes; the attachment it
 * produces is owned by the admin who minted it.
 *
 * The dialog polls the token's status rather than holding a socket open: an
 * operator has the dialog open for under a minute, and a poll costs one indexed
 * Redis read.
 */
export function ScanUploadModal({
  onClose,
  categoryId,
}: {
  onClose: () => void;
  categoryId: string | undefined;
}) {
  const [token, setToken] = useState<string | null>(null);
  const invalidate = useInvalidateRoutes();

  const mint = useRouteMutation(storageScanTokenCreate, {
    onSuccess: (result) => setToken(result.token),
  });

  const status = useRouteQuery(storageScanTokenStatus, token ? { params: { token } } : undefined, {
    enabled: token !== null,
    // Only a code still waiting for a phone is worth asking about again.
    refetchInterval: (query) =>
      query.state.data === undefined || query.state.data.state === 'pending' ? 2000 : false,
    // A used or expired token answers 200 with a state; only a real failure
    // should shout, and the dialog shows that itself.
    presentError: false,
  });

  // Minted once, on mount: the parent renders this component only while the
  // dialog is open, so "open" is the mount and closing it throws the token
  // away rather than clearing state from inside an effect.
  const { mutate: mintToken } = mint;
  useEffect(() => {
    mintToken({ body: categoryId ? { categoryId } : {} });
  }, [categoryId, mintToken]);

  const state = status.data?.state;
  useEffect(() => {
    if (state === 'used') {
      void message.success('手机上传成功');
      void invalidate(storageAttachmentList);
    }
  }, [state, invalidate]);

  return (
    <Modal open onCancel={onClose} onOk={onClose} title="扫码上传" footer={null} width={420}>
      <Space direction="vertical" align="center" style={{ width: '100%' }} size="middle">
        {mint.isError || (status.isError && !status.data) ? (
          <Alert
            type="error"
            showIcon
            message="二维码获取失败"
            description="关闭后重新打开再试。"
          />
        ) : mint.isPending || !status.data ? (
          <Spin />
        ) : state === 'used' ? (
          <Alert type="success" showIcon message="已收到手机上传的文件，素材库已刷新。" />
        ) : state === 'expired' ? (
          <Alert
            type="warning"
            showIcon
            message="二维码已过期"
            description="关闭后重新打开可以获取新的二维码。"
          />
        ) : (
          <>
            <QRCode value={qrValue(mint.data?.url)} size={200} />
            <Typography.Text type="secondary">
              用手机扫码后选择照片上传；二维码只能用一次。
            </Typography.Text>
          </>
        )}
      </Space>
    </Modal>
  );
}

/**
 * `<QRCode>` throws on an empty string, and the URL is briefly undefined while
 * the token is being minted.
 *
 * A path (`/scan-upload/…`, what the server sends when the deployment states no
 * origin) is no use to a phone, which would scan it as plain text; the admin is
 * served from the same origin as the upload page, so it supplies one.
 */
export function qrValue(url: string | undefined, origin: string = window.location.origin): string {
  if (!url || url.length === 0) return 'about:blank';
  return url.startsWith('/') ? `${origin}${url}` : url;
}
