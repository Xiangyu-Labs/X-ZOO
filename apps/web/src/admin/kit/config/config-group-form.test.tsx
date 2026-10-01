import { defineRoute } from '@shop/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { resetApiConfig } from '@/admin/api/config';
import { on, respondWithError, stubRoutes } from '@/test/api';
import { renderAdmin, zhName } from '@/test/render';

import { ConfigGroupForm } from './config-group-form';
import {
  buildConfigPayload,
  changedConfigKeys,
  isConfigFieldVisible,
  type ConfigGroupDescriptor,
} from './types';

const descriptor: ConfigGroupDescriptor = {
  group: 'demo',
  title: '演示配置',
  fields: [
    { key: 'siteName', label: '站点名称', kind: 'text', required: true },
    { key: 'apiSecret', label: '接口密钥', kind: 'password' },
    { key: 'smsSecret', label: '短信密钥', kind: 'password' },
    { key: 'mode', label: '模式', kind: 'select', options: [{ label: '快递', value: 'express' }] },
    {
      key: 'threshold',
      label: '门槛',
      kind: 'money',
      visibleWhen: { key: 'mode', equals: 'express' },
    },
  ],
};

const saveRoute = defineRoute({
  id: 'test.configSave',
  method: 'PUT',
  path: '/admin-api/config/:group',
  auth: 'admin',
  permission: 'test:config:save',
  summary: '保存配置',
  tags: ['test'],
  params: z.object({ group: z.string() }),
  body: z.object({ values: z.record(z.string(), z.unknown()) }),
  response: z.object({ ok: z.literal(true) }),
  examples: [
    { name: 'ok', params: { group: 'demo' }, body: { values: {} }, response: { ok: true } },
  ],
});

// `apiSecret` is already set (boolean flag, never the secret); `smsSecret` isn't.
const values = { siteName: '示例商城', apiSecret: true, smsSecret: false, mode: 'express' };

function stubSave(): { bodies: unknown[] } {
  const bodies: unknown[] = [];
  stubRoutes([
    on(saveRoute, (call) => {
      bodies.push(call.body);
      return { ok: true };
    }),
  ]);
  return { bodies };
}

afterEach(() => resetApiConfig());

describe('buildConfigPayload', () => {
  it('omits a secret the operator did not retype', () => {
    const payload = buildConfigPayload(descriptor, { ...values }, {});
    expect(payload).not.toHaveProperty('apiSecret');
    expect(payload).not.toHaveProperty('smsSecret');
    expect(payload['siteName']).toBe('示例商城');
  });

  it('includes a secret that was retyped', () => {
    const payload = buildConfigPayload(descriptor, { ...values }, { apiSecret: 'new-secret' });
    expect(payload['apiSecret']).toBe('new-secret');
    expect(payload).not.toHaveProperty('smsSecret');
  });

  it('treats an emptied secret box as "leave it alone", not "clear it"', () => {
    const payload = buildConfigPayload(descriptor, { ...values }, { apiSecret: '' });
    expect(payload).not.toHaveProperty('apiSecret');
  });

  it('leaves out fields hidden by visibleWhen', () => {
    const payload = buildConfigPayload(
      descriptor,
      { ...values, mode: 'city', threshold: '9.00' },
      {},
    );
    expect(payload).not.toHaveProperty('threshold');
  });
});

describe('isConfigFieldVisible', () => {
  const field = descriptor.fields[4]!;

  it('matches a single value and a list of values', () => {
    expect(isConfigFieldVisible(field, { mode: 'express' })).toBe(true);
    expect(isConfigFieldVisible(field, { mode: 'city' })).toBe(false);
    expect(
      isConfigFieldVisible(
        { ...field, visibleWhen: { key: 'mode', equals: ['express', 'city'] } },
        { mode: 'city' },
      ),
    ).toBe(true);
  });

  it('always shows a field with no condition', () => {
    expect(isConfigFieldVisible(descriptor.fields[0]!, {})).toBe(true);
  });
});

describe('<ConfigGroupForm> secrets', () => {
  it('shows 已设置 / 未设置 instead of the secret', () => {
    stubSave();
    renderAdmin(<ConfigGroupForm descriptor={descriptor} values={values} route={saveRoute} />);

    expect(screen.getByTestId('secret-state-apiSecret')).toHaveTextContent('已设置');
    expect(screen.getByTestId('secret-state-smsSecret')).toHaveTextContent('未设置');
    expect(screen.getByTestId('secret-input-apiSecret')).toHaveValue('');
  });

  it('does not send an untouched secret', async () => {
    const user = userEvent.setup();
    const { bodies } = stubSave();
    renderAdmin(<ConfigGroupForm descriptor={descriptor} values={values} route={saveRoute} />);

    await user.click(screen.getByRole('button', { name: zhName('保存') }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    const sent = (bodies[0] as { values: Record<string, unknown> }).values;
    expect(sent).not.toHaveProperty('apiSecret');
    expect(sent).not.toHaveProperty('smsSecret');
    expect(sent['siteName']).toBe('示例商城');
  });

  it('sends only the secret that was changed', async () => {
    const user = userEvent.setup();
    const { bodies } = stubSave();
    renderAdmin(<ConfigGroupForm descriptor={descriptor} values={values} route={saveRoute} />);

    await user.type(screen.getByTestId('secret-input-apiSecret'), 'brand-new');
    await user.click(screen.getByRole('button', { name: zhName('保存') }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    const sent = (bodies[0] as { values: Record<string, unknown> }).values;
    expect(sent['apiSecret']).toBe('brand-new');
    expect(sent).not.toHaveProperty('smsSecret');
  });

  it('clears the typed secret after a successful save', async () => {
    const user = userEvent.setup();
    stubSave();
    renderAdmin(<ConfigGroupForm descriptor={descriptor} values={values} route={saveRoute} />);

    await user.type(screen.getByTestId('secret-input-apiSecret'), 'brand-new');
    await user.click(screen.getByRole('button', { name: zhName('保存') }));

    await waitFor(() => expect(screen.getByTestId('secret-input-apiSecret')).toHaveValue(''));
  });

  it('sends the group as a path param', async () => {
    const user = userEvent.setup();
    const calls = stubRoutes([on(saveRoute, { ok: true })]);
    renderAdmin(<ConfigGroupForm descriptor={descriptor} values={values} route={saveRoute} />);

    await user.click(screen.getByRole('button', { name: zhName('保存') }));
    await waitFor(() => expect(calls[0]?.url).toBe('/admin-api/config/demo'));
  });
});

describe('<ConfigGroupForm> server errors', () => {
  function stubRejection(details: unknown) {
    stubRoutes([
      on(saveRoute, () =>
        respondWithError(422, { code: 'VALIDATION_FAILED', message: '提交的数据有误', details }),
      ),
    ]);
  }

  const banner = () => document.querySelector('.ant-alert');

  async function save(): Promise<void> {
    const user = userEvent.setup();
    renderAdmin(<ConfigGroupForm descriptor={descriptor} values={values} route={saveRoute} />);
    await user.click(screen.getByRole('button', { name: zhName('保存') }));
  }

  it('shows an error on a saved value under its field, without a banner', async () => {
    stubRejection([{ field: 'values.siteName', message: '站点名称过长' }]);
    await save();

    const item = screen.getByLabelText('站点名称').closest('.ant-form-item');
    await waitFor(() => expect(item).toHaveTextContent('站点名称过长'));
    expect(banner()).toBeNull();
  });

  it('shows an error no field renders as a banner, with its message', async () => {
    stubRejection([
      { field: 'values.apiSecret', message: '密钥格式不正确' },
      { field: 'params.group', message: '配置分组不存在' },
    ]);
    await save();

    await waitFor(() => expect(banner()).toHaveTextContent('密钥格式不正确'));
    expect(banner()).toHaveTextContent('配置分组不存在');
  });
});

describe('<ConfigGroupForm> rendering', () => {
  it('hides a field whose condition does not hold', () => {
    stubSave();
    renderAdmin(
      <ConfigGroupForm
        descriptor={descriptor}
        values={{ ...values, mode: 'city' }}
        route={saveRoute}
      />,
    );
    expect(screen.queryByLabelText('门槛')).not.toBeInTheDocument();
  });

  it('lets a group save while a required field is hidden', async () => {
    // A shop on the local storage driver must be able to change an upload limit
    // without filling in an S3 bucket. The hidden key is simply not sent, and
    // the server keeps whatever it had stored.
    const user = userEvent.setup();
    const { bodies } = stubSave();
    const conditional: ConfigGroupDescriptor = {
      ...descriptor,
      fields: [
        ...descriptor.fields,
        {
          key: 'bucket',
          label: 'Bucket',
          kind: 'text',
          required: true,
          visibleWhen: { key: 'mode', equals: 'city' },
        },
      ],
    };
    renderAdmin(
      <ConfigGroupForm
        descriptor={conditional}
        values={{ ...values, bucket: '' }}
        route={saveRoute}
      />,
    );

    expect(screen.queryByLabelText('Bucket')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: zhName('保存') }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect((bodies[0] as { values: Record<string, unknown> }).values).not.toHaveProperty('bucket');
  });

  it('renders a heading per section, in first-appearance order', () => {
    stubSave();
    const sectioned: ConfigGroupDescriptor = {
      group: 'demo',
      title: '演示配置',
      fields: [
        { key: 'siteName', label: '站点名称', kind: 'text' },
        { key: 'a', label: '端点', kind: 'text', section: 'S3' },
        { key: 'b', label: '桶', kind: 'text', section: 'S3' },
        { key: 'c', label: '退货地址', kind: 'text', section: '售后' },
      ],
    };
    const { container } = renderAdmin(
      <ConfigGroupForm descriptor={sectioned} values={{}} route={saveRoute} />,
    );

    const headings = [...container.querySelectorAll('.ant-card-head-title')].map(
      (n) => n.textContent,
    );
    expect(headings).toEqual(['S3', '售后']);
    // The sectionless field is still there, above the first heading.
    expect(screen.getByLabelText('站点名称')).toBeInTheDocument();
    expect(screen.getByLabelText('退货地址')).toBeInTheDocument();
  });

  it('renders a descriptor with no sections as one untitled card', () => {
    // A sectionless descriptor collapses to one card with one `<Row>` — no
    // heading, nothing reordered.
    stubSave();
    const { container } = renderAdmin(
      <ConfigGroupForm descriptor={descriptor} values={values} route={saveRoute} />,
    );

    expect(container.querySelectorAll('.ant-card-head-title')).toHaveLength(0);
    const rows = container.querySelectorAll('form .ant-card-body > .ant-row');
    expect(rows).toHaveLength(1);
    expect([...rows[0]!.children].map((col) => col.querySelector('label')?.textContent)).toEqual([
      '站点名称',
      '接口密钥 已设置',
      '短信密钥 未设置',
      '模式',
      '门槛',
    ]);
  });

  it('only shows the headings whose fields survive visibleWhen', () => {
    stubSave();
    const sectioned: ConfigGroupDescriptor = {
      group: 'demo',
      title: '演示配置',
      fields: [
        {
          key: 'mode',
          label: '模式',
          kind: 'select',
          options: [{ label: '快递', value: 'express' }],
        },
        {
          key: 'a',
          label: '端点',
          kind: 'text',
          section: 'S3',
          visibleWhen: { key: 'mode', equals: 's3' },
        },
        { key: 'c', label: '退货地址', kind: 'text', section: '售后' },
      ],
    };
    const { container } = renderAdmin(
      <ConfigGroupForm descriptor={sectioned} values={{ mode: 'express' }} route={saveRoute} />,
    );
    // An empty 'S3' heading over nothing would be worse than no heading.
    expect(
      [...container.querySelectorAll('.ant-card-head-title')].map((n) => n.textContent),
    ).toEqual(['售后']);
  });

  it('shows a skeleton while the values are loading', () => {
    stubSave();
    renderAdmin(
      <ConfigGroupForm descriptor={descriptor} values={undefined} loading route={saveRoute} />,
    );
    expect(screen.queryByTestId('secret-input-apiSecret')).not.toBeInTheDocument();
  });
});

/**
 * Read-only fields.
 *
 * `site.publicOrigin` comes from the environment. Leaving it off the screen
 * was the first draft and it was worse: an operator whose WeChat links point
 * at the wrong host has to be able to see which host the shop thinks it is.
 * So it is shown, as text, next to the variable that decides it — and it never
 * reaches the payload.
 */
const deployDescriptor: ConfigGroupDescriptor = {
  group: 'site',
  title: '站点设置',
  fields: [
    { key: 'siteName', label: '站点名称', kind: 'text' },
    {
      key: 'publicOrigin',
      label: '站点域名',
      kind: 'text',
      readOnly: true,
      help: '由部署环境决定：env:PUBLIC_ORIGIN',
    },
    { key: 'extraOrigins', label: '其他域名', kind: 'text', readOnly: true },
  ],
};

const deployValues = { siteName: '示例商城', publicOrigin: 'https://shop.example.com' };

describe('<ConfigGroupForm> read-only fields', () => {
  it('renders the value as text, with no control to type into', () => {
    stubSave();
    renderAdmin(
      <ConfigGroupForm descriptor={deployDescriptor} values={deployValues} route={saveRoute} />,
    );

    expect(screen.getByTestId('readonly-value-publicOrigin')).toHaveTextContent(
      'https://shop.example.com',
    );
    // No control at all — not a disabled one, which reads as "not yet".
    expect(screen.queryByLabelText('站点域名')).not.toBeInTheDocument();
    // And the writable field beside it is untouched.
    expect(screen.getByLabelText('站点名称')).toHaveValue('示例商城');
  });

  it('says where the value comes from', () => {
    stubSave();
    renderAdmin(
      <ConfigGroupForm descriptor={deployDescriptor} values={deployValues} route={saveRoute} />,
    );
    expect(screen.getByText('由部署环境决定：env:PUBLIC_ORIGIN')).toBeInTheDocument();
  });

  it('shows 未设置 rather than an empty line when the environment said nothing', () => {
    stubSave();
    renderAdmin(
      <ConfigGroupForm descriptor={deployDescriptor} values={deployValues} route={saveRoute} />,
    );
    expect(screen.getByTestId('readonly-value-extraOrigins')).toHaveTextContent('未设置');
  });

  it('never submits a read-only key, so the server has nothing to refuse', async () => {
    const user = userEvent.setup();
    const { bodies } = stubSave();
    renderAdmin(
      <ConfigGroupForm descriptor={deployDescriptor} values={deployValues} route={saveRoute} />,
    );

    await user.clear(screen.getByLabelText('站点名称'));
    await user.type(screen.getByLabelText('站点名称'), '改过的名称');
    await user.click(screen.getByRole('button', { name: zhName('保存') }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    const sent = (bodies[0] as { values: Record<string, unknown> }).values;
    expect(sent).toEqual({ siteName: '改过的名称' });
  });
});

describe('changedConfigKeys', () => {
  it('counts a visible field that differs, and treats blank as blank', () => {
    expect(
      changedConfigKeys(
        descriptor,
        { siteName: '新名字', mode: 'express', threshold: '' },
        values,
        {},
      ),
    ).toEqual(['siteName']);
  });

  it('counts a secret only once something was typed into it', () => {
    expect(changedConfigKeys(descriptor, values, values, { apiSecret: '' })).toEqual([]);
    expect(changedConfigKeys(descriptor, values, values, { apiSecret: 'k' })).toEqual([
      'apiSecret',
    ]);
  });
});

describe('<ConfigGroupForm> save bar', () => {
  it('counts unsaved changes and puts them back on 放弃修改', async () => {
    const user = userEvent.setup();
    stubSave();
    renderAdmin(<ConfigGroupForm descriptor={descriptor} values={values} route={saveRoute} />);

    expect(screen.getByTestId('config-dirty-state')).toHaveTextContent('没有未保存的修改');
    await user.type(screen.getByLabelText('站点名称'), '2');
    await user.type(screen.getByTestId('secret-input-smsSecret'), 'new-key');
    expect(screen.getByTestId('config-dirty-state')).toHaveTextContent('已修改 2 项');

    await user.click(screen.getByRole('button', { name: zhName('放弃修改') }));
    expect(screen.getByTestId('config-dirty-state')).toHaveTextContent('没有未保存的修改');
    expect(screen.getByLabelText('站点名称')).toHaveValue('示例商城');
    expect(screen.getByTestId('secret-input-smsSecret')).toHaveValue('');
  });

  it('saves on Ctrl+S', async () => {
    const user = userEvent.setup();
    const { bodies } = stubSave();
    renderAdmin(<ConfigGroupForm descriptor={descriptor} values={values} route={saveRoute} />);

    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(bodies).toHaveLength(1));
  });

  it('scrolls to and focuses the field the settings search linked to', async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      renderAdmin(
        <ConfigGroupForm
          descriptor={descriptor}
          values={values}
          route={saveRoute}
          focusKey="siteName"
        />,
      );
      await waitFor(() => expect(scrolled).toHaveLength(1));
      expect(scrolled[0]).toHaveAttribute('id', 'config-field-siteName');
      expect(screen.getByLabelText('站点名称')).toHaveFocus();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('says which choice shows a linked field that is hidden', async () => {
    renderAdmin(
      <ConfigGroupForm
        descriptor={descriptor}
        values={{ ...values, mode: 'pickup' }}
        route={saveRoute}
        focusKey="threshold"
      />,
    );
    expect(
      await screen.findByText('「门槛」要先在「模式」里选择对应选项才会显示'),
    ).toBeInTheDocument();
  });
});

describe('<ConfigGroupForm> units', () => {
  const sized: ConfigGroupDescriptor = {
    group: 'demo',
    title: '演示配置',
    fields: [
      { key: 'maxBytes', label: '上传上限', kind: 'number', unit: 'bytes' },
      { key: 'ttl', label: '有效期', kind: 'number', unit: 'seconds' },
    ],
  };

  it('edits bytes in MB and saves bytes', async () => {
    const user = userEvent.setup();
    const { bodies } = stubSave();
    renderAdmin(
      <ConfigGroupForm
        descriptor={sized}
        values={{ maxBytes: 10 * 1024 * 1024, ttl: 600 }}
        route={saveRoute}
      />,
    );

    const box = screen.getByLabelText('上传上限');
    expect(box).toHaveValue('10.00');
    expect(screen.getByText('MB')).toBeInTheDocument();
    expect(screen.getByText('秒')).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, '2.5');
    await user.click(screen.getByRole('button', { name: zhName('保存') }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect((bodies[0] as { values: Record<string, unknown> }).values).toEqual({
      maxBytes: 2.5 * 1024 * 1024,
      ttl: 600,
    });
  });
});

describe('<ConfigGroupForm> 测试', () => {
  const testRoute = defineRoute({
    id: 'test.configTest',
    method: 'POST',
    path: '/admin-api/config/:group/test',
    auth: 'admin',
    permission: 'test:config:save',
    summary: '测试配置',
    tags: ['test'],
    params: z.object({ group: z.string() }),
    body: z.object({
      values: z.record(z.string(), z.unknown()),
      input: z.record(z.string(), z.unknown()),
    }),
    response: z.object({
      ok: z.boolean(),
      steps: z.array(
        z.object({
          name: z.string(),
          ok: z.boolean(),
          detail: z.string().optional(),
          ms: z.number().optional(),
        }),
      ),
    }),
    examples: [
      {
        name: 'ok',
        params: { group: 'demo' },
        body: { values: {}, input: {} },
        response: { ok: true, steps: [] },
      },
    ],
  });

  const testable: ConfigGroupDescriptor = {
    ...descriptor,
    test: {
      label: '发送测试短信',
      confirm: '会真实发送一条短信',
      inputs: [{ key: 'phone', label: '接收手机号', kind: 'text' }],
    },
  };

  it('asks first, then tests the unsaved form and shows each step', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    stubRoutes([
      on(saveRoute, () => ({ ok: true })),
      on(testRoute, (call) => {
        bodies.push(call.body);
        return {
          ok: false,
          steps: [
            { name: '检查配置', ok: true, detail: '腾讯云', ms: 0 },
            { name: '发送验证码短信', ok: false, detail: 'FailedOperation.SignatureIncorrect' },
          ],
        };
      }),
    ]);
    renderAdmin(
      <ConfigGroupForm
        descriptor={testable}
        values={values}
        route={saveRoute}
        testRoute={testRoute}
      />,
    );

    await user.type(screen.getByLabelText('站点名称'), '2');
    await user.type(screen.getByTestId('secret-input-smsSecret'), 'typed-key');
    await user.click(screen.getByRole('button', { name: zhName('发送测试短信') }));
    await user.type(screen.getByLabelText('接收手机号'), '13800138000');
    await user.click(screen.getByRole('button', { name: zhName('开始测试') }));
    // The warning comes first; nothing has been sent yet.
    expect(screen.getByText('会真实发送一条短信')).toBeInTheDocument();
    expect(bodies).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: zhName('确定，开始测试') }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      values: { siteName: '示例商城2', smsSecret: 'typed-key', mode: 'express' },
      input: { phone: '13800138000' },
    });
    expect(await screen.findByText('测试未通过')).toBeInTheDocument();
    expect(screen.getByText('FailedOperation.SignatureIncorrect')).toBeInTheDocument();
    // Testing saved nothing.
    expect(screen.getByTestId('config-dirty-state')).toHaveTextContent('已修改 2 项');
  });

  it('offers no 测试 button without a test route', () => {
    stubSave();
    renderAdmin(<ConfigGroupForm descriptor={testable} values={values} route={saveRoute} />);
    expect(screen.queryByRole('button', { name: zhName('发送测试短信') })).toBeNull();
  });
});
