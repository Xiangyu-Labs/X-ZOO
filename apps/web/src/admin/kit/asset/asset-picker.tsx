'use client';

import { CheckOutlined, InboxOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  App,
  Button,
  Col,
  Empty,
  Input,
  Modal,
  Pagination,
  Row,
  Spin,
  Typography,
  Upload,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ApiError } from '../../api/errors';
import { SideTree } from '../tree/side-tree';
import { useAssetAccess, useAssetSource } from './asset-source-context';
import type { AssetCategory, AssetItem } from './types';

const PAGE_SIZE = 24;
const ALL_KEY = '__all__';

export interface AssetPickerProps {
  open: boolean;
  onClose: () => void;
  /** Select more than one. Default `false`. */
  multiple?: boolean | undefined;
  /** Cap on the selection when `multiple`. */
  max?: number | undefined;
  /** Called with the chosen assets when the operator confirms. */
  onSelect: (assets: AssetItem[]) => void;
  title?: string | undefined;
  /** `accept` passed to the upload input. Default images only. */
  accept?: string | undefined;
  /**
   * Ids or URLs the field already holds. Those tiles show 已添加 and cannot be
   * picked again, and a Shift+click run steps over them.
   */
  taken?: readonly string[] | undefined;
}

function toTreeData(
  categories: AssetCategory[],
): { key: string; title: string; children?: unknown[] }[] {
  const map = (list: AssetCategory[]): { key: string; title: string; children?: unknown[] }[] =>
    list.map((category) => ({
      key: category.id,
      title: category.name,
      ...(category.children?.length ? { children: map(category.children) } : {}),
    }));
  return [{ key: ALL_KEY, title: '全部素材', children: map(categories) }];
}

/**
 * Shift+click: walk the page from the anchor to the clicked item and append,
 * in walking order, every item not yet picked — so the numbers on the grid
 * follow the direction the operator swept. Items `skip` names (already in the
 * field) are stepped over like picked ones. Stops at `max`. Without an anchor on
 * this page it only picks the clicked item.
 */
export function selectRange(
  selected: readonly AssetItem[],
  items: readonly AssetItem[],
  anchorId: string | null,
  targetIndex: number,
  max: number | undefined,
  skip?: (item: AssetItem) => boolean,
): { next: AssetItem[]; capped: boolean } {
  const anchorIndex = anchorId === null ? -1 : items.findIndex((item) => item.id === anchorId);
  const from = anchorIndex === -1 ? targetIndex : anchorIndex;
  const step = targetIndex >= from ? 1 : -1;
  const picked = new Set(selected.map((asset) => asset.id));
  const next = [...selected];
  for (let i = from; i !== targetIndex + step; i += step) {
    const item = items[i];
    if (!item || picked.has(item.id) || skip?.(item)) continue;
    if (max !== undefined && next.length >= max) return { next, capped: true };
    picked.add(item.id);
    next.push(item);
  }
  return { next, capped: false };
}

/**
 * Material library picker: category tree, paginated image grid, drag-and-drop
 * upload, single or multiple selection. Returns contract `asset` objects, in
 * the order they were picked; with `multiple` each tile shows its number and
 * Shift+click picks the run from the last clicked tile. Tiles in `taken` are
 * already in the field and cannot be picked twice.
 *
 * Talks to an `AssetSource`, not to routes directly, so it works today against
 * the in-memory stub and unchanged against the real storage API.
 */
export function AssetPicker({
  open,
  onClose,
  multiple = false,
  max,
  onSelect,
  title = '选择素材',
  accept = 'image/*',
  taken,
}: AssetPickerProps) {
  const source = useAssetSource();
  const access = useAssetAccess();
  const { message } = App.useApp();

  const [categoryId, setCategoryId] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<AssetItem[]>([]);
  const [uploading, setUploading] = useState(false);
  // Where a Shift+click range starts: the last tile clicked on, only while it is
  // still picked and still on the page being looked at.
  const anchor = useRef<string | null>(null);

  const categories = useQuery({
    queryKey: ['kit.assets.categories'],
    queryFn: () => source.listCategories(),
    enabled: open && access.categories,
    staleTime: 5 * 60_000,
  });

  const list = useQuery({
    queryKey: ['kit.assets.list', categoryId ?? null, page, keyword],
    queryFn: () => source.listAssets({ categoryId, page, pageSize: PAGE_SIZE, keyword }),
    enabled: open && access.list,
  });

  const isTaken = useMemo(() => {
    const set = new Set(taken ?? []);
    return (item: AssetItem): boolean => set.has(item.id) || set.has(item.url);
  }, [taken]);

  const treeData = useMemo(() => toTreeData(categories.data ?? []), [categories.data]);
  const items = list.data?.items;

  // A new page, category or search shows other tiles; the old anchor is off-screen.
  useEffect(() => {
    anchor.current = null;
  }, [items]);

  const warnMax = useCallback(() => {
    void message.warning(`最多选择 ${max} 个素材`);
  }, [max, message]);

  const toggle = useCallback(
    (item: AssetItem) => {
      const exists = selected.some((asset) => asset.id === item.id);
      if (!multiple) {
        setSelected(exists ? [] : [item]);
        return;
      }
      if (exists) {
        anchor.current = null;
        setSelected(selected.filter((asset) => asset.id !== item.id));
        return;
      }
      if (max !== undefined && selected.length >= max) {
        warnMax();
        return;
      }
      anchor.current = item.id;
      setSelected([...selected, item]);
    },
    [selected, multiple, max, warnMax],
  );

  const pickRange = useCallback(
    (index: number) => {
      const { next, capped } = selectRange(
        selected,
        items ?? [],
        anchor.current,
        index,
        max,
        isTaken,
      );
      if (capped) warnMax();
      const target = items?.[index];
      if (target && next.some((asset) => asset.id === target.id)) anchor.current = target.id;
      setSelected(next);
    },
    [selected, items, max, warnMax, isTaken],
  );

  const reset = useCallback(() => {
    setSelected([]);
    setKeyword('');
    setPage(1);
    anchor.current = null;
  }, []);

  const confirm = (): void => {
    onSelect(selected);
    reset();
    onClose();
  };

  const cancel = (): void => {
    reset();
    onClose();
  };

  return (
    <Modal
      open={open}
      title={title}
      width={920}
      onCancel={cancel}
      onOk={confirm}
      okText={`确定${selected.length > 0 ? `（${selected.length}）` : ''}`}
      cancelText="取消"
      okButtonProps={{ disabled: selected.length === 0 }}
      destroyOnHidden
      styles={{ body: { paddingTop: 12 } }}
    >
      <Row gutter={16} style={{ minHeight: 420 }}>
        <Col
          xs={24}
          md={6}
          style={{ minWidth: 0, borderRight: '1px solid var(--ant-color-border-secondary)' }}
        >
          <Spin spinning={access.categories && categories.isPending}>
            <SideTree
              treeData={treeData as never}
              defaultExpandAll
              selectedKeys={[categoryId ?? ALL_KEY]}
              onSelect={(keys) => {
                const key = String(keys[0] ?? ALL_KEY);
                setCategoryId(key === ALL_KEY ? undefined : key);
                setPage(1);
              }}
            />
          </Spin>
        </Col>

        <Col xs={24} md={18}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <Input.Search
              allowClear
              placeholder="搜索素材名称"
              style={{ maxWidth: 240 }}
              onSearch={(value) => {
                setKeyword(value);
                setPage(1);
              }}
            />
            <Button icon={<ReloadOutlined />} onClick={() => list.refetch()}>
              刷新
            </Button>
            {access.upload ? (
              <UploadArea
                accept={accept}
                uploading={uploading}
                onUpload={async (files) => {
                  setUploading(true);
                  try {
                    for (const file of files) await source.upload(file, categoryId);
                    await list.refetch();
                    void message.success(`已上传 ${files.length} 个文件`);
                  } catch (error) {
                    // A server refusal is written for the operator; anything else is not.
                    void message.error(ApiError.is(error) ? error.message : '上传失败，请重试');
                  } finally {
                    setUploading(false);
                  }
                }}
              />
            ) : null}
          </div>

          <Spin spinning={list.isFetching}>
            {list.data && list.data.items.length > 0 ? (
              <div
                className="admin-scroll-area"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))',
                  gap: 10,
                  maxHeight: 340,
                  overflowY: 'auto',
                  // Shift+click would otherwise also select the page's text.
                  userSelect: 'none',
                }}
              >
                {list.data.items.map((item, index) => {
                  const order = selected.findIndex((asset) => asset.id === item.id) + 1;
                  const active = order > 0;
                  const already = isTaken(item);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={already}
                      onClick={(event) => {
                        if (multiple && event.shiftKey) pickRange(index);
                        else toggle(item);
                      }}
                      title={already ? `${item.name}（已添加）` : item.name}
                      data-testid={`asset-${item.id}`}
                      aria-pressed={active}
                      style={{
                        position: 'relative',
                        padding: 0,
                        border: `2px solid ${active ? 'var(--ant-color-primary)' : 'var(--ant-color-border)'}`,
                        borderRadius: 6,
                        overflow: 'hidden',
                        cursor: already ? 'not-allowed' : 'pointer',
                        opacity: already ? 0.45 : 1,
                        background: 'var(--ant-color-fill-quaternary)',
                        aspectRatio: '1 / 1',
                      }}
                    >
                      {item.mime.startsWith('video/') ? (
                        // A video's first frame, muted and paused; only its metadata loads.
                        <video
                          src={item.url}
                          muted
                          preload="metadata"
                          aria-label={item.name}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            display: 'block',
                          }}
                        />
                      ) : (
                        <img
                          src={item.url}
                          alt={item.name}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            display: 'block',
                          }}
                        />
                      )}
                      {active ? (
                        <span
                          style={{
                            position: 'absolute',
                            insetInlineEnd: 4,
                            insetBlockStart: 4,
                            background: 'var(--ant-color-primary)',
                            color: '#fff',
                            borderRadius: 9,
                            minWidth: 18,
                            height: 18,
                            paddingInline: 4,
                            boxSizing: 'border-box',
                            display: 'grid',
                            placeItems: 'center',
                            fontSize: 11,
                          }}
                        >
                          {multiple ? order : <CheckOutlined />}
                        </span>
                      ) : null}
                      {already ? (
                        <span
                          style={{
                            position: 'absolute',
                            insetInline: 0,
                            insetBlockEnd: 0,
                            background: 'rgba(0, 0, 0, 0.55)',
                            color: '#fff',
                            fontSize: 11,
                            lineHeight: '18px',
                          }}
                        >
                          已添加
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <Empty
                description={list.isPending ? '加载中…' : '暂无素材'}
                style={{ padding: 48 }}
              />
            )}
          </Spin>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
            <Typography.Text type="secondary">
              已选 {selected.length}
              {max !== undefined ? ` / ${max}` : ''}
              {multiple ? '，按住 Shift 点击可连选' : ''}
            </Typography.Text>
            <Pagination
              size="small"
              current={page}
              pageSize={PAGE_SIZE}
              total={list.data?.total ?? 0}
              showSizeChanger={false}
              onChange={setPage}
            />
          </div>
        </Col>
      </Row>
    </Modal>
  );
}

function UploadArea({
  accept,
  uploading,
  onUpload,
}: {
  accept: string;
  uploading: boolean;
  onUpload: (files: File[]) => Promise<void>;
}) {
  const buffer = useRef<File[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // antd calls `beforeUpload` once per file; batch them into a single flush so
  // "drop 10 images" is one refetch and one toast, not ten.
  const enqueue = (file: File): boolean => {
    buffer.current.push(file);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const files = buffer.current;
      buffer.current = [];
      void onUpload(files);
    }, 30);
    return false;
  };

  return (
    <Upload
      accept={accept}
      multiple
      showUploadList={false}
      beforeUpload={enqueue}
      disabled={uploading}
    >
      <Button icon={<InboxOutlined />} loading={uploading}>
        上传
      </Button>
    </Upload>
  );
}

export interface AssetPickerHandle {
  /** Resolves with the chosen assets, or `[]` when cancelled. */
  pick: (options?: Omit<AssetPickerProps, 'open' | 'onClose' | 'onSelect'>) => Promise<AssetItem[]>;
  /** Render this somewhere in the tree; it is the modal itself. */
  holder: ReactNode;
}

/**
 * Promise-style access to the picker, for places that can't easily hold modal
 * state — a rich-text toolbar button, a table row action.
 *
 * ```tsx
 * const picker = useAssetPicker();
 * // …
 * const [image] = await picker.pick({ multiple: false });
 * return <>{picker.holder}</>;
 * ```
 */
export function useAssetPicker(): AssetPickerHandle {
  const [state, setState] = useState<{
    open: boolean;
    options: Omit<AssetPickerProps, 'open' | 'onClose' | 'onSelect'>;
  }>({ open: false, options: {} });
  const resolver = useRef<((assets: AssetItem[]) => void) | null>(null);

  const pick = useCallback(
    (options: Omit<AssetPickerProps, 'open' | 'onClose' | 'onSelect'> = {}) =>
      new Promise<AssetItem[]>((resolve) => {
        resolver.current = resolve;
        setState({ open: true, options });
      }),
    [],
  );

  const settle = useCallback((assets: AssetItem[]) => {
    resolver.current?.(assets);
    resolver.current = null;
    setState((prev) => ({ ...prev, open: false }));
  }, []);

  const holder = (
    <AssetPicker
      {...state.options}
      open={state.open}
      onClose={() => settle([])}
      onSelect={(assets) => settle(assets)}
    />
  );

  return { pick, holder };
}
