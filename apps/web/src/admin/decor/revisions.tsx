'use client';

import {
  decorDesignations,
  decorDocumentGet,
  decorDocumentList,
  decorRevisionList,
  decorRollback,
} from '@shop/contracts/decor/decor.admin.contract';
import type { ResponseOf } from '@shop/contracts/_conventions/route';
import type { RevisionSummary } from '@shop/contracts/decor/schemas';
import { Button, Drawer, Empty, List, Space, Spin, Tag, Typography } from 'antd';

import { useRouteQuery } from '../api';
import { ConfirmButton, InstantText } from '../kit';

/**
 * 发布记录: every published revision, newest first. A revision can be looked
 * at (read-only, in the canvas) and rolled back to.
 *
 * Rolling back republishes that revision's content as a *new* revision
 * (`restoredFrom` says which); the draft is left alone, so whatever is being
 * edited is never lost by a rollback. The editor then offers to load the
 * restored content into the draft.
 */
export function RevisionsDrawer({
  id,
  open,
  onClose,
  liveNumber,
  viewing,
  onView,
  onRolledBack,
}: {
  id: string;
  open: boolean;
  onClose: () => void;
  /** The revision the storefront serves now. */
  liveNumber: number | undefined;
  /** The revision open in the canvas, if any. */
  viewing: number | undefined;
  onView: (revision: RevisionSummary) => void;
  onRolledBack: (result: ResponseOf<typeof decorRollback>, from: RevisionSummary) => void;
}) {
  const revisions = useRouteQuery(decorRevisionList, { params: { id } }, { enabled: open });
  const items = revisions.data?.items ?? [];

  return (
    <Drawer open={open} onClose={onClose} title="发布记录" size={420} mask={false}>
      {revisions.isPending ? (
        <Spin style={{ display: 'block', margin: '48px auto' }} />
      ) : items.length === 0 ? (
        <Empty description="还没有发布过" />
      ) : (
        <List
          dataSource={items}
          rowKey="number"
          renderItem={(revision) => {
            const live = revision.number === liveNumber;
            return (
              <List.Item
                data-testid={`decor-revision-${revision.number}`}
                {...(viewing === revision.number
                  ? { style: { background: 'var(--ant-color-primary-bg)' } }
                  : {})}
                actions={[
                  <Button
                    key="view"
                    type="link"
                    size="small"
                    disabled={viewing === revision.number}
                    onClick={() => onView(revision)}
                  >
                    查看
                  </Button>,
                  <ConfirmButton
                    key="rollback"
                    route={decorRollback}
                    input={{
                      params: { id, number: revision.number },
                      body: { note: `回滚到第 ${revision.number} 版` },
                    }}
                    title={`回滚到第 ${revision.number} 版？`}
                    description="以这一版的内容发布一个新版本，小程序立即生效；正在编辑的草稿不受影响。"
                    invalidate={[
                      decorRevisionList,
                      decorDocumentGet,
                      decorDocumentList,
                      decorDesignations,
                    ]}
                    onSuccess={(result) => onRolledBack(result, revision)}
                    permission="decor:page:publish"
                    buttonProps={{ type: 'link', size: 'small', disabled: live }}
                  >
                    回滚
                  </ConfirmButton>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space size={6} wrap>
                      <span>第 {revision.number} 版</span>
                      {live ? <Tag color="success">当前线上</Tag> : null}
                      {revision.restoredFrom ? (
                        <Tag>回滚自第 {revision.restoredFrom} 版</Tag>
                      ) : null}
                    </Space>
                  }
                  description={
                    <Space direction="vertical" size={0}>
                      <InstantText value={revision.createdAt} format="minute" />
                      {revision.note ? (
                        <Typography.Text type="secondary" ellipsis style={{ maxWidth: 240 }}>
                          {revision.note}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  }
                />
              </List.Item>
            );
          }}
        />
      )}
    </Drawer>
  );
}
