'use client';

import type { Config, Data, Permissions } from '@puckeditor/core';
import { decorBlocks } from '@shop/contracts/decor/all-blocks';
import {
  IMAGE_CUBE_LAYOUTS,
  type DocumentKind,
  type ImageCubeLayout,
} from '@shop/contracts/decor/constants';
import { imageCubeCell } from '@shop/contracts/decor/blocks/image-cube';
import { pageRootProps } from '@shop/contracts/decor/document';
import type { AnyBlockDefinition, BlockRegistry } from '@shop/contracts/decor/registry';
import type { DataNeed } from '@shop/contracts/decor/sources';
import { BLOCK_COMPONENTS } from '@shop/storefront-blocks/admin';
import { Component, useMemo, type ComponentType, type ErrorInfo, type ReactNode } from 'react';

import { useCanvasSlots } from './canvas-data';
import { withImagePlaceholders } from './canvas-images';
import { UNKNOWN_BLOCK, type UnknownBlockProps } from './document';
import {
  defaultsOf,
  initialPropsOf,
  zodToPuckFields,
  type CustomFieldRenderers,
} from './zod-to-puck';

/**
 * The Puck `Config` for the DIY v2 blocks, built from the contracts' block
 * registry: one component per registered block, its fields generated from
 * the block's zod schema, rendered by the *storefront's own* component
 * (`@shop/storefront-blocks/admin`, Taro swapped for a DOM shim) with the data
 * its `defineBlock({ data })` asks for. Nothing about a block is written twice
 * for the editor: a block registered in the contracts appears in the palette
 * as soon as it exists, and in the canvas as soon as its component does.
 */

export type DecorData = Data;

// ─── rendering ───────────────────────────────────────────────────────────────

/**
 * A block with half-edited props (a cleared number, a layout with too few
 * cells) must not take the whole canvas down: it draws a notice instead and
 * recovers on the next edit.
 */
class BlockBoundary extends Component<
  { label: string; watch: unknown; children: ReactNode },
  { failed: boolean; watched: unknown }
> {
  override state = { failed: false, watched: this.props.watch };

  static getDerivedStateFromError(): Partial<{ failed: boolean }> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { watch: unknown },
    state: { failed: boolean; watched: unknown },
  ): Partial<{ failed: boolean; watched: unknown }> | null {
    return props.watch === state.watched ? null : { failed: false, watched: props.watch };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(`[decor] ${this.props.label} failed to render`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return <CanvasNotice>{this.props.label}：当前配置无法预览</CanvasNotice>;
    }
    return this.props.children;
  }
}

function CanvasNotice({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'warn';
}) {
  return (
    <div
      style={{
        margin: '8px 12px',
        padding: '14px 12px',
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1.6,
        textAlign: 'center',
        color: tone === 'warn' ? '#ad6800' : '#8c8c8c',
        background: tone === 'warn' ? '#fffbe6' : '#fafafa',
        border: `1px dashed ${tone === 'warn' ? '#ffe58f' : '#d9d9d9'}`,
      }}
    >
      {children}
    </div>
  );
}

/** Puck adds `id`, `puck` and `editMode` to a component's props; the block wants its own only. */
export function ownProps(props: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, puck: _puck, editMode: _editMode, ...own } = props;
  return own;
}

type AnyBlockComponent = ComponentType<{ props: any; data?: any; host?: { canvas?: boolean } }>;

const COMPONENTS = BLOCK_COMPONENTS as unknown as Readonly<Record<string, AnyBlockComponent>>;

/**
 * What the canvas tells a block about its host: it is the editor, so a video
 * shows its poster, a floating button sits in the flow where the operator can
 * select it, and a list with nothing to show says so instead of vanishing.
 */
const CANVAS_HOST = { canvas: true } as const;

function BlockCanvas({
  definition,
  props,
}: {
  definition: AnyBlockDefinition;
  props: Record<string, unknown>;
}) {
  // The storefront renders parsed props (defaults filled); half-edited props
  // that do not parse are drawn as they are and the boundary catches a crash.
  const parsed = useMemo(() => {
    const result = definition.props.safeParse(props);
    return result.success ? (result.data as Record<string, unknown>) : props;
  }, [definition, props]);
  const drawn = useMemo(
    () => withImagePlaceholders(definition.props, parsed),
    [definition, parsed],
  );
  const needs = useMemo((): Record<string, DataNeed> => {
    if (!definition.data) return {};
    try {
      return (definition.data as (props: unknown) => Record<string, DataNeed>)(parsed);
    } catch {
      return {};
    }
  }, [definition, parsed]);
  const slots = useCanvasSlots(needs);
  const Block = COMPONENTS[definition.type];
  if (!Block) {
    return (
      <CanvasNotice>
        {definition.meta.label}
        <br />
        画布暂无此组件的预览，可在「预览」或小程序体验版中查看
      </CanvasNotice>
    );
  }
  return (
    <BlockBoundary label={definition.meta.label} watch={props}>
      <Block props={drawn} data={slots} host={CANVAS_HOST} />
    </BlockBoundary>
  );
}

function UnknownBlock({ reason }: Partial<UnknownBlockProps>) {
  return (
    <CanvasNotice tone="warn">
      {reason ?? '无法编辑的组件'}
      <br />
      原样保留，可移动或删除；含有此组件的页面无法发布
    </CanvasNotice>
  );
}

// ─── defaults for a newly inserted block ─────────────────────────────────────

/**
 * The props a block starts with when dropped on the page: the schema's
 * defaults and the minimum list items (`initialPropsOf`). An image cube also
 * starts with as many cells as its default layout shows.
 */
export function newBlockProps(definition: AnyBlockDefinition): Record<string, unknown> {
  const props = initialPropsOf(definition.props);
  if (definition.type === 'imageCube') {
    const layout = props.layout as ImageCubeLayout;
    props.cells = Array.from({ length: IMAGE_CUBE_LAYOUTS[layout].cells }, () =>
      defaultsOf(imageCubeCell),
    );
  }
  return props;
}

// ─── the config ──────────────────────────────────────────────────────────────

/** A stored block this build cannot edit may move and go, but not be copied or edited. */
const UNKNOWN_PERMISSIONS: Partial<Permissions> = { duplicate: false, edit: false };

export interface DecorConfigOptions {
  /** The page being edited: the palette offers the blocks allowed on it (`meta.pages`). */
  kind: DocumentKind;
  custom: CustomFieldRenderers;
  registry?: BlockRegistry | undefined;
}

export function buildDecorConfig({
  kind,
  custom,
  registry = decorBlocks,
}: DecorConfigOptions): Config {
  const components: Config['components'] = {};
  for (const definition of registry.list()) {
    components[definition.type] = {
      label: definition.meta.label,
      fields: zodToPuckFields(definition.props, custom),
      defaultProps: newBlockProps(definition),
      render: function DecorBlock(props: Record<string, unknown>) {
        return <BlockCanvas definition={definition} props={ownProps(props)} />;
      },
    };
  }
  components[UNKNOWN_BLOCK] = {
    label: '无法编辑的组件',
    fields: {},
    permissions: UNKNOWN_PERMISSIONS,
    render: function DecorUnknownBlock(props: Record<string, unknown>) {
      return <UnknownBlock {...(props as Partial<UnknownBlockProps>)} />;
    },
  };
  const allowed = registry
    .list()
    .filter((definition) => definition.meta.pages.includes(kind))
    .map((definition) => definition.type);

  return {
    categories: {
      blocks: { title: '组件', components: allowed, defaultExpanded: true },
      // Blocks not allowed on this kind of page, and the placeholder for
      // unknown ones: registered (a stored page may hold them) but not offered.
      other: { visible: false },
    },
    components,
    root: {
      fields: zodToPuckFields(pageRootProps, custom),
      defaultProps: defaultsOf(pageRootProps) as Record<string, unknown>,
      render: function PageRoot({
        children,
        background,
        title,
      }: {
        children?: ReactNode;
        background?: string;
        title?: string;
      }) {
        return (
          <div style={{ background, minHeight: '100vh' }}>
            {/* The mini-program's navigation bar, which shows the page title. */}
            <div
              data-decor-navbar=""
              style={{
                position: 'sticky',
                top: 0,
                zIndex: 10,
                height: 44,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#ffffff',
                color: '#1f1f1f',
                fontSize: 16,
                fontWeight: 500,
                fontFamily: 'system-ui, -apple-system, sans-serif',
                borderBottom: '1px solid #f0f0f0',
              }}
            >
              {title}
            </div>
            {children}
          </div>
        );
      },
    },
  };
}
