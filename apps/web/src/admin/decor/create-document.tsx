'use client';

import { CheckCircleFilled } from '@ant-design/icons';
import { DOCUMENT_KINDS, type DocumentKind } from '@shop/contracts/decor/constants';
import {
  decorDesignations,
  decorDocumentCreate,
  decorDocumentList,
} from '@shop/contracts/decor/decor.admin.contract';
import { Form, Input, Modal, Radio, Spin, Typography } from 'antd';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useRouteMutation } from '../api';
import { useDetailHref } from '../kit/table/list-return';
import { toPuckData } from './document';
import { BLANK_TEMPLATE_KEY, templatesFor, type DecorTemplate } from './templates';

/**
 * 新建页面: a kind, a name and a starting point — the blank page or one of
 * the templates of that kind (`./templates`). Creating opens the editor.
 */

/** The page preview carries the editor library: loaded only when a template is shown. */
const DecorPagePreview = dynamic(() => import('./editor').then((mod) => mod.DecorPagePreview), {
  ssr: false,
  loading: () => <Spin style={{ display: 'block', margin: '48px auto' }} />,
});

const THUMB_SCALE = 0.4;
const THUMB_WIDTH = 375;
const THUMB_HEIGHT = 640;

function TemplateCard({
  template,
  selected,
  onSelect,
}: {
  template: DecorTemplate;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={template.name}
      onClick={onSelect}
      style={{
        position: 'relative',
        width: THUMB_WIDTH * THUMB_SCALE + 18,
        padding: 8,
        textAlign: 'left',
        cursor: 'pointer',
        borderRadius: 8,
        background: 'var(--ant-color-bg-container)',
        border: selected
          ? '2px solid var(--ant-color-primary, #1677ff)'
          : '2px solid var(--ant-color-border-secondary, #f0f0f0)',
      }}
    >
      {selected ? (
        <CheckCircleFilled
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            zIndex: 1,
            color: 'var(--ant-color-primary, #1677ff)',
          }}
        />
      ) : null}
      <div
        style={{
          width: THUMB_WIDTH * THUMB_SCALE,
          height: THUMB_HEIGHT * THUMB_SCALE,
          overflow: 'hidden',
          borderRadius: 6,
          background: 'var(--ant-color-fill-quaternary)',
          pointerEvents: 'none',
        }}
      >
        {template.document ? (
          <div
            style={{
              width: THUMB_WIDTH,
              height: THUMB_HEIGHT,
              transform: `scale(${THUMB_SCALE})`,
              transformOrigin: 'top left',
            }}
          >
            <DecorPagePreview
              kind={template.kind}
              data={toPuckData(template.document)}
              width={THUMB_WIDTH}
              height={THUMB_HEIGHT}
              title={`${template.name}预览`}
            />
          </div>
        ) : (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ant-color-text-quaternary)',
              fontSize: 13,
            }}
          >
            空白
          </div>
        )}
      </div>
      <div style={{ marginTop: 6, fontWeight: 500 }}>{template.name}</div>
      <Typography.Paragraph
        type="secondary"
        style={{ fontSize: 12, marginBottom: 0 }}
        ellipsis={{ rows: 2 }}
      >
        {template.description}
      </Typography.Paragraph>
    </button>
  );
}

interface CreateValues {
  kind: DocumentKind;
  name: string;
}

export function CreateDecorDocumentModal({
  open,
  onClose,
  initialKind = 'custom',
}: {
  open: boolean;
  onClose: () => void;
  initialKind?: DocumentKind;
}) {
  const router = useRouter();
  const detailHref = useDetailHref();
  const [form] = Form.useForm<CreateValues>();
  const kind = Form.useWatch('kind', form) ?? initialKind;
  const [templateKey, setTemplateKey] = useState(BLANK_TEMPLATE_KEY);
  const templates = templatesFor(kind);
  const template = templates.find((entry) => entry.key === templateKey) ?? templates[0]!;
  const create = useRouteMutation(decorDocumentCreate, {
    invalidate: [decorDocumentList, decorDesignations],
    successMessage: '已创建',
  });

  const submit = async () => {
    const values = await form.validateFields();
    const created = await create.mutateAsync({
      body: {
        kind: values.kind,
        name: values.name.trim(),
        ...(template.document ? { document: template.document } : {}),
      },
    });
    onClose();
    router.push(detailHref(`/admin/decor/${created.id}`));
  };

  return (
    <Modal
      open={open}
      title="新建页面"
      width={720}
      okText="创建并装修"
      confirmLoading={create.isPending}
      onCancel={onClose}
      onOk={() => submit().catch(() => undefined)}
      afterClose={() => {
        form.resetFields();
        setTemplateKey(BLANK_TEMPLATE_KEY);
      }}
      destroyOnHidden
    >
      <Form<CreateValues>
        form={form}
        layout="vertical"
        initialValues={{ kind: initialKind, name: '' }}
        onValuesChange={(changed: Partial<CreateValues>) => {
          if (changed.kind) setTemplateKey(BLANK_TEMPLATE_KEY);
        }}
      >
        <Form.Item name="kind" label="页面类型">
          <Radio.Group
            optionType="button"
            options={(Object.entries(DOCUMENT_KINDS) as [DocumentKind, string][]).map(
              ([value, label]) => ({ value, label }),
            )}
          />
        </Form.Item>
        <Form.Item
          name="name"
          label="页面名称"
          extra="仅后台可见；小程序标题栏的文字在页面设置里修改。"
          rules={[
            { required: true, whitespace: true, message: '请填写页面名称' },
            { max: 50, message: '最多 50 个字' },
          ]}
        >
          <Input placeholder="如：春季首页" maxLength={50} />
        </Form.Item>
        <Form.Item label="从模板开始">
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {templates.map((entry) => (
              <TemplateCard
                key={entry.key}
                template={entry}
                selected={entry.key === template.key}
                onSelect={() => setTemplateKey(entry.key)}
              />
            ))}
          </div>
        </Form.Item>
      </Form>
    </Modal>
  );
}
