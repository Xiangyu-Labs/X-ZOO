'use client';

import '@puckeditor/core/puck.css';

import { RedoOutlined, UndoOutlined } from '@ant-design/icons';
import {
  Puck,
  Render,
  createUsePuck,
  useGetPuck,
  type Config,
  type Data,
  type Dictionary,
  type Permissions,
} from '@puckeditor/core';
import type { DocumentKind } from '@shop/contracts/decor/constants';
import blocksCss from '@shop/storefront-blocks/admin-css';
import { Button, Space, Tooltip } from 'antd';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { buildDecorConfig, navBarSearch, NavBarSearchContext } from './config';
import { DECOR_CUSTOM_FIELDS } from './fields';

/**
 * The page-decoration editor: Puck behind a props surface of our own, so the
 * routes that mount it never import Puck and the library can be swapped
 * (docs/mini/spikes/S3-decor.md). Load this module with `next/dynamic`: it
 * carries the editor library and its CSS.
 *
 * The canvas is an iframe 375 px wide — a phone. It does **not** copy the
 * admin's styles in (`syncHostStyles: false`): antd's reset and the admin's
 * globals would restyle the blocks. It gets the blocks' own stylesheet
 * instead, the build of `@shop/storefront-blocks/admin-css`, whose design px
 * are already converted to vw — so inside a 375 px frame 750 design px is
 * exactly the frame's width, as on a phone.
 */

/** 375 × 812: an iPhone X-class screen, the width the storefront is designed at half of. */
export const CANVAS_WIDTH = 375;
export const CANVAS_HEIGHT = 812;

const CANVAS_BASE_CSS = `
html, body { margin: 0; padding: 0; }
body { -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%; }
*, *::before, *::after { box-sizing: border-box; }
`;

function injectCanvasStyles(document: Document): () => void {
  const style = document.createElement('style');
  style.dataset.decorCanvas = 'blocks';
  style.textContent = CANVAS_BASE_CSS + blocksCss;
  document.head.append(style);
  return () => style.remove();
}

/** Puts the blocks' stylesheet into the canvas iframe's own document. */
function CanvasStyles({ children, document }: { children: ReactNode; document?: Document }) {
  useEffect(() => (document ? injectCanvasStyles(document) : undefined), [document]);
  return <>{children}</>;
}

/** Puck's own UI strings, in Chinese. */
export const PUCK_DICTIONARY_ZH: Dictionary = {
  'header-publish': '发布',
  'header-undo': '撤销',
  'header-redo': '重做',
  'header-toggle-leftsidebar': '显示/隐藏组件栏',
  'header-toggle-rightsidebar': '显示/隐藏属性栏',
  'header-toggle-menubar': '菜单',
  'action-selectparent': '选中上一级',
  'action-duplicate': '复制',
  'action-delete': '删除',
  'label-page': '页面',
  'label-component': '组件',
  'outline-empty': '页面还没有组件',
  'outline-item-collapse': '收起',
  'outline-item-expand': '展开',
  'outline-header-title': '页面结构',
  'outline-header-collapseall': '全部收起',
  'outline-item-duplicate': '复制',
  'outline-item-delete': '删除',
  'drawer-category-collapse': '收起{title}',
  'drawer-category-expand': '展开{title}',
  'drawer-category-other': '其他',
  'canvas-noconfig': '没有「{type}」的配置',
  'field-readonly': '只读',
  'field-arrayitem-summary': '第 {index} 项',
  'field-arrayitem-duplicate': '复制',
  'field-arrayitem-delete': '删除',
  'viewport-zoom-in': '放大',
  'viewport-zoom-out': '缩小',
  'viewport-zoom-auto': '{zoom}%（自动）',
  'viewport-toggle-menu': '切换视口',
  'viewport-switch': '切换到{label}',
  'viewport-switch-default': '切换视口',
  'plugin-blocks': '组件',
  'plugin-outline': '结构',
  'plugin-fields': '属性',
  'plugin-components': '组件',
  'layout-maximize': '最大化',
  'layout-minimize': '还原',
  'loader-loading': '加载中',
};

const usePuckSelector = createUsePuck();

/** The canvas's navigation bar reads the page's blocks as they are being edited. */
function useNavBarSearchInEditor(): string | null {
  return usePuckSelector((state) => navBarSearch(state.appState.data.content));
}

function UndoRedo() {
  const history = usePuckSelector((state) => state.history);
  return (
    <Space.Compact>
      <Tooltip title="撤销">
        <Button
          icon={<UndoOutlined />}
          aria-label="撤销"
          disabled={!history.hasPast}
          onClick={() => history.back()}
        />
      </Tooltip>
      <Tooltip title="重做">
        <Button
          icon={<RedoOutlined />}
          aria-label="重做"
          disabled={!history.hasFuture}
          onClick={() => history.forward()}
        />
      </Tooltip>
    </Space.Compact>
  );
}

const READ_ONLY: Partial<Permissions> = {
  drag: false,
  duplicate: false,
  delete: false,
  edit: false,
  insert: false,
};

export interface DecorEditorProps {
  /** The page kind: the palette offers only the blocks allowed on it. */
  kind: DocumentKind;
  /** Initial editor data (`toPuckData(document)`); remount with a `key` to load other data. */
  data: Data;
  onChange?: ((data: Data) => void) | undefined;
  /** The toolbar: drawn across the top, with undo / redo after it. */
  toolbar?: ReactNode;
  /** Drawn under the toolbar, full width: the save issues, a read-only notice. */
  banner?: ReactNode;
  /** Nothing can be changed; the side panels stay for looking. */
  readOnly?: boolean | undefined;
}

interface HeaderSlots {
  toolbar: ReactNode;
  banner: ReactNode;
  readOnly: boolean;
}

const HeaderSlotsContext = createContext<HeaderSlots>({
  toolbar: null,
  banner: null,
  readOnly: false,
});

/**
 * Puck's header, replaced. A stable component that reads what to draw from
 * context: an override defined inline would be a new component type on every
 * render, and Puck would remount the toolbar — its popovers and focus with it
 * — on every keystroke in the inspector.
 */
function EditorHeader() {
  const { toolbar, banner, readOnly } = useContext(HeaderSlotsContext);
  return (
    <div
      style={{
        gridArea: 'header',
        background: 'var(--ant-color-bg-container)',
        borderBottom: '1px solid var(--ant-color-border-secondary)',
      }}
    >
      <div
        className="decor-editor-toolbar"
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px' }}
      >
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
          {toolbar}
        </div>
        {readOnly ? null : <UndoRedo />}
      </div>
      {banner}
    </div>
  );
}

const OVERRIDES = { iframe: CanvasStyles, header: EditorHeader };
const VIEWPORTS = [
  { width: CANVAS_WIDTH, height: 'auto' as const, label: '手机', icon: 'Smartphone' as const },
];
const IFRAME = { enabled: true, syncHostStyles: false };

export function DecorEditor({
  kind,
  data,
  onChange,
  toolbar,
  banner,
  readOnly = false,
}: DecorEditorProps) {
  const config = useMemo(() => buildDecorConfig({ kind, custom: DECOR_CUSTOM_FIELDS }), [kind]);
  const slots = useMemo(() => ({ toolbar, banner, readOnly }), [toolbar, banner, readOnly]);
  return (
    <HeaderSlotsContext value={slots}>
      <NavBarSearchContext value={useNavBarSearchInEditor}>
        <Puck
          config={config}
          data={data}
          {...(onChange ? { onChange } : {})}
          height="100%"
          dictionary={PUCK_DICTIONARY_ZH}
          {...(readOnly ? { permissions: READ_ONLY } : {})}
          viewports={VIEWPORTS}
          iframe={IFRAME}
          overrides={OVERRIDES}
        />
      </NavBarSearchContext>
    </HeaderSlotsContext>
  );
}

/** Puck's top-level drop zone: where a page's blocks live. */
const ROOT_ZONE = 'root:default-zone';

/**
 * Selects a block by id (or, with `null`, nothing — the page settings show),
 * for pointing at an issue. Only inside the editor: the toolbar and the banner.
 */
export function useDecorSelect(): (blockId: string | null) => void {
  const getPuck = useGetPuck();
  return useCallback(
    (blockId) => {
      const { appState, dispatch } = getPuck();
      if (blockId === null) {
        dispatch({ type: 'setUi', ui: { itemSelector: null } });
        return;
      }
      const index = appState.data.content.findIndex(
        (item) => (item.props as { id?: unknown }).id === blockId,
      );
      if (index !== -1) {
        dispatch({ type: 'setUi', ui: { itemSelector: { index, zone: ROOT_ZONE } } });
      }
    },
    [getPuck],
  );
}

/**
 * A page drawn read-only in a phone-sized frame — for a revision, a template.
 * Its own iframe, like the editor canvas, so the blocks' vw units measure
 * the phone and not the admin window.
 */
export function DecorPagePreview({
  kind,
  data,
  width = CANVAS_WIDTH,
  height = 667,
  title = '页面预览',
}: {
  kind: DocumentKind;
  data: Data;
  width?: number;
  height?: number;
  title?: string;
}) {
  const config: Config = useMemo(
    () => buildDecorConfig({ kind, custom: DECOR_CUSTOM_FIELDS }),
    [kind],
  );
  const useNavBarSearch = useMemo(() => {
    const search = navBarSearch(data.content);
    return () => search;
  }, [data]);
  const [body, setBody] = useState<HTMLElement | null>(null);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  useEffect(() => {
    if (!frame) return;
    let cleanup: (() => void) | undefined;
    const attach = () => {
      const document = frame.contentDocument;
      if (!document?.body) return;
      cleanup?.();
      cleanup = injectCanvasStyles(document);
      setBody(document.body);
    };
    if (frame.contentDocument?.readyState === 'complete') attach();
    frame.addEventListener('load', attach);
    return () => {
      frame.removeEventListener('load', attach);
      cleanup?.();
    };
  }, [frame]);
  return (
    <iframe
      ref={setFrame}
      title={title}
      srcDoc="<!DOCTYPE html><html><head></head><body></body></html>"
      style={{
        width,
        height,
        border: '1px solid #f0f0f0',
        borderRadius: 12,
        background: '#fff',
        display: 'block',
      }}
    >
      {body
        ? createPortal(
            <NavBarSearchContext value={useNavBarSearch}>
              <Render config={config} data={data} />
            </NavBarSearchContext>,
            body,
          )
        : null}
    </iframe>
  );
}
