import type { FormRule } from 'antd';
import type { ReactNode } from 'react';

import type { LinkTargetType } from '../link/types';
import type { AssetValueType } from './asset-field';
import type { SortableItemHelpers } from './sortable-list-field';

export type FieldName = string | (string | number)[];

export interface SelectOption {
  label: ReactNode;
  value: string | number | boolean;
  disabled?: boolean | undefined;
}

/** Props shared by every field kind. */
export interface FieldBase<N extends string = string> {
  /** Key in the form value. Use an array for a nested path (`['sku', 0, 'price']`). */
  name: N | (string | number)[];
  label?: ReactNode | undefined;
  /** Small grey hint under the control. */
  help?: ReactNode | undefined;
  /** Question-mark tooltip next to the label. */
  tooltip?: string | undefined;
  /** Overrides the required marker, which is otherwise inferred from the zod schema. */
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Grid width out of 24 at `md` and up. Defaults to the form's `columns` setting. */
  span?: number | undefined;
  /** Show this field only when the predicate passes. Re-evaluated on every change. */
  visibleWhen?: ((values: Record<string, unknown>) => boolean) | undefined;
  /** Extra antd rules on top of the zod-derived one. */
  rules?: FormRule[] | undefined;
  /**
   * The titled card this field sits in, on a long page form (商品编辑:
   * 基本信息 / 价格与规格 / …). Cards come in the order their first field
   * does; a form with no sections is one plain grid.
   */
  section?: string | undefined;
}

export type FieldSpec<N extends string = string> =
  | (FieldBase<N> & {
      kind: 'text' | 'password';
      placeholder?: string | undefined;
      maxLength?: number | undefined;
      prefix?: ReactNode | undefined;
      addonAfter?: ReactNode | undefined;
    })
  | (FieldBase<N> & {
      kind: 'textarea';
      placeholder?: string | undefined;
      rows?: number | undefined;
      maxLength?: number | undefined;
      showCount?: boolean | undefined;
    })
  | (FieldBase<N> & {
      kind: 'number';
      placeholder?: string | undefined;
      min?: number | undefined;
      max?: number | undefined;
      step?: number | undefined;
      precision?: number | undefined;
      addonAfter?: ReactNode | undefined;
    })
  | (FieldBase<N> & {
      /** String in, string out — `"12.00"`. Never a float. */
      kind: 'money';
      placeholder?: string | undefined;
      symbol?: string | undefined;
      allowNegative?: boolean | undefined;
    })
  | (FieldBase<N> & { kind: 'switch'; checkedText?: string; uncheckedText?: string })
  | (FieldBase<N> & {
      kind: 'select';
      options: readonly SelectOption[];
      placeholder?: string | undefined;
      mode?: 'multiple' | 'tags' | undefined;
      allowClear?: boolean | undefined;
      showSearch?: boolean | undefined;
    })
  | (FieldBase<N> & {
      kind: 'radio';
      options: readonly SelectOption[];
      optionType?: 'default' | 'button' | undefined;
    })
  | (FieldBase<N> & { kind: 'checkbox'; options: readonly SelectOption[] })
  | (FieldBase<N> & {
      /** ISO instant with offset, displayed in Asia/Shanghai. */
      kind: 'date';
      showTime?: boolean | undefined;
      placeholder?: string | undefined;
      /**
       * The end of a window: a picked day means 23:59:59 of it. Inferred from
       * the name when omitted (`endAt`, `validTo`, `claimTo`, `…Until`).
       */
      endOfDay?: boolean | undefined;
    })
  | (FieldBase<N> & {
      /** `[startISO, endISO]`. */
      kind: 'dateRange';
      showTime?: boolean | undefined;
      wholeDays?: boolean | undefined;
    })
  | (FieldBase<N> & {
      kind: 'treeSelect';
      treeData?: import('./select-fields').TreeOption[] | undefined;
      loadOptions?: (() => Promise<import('./select-fields').TreeOption[]>) | undefined;
      cacheKey?: string | undefined;
      multiple?: boolean | undefined;
      leafOnly?: boolean | undefined;
      /** See `TreeSelectFieldProps.withParents`. */
      withParents?: boolean | undefined;
      placeholder?: string | undefined;
    })
  | (FieldBase<N> & {
      kind: 'cascader';
      options?: import('./select-fields').CascaderOption[] | undefined;
      loadOptions?: (() => Promise<import('./select-fields').CascaderOption[]>) | undefined;
      cacheKey?: string | undefined;
      changeOnSelect?: boolean | undefined;
      placeholder?: string | undefined;
    })
  | (FieldBase<N> & { kind: 'richText'; minHeight?: number })
  | (FieldBase<N> & {
      kind: 'asset';
      multiple?: boolean | undefined;
      max?: number | undefined;
      valueType?: AssetValueType | undefined;
      size?: number | undefined;
    })
  | (FieldBase<N> & { kind: 'link'; allow?: readonly LinkTargetType[] })
  | (FieldBase<N> & {
      kind: 'sortableList';
      renderItem: (item: never, helpers: SortableItemHelpers<never>) => ReactNode;
      newItem?: (() => unknown) | undefined;
      addText?: string | undefined;
      max?: number | undefined;
      min?: number | undefined;
      emptyText?: string | undefined;
    })
  | (FieldBase<N> & {
      /** Anything the kit doesn't cover. Gets antd's `value` / `onChange` contract. */
      kind: 'custom';
      render: (props: {
        value: unknown;
        onChange: (value: unknown) => void;
        disabled: boolean;
        id?: string | undefined;
      }) => ReactNode;
      /** Set when your control uses a prop other than `value`, e.g. `'checked'`. */
      valuePropName?: string | undefined;
    })
  | (FieldBase<N> & {
      /** Carried in the form value, never rendered. */
      kind: 'hidden';
    });

export function toNamePath(name: FieldName): (string | number)[] {
  return Array.isArray(name) ? name : name.split('.');
}
