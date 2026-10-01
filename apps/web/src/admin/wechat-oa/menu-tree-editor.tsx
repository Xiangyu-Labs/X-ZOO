'use client';

import { DeleteOutlined, DownOutlined, PlusOutlined, UpOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Input, Select, Space, Typography } from 'antd';
import type { WechatMenuButtonShape } from '@shop/contracts/wechat-oa/schemas';

/**
 * The Official Account bottom menu, edited as the tree WeChat actually
 * renders: at most three buttons across the bottom, each either an action of
 * its own or a drawer of at most five children.
 *
 * WeChat's own limits are the structure of the UI rather than a validation
 * message: 添加按钮 disappears at three, 添加子菜单 at five, and a parent with
 * children stops offering an action because WeChat ignores one. The contract
 * enforces the same limits on submit — this only makes them impossible to hit
 * by accident.
 *
 * The keys stay WeChat's own (`sub_button`, `pagepath`, `appid`): the tree is
 * POSTed verbatim, and a camelCase layer here would be one more place to get
 * the translation wrong.
 */

const MAX_TOP = 3;
const MAX_CHILDREN = 5;

const TYPE_OPTIONS = [
  { value: 'view', label: '跳转网页' },
  { value: 'click', label: '触发关键词回复' },
  { value: 'miniprogram', label: '打开小程序' },
];

export interface MenuTreeEditorProps {
  value?: WechatMenuButtonShape[] | undefined;
  onChange?: ((value: WechatMenuButtonShape[]) => void) | undefined;
  disabled?: boolean | undefined;
}

function move<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return items;
  next.splice(to, 0, moved);
  return next;
}

export function MenuTreeEditor({ value, onChange, disabled = false }: MenuTreeEditorProps) {
  const buttons = value ?? [];

  const replace = (index: number, patch: Partial<WechatMenuButtonShape>) => {
    onChange?.(
      buttons.map((button, i) => (i === index ? normalise({ ...button, ...patch }) : button)),
    );
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      {buttons.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有按钮" />
      ) : null}

      {buttons.map((button, index) => {
        const children = button.sub_button ?? [];
        return (
          <Card
            key={index}
            size="small"
            title={
              <Space>
                <Typography.Text type="secondary">{index + 1}</Typography.Text>
                <Input
                  value={button.name}
                  placeholder="按钮名称"
                  maxLength={60}
                  disabled={disabled}
                  style={{ width: 220 }}
                  onChange={(event) => replace(index, { name: event.target.value })}
                  aria-label={`一级按钮 ${index + 1} 名称`}
                />
              </Space>
            }
            extra={
              <Space size={0}>
                <Button
                  type="text"
                  size="small"
                  icon={<UpOutlined />}
                  aria-label="上移"
                  disabled={disabled || index === 0}
                  onClick={() => onChange?.(move(buttons, index, index - 1))}
                />
                <Button
                  type="text"
                  size="small"
                  icon={<DownOutlined />}
                  aria-label="下移"
                  disabled={disabled || index === buttons.length - 1}
                  onClick={() => onChange?.(move(buttons, index, index + 1))}
                />
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label="删除按钮"
                  disabled={disabled}
                  onClick={() => onChange?.(buttons.filter((_item, i) => i !== index))}
                />
              </Space>
            }
          >
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              {children.length === 0 ? (
                <ActionEditor
                  button={button}
                  scope={`一级按钮 ${index + 1}`}
                  disabled={disabled}
                  onChange={(patch) => replace(index, patch)}
                />
              ) : (
                <Typography.Text type="secondary">
                  有子菜单的按钮本身不触发动作，点击后只展开子菜单。
                </Typography.Text>
              )}

              {children.map((child, childIndex) => (
                <Card key={childIndex} size="small" type="inner">
                  <Space direction="vertical" style={{ width: '100%' }} size={8}>
                    <Space>
                      <Input
                        value={child.name}
                        placeholder="子菜单名称"
                        maxLength={60}
                        disabled={disabled}
                        style={{ width: 200 }}
                        aria-label={`二级按钮 ${index + 1}-${childIndex + 1} 名称`}
                        onChange={(event) =>
                          replace(index, {
                            sub_button: children.map((item, i) =>
                              i === childIndex ? { ...item, name: event.target.value } : item,
                            ),
                          })
                        }
                      />
                      <Button
                        type="text"
                        size="small"
                        icon={<UpOutlined />}
                        aria-label="子菜单上移"
                        disabled={disabled || childIndex === 0}
                        onClick={() =>
                          replace(index, { sub_button: move(children, childIndex, childIndex - 1) })
                        }
                      />
                      <Button
                        type="text"
                        size="small"
                        icon={<DownOutlined />}
                        aria-label="子菜单下移"
                        disabled={disabled || childIndex === children.length - 1}
                        onClick={() =>
                          replace(index, { sub_button: move(children, childIndex, childIndex + 1) })
                        }
                      />
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        aria-label="删除子菜单"
                        disabled={disabled}
                        onClick={() =>
                          replace(index, {
                            sub_button: children.filter((_item, i) => i !== childIndex),
                          })
                        }
                      />
                    </Space>
                    <ActionEditor
                      button={child}
                      scope={`二级按钮 ${index + 1}-${childIndex + 1}`}
                      disabled={disabled}
                      onChange={(patch) =>
                        replace(index, {
                          sub_button: children.map((item, i) =>
                            i === childIndex ? normalise({ ...item, ...patch }) : item,
                          ),
                        })
                      }
                    />
                  </Space>
                </Card>
              ))}

              {children.length < MAX_CHILDREN ? (
                <Button
                  size="small"
                  icon={<PlusOutlined />}
                  disabled={disabled}
                  onClick={() =>
                    replace(index, {
                      sub_button: [...children, { name: '', type: 'view', url: '' }],
                    })
                  }
                >
                  添加子菜单
                </Button>
              ) : (
                <Typography.Text type="secondary">
                  微信最多允许 5 个子菜单，已经满了。
                </Typography.Text>
              )}
            </Space>
          </Card>
        );
      })}

      {buttons.length < MAX_TOP ? (
        <Button
          icon={<PlusOutlined />}
          disabled={disabled}
          onClick={() => onChange?.([...buttons, { name: '', type: 'view', url: '' }])}
        >
          添加按钮
        </Button>
      ) : (
        <Typography.Text type="secondary">微信最多允许 3 个一级按钮，已经满了。</Typography.Text>
      )}
    </Space>
  );
}

/** The 类型 picker plus whichever target that type needs. */
function ActionEditor({
  button,
  scope,
  disabled,
  onChange,
}: {
  button: WechatMenuButtonShape;
  /** Prefixes every label, so a screen reader (and a test) can tell the rows apart. */
  scope: string;
  disabled: boolean;
  onChange: (patch: Partial<WechatMenuButtonShape>) => void;
}) {
  const type = button.type ?? 'view';
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      <Select
        value={type}
        options={TYPE_OPTIONS}
        style={{ width: 200 }}
        disabled={disabled}
        aria-label={`${scope} 类型`}
        onChange={(next: 'view' | 'click' | 'miniprogram') => onChange({ type: next })}
      />
      {type === 'view' ? (
        <Input
          value={button.url ?? ''}
          placeholder="https://…"
          maxLength={1024}
          disabled={disabled}
          aria-label={`${scope} 网页地址`}
          onChange={(event) => onChange({ url: event.target.value })}
        />
      ) : null}
      {type === 'click' ? (
        <Input
          value={button.key ?? ''}
          placeholder="关键词，例如 CONTACT"
          maxLength={128}
          disabled={disabled}
          aria-label={`${scope} 关键词`}
          onChange={(event) => onChange({ key: event.target.value })}
        />
      ) : null}
      {type === 'miniprogram' ? (
        <>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={button.appid ?? ''}
              placeholder="小程序 AppID"
              maxLength={64}
              disabled={disabled}
              aria-label={`${scope} 小程序 AppID`}
              onChange={(event) => onChange({ appid: event.target.value })}
            />
            <Input
              value={button.pagepath ?? ''}
              placeholder="页面路径，例如 pages/index/index"
              maxLength={256}
              disabled={disabled}
              aria-label={`${scope} 小程序页面路径`}
              onChange={(event) => onChange({ pagepath: event.target.value })}
            />
          </Space.Compact>
          {/* WeChat requires a fallback for clients too old to open a mini
              program; without it the publish is rejected, not degraded. */}
          <Input
            value={button.url ?? ''}
            placeholder="低版本客户端的兜底链接 https://…"
            maxLength={1024}
            disabled={disabled}
            aria-label={`${scope} 兜底链接`}
            onChange={(event) => onChange({ url: event.target.value })}
          />
        </>
      ) : null}
    </Space>
  );
}

/**
 * Drops the fields the chosen type does not use.
 *
 * WeChat rejects a `view` button that still carries a `key` from a moment when
 * it was a `click`, and that rejection arrives as `40016` on publish — long
 * after the operator has left this screen.
 */
function normalise(button: WechatMenuButtonShape): WechatMenuButtonShape {
  const { name, type, sub_button } = button;
  const base: WechatMenuButtonShape = { name };
  if (sub_button !== undefined && sub_button.length > 0) return { ...base, sub_button };
  base.type = type ?? 'view';
  if (base.type === 'view') base.url = button.url ?? '';
  if (base.type === 'click') base.key = button.key ?? '';
  if (base.type === 'miniprogram') {
    base.appid = button.appid ?? '';
    base.pagepath = button.pagepath ?? '';
    base.url = button.url ?? '';
  }
  return base;
}
