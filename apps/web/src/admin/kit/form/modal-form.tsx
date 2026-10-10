'use client';

import { App, Button, Drawer, Form, Modal, Skeleton, Space, type FormInstance } from 'antd';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { z } from 'zod';

import type { ParamsInputOf, RouteInput } from '../../api/call-route';
import type { AnyRouteDef, ResponseOf } from '../../api/contracts';
import { useRouteMutation, useRouteQuery } from '../../api/hooks';
import type { FieldSpec } from './types';
import { ZodForm } from './zod-form';
import { LoadFailure } from '../load-failure';

type AnyObjectSchema = z.ZodObject<z.ZodRawShape>;

/**
 * Where an edit form's values come from when the list row is not enough.
 *
 * A list route answers the columns; an update route takes the whole record.
 * Open the form on the list row and every field the list did not carry is
 * submitted as its default — on 预售活动 that meant an empty 规格 list, and
 * every presale price on the campaign deleted by a save the operator thought
 * only changed the title. Three pages had written the same
 * fetch-first-then-render dance by hand, each a little differently, so it lives
 * here now.
 *
 * The promise is narrow and absolute: **the form is never rendered
 * half-populated.** While the detail is in flight there is a skeleton; if it
 * fails there is the reason and a 重试 button; the fields mount once, with the
 * record already in them. There is no effect that pours values into a form that
 * is already on screen, because that is the thing that goes wrong.
 *
 * `select` answers the form's values. It is typed as a plain record rather
 * than against the body schema because the controller that usually supplies it
 * (`useFormModal({ detail })`) does not know the schema; the schema is what
 * validates the values on submit, which is where a mismatch has to be caught
 * anyway.
 */
export interface EntityFormLoad<D extends AnyRouteDef = AnyRouteDef> {
  /** The detail route. */
  route: D;
  /** Its path params, e.g. `{ id }`. */
  params?: ParamsInputOf<D> | undefined;
  /**
   * The response as the form's values. Omit it when the detail route already
   * answers the shape the body schema wants.
   */
  select?: ((data: ResponseOf<D>) => Record<string, unknown>) | undefined;
}

/** What the chrome needs to know about the record it is waiting for. */
interface LoadState<S extends AnyObjectSchema> {
  ready: boolean;
  values: Partial<z.input<S>> | undefined;
  error: unknown;
  retry: () => void;
}

const noop = () => undefined;

export interface EntityFormProps<
  S extends AnyObjectSchema,
  R extends AnyRouteDef,
  D extends AnyRouteDef = AnyRouteDef,
> {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  schema: S;
  fields: readonly FieldSpec<Extract<keyof z.input<S>, string>>[];
  initialValues?: Partial<z.input<S>> | undefined;
  /**
   * Load the record before rendering the form. Omit it when creating
   * — `useFormModal({ detail })` omits it for you.
   *
   * What `select` returns is merged over `initialValues`, so a page can still
   * supply defaults the detail route does not carry.
   */
  load?: EntityFormLoad<D> | undefined;
  /** The create/update route. */
  route: R;
  /** Request builder. Default `(values) => ({ body: values })`. */
  toInput?: ((values: z.output<S>) => RouteInput<R>) | undefined;
  /** Refreshed on success — normally the list route behind the table. */
  invalidate?: readonly AnyRouteDef[] | undefined;
  successMessage?: string | undefined;
  onSuccess?: ((data: ResponseOf<R>) => void) | undefined;
  columns?: 1 | 2 | 3 | undefined;
  okText?: string | undefined;
  /** Red 保存, for a submit that cannot be taken back (通过注销 anonymises the account). */
  okDanger?: boolean | undefined;
  cancelText?: string | undefined;
  /** Extra content above the fields, e.g. a summary of the record being edited. */
  header?: ReactNode | undefined;
  /**
   * A tool at the left of the footer that works on the form as it stands —
   * 运费试算 and 通知预览 read the unsaved values from `form`. Shown once the
   * form is.
   */
  footerExtra?: ((form: FormInstance) => ReactNode) | undefined;
  /**
   * Show the record without offering to save it — for a role that may read but
   * not write. The fields are disabled and there is no 保存 to press into a
   * 403; `footerExtra` (a preview, say) still works on the values shown.
   */
  readOnly?: boolean | undefined;
}

/**
 * How wide a form dialog is. Three widths, so dialogs of the same kind are the
 * same size on every page:
 *
 * - `small` (480): one column of a few fields — a rename, a password, a
 *   退款/驳回/备注 with its reason.
 * - `medium` (640, the default): an ordinary create/edit, one or two columns.
 * - `large` (960): a long two-column form — an activity, a coupon, a role's
 *   permission tree.
 */
export type FormDialogSize = 'small' | 'medium' | 'large';

const MODAL_WIDTH: Record<FormDialogSize, number> = { small: 480, medium: 640, large: 960 };

export interface ModalFormProps<
  S extends AnyObjectSchema,
  R extends AnyRouteDef,
  D extends AnyRouteDef = AnyRouteDef,
> extends EntityFormProps<S, R, D> {
  /** Default `medium`. */
  size?: FormDialogSize | undefined;
  /**
   * An exact width, for the one dialog no tier fits (the 公众号菜单 editor draws
   * the phone next to the form). Wins over `size`.
   */
  width?: number | undefined;
}

const DRAWER_WIDTH: Record<'medium' | 'large', number> = { medium: 720, large: 960 };

export interface DrawerFormProps<
  S extends AnyObjectSchema,
  R extends AnyRouteDef,
  D extends AnyRouteDef = AnyRouteDef,
> extends EntityFormProps<S, R, D> {
  /** `medium` 720, `large` 960. Default `medium`. */
  size?: 'medium' | 'large' | undefined;
  placement?: 'right' | 'left' | undefined;
}

/**
 * The body of a dialog with many fields scrolls inside the dialog, so its
 * 保存 stays on screen. The few pixels of padding keep a focused input's
 * outline from being clipped by the scroll box.
 */
const SCROLLING_BODY = {
  maxHeight: 'calc(100vh - 240px)',
  overflowY: 'auto',
  overflowX: 'hidden',
  marginInline: -4,
  paddingInline: 4,
} as const;

/**
 * Fetches the record the form is about to edit.
 *
 * Only mounted when `load` is set, which is what keeps the hook order stable
 * between the create dialog (no detail) and the edit dialog (a detail) — the
 * same split `CrudTable` makes for its URL state.
 */
function useLoadedRecord<S extends AnyObjectSchema, D extends AnyRouteDef>(
  load: EntityFormLoad<D>,
  open: boolean,
  initialValues: Partial<z.input<S>> | undefined,
): LoadState<S> {
  const query = useRouteQuery(
    load.route,
    load.params === undefined ? undefined : ({ params: load.params } as never),
    // The dialog shows the failure itself, with the retry next to it; a toast
    // as well would be the same sentence twice.
    //
    // `refetchOnMount: 'always'`: the loader is remounted on every open (see
    // `useOpenGeneration`), and a cached detail is never good enough. It was
    // fetched before the last save — or before a 下架/停用 toggle on the list —
    // and a form mounted on it quietly saves the old record back.
    { enabled: open, presentError: false, refetchOnMount: 'always' },
  );

  const { data, error, refetch, isFetchedAfterMount, isError } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  // Ready only on an answer fetched for this opening: the cache may hold the
  // record as it was, and an error leaves the last good data in place.
  if (data === undefined || !isFetchedAfterMount || isError) {
    return {
      ready: false,
      values: undefined,
      error: isFetchedAfterMount ? (error ?? null) : null,
      retry,
    };
  }
  const selected = (load.select ? load.select(data) : data) as Partial<z.input<S>>;
  return { ready: true, values: { ...initialValues, ...selected }, error: null, retry };
}

/**
 * Counts openings, so each opening can be keyed on it. The loader then mounts a
 * fresh query observer, whose `isFetchedAfterMount` means "fetched for this
 * opening"; a form filled from the row gets a fresh `FormInstance`, since the
 * old one still holds the last record's values and antd lets them win over the
 * new `initialValues` (opening 编辑 on row B showed row A). Closing keeps the
 * key, so the close animation plays out.
 */
function useOpenGeneration(open: boolean): number {
  const [state, setState] = useState({ open, generation: 0 });
  if (state.open !== open) {
    setState({ open, generation: open ? state.generation + 1 : state.generation });
  }
  return state.generation;
}

function useEntityForm<S extends AnyObjectSchema, R extends AnyRouteDef>(
  props: EntityFormProps<S, R, AnyRouteDef>,
) {
  const { open, onClose, route, toInput, invalidate, successMessage, onSuccess, load } = props;
  const [form] = Form.useForm();

  // A save makes the record's detail stale as well as the list: anything else
  // on the page showing it (a drawer, the next opening) must read it again.
  const targets = [...(invalidate ?? []), ...(load ? [load.route] : [])];

  const mutation = useRouteMutation(route, {
    // The form shows 422 field errors and the error banner itself; a toast on
    // top of that is noise.
    presentError: false,
    ...(targets.length > 0 ? { invalidate: targets } : {}),
    ...(successMessage ? { successMessage } : {}),
    onSuccess(data) {
      onSuccess?.(data);
      onClose();
    },
  });

  const { reset } = mutation;
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  const submit = useCallback(
    async (values: z.output<S>) => {
      // Enter in a field submits too, and a second Enter must not send twice.
      if (mutation.isPending) return;
      const input = toInput ? toInput(values) : ({ body: values } as RouteInput<R>);
      await mutation.mutateAsync(input).catch(() => {
        /* surfaced through `mutation.error` on the form */
      });
    },
    [mutation, toInput],
  );

  return { form, mutation, submit };
}

/**
 * Closing a form the operator has typed into asks first.
 *
 * Esc, the ✕ and 取消 all land here, and each of them used to throw away a
 * half-written activity without a word. Nothing is asked when nothing was
 * touched, when the form is read-only, or before the record has loaded; and
 * nothing closes while the save is in flight — the dialog would vanish with
 * the result still to come.
 */
function useGuardedClose(
  form: FormInstance,
  onClose: () => void,
  { busy, guarded }: { busy: boolean; guarded: boolean },
): () => void {
  const { modal } = App.useApp();
  const asking = useRef(false);
  return useCallback(() => {
    if (busy) return;
    if (!guarded || !form.isFieldsTouched()) {
      onClose();
      return;
    }
    if (asking.current) return;
    asking.current = true;
    modal.confirm({
      title: '放弃未保存的修改？',
      content: '关闭后，这次填写的内容不会保存。',
      okText: '放弃修改',
      okButtonProps: { danger: true },
      cancelText: '继续编辑',
      // A stray Enter keeps the work rather than discarding it.
      focusable: { autoFocusButton: 'cancel' },
      onOk: () => {
        asking.current = false;
        onClose();
      },
      onCancel: () => {
        asking.current = false;
      },
    });
  }, [busy, guarded, form, onClose, modal]);
}

interface ChromeParts {
  footer: ReactNode;
  body: ReactNode;
  close: () => void;
  busy: boolean;
}

/**
 * What the modal and the drawer share: the footer (a tool on the left; 取消
 * then 保存 on the right), the body (skeleton, failure or the form), and the
 * guarded close.
 *
 * 保存 is a real submit button tied to the form by id, though it sits in the
 * dialog's footer outside the `<form>`: Enter in a one-line field then submits
 * the way it does on any web form, and a textarea keeps its newline.
 */
function useChrome<S extends AnyObjectSchema, R extends AnyRouteDef, D extends AnyRouteDef>(
  props: EntityFormProps<S, R, D> & { loaded: LoadState<S> },
): ChromeParts {
  const { form, mutation, submit } = useEntityForm(props);
  const formId = useId();
  const {
    onClose,
    schema,
    fields,
    loaded,
    columns = 1,
    okText = '保存',
    okDanger = false,
    cancelText = '取消',
    header,
    footerExtra,
    readOnly = false,
  } = props;
  const busy = mutation.isPending;
  const close = useGuardedClose(form, onClose, { busy, guarded: loaded.ready && !readOnly });

  const footer = (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <div>{loaded.ready && footerExtra ? footerExtra(form) : null}</div>
      <Space>
        <Button onClick={close} disabled={busy}>
          {readOnly ? '关闭' : cancelText}
        </Button>
        {/* No 保存 until there is something to save: a submit from a form
            that never received the record is the bug this whole path exists
            to prevent. */}
        {loaded.ready && !readOnly ? (
          <Button type="primary" danger={okDanger} htmlType="submit" form={formId} loading={busy}>
            {okText}
          </Button>
        ) : null}
      </Space>
    </div>
  );

  const body = (
    <>
      {header}
      {loaded.ready ? (
        <ZodForm
          id={formId}
          form={form}
          schema={schema}
          fields={fields}
          {...(loaded.values ? { initialValues: loaded.values } : {})}
          columns={columns}
          disabled={readOnly}
          footer={false}
          submitting={busy}
          error={mutation.error}
          onSubmit={submit}
        />
      ) : loaded.error ? (
        <LoadFailure error={loaded.error} onRetry={loaded.retry} />
      ) : (
        <Skeleton active paragraph={{ rows: 6 }} />
      )}
    </>
  );

  return { footer, body, close, busy };
}

/**
 * A schema-driven create/edit dialog wired to a mutation route. Replaces the
 * old server-driven `$modalForm`.
 *
 * ```tsx
 * const modal = useFormModal<Coupon>();
 * // …
 * <Button onClick={() => modal.show()}>新建</Button>
 * <ModalForm
 *   {...modal.props}
 *   title={modal.record ? '编辑优惠券' : '新建优惠券'}
 *   schema={couponCreate.body}
 *   fields={couponFields}
 *   initialValues={modal.record}
 *   route={modal.record ? couponUpdate : couponCreate}
 *   toInput={(values) => modal.record
 *     ? { params: { id: modal.record.id }, body: values }
 *     : { body: values }}
 *   invalidate={[couponList]}
 *   successMessage="已保存"
 * />
 * ```
 */
export function ModalForm<
  S extends AnyObjectSchema,
  R extends AnyRouteDef,
  D extends AnyRouteDef = AnyRouteDef,
>(props: ModalFormProps<S, R, D>) {
  // Two components rather than a conditional hook: `load` is present on the
  // edit dialog and absent on the create dialog, and the same `CrudTable`
  // splits for the same reason.
  const generation = useOpenGeneration(props.open);
  if (props.load) return <ModalFormLoading key={generation} {...props} load={props.load} />;
  return (
    <ModalFormChrome
      key={generation}
      {...props}
      loaded={{ ready: true, values: props.initialValues, error: null, retry: noop }}
    />
  );
}

function ModalFormLoading<S extends AnyObjectSchema, R extends AnyRouteDef, D extends AnyRouteDef>(
  props: ModalFormProps<S, R, D> & { load: EntityFormLoad<D> },
) {
  const loaded = useLoadedRecord<S, D>(props.load, props.open, props.initialValues);
  return <ModalFormChrome {...props} loaded={loaded} />;
}

function ModalFormChrome<S extends AnyObjectSchema, R extends AnyRouteDef, D extends AnyRouteDef>(
  props: ModalFormProps<S, R, D> & { loaded: LoadState<S> },
) {
  const { footer, body, close, busy } = useChrome(props);
  const { open, title, size = 'medium', width } = props;

  return (
    <Modal
      open={open}
      title={title}
      width={width ?? MODAL_WIDTH[size]}
      onCancel={close}
      closable={!busy}
      keyboard={!busy}
      mask={{ closable: false }}
      destroyOnHidden
      styles={{ body: SCROLLING_BODY }}
      footer={footer}
    >
      {body}
    </Modal>
  );
}

/** Same contract as `ModalForm`, in a drawer — for forms with many fields. */
export function DrawerForm<
  S extends AnyObjectSchema,
  R extends AnyRouteDef,
  D extends AnyRouteDef = AnyRouteDef,
>(props: DrawerFormProps<S, R, D>) {
  const generation = useOpenGeneration(props.open);
  if (props.load) return <DrawerFormLoading key={generation} {...props} load={props.load} />;
  return (
    <DrawerFormChrome
      key={generation}
      {...props}
      loaded={{ ready: true, values: props.initialValues, error: null, retry: noop }}
    />
  );
}

function DrawerFormLoading<S extends AnyObjectSchema, R extends AnyRouteDef, D extends AnyRouteDef>(
  props: DrawerFormProps<S, R, D> & { load: EntityFormLoad<D> },
) {
  const loaded = useLoadedRecord<S, D>(props.load, props.open, props.initialValues);
  return <DrawerFormChrome {...props} loaded={loaded} />;
}

function DrawerFormChrome<S extends AnyObjectSchema, R extends AnyRouteDef, D extends AnyRouteDef>(
  props: DrawerFormProps<S, R, D> & { loaded: LoadState<S> },
) {
  const { footer, body, close, busy } = useChrome(props);
  const { open, title, size = 'medium', placement = 'right' } = props;

  return (
    <Drawer
      open={open}
      title={title}
      size={DRAWER_WIDTH[size]}
      placement={placement}
      onClose={close}
      closable={!busy}
      keyboard={!busy}
      mask={{ closable: false }}
      destroyOnHidden
      footer={footer}
    >
      {body}
    </Drawer>
  );
}

/**
 * The detail route an edit dialog loads before it renders.
 *
 * Give it to `useFormModal` next to the table's list route and the wiring is
 * done: `modal.props` carries `load` when a row is being edited and omits it
 * when a new record is being created, so the create dialog still opens
 * instantly and asks for nothing.
 */
export interface FormModalDetail<T, D extends AnyRouteDef> {
  route: D;
  /** The row's path params, e.g. `(row) => ({ id: row.id })`. */
  params: (record: T) => ParamsInputOf<D>;
  /** The detail as the form's values. Omit when the shapes already agree. */
  select?: ((data: ResponseOf<D>) => Record<string, unknown>) | undefined;
}

export interface FormModalController<T, D extends AnyRouteDef = AnyRouteDef> {
  open: boolean;
  /** The record being edited, or `undefined` when creating. */
  record: T | undefined;
  show: (record?: T) => void;
  close: () => void;
  /** Spread onto `<ModalForm>` / `<DrawerForm>`. */
  props: { open: boolean; onClose: () => void; load?: EntityFormLoad<D> | undefined };
}

export interface UseFormModalOptions<T, D extends AnyRouteDef> {
  /**
   * Load the whole record before the edit form renders.
   *
   * Pass it whenever the update route's body is wider than the list row — that
   * is, nearly always. Without it, every field the list did not carry is
   * submitted as its schema default, and the operator's "I only changed the
   * title" quietly blanks the rest.
   */
  detail?: FormModalDetail<T, D> | undefined;
}

/**
 * Open/close, "which record", and — with `detail` — loading that record.
 *
 * ```tsx
 * const modal = useFormModal<PresaleActivityListItem, typeof presaleAdminActivityDetail>({
 *   detail: {
 *     route: presaleAdminActivityDetail,
 *     params: (row) => ({ id: row.id }),
 *     select: initialValuesOf,
 *   },
 * });
 * // …
 * <ModalForm {...modal.props} schema={…} route={modal.record ? update : create} … />
 * ```
 */
export function useFormModal<T, D extends AnyRouteDef = AnyRouteDef>(
  options: UseFormModalOptions<T, D> = {},
): FormModalController<T, D> {
  const [state, setState] = useState<{ open: boolean; record: T | undefined }>({
    open: false,
    record: undefined,
  });

  const close = useCallback(() => setState({ open: false, record: undefined }), []);
  const show = useCallback((record?: T) => setState({ open: true, record }), []);

  const { detail } = options;
  const record = state.record;
  // No record means "create": no detail to fetch, and no skeleton in front of
  // an empty form.
  const load =
    detail && record !== undefined
      ? {
          route: detail.route,
          params: detail.params(record),
          ...(detail.select ? { select: detail.select } : {}),
        }
      : undefined;

  return {
    open: state.open,
    record,
    show,
    close,
    props: { open: state.open, onClose: close, ...(load ? { load } : {}) },
  };
}
