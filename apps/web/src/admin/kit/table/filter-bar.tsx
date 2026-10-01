'use client';

import { DownOutlined, ReloadOutlined, SearchOutlined, UpOutlined } from '@ant-design/icons';
import { Button, Form, Input, InputNumber, Select } from 'antd';
import { useCallback, useState, type ReactNode } from 'react';

import { DateRangeField } from '../form/date-fields';
import { MoneyInput } from '../form/money-input';
import type { SelectOption } from '../form/types';
import { defined } from '../props';
import { useStoredFlag } from '../stored-flag';

/** How much of a row a filter takes. Wide controls (a range with times) take two cells. */
interface FilterLayout {
  /** Grid cells, 1 by default; a `dateRange` with `showTime` defaults to 2. */
  span?: 1 | 2 | undefined;
}

/**
 * A filter in the bar above a `CrudTable`. `name` is the route's query key, so
 * the filter bar maps one-to-one onto the contract's query schema.
 *
 * Keep `label` to six characters or fewer (单号, 用户, 下单时间): every label in
 * a bar gets the width of the longest one. Say the rest in `placeholder`
 * (售后单号或订单号).
 */
export type FilterSpec = FilterLayout &
  (
    | { kind: 'text'; name: string; label: string; placeholder?: string | undefined }
    | {
        kind: 'number';
        name: string;
        label: string;
        placeholder?: string | undefined;
        min?: number | undefined;
        max?: number | undefined;
      }
    | {
        /** An amount, sent as the contract's money string (`"100.00"`), never `"100"`. */
        kind: 'money';
        name: string;
        label: string;
        placeholder?: string | undefined;
      }
    | {
        kind: 'select';
        name: string;
        label: string;
        options: readonly SelectOption[];
        /** Multi-select; serialised into the URL and the query as `a,b`. */
        multiple?: boolean | undefined;
        allowClear?: boolean | undefined;
        /** Type to filter the options. Default on for more than 8 options. */
        showSearch?: boolean | undefined;
      }
    | {
        /** Two query keys, one control: `[startKey, endKey]`. */
        kind: 'dateRange';
        names: [string, string];
        label: string;
        showTime?: boolean | undefined;
      }
    | {
        kind: 'custom';
        name: string;
        label: string;
        render: (
          value: string | undefined,
          onChange: (next: string | undefined) => void,
        ) => ReactNode;
      }
  );

/** Every query key a spec owns. */
export function filterKeys(spec: FilterSpec): string[] {
  return spec.kind === 'dateRange' ? [...spec.names] : [spec.name];
}

export interface FilterBarProps {
  filters: readonly FilterSpec[];
  /** Current values, keyed by query key. */
  values: Record<string, string | undefined>;
  /** Applied on 查询 / reset. The table resets to page 1. */
  onApply: (values: Record<string, string | undefined>) => void;
  loading?: boolean | undefined;
}

/** Cells per row for a bar this wide. A filter is never narrower than ~280px. */
export function columnsForWidth(width: number): number {
  if (width < 560) return 1;
  if (width < 880) return 2;
  if (width < 1240) return 3;
  return 4;
}

/** antd's colon after a label, with its margins (2px before, 8px after). */
const COLON_EM = 1.25;

/**
 * The label column, in em: the longest label (a CJK character is 1em, ASCII
 * about half) plus the colon, capped so one long label cannot squeeze every
 * input in the bar. A longer label wraps.
 */
export function labelWidthEm(labels: readonly string[]): number {
  let longest = 0;
  for (const label of labels) {
    let width = 0;
    for (const char of label) width += char.charCodeAt(0) > 0xff ? 1 : 0.55;
    longest = Math.max(longest, width);
  }
  return Math.min(Math.max(longest, 2), 6) + COLON_EM;
}

function spanOf(spec: FilterSpec, columns: number): number {
  const span = spec.span ?? (spec.kind === 'dateRange' && spec.showTime ? 2 : 1);
  return Math.min(span, columns);
}

/**
 * How many leading filters fit on the first row beside the buttons. The rest
 * fold away until 展开.
 */
export function firstRowCount(
  filters: readonly FilterSpec[],
  columns: number,
): { count: number; collapsible: boolean } {
  const total = filters.reduce((sum, spec) => sum + spanOf(spec, columns), 0);
  if (total + 1 <= columns) return { count: filters.length, collapsible: false };
  let used = 0;
  let count = 0;
  for (const spec of filters) {
    const span = spanOf(spec, columns);
    if (used + span > columns - 1) break;
    used += span;
    count += 1;
  }
  // A one-column bar (a phone) still shows its first filter.
  return { count: Math.max(count, 1), collapsible: true };
}

/** Before the bar is measured (and in tests): a laptop-sized row. */
const DEFAULT_COLUMNS = 3;

function useColumns(): [(node: HTMLDivElement | null) => void, number] {
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const width = node.getBoundingClientRect().width;
      if (width > 0) setColumns(columnsForWidth(width));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, columns];
}

/**
 * Declarative filter bar. Holds a local draft so typing doesn't refetch on
 * every keystroke; 查询 commits, 重置 clears every key it owns.
 *
 * Layout, the same on every list: labels on the left, one width per bar, the
 * control filling the rest of its cell; 查询/重置 in the last cell of the last
 * row, right-aligned. More filters than one row folds to the first row behind
 * 展开, unless a folded filter is in use.
 */
export function FilterBar({ filters, values, onApply, loading = false }: FilterBarProps) {
  const [draft, setDraft] = useState<Record<string, string | undefined>>(values);
  const [seenValues, setSeenValues] = useState(values);
  const [gridRef, columns] = useColumns();
  const [expandedPreference, setExpanded] = useStoredFlag('admin.filters.expanded');

  // Adopt external changes (back button, programmatic reset). React's documented
  // "adjust state when a prop changes" pattern — cheaper and less surprising
  // than an effect, which would render once with the stale draft first.
  if (seenValues !== values) {
    setSeenValues(values);
    setDraft(values);
  }

  // A pasted order number with a trailing space finds nothing; what a search
  // box sends is what the operator meant.
  const apply = (next: Record<string, string | undefined>): void => {
    const trimmed: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(next)) {
      const text = value?.trim();
      trimmed[key] = text === '' ? undefined : text;
    }
    onApply(trimmed);
  };

  const set = (patch: Record<string, string | undefined>): void =>
    setDraft((prev) => ({ ...prev, ...patch }));

  const reset = (): void => {
    const cleared: Record<string, string | undefined> = {};
    for (const spec of filters) for (const key of filterKeys(spec)) cleared[key] = undefined;
    setDraft(cleared);
    onApply(cleared);
  };

  if (filters.length === 0) return null;

  const { count, collapsible } = firstRowCount(filters, columns);
  // A folded filter that narrows the list must stay in sight: a link to
  // 已退款 orders of one user should not look like every order.
  const foldedInUse = filters
    .slice(count)
    .some((spec) =>
      filterKeys(spec).some((key) => values[key] !== undefined && values[key] !== ''),
    );
  const expanded = !collapsible || foldedInUse || expandedPreference === true;
  const shown = expanded ? filters : filters.slice(0, count);
  const labelCol = { flex: `0 0 ${labelWidthEm(filters.map((spec) => spec.label))}em` };

  return (
    <Form
      layout="horizontal"
      labelWrap
      onSubmitCapture={(event) => {
        event.preventDefault();
        apply(draft);
      }}
      style={{ marginBottom: 16 }}
    >
      <div
        ref={gridRef}
        data-testid="filter-bar"
        data-columns={columns}
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: '12px 24px',
          alignItems: 'start',
        }}
      >
        {shown.map((spec) => (
          <Form.Item
            key={filterKeys(spec).join('|')}
            label={spec.label}
            labelCol={labelCol}
            wrapperCol={{ flex: '1 1 0', style: { minWidth: 0 } }}
            style={{ marginBottom: 0, gridColumn: `span ${spanOf(spec, columns)}` }}
          >
            {renderFilter(spec, draft, set, () => apply(draft))}
          </Form.Item>
        ))}
        {/* `-2 / -1` is the last column: grid placement puts it at the end of
            the last row, or on a row of its own when that row is full. */}
        <div
          data-testid="filter-actions"
          style={{
            gridColumn: '-2 / -1',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Button
            type="primary"
            icon={<SearchOutlined />}
            loading={loading}
            onClick={() => apply(draft)}
          >
            查询
          </Button>
          <Button icon={<ReloadOutlined />} onClick={reset}>
            重置
          </Button>
          {collapsible && !foldedInUse ? (
            <Button
              type="link"
              style={{ paddingInline: 4 }}
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
            >
              {expanded ? '收起' : '展开'}
              {expanded ? <UpOutlined /> : <DownOutlined />}
            </Button>
          ) : null}
        </div>
      </div>
    </Form>
  );
}

function renderFilter(
  spec: FilterSpec,
  draft: Record<string, string | undefined>,
  set: (patch: Record<string, string | undefined>) => void,
  submit: () => void,
): ReactNode {
  switch (spec.kind) {
    case 'text':
      return (
        <Input
          allowClear
          style={{ width: '100%' }}
          placeholder={spec.placeholder ?? `请输入${spec.label}`}
          value={draft[spec.name] ?? ''}
          data-testid={`filter-${spec.name}`}
          onChange={(event) => set({ [spec.name]: event.target.value || undefined })}
          onPressEnter={submit}
        />
      );

    case 'number':
      return (
        <InputNumber
          style={{ width: '100%' }}
          // A filter is typed, never stepped; most number filters are ids, where ±1 is noise.
          controls={false}
          placeholder={spec.placeholder ?? `请输入${spec.label}`}
          {...defined({ min: spec.min, max: spec.max })}
          value={draft[spec.name] === undefined ? null : Number(draft[spec.name])}
          onChange={(next) => set({ [spec.name]: next === null ? undefined : String(next) })}
          onPressEnter={submit}
        />
      );

    case 'money':
      return (
        <MoneyInput
          style={{ width: '100%' }}
          placeholder={spec.placeholder ?? '0.00'}
          value={draft[spec.name]}
          onChange={(next) => set({ [spec.name]: next })}
        />
      );

    case 'select':
      return (
        <Select
          style={{ width: '100%' }}
          allowClear={spec.allowClear ?? true}
          placeholder={`请选择${spec.label}`}
          options={spec.options as never}
          {...((spec.showSearch ?? spec.options.length > 8)
            ? { showSearch: { optionFilterProp: 'label' } }
            : {})}
          data-testid={`filter-${spec.name}`}
          {...(spec.multiple ? { mode: 'multiple' as const } : {})}
          value={
            spec.multiple
              ? (draft[spec.name]?.split(',').filter(Boolean) ?? [])
              : (draft[spec.name] ?? undefined)
          }
          onChange={(next: unknown) => {
            const value = Array.isArray(next)
              ? next.length > 0
                ? next.join(',')
                : undefined
              : next === undefined || next === null
                ? undefined
                : String(next);
            set({ [spec.name]: value });
          }}
        />
      );

    case 'dateRange': {
      const [startKey, endKey] = spec.names;
      const start = draft[startKey];
      const end = draft[endKey];
      return (
        <DateRangeField
          showTime={spec.showTime ?? false}
          value={start && end ? [start, end] : undefined}
          onChange={(next) => set({ [startKey]: next?.[0], [endKey]: next?.[1] })}
        />
      );
    }

    case 'custom':
      return spec.render(draft[spec.name], (next) => set({ [spec.name]: next }));

    default: {
      const exhaustive: never = spec;
      return exhaustive;
    }
  }
}
