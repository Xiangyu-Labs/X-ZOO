'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Divider,
  Empty,
  Input,
  List,
  Modal,
  Pagination,
  Space,
  Tabs,
  Typography,
} from 'antd';
import { createContext, use, useCallback, useMemo, useState, type ReactNode } from 'react';

import type { LinkSource, LinkTargetType, LinkValue } from './types';

const PAGE_SIZE = 10;

const LinkSourceContext = createContext<LinkSource | null>(null);

/**
 * The storefront link catalogue, from the nearest `<LinkSourceProvider>`.
 *
 * There is deliberately no fallback: a picker rendered without a provider
 * throws rather than offering links that are not in the shop, because whatever
 * the operator picks is saved and opened by the storefront. The kit demo
 * mounts its own rows; tests mount `createStubLinkSource()` from
 * `@/test/link-source`. (The decoration editor has its own link field,
 * `src/admin/decor/fields/link.tsx`, which stores a `LinkTarget`.)
 */
export function useLinkSource(): LinkSource {
  const provided = use(LinkSourceContext);
  if (!provided) throw new Error('useLinkSource() needs a <LinkSourceProvider> above it');
  return provided;
}

export function LinkSourceProvider({
  source,
  children,
}: {
  source: LinkSource;
  children: ReactNode;
}) {
  const value = useMemo(() => source, [source]);
  return <LinkSourceContext value={value}>{children}</LinkSourceContext>;
}

export interface LinkPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (value: LinkValue) => void;
  /** Restrict the tabs on offer. Default: all of them. */
  allow?: readonly LinkTargetType[] | undefined;
  title?: string | undefined;
  value?: LinkValue | undefined;
}

const SEARCHABLE: Record<'product' | 'category' | 'article', string> = {
  product: '商品',
  category: '商品分类',
  article: '文章',
};

/**
 * Picks an in-app storefront link: a built-in page, a product, a category, an
 * article, or a hand-typed URL. Returns `{ type, label, url }`.
 *
 * Used by banners, DIY components and anywhere else an operator points at a
 * storefront destination.
 */
export function LinkPicker({
  open,
  onClose,
  onSelect,
  allow = ['page', 'product', 'category', 'article', 'custom'],
  title = '选择链接',
  value,
}: LinkPickerProps) {
  const source = useLinkSource();
  const [tab, setTab] = useState<LinkTargetType>(allow[0] ?? 'page');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [customUrl, setCustomUrl] = useState(value?.type === 'custom' ? value.url : '');
  const [customLabel, setCustomLabel] = useState(value?.type === 'custom' ? value.label : '');

  const pages = useQuery({
    queryKey: ['kit.links.pages'],
    queryFn: () => source.listPages(),
    enabled: open && allow.includes('page'),
    staleTime: 5 * 60_000,
  });

  const searchable = tab !== 'page' && tab !== 'custom' ? tab : null;
  const targets = useQuery({
    queryKey: ['kit.links.targets', searchable, keyword, page],
    queryFn: () =>
      source.listTargets(searchable as 'product' | 'category' | 'article', {
        keyword,
        page,
        pageSize: PAGE_SIZE,
      }),
    enabled: open && searchable !== null,
  });

  const choose = useCallback(
    (next: LinkValue) => {
      onSelect(next);
      onClose();
    },
    [onSelect, onClose],
  );

  const tabItems = allow.map((type) => {
    if (type === 'page') {
      return {
        key: 'page',
        label: '商城页面',
        children: (
          <div style={{ maxHeight: 380, overflowY: 'auto' }} className="admin-scroll-area">
            {(pages.data ?? []).map((group) => (
              <div key={group.group}>
                <Divider titlePlacement="start" plain style={{ margin: '8px 0' }}>
                  {group.group}
                </Divider>
                <Space wrap>
                  {group.items.map((item) => (
                    <Button
                      key={item.id}
                      onClick={() => choose({ type: 'page', label: item.name, url: item.url })}
                    >
                      {item.name}
                    </Button>
                  ))}
                </Space>
              </div>
            ))}
            {pages.data?.length === 0 ? <Empty description="暂无页面" /> : null}
          </div>
        ),
      };
    }

    if (type === 'custom') {
      return {
        key: 'custom',
        label: '自定义链接',
        children: (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Input
              placeholder="名称，例如：活动页"
              value={customLabel}
              onChange={(event) => setCustomLabel(event.target.value)}
            />
            <Input
              placeholder="链接地址，例如 /pages/index/index 或 https://…"
              value={customUrl}
              onChange={(event) => setCustomUrl(event.target.value)}
            />
            <Button
              type="primary"
              disabled={customUrl.trim() === ''}
              onClick={() =>
                choose({
                  type: 'custom',
                  label: customLabel.trim() || customUrl.trim(),
                  url: customUrl.trim(),
                })
              }
            >
              使用该链接
            </Button>
          </Space>
        ),
      };
    }

    return {
      key: type,
      label: SEARCHABLE[type as 'product' | 'category' | 'article'],
      children: (
        <div>
          <Input.Search
            allowClear
            placeholder={`搜索${SEARCHABLE[type as 'product' | 'category' | 'article']}`}
            style={{ marginBottom: 12, maxWidth: 280 }}
            onSearch={(next) => {
              setKeyword(next);
              setPage(1);
            }}
          />
          <List
            size="small"
            loading={targets.isFetching}
            dataSource={targets.data?.items ?? []}
            locale={{ emptyText: <Empty description="没有匹配的结果" /> }}
            style={{ maxHeight: 320, overflowY: 'auto' }}
            className="admin-scroll-area"
            renderItem={(item) => (
              <List.Item
                key={item.id}
                actions={[
                  <Button
                    key="pick"
                    type="link"
                    size="small"
                    onClick={() => choose({ type, label: item.name, url: item.url })}
                  >
                    选择
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={item.name}
                  description={
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {item.subtitle ?? item.url}
                    </Typography.Text>
                  }
                />
              </List.Item>
            )}
          />
          <Pagination
            size="small"
            style={{ marginTop: 12, textAlign: 'right' }}
            current={page}
            pageSize={PAGE_SIZE}
            total={targets.data?.total ?? 0}
            showSizeChanger={false}
            onChange={setPage}
          />
        </div>
      ),
    };
  });

  return (
    <Modal open={open} title={title} width={680} footer={null} onCancel={onClose} destroyOnHidden>
      <Tabs
        activeKey={tab}
        onChange={(key) => {
          setTab(key as LinkTargetType);
          setKeyword('');
          setPage(1);
        }}
        items={tabItems}
      />
    </Modal>
  );
}
