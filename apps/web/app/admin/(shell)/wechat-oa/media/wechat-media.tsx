'use client';

import { Button, Tag, Typography, message } from 'antd';
import {
  wechatOaMediaDelete,
  wechatOaMediaList,
  wechatOaMediaSync,
  wechatOaMediaUpload,
} from '@shop/contracts/wechat-oa/wechat-oa.media.contract';
import { wechatMediaUploadBody, type WechatMedium } from '@shop/contracts/wechat-oa/schemas';

import { ConfirmButton } from '@/admin/kit/confirm-button';
import { formatInstant } from '@/admin/kit/instant';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import { statusOptions } from '@/admin/kit/status-tag';
import {
  actionsColumn,
  enumColumn,
  idColumn,
  imageColumn,
  instantColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';

import { MEDIA_KIND } from '../wechat-oa-enums';

/**
 * 微信素材 — the mapping between the shop's media library and WeChat's.
 *
 * This is not a second media library. The bytes live in `attachments`; a row
 * here says "WeChat also holds this one, under this handle". That is why 上传
 * picks an existing attachment instead of a file: two upload paths would mean
 * two copies and two places to get the MIME check wrong.
 *
 * 同步 exists because WeChat is the authority on what it still holds. A
 * temporary asset expires after three days, and a permanent one can be deleted
 * from the 公众平台 by somebody who never opened this screen — without the
 * reconcile, the first symptom is an auto-reply that silently stops arriving.
 */
export function WechatMediaPage() {
  const modal = useFormModal<WechatMedium>();

  return (
    <PageContainer subTitle="已推送到微信的素材；自动回复和渠道码只能引用这里的条目">
      <CrudTable
        route={wechatOaMediaList}
        scrollX={1100}
        filters={[
          { kind: 'select', name: 'kind', label: '类型', options: statusOptions(MEDIA_KIND) },
        ]}
        toolbar={
          <Can permission="wechat-oa:media:write">
            <ConfirmButton
              route={wechatOaMediaSync}
              title="确认与微信同步？"
              description="以微信为准：它已经没有的条目会被移除，它有而这里没有的会被补上。"
              invalidate={[wechatOaMediaList]}
              permission="wechat-oa:media:write"
              onSuccess={(result) =>
                void message.success(
                  `同步完成：新增 ${result.added}，移除 ${result.removed}，未变 ${result.unchanged}`,
                )
              }
            >
              与微信同步
            </ConfirmButton>
            <Button type="primary" onClick={() => modal.show()}>
              上传到微信
            </Button>
          </Can>
        }
        columns={[
          idColumn<WechatMedium>(),
          imageColumn<WechatMedium>({ title: '预览', dataIndex: 'url' }),
          enumColumn<WechatMedium, WechatMedium['kind']>({
            title: '类型',
            dataIndex: 'kind',
            map: MEDIA_KIND,
            width: 90,
          }),
          textColumn<WechatMedium>({ title: '微信素材 ID', dataIndex: 'mediaId', ellipsis: true }),
          {
            title: '有效期',
            key: 'isPermanent',
            width: 160,
            render: (_value: unknown, row: WechatMedium) =>
              row.isPermanent ? (
                <Tag color="success">永久</Tag>
              ) : (
                <Typography.Text type="secondary">
                  临时{row.expiresAt ? `，至 ${formatInstant(row.expiresAt, 'date')}` : ''}
                </Typography.Text>
              ),
          },
          instantColumn<WechatMedium>({ title: '上传时间', dataIndex: 'createdAt' }),
          actionsColumn<WechatMedium>({
            width: 100,
            render: (row) => (
              <ConfirmButton
                route={wechatOaMediaDelete}
                input={{ params: { id: row.id } }}
                title="确认删除该素材？"
                description="微信上的素材也会一并删除，引用它的自动回复将无法送达。"
                invalidate={[wechatOaMediaList]}
                successMessage="已删除"
                permission="wechat-oa:media:write"
                buttonProps={{ type: 'link', size: 'small', danger: true }}
              >
                删除
              </ConfirmButton>
            ),
          }),
        ]}
      />

      <ModalForm
        {...modal.props}
        title="把素材库里的文件上传到微信"
        schema={wechatMediaUploadBody}
        fields={[
          {
            kind: 'asset',
            name: 'attachmentId',
            label: '选择文件',
            valueType: 'id',
            help: '从商城素材库里选；文件本身不会被复制一份。',
          },
          {
            kind: 'select',
            name: 'kind',
            label: '微信素材类型',
            options: statusOptions(MEDIA_KIND),
          },
          {
            kind: 'switch',
            name: 'isPermanent',
            label: '永久素材',
            checkedText: '永久',
            uncheckedText: '临时',
            help: '临时素材三天后由微信自动清除，够用就不必占永久配额。',
          },
        ]}
        route={wechatOaMediaUpload}
        invalidate={[wechatOaMediaList]}
        successMessage="已上传到微信"
      />
    </PageContainer>
  );
}
