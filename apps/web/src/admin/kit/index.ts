// ── Display primitives ──────────────────────────────────────────────────────
export { ConfirmAction } from './confirm-action';
export type { ConfirmActionProps } from './confirm-action';
export { ConfirmButton } from './confirm-button';
export { StatusToggleButton } from './status-toggle-button';
export type { StatusToggleButtonProps } from './status-toggle-button';
export type { ConfirmButtonProps } from './confirm-button';
export { DescriptionsCard } from './descriptions-card';
export { ErrorSummary } from './error-summary';
export type { ErrorSummaryProps } from './error-summary';
export type { DescriptionEntry, DescriptionsCardProps } from './descriptions-card';
export { InstantText } from './instant-text';
export type { InstantTextProps } from './instant-text';
export { MoneyText } from './money-text';
export type { MoneyTextProps } from './money-text';
export { PageContainer } from './page-container';
export type { BreadcrumbEntry, PageContainerProps } from './page-container';
export { StatusTag, statusOptions } from './status-tag';
export type { StatusColor, StatusMap, StatusOption, StatusTagProps } from './status-tag';

// ── Value helpers ───────────────────────────────────────────────────────────
export {
  addMoney,
  fenToMoney,
  formatMoney,
  isMoney,
  moneyToFen,
  multiplyMoney,
  normaliseMoney,
} from './money';
export type { FormatMoneyOptions } from './money';
export { DISPLAY_TZ, formatInstant, fromInstant, toDisplayDayjs, toInstant } from './instant';
export type { InstantFormat } from './instant';

// ── Table ───────────────────────────────────────────────────────────────────
export { CrudTable, TableToolbar } from './table/crud-table';
export type {
  BatchActionContext,
  CrudTableProps,
  PagedItemOf,
  ToolbarContext,
} from './table/crud-table';
export {
  actionsColumn,
  CodeText,
  codeColumn,
  codeWidth,
  enumColumn,
  errorColumn,
  idColumn,
  imageColumn,
  instantColumn,
  moneyColumn,
  textColumn,
} from './table/columns';
export { FilterBar, filterKeys } from './table/filter-bar';
export type { FilterBarProps, FilterSpec } from './table/filter-bar';
export { prefixKey, useMemoryUrlState, useNextUrlState } from './table/url-state';
export { listReturnHref, useDetailHref, useListReturn, withListReturn } from './table/list-return';
export type { MemoryUrlState, TableUrlState } from './table/url-state';

// ── Forms ───────────────────────────────────────────────────────────────────
export { ZodForm } from './form/zod-form';
export type { ZodFormProps } from './form/zod-form';
export { DrawerForm, ModalForm, useFormModal } from './form/modal-form';
export type {
  DrawerFormProps,
  EntityFormLoad,
  EntityFormProps,
  FormDialogSize,
  FormModalController,
  FormModalDetail,
  ModalFormProps,
  UseFormModalOptions,
} from './form/modal-form';
export { useLeaveGuard } from './leave-guard';
export { useSaveShortcut } from './save-shortcut';
export { MoneyInput } from './form/money-input';
export type { MoneyInputProps } from './form/money-input';
export { DateField, DateRangeField } from './form/date-fields';
export type { DateFieldProps, DateRangeFieldProps } from './form/date-fields';
export { CascaderField, TreeSelectField } from './form/select-fields';
export type {
  CascaderFieldProps,
  CascaderOption,
  TreeOption,
  TreeSelectFieldProps,
} from './form/select-fields';
export { RichTextField } from './form/rich-text-field';
export type { RichTextFieldProps } from './form/rich-text-field';
export { AssetField } from './form/asset-field';
export type { AssetFieldProps, AssetValueType } from './form/asset-field';
export { LinkField } from './form/link-field';
export type { LinkFieldProps } from './form/link-field';
export { SortableListField } from './form/sortable-list-field';
export type { SortableItemHelpers, SortableListFieldProps } from './form/sortable-list-field';
export { toNamePath } from './form/types';
export type { FieldBase, FieldName, FieldSpec, SelectOption } from './form/types';
export {
  applyFieldErrors,
  applyZodIssues,
  emptyValueFor,
  fieldSchemaOf,
  isFieldRequired,
  matchApiError,
  matchFieldErrors,
  normaliseFormValues,
  zodFieldRule,
} from './form/zod-bridge';
export type { FieldErrorMatch } from './form/zod-bridge';
export { FormErrorBanner, useFieldErrors } from './form/form-errors';

// ── Asset library ───────────────────────────────────────────────────────────
export { SideTree } from './tree/side-tree';
export type { SideTreeProps } from './tree/side-tree';
export { AssetPicker, useAssetPicker } from './asset/asset-picker';
export type { AssetPickerHandle, AssetPickerProps } from './asset/asset-picker';
export { AssetSourceProvider, useAssetSource } from './asset/asset-source-context';
export type {
  AssetCategory,
  AssetItem,
  AssetListQuery,
  AssetListResult,
  AssetSource,
} from './asset/types';

// ── Product SKUs ────────────────────────────────────────────────────────────
export { SkuPicker } from './sku-picker';
export type { PickedSku, SkuPickerProps } from './sku-picker';

// ── Storefront links ────────────────────────────────────────────────────────
export { LinkPicker, LinkSourceProvider, useLinkSource } from './link/link-picker';
export type { LinkPickerProps } from './link/link-picker';
export type {
  LinkPage,
  LinkPageGroup,
  LinkSource,
  LinkTarget,
  LinkTargetQuery,
  LinkTargetResult,
  LinkTargetType,
  LinkValue,
} from './link/types';

// ── Settings ────────────────────────────────────────────────────────────────
export { ConfigGroupForm } from './config/config-group-form';
export type { ConfigGroupFormProps } from './config/config-group-form';
export { buildConfigPayload, isConfigFieldVisible } from './config/types';
export type {
  ConfigFieldDescriptor,
  ConfigFieldKind,
  ConfigGroupDescriptor,
  ConfigSelectOption,
  ConfigValues,
  ConfigVisibleWhen,
} from './config/types';
