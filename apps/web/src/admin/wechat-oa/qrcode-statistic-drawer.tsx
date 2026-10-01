'use client';

import { Drawer, Space, Table, Tag, Typography } from 'antd';
import {
  wechatOaQrcodeScans,
  wechatOaQrcodeStatistic,
} from '@shop/contracts/wechat-oa/wechat-oa.qrcode.contract';
import type {
  WechatQrcode,
  WechatQrcodeScan,
  WechatQrcodeStatPoint,
} from '@shop/contracts/wechat-oa/schemas';

import { useRouteQuery } from '@/admin/api/hooks';
import { DescriptionsCard } from '@/admin/kit/descriptions-card';
import { formatInstant } from '@/admin/kit/instant';
import { idColumn, instantColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';

export interface QrcodeStatisticDrawerProps {
  qrcode: WechatQrcode | null;
  onClose: () => void;
}

/**
 * One channel code's scan history.
 *
 * Three numbers that are routinely confused sit next to each other on purpose:
 * 扫码次数 counts deliveries, 扫码人数 counts distinct openids (the same
 * person photographing the poster twice is one customer), and 新增关注 counts
 * the scans that actually produced a follow. A poster with 500 scans and 6
 * follows is not a successful poster, and only the three together say so.
 */
export function QrcodeStatisticDrawer({ qrcode, onClose }: QrcodeStatisticDrawerProps) {
  return (
    <Drawer
      open={qrcode !== null}
      onClose={onClose}
      width={880}
      destroyOnHidden
      title={qrcode ? `扫码统计：${qrcode.name}` : '扫码统计'}
    >
      {qrcode ? <Body qrcode={qrcode} /> : null}
    </Drawer>
  );
}

function Body({ qrcode }: { qrcode: WechatQrcode }) {
  const statistic = useRouteQuery(wechatOaQrcodeStatistic, { params: { id: qrcode.id } });
  const data = statistic.data;

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <DescriptionsCard
        loading={statistic.isPending}
        column={3}
        items={[
          { label: '场景值', value: <Typography.Text code>{qrcode.scene}</Typography.Text> },
          { label: '扫码次数', value: data?.scanCount ?? qrcode.scanCount },
          { label: '扫码人数', value: data?.uniqueScanners ?? '—' },
          { label: '新增关注', value: data?.followCount ?? qrcode.followCount },
          {
            label: '有效期',
            value: qrcode.expiresAt ? formatInstant(qrcode.expiresAt, 'date') : '永久',
          },
          {
            label: '二维码',
            value: qrcode.imageUrl ? (
              <Typography.Link href={qrcode.imageUrl} target="_blank" rel="noreferrer">
                下载图片
              </Typography.Link>
            ) : (
              '—'
            ),
          },
        ]}
      />

      <Table<WechatQrcodeStatPoint>
        size="small"
        rowKey="date"
        title={() => '按天'}
        loading={statistic.isPending}
        dataSource={data?.points ?? []}
        pagination={false}
        scroll={{ y: 220 }}
        locale={{ emptyText: '这段时间没有扫码记录' }}
        columns={[
          { title: '日期', dataIndex: 'date', key: 'date', width: 140 },
          { title: '扫码次数', dataIndex: 'scans', key: 'scans', width: 120 },
          { title: '新增关注', dataIndex: 'newFollowers', key: 'newFollowers' },
        ]}
      />

      <CrudTable
        route={wechatOaQrcodeScans}
        params={{ id: qrcode.id }}
        urlPrefix="scan"
        size="small"
        title="扫码明细"
        columns={[
          idColumn<WechatQrcodeScan>(),
          textColumn<WechatQrcodeScan>({
            title: '用户',
            dataIndex: 'nickname',
            placeholder: '未关注',
          }),
          // Masked by the server; it identifies a person and nobody on this
          // screen needs the whole thing.
          textColumn<WechatQrcodeScan>({ title: 'OpenID', dataIndex: 'openid', ellipsis: true }),
          {
            title: '来源',
            key: 'isNewFollower',
            width: 110,
            render: (_value: unknown, row: WechatQrcodeScan) =>
              row.isNewFollower ? <Tag color="success">扫码关注</Tag> : <Tag>已关注</Tag>,
          },
          instantColumn<WechatQrcodeScan>({ title: '扫码时间', dataIndex: 'createdAt' }),
        ]}
      />
    </Space>
  );
}
