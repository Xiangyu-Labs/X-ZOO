import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiError } from '@/admin/api/errors';
import { renderAdmin, zhName } from '@/test/render';

import type { FieldSpec } from './types';
import { ZodForm } from './zod-form';

const schema = z
  .object({
    name: z.string().min(2, '名称至少 2 个字'),
    price: z.string().regex(/^\d+\.\d{2}$/, '金额格式不正确'),
    quantity: z.coerce.number().int().min(0, '数量不能为负').default(0),
    note: z.string().optional(),
    confirm: z.string().optional(),
  })
  .refine((value) => value.confirm === undefined || value.confirm === value.name, {
    message: '两次输入的名称不一致',
    path: ['confirm'],
  });

const fields: FieldSpec[] = [
  { kind: 'text', name: 'name', label: '名称' },
  { kind: 'money', name: 'price', label: '价格' },
  { kind: 'number', name: 'quantity', label: '数量' },
  { kind: 'text', name: 'note', label: '备注' },
  { kind: 'text', name: 'confirm', label: '确认名称' },
];

function setup(props: Partial<Parameters<typeof ZodForm>[0]> = {}) {
  const onSubmit = vi.fn();
  renderAdmin(
    <ZodForm
      schema={schema as never}
      fields={fields}
      onSubmit={onSubmit}
      initialValues={{ name: '有效名称', price: '10.00', quantity: 1 }}
      {...props}
    />,
  );
  return { onSubmit };
}

const submit = () => screen.getByRole('button', { name: zhName('保存') });

describe('<ZodForm> validation', () => {
  it('marks a field required from the schema, and an optional one not', () => {
    setup();
    // antd renders the required marker as a `*` inside the label.
    const nameLabel = screen.getByText('名称').closest('label');
    const noteLabel = screen.getByText('备注').closest('label');
    expect(nameLabel?.className).toContain('ant-form-item-required');
    expect(noteLabel?.className).not.toContain('ant-form-item-required');
  });

  it('shows the zod message for a field that fails its own schema', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.clear(screen.getByLabelText('名称'));
    await user.type(screen.getByLabelText('名称'), 'x');
    await user.click(submit());

    expect(await screen.findByText('名称至少 2 个字')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the parsed value, with defaults and coercions applied', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ initialValues: { name: '有效名称', price: '10.00' } });

    await user.click(submit());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      name: '有效名称',
      price: '10.00',
      quantity: 0,
    });
  });

  it('enforces a cross-field refinement on submit', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();

    await user.type(screen.getByLabelText('确认名称'), '别的名称');
    await user.click(submit());

    expect(await screen.findByText('两次输入的名称不一致')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('<ZodForm> placeholders', () => {
  it('asks for a field by its label, with a space before a Latin one', () => {
    renderAdmin(
      <ZodForm
        schema={z.object({ name: z.string(), spu: z.string().optional() }) as never}
        fields={[
          { kind: 'text', name: 'name', label: '名称' },
          { kind: 'text', name: 'spu', label: 'SPU 编码' },
        ]}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('名称')).toHaveAttribute('placeholder', '请输入名称');
    expect(screen.getByLabelText('SPU 编码')).toHaveAttribute('placeholder', '请输入 SPU 编码');
  });
});

describe('<ZodForm> Enter', () => {
  it('saves from a one-line field, but only confirms the date in a date picker', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderAdmin(
      <ZodForm
        schema={z.object({ name: z.string(), startAt: z.string().optional() }) as never}
        fields={[
          { kind: 'text', name: 'name', label: '名称' },
          { kind: 'date', name: 'startAt', label: '开始时间' },
        ]}
        onSubmit={onSubmit}
        initialValues={{ name: '有效名称' } as never}
      />,
    );

    await user.type(screen.getByLabelText('开始时间'), '2026-10-01{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('名称'), '{Enter}');
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });
});

describe('<ZodForm> empty and cleared fields', () => {
  const clearable = z.object({
    name: z.string().min(1).max(10),
    kind: z.enum(['a', 'b']),
    limit: z.number().int().min(1).optional(),
    birthday: z.string().nullable().optional(),
    note: z.string().optional(),
  });
  const clearableFields: FieldSpec[] = [
    { kind: 'text', name: 'name', label: '名称' },
    {
      kind: 'select',
      name: 'kind',
      label: '类型',
      options: [
        { label: '甲', value: 'a' },
        { label: '乙', value: 'b' },
      ],
    },
    { kind: 'number', name: 'limit', label: '每人限领' },
    { kind: 'text', name: 'birthday', label: '生日' },
    { kind: 'text', name: 'note', label: '备注' },
  ];

  function renderClearable(initialValues: Record<string, unknown>) {
    const onSubmit = vi.fn();
    renderAdmin(
      <ZodForm
        schema={clearable as never}
        fields={clearableFields}
        onSubmit={onSubmit}
        initialValues={initialValues as never}
      />,
    );
    return { onSubmit };
  }

  it('asks for an empty required field by its label, never with a zod type error', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderClearable({});

    await user.click(submit());

    expect(await screen.findByText('请填写名称')).toBeInTheDocument();
    // 请选择类型 is the select's placeholder too; the error is the one under it.
    const errors = () =>
      [...document.querySelectorAll('.ant-form-item-explain-error')].map(
        (node) => node.textContent,
      );
    expect(errors()).toContain('请选择类型');
    expect(screen.queryByText(/期望|undefined/)).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('stops typing at the length the contract allows', async () => {
    const user = userEvent.setup();
    renderClearable({ name: '', kind: 'a' });

    await user.type(screen.getByLabelText('名称'), '一二三四五六七八九十十一');

    expect(screen.getByLabelText('名称')).toHaveValue('一二三四五六七八九十');
  });

  it('says how long a text may be in words, for a value already too long', async () => {
    const user = userEvent.setup();
    renderClearable({ name: '一二三四五六七八九十十一', kind: 'a' });

    await user.click(submit());

    expect(await screen.findByText('最多 10 个字')).toBeInTheDocument();
  });

  it('lets an optional number, a nullable value and a text be cleared, and trims text', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderClearable({
      name: '  张三 ',
      kind: 'a',
      limit: 5,
      birthday: '1990-01-01',
      note: '备注',
    });

    await user.clear(screen.getByLabelText('每人限领'));
    await user.clear(screen.getByLabelText('生日'));
    await user.clear(screen.getByLabelText('备注'));
    await user.click(submit());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // Optional → absent; nullable → null, the explicit clear; text trimmed.
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ name: '张三', kind: 'a', birthday: null });
  });
});

describe('<ZodForm> server errors', () => {
  it('maps a 422 detail onto the matching field', async () => {
    setup({
      error: new ApiError({
        status: 422,
        code: 'VALIDATION_FAILED',
        message: '提交的数据有误',
        details: { fieldErrors: { name: ['该名称已被占用'] } },
      }),
    });

    expect(await screen.findByText('该名称已被占用')).toBeInTheDocument();
    // A mapped 422 is shown on the field, not duplicated as a banner.
    expect(screen.queryByText('提交的数据有误')).not.toBeInTheDocument();
  });

  it('maps the `{ field, message }` list handle() sends onto the matching field', async () => {
    setup({
      error: new ApiError({
        status: 422,
        code: 'VALIDATION_FAILED',
        message: '提交的数据有误',
        details: [{ field: 'name', message: '该名称已被占用' }],
      }),
    });

    expect(await screen.findByText('该名称已被占用')).toBeInTheDocument();
    expect(screen.queryByText('提交的数据有误')).not.toBeInTheDocument();
  });

  it('shows a non-422 failure as a banner', async () => {
    setup({
      error: new ApiError({ status: 409, code: 'THING_LOCKED', message: '该记录已被锁定' }),
    });
    expect(await screen.findByText('该记录已被锁定')).toBeInTheDocument();
  });

  it('shows a 422 without usable details as a banner', async () => {
    setup({
      error: new ApiError({ status: 422, code: 'VALIDATION_FAILED', message: '提交的数据有误' }),
    });
    expect(await screen.findByText('提交的数据有误')).toBeInTheDocument();
  });
});

/** The form-level `<Alert>`; antd also gives every field error `role="alert"`. */
const banner = () => document.querySelector('.ant-alert');

describe('<ZodForm> errors no field shows', () => {
  const serverError = (details: unknown) =>
    new ApiError({ status: 422, code: 'VALIDATION_FAILED', message: '提交的数据有误', details });

  it('shows a 422 on a route param as a banner, with its message', async () => {
    setup({ error: serverError([{ field: 'params.id', message: 'ID 不合法' }]) });

    await waitFor(() => expect(banner()).toHaveTextContent('提交的数据有误'));
    expect(banner()).toHaveTextContent('ID 不合法');
  });

  it('shows what landed on a field there, and the rest in the banner', async () => {
    setup({
      error: serverError([
        { field: 'name', message: '该名称已被占用' },
        { field: 'params.id', message: 'ID 不合法' },
      ]),
    });

    const nameItem = (await screen.findByLabelText('名称')).closest('.ant-form-item');
    await waitFor(() => expect(nameItem).toHaveTextContent('该名称已被占用'));
    expect(banner()).toHaveTextContent('ID 不合法');
    expect(banner()).not.toHaveTextContent('该名称已被占用');
  });

  it('shows a 422 on a field hidden by visibleWhen as a banner', async () => {
    setup({
      fields: fields.map((spec) =>
        spec.name === 'note' ? { ...spec, visibleWhen: () => false } : spec,
      ),
      error: serverError([{ field: 'note', message: '备注过长' }]),
    });

    await waitFor(() => expect(banner()).toHaveTextContent('备注过长'));
  });

  it('moves an error from the banner onto its field when the field comes into view', async () => {
    const user = userEvent.setup();
    setup({
      fields: fields.map((spec) =>
        spec.name === 'note' ? { ...spec, visibleWhen: (v) => v['name'] === '显示备注' } : spec,
      ),
      error: serverError([{ field: 'note', message: '备注过长' }]),
    });
    await waitFor(() => expect(banner()).toHaveTextContent('备注过长'));

    const name = screen.getByLabelText('名称');
    await user.clear(name);
    await user.type(name, '显示备注');

    const noteItem = (await screen.findByLabelText('备注')).closest('.ant-form-item');
    await waitFor(() => expect(noteItem).toHaveTextContent('备注过长'));
    expect(banner()).toBeNull();
  });

  it('shows a 422 on a hidden-kind field as a banner', async () => {
    setup({
      fields: fields.map((spec) =>
        spec.name === 'note' ? { kind: 'hidden', name: 'note' } : spec,
      ),
      error: serverError([{ field: 'note', message: '备注过长' }]),
    });

    await waitFor(() => expect(banner()).toHaveTextContent('备注过长'));
  });
});

describe('<ZodForm> errors inside a custom field', () => {
  const skuSchema = z
    .object({
      name: z.string().min(1),
      skus: z.array(z.object({ price: z.string() })),
    })
    .superRefine((value, ctx) => {
      value.skus.forEach((sku, index) => {
        if (sku.price === '0.00') {
          ctx.addIssue({ code: 'custom', path: ['skus', index, 'price'], message: '价格不能为 0' });
        }
      });
    });

  const skuFields: FieldSpec[] = [
    { kind: 'text', name: 'name', label: '名称' },
    { kind: 'custom', name: 'skus', label: '规格', render: () => <span>规格表</span> },
  ];

  function setupSkus(props: Partial<Parameters<typeof ZodForm>[0]> = {}) {
    const onSubmit = vi.fn();
    renderAdmin(
      <ZodForm
        schema={skuSchema as never}
        fields={skuFields}
        onSubmit={onSubmit}
        initialValues={{ name: '商品', skus: [{ price: '1.00' }, { price: '0.00' }] }}
        {...props}
      />,
    );
    return { onSubmit };
  }

  const skuItem = () => screen.getByText('规格表').closest('.ant-form-item');

  it('shows a server 422 on a row of the field under that field, without a banner', async () => {
    setupSkus({
      error: new ApiError({
        status: 422,
        code: 'VALIDATION_FAILED',
        message: '提交的数据有误',
        details: [{ field: 'skus.1.price', message: '价格不合法' }],
      }),
    });

    await waitFor(() => expect(skuItem()).toHaveTextContent('价格不合法'));
    expect(banner()).toBeNull();
  });

  it('shows a whole-form rule that fails on a row under that field', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setupSkus();

    await user.click(submit());

    await waitFor(() => expect(skuItem()).toHaveTextContent('价格不能为 0'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('<ZodForm> layout', () => {
  it('hides a field whose visibleWhen predicate fails', async () => {
    const user = userEvent.setup();
    renderAdmin(
      <ZodForm
        schema={schema as never}
        fields={[
          { kind: 'text', name: 'name', label: '名称' },
          {
            kind: 'text',
            name: 'note',
            label: '备注',
            visibleWhen: (values) => values['name'] === '显示备注',
          },
        ]}
        initialValues={{ name: '有效名称', price: '10.00' } as never}
        onSubmit={() => {}}
      />,
    );

    expect(screen.queryByLabelText('备注')).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('名称'));
    await user.type(screen.getByLabelText('名称'), '显示备注');
    await waitFor(() => expect(screen.getByLabelText('备注')).toBeInTheDocument());
  });

  it('hides the built-in footer when asked', () => {
    renderAdmin(
      <ZodForm schema={schema as never} fields={fields} footer={false} onSubmit={() => {}} />,
    );
    expect(screen.queryByRole('button', { name: zhName('保存') })).not.toBeInTheDocument();
  });
});

describe('<ZodForm> sections', () => {
  it('puts each section in its own titled card, in the order its first field comes', () => {
    const schema = z.object({ a: z.string(), b: z.string(), c: z.string() });
    renderAdmin(
      <ZodForm
        schema={schema}
        fields={[
          { kind: 'text', name: 'a', label: '名称', section: '基本信息' },
          { kind: 'text', name: 'b', label: '运费', section: '运费与限购' },
          { kind: 'text', name: 'c', label: '编码', section: '基本信息' },
        ]}
        onSubmit={vi.fn()}
      />,
    );

    const cards = [...document.querySelectorAll('.ant-card')];
    expect(cards.map((card) => card.querySelector('.ant-card-head-title')?.textContent)).toEqual([
      '基本信息',
      '运费与限购',
    ]);
    expect(cards[0]).toContainElement(screen.getByLabelText('编码'));
    expect(cards[1]).toContainElement(screen.getByLabelText('运费'));
  });
});
