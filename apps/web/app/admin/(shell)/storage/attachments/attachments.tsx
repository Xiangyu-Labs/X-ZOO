'use client';

import { Button, Col, Modal, Row, Select, Space, Typography, Upload, message } from 'antd';
import type { UploadProps } from 'antd';
import { useRef, useState } from 'react';
import {
  storageAttachmentDeleteMany,
  storageAttachmentImport,
  storageAttachmentList,
  storageAttachmentMoveMany,
  storageAttachmentUpdate,
  storageAttachmentUpload,
  storageCategoryTree,
} from '@shop/contracts/storage/storage.admin.contract';
import {
  attachmentImportBody,
  attachmentUpdateBody,
  type AttachmentItem,
} from '@shop/contracts/storage/schemas';

import { ApiError } from '@/admin/api/errors';
import { useInvalidateRoutes, useRouteMutation, useRouteQuery } from '@/admin/api/hooks';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import {
  actionsColumn,
  idColumn,
  imageColumn,
  instantColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';
import { useCan } from '@/admin/session/session-provider';
import { uploadFile } from '@/admin/storage/upload';

import { CategoryTree } from './category-tree';
import { ScanUploadModal } from './scan-upload-modal';

const KIND_OPTIONS = [
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'file', label: '文件' },
];

/**
 * 素材库.
 *
 * Three guarantees come from the routes behind this page rather than from
 * anything visible here, and it is worth knowing which:
 *
 *  - the client never names a storage path; the server derives the key,
 *    so `../../` in a filename cannot escape anything;
 *  - identical bytes are stored once (sha256 under an advisory lock), so a
 *    double-clicked upload returns the existing row instead of a twin;
 *  - 网址导入 goes through the SSRF guard, which resolves DNS itself and
 *    refuses private, loopback, link-local and metadata addresses *after*
 *    resolution and again on every redirect.
 */
export function AttachmentsPage() {
  const [categoryId, setCategoryId] = useState<string | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const rename = useFormModal<AttachmentItem>();
  const invalidate = useInvalidateRoutes();
  const uploading = useRef(0);

  // 分组 is its own atom: a role that may manage files but not read the
  // folders gets the files without the tree, not a 403 toast on every open.
  const can = useCan();
  const canCategories = can('storage:category:read');
  const categories = useRouteQuery(storageCategoryTree, undefined, { enabled: canCategories });
  const categoryOptions = (categories.data?.items ?? []).map((item) => ({
    value: item.id,
    label: `${'　'.repeat(item.depth)}${item.name}`,
  }));

  const move = useRouteMutation(storageAttachmentMoveMany, {
    invalidate: [storageAttachmentList, storageCategoryTree],
  });
  const removeMany = useRouteMutation(storageAttachmentDeleteMany, {
    invalidate: [storageAttachmentList, storageCategoryTree],
  });

  /**
   * antd's `<Upload>` wants a custom request because the kit's `callRoute`
   * cannot send multipart. Failures are reported per file: uploading twelve
   * photos and being told only that "the upload failed" is useless.
   */
  const customUpload: NonNullable<UploadProps['customRequest']> = async ({
    file,
    onSuccess,
    onError,
  }) => {
    uploading.current += 1;
    try {
      const result = await uploadFile(
        storageAttachmentUpload,
        { query: categoryId ? { categoryId } : {} },
        file as File,
      );
      onSuccess?.(result);
      if (result.deduped) {
        void message.info(`${result.attachment.name}：素材库中已有相同文件，已直接引用`);
      }
    } catch (error) {
      const text = error instanceof ApiError ? error.message : '上传失败';
      void message.error(`${(file as File).name}：${text}`);
      onError?.(error as Error);
    } finally {
      uploading.current -= 1;
      if (uploading.current === 0) {
        void invalidate(storageAttachmentList, storageCategoryTree);
      }
    }
  };

  return (
    <PageContainer subTitle="后台与商城用到的图片、视频和文件；相同内容只存一份">
      <Row gutter={16}>
        {canCategories && (
          <Col xs={24} md={6} lg={5}>
            <CategoryTree selectedId={categoryId} onSelect={setCategoryId} />
          </Col>
        )}

        <Col xs={24} md={canCategories ? 18 : 24} lg={canCategories ? 19 : 24}>
          <CrudTable
            route={storageAttachmentList}
            scrollX={1100}
            fixedQuery={{
              ...(categoryId ? { categoryId, includeSubcategories: 'true' } : {}),
            }}
            filters={[
              { kind: 'text', name: 'keyword', label: '名称' },
              { kind: 'select', name: 'kind', label: '类型', options: KIND_OPTIONS },
            ]}
            toolbar={
              <Space>
                <Can permission="storage:attachment:write">
                  <Upload multiple showUploadList={false} customRequest={customUpload}>
                    <Button type="primary">上传</Button>
                  </Upload>
                  <Button onClick={() => setImporting(true)}>网址导入</Button>
                  <Button onClick={() => setScanning(true)}>扫码上传</Button>
                </Can>
              </Space>
            }
            batchActions={({ selectedRowKeys, clear }) => (
              <Space>
                <Typography.Text type="secondary">已选 {selectedRowKeys.length} 项</Typography.Text>
                <Can permission="storage:attachment:write">
                  <Select
                    placeholder="移动到分类"
                    style={{ width: 200 }}
                    options={[{ value: '', label: '未分类' }, ...categoryOptions]}
                    onChange={(value: string) => {
                      move.mutate(
                        {
                          body: {
                            ids: selectedRowKeys.map(String),
                            categoryId: value === '' ? null : value,
                          },
                        },
                        {
                          onSuccess: (result) => {
                            void message.success(`已移动 ${result.affected} 项`);
                            clear();
                          },
                        },
                      );
                    }}
                  />
                </Can>
                <Can permission="storage:attachment:delete">
                  <Button
                    danger
                    onClick={() => {
                      Modal.confirm({
                        title: `确认删除选中的 ${selectedRowKeys.length} 项素材？`,
                        content:
                          '已经被商品或页面引用的图片会跟着失效，删除前请确认。文件会在稍后由清理任务真正移除。',
                        okButtonProps: { danger: true },
                        onOk: async () => {
                          const result = await removeMany.mutateAsync({
                            body: { ids: selectedRowKeys.map(String) },
                          });
                          void message.success(
                            result.skippedIds.length === 0
                              ? `已删除 ${result.affected} 项`
                              : `已删除 ${result.affected} 项，${result.skippedIds.length} 项已不存在`,
                          );
                          clear();
                        },
                      });
                    }}
                  >
                    删除
                  </Button>
                </Can>
              </Space>
            )}
            columns={[
              idColumn<AttachmentItem>({ sortable: true }),
              imageColumn<AttachmentItem>({ title: '预览', dataIndex: 'url', size: 44 }),
              textColumn<AttachmentItem>({
                title: '名称',
                dataIndex: 'name',
                ellipsis: true,
                sortable: true,
              }),
              textColumn<AttachmentItem>({ title: '类型', dataIndex: 'mime', width: 140 }),
              {
                title: '大小',
                key: 'size',
                width: 100,
                sorter: true,
                render: (_value: unknown, row: AttachmentItem) => formatBytes(row.size),
              },
              {
                title: '尺寸',
                key: 'dimensions',
                width: 110,
                render: (_value: unknown, row: AttachmentItem) =>
                  row.width && row.height ? `${row.width}×${row.height}` : '—',
              },
              instantColumn<AttachmentItem>({
                title: '上传时间',
                dataIndex: 'createdAt',
                sortable: true,
              }),
              actionsColumn<AttachmentItem>({
                width: 180,
                render: (row) => (
                  <>
                    <Button
                      type="link"
                      size="small"
                      onClick={() => {
                        return navigator.clipboard
                          .writeText(absoluteUrl(row.url))
                          .then(() => message.success('已复制链接'));
                      }}
                    >
                      复制链接
                    </Button>
                    <Can permission="storage:attachment:write">
                      <Button type="link" size="small" onClick={() => rename.show(row)}>
                        重命名
                      </Button>
                    </Can>
                    <ConfirmButton
                      route={storageAttachmentDeleteMany}
                      input={{ body: { ids: [row.id] } }}
                      title={`删除素材「${row.name}」？`}
                      description="已经引用它的商品或页面会跟着失效。"
                      invalidate={[storageAttachmentList, storageCategoryTree]}
                      successMessage="已删除"
                      permission="storage:attachment:delete"
                      buttonProps={{ type: 'link', size: 'small', danger: true }}
                    >
                      删除
                    </ConfirmButton>
                  </>
                ),
              }),
            ]}
          />
        </Col>
      </Row>

      <ModalForm
        {...rename.props}
        title="重命名素材"
        size="small"
        schema={attachmentUpdateBody}
        fields={[
          { kind: 'text', name: 'name', label: '名称', span: 24 },
          {
            kind: 'select',
            name: 'categoryId',
            label: '分类',
            options: [{ value: '', label: '未分类' }, ...categoryOptions],
            span: 24,
          },
        ]}
        initialValues={
          rename.record
            ? {
                name: rename.record.name,
                categoryId: rename.record.categoryId ?? '',
              }
            : undefined
        }
        route={storageAttachmentUpdate}
        toInput={(values) => ({
          params: { id: rename.record?.id ?? '' },
          body: { ...values, categoryId: values.categoryId ? values.categoryId : null },
        })}
        invalidate={[storageAttachmentList, storageCategoryTree]}
        successMessage="已保存"
      />

      <ModalForm
        open={importing}
        onClose={() => setImporting(false)}
        title="从网址导入"
        size="small"
        schema={attachmentImportBody}
        fields={[
          {
            kind: 'text',
            name: 'url',
            label: '图片网址',
            span: 24,
            help: '只允许公网 https 地址（http 需在存储设置中开启）；内网、回环和云元数据地址会被拒绝',
          },
          { kind: 'text', name: 'name', label: '名称', span: 24, help: '留空则用文件名' },
        ]}
        initialValues={categoryId ? { categoryId } : undefined}
        route={storageAttachmentImport}
        toInput={(values) => ({
          body: { ...values, ...(categoryId ? { categoryId } : {}) },
        })}
        invalidate={[storageAttachmentList, storageCategoryTree]}
        successMessage="已导入"
      />

      {scanning && <ScanUploadModal onClose={() => setScanning(false)} categoryId={categoryId} />}
    </PageContainer>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** Local-driver URLs are site-relative; a copied link has to be absolute. */
function absoluteUrl(url: string): string {
  return url.startsWith('http') ? url : new URL(url, window.location.origin).toString();
}
