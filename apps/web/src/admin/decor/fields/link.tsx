'use client';

import { LINK_KINDS, type LinkKind } from '@shop/contracts/decor/constants';
import type { LinkTarget } from '@shop/contracts/decor/link';
import type { StorefrontRouteKey } from '@shop/contracts/system/storefront-routes';
import { Button, Input, Select, Space, Typography } from 'antd';
import type { ReactNode } from 'react';

import {
  LINK_ROUTE_KEYS,
  LINK_ROUTES,
  checkRoute,
  isParamRequired,
  linkRouteSpec,
  type RouteParamControl,
} from './link-routes';
import { CategoryTreeSelect, SingleRecordPicker } from './record-picker';
import { FieldShell, metaOf, type DecorFieldProps } from './shell';

/**
 * The `LinkTarget` picker: every link kind, and for `route` every linkable
 * catalogue page with its params (`link-routes.ts`).
 *
 * What it stores is always a `LinkTarget` the operator can see is incomplete
 * — a product link with no product picked yet — rather than nothing: the
 * server's check on save names it, and publishing waits until it is filled.
 */

const NO_LINK = '__none__';

export function emptyLink(kind: LinkKind): LinkTarget {
  switch (kind) {
    case 'route':
      return { kind, to: { route: 'home', params: {} } };
    case 'webview':
      return { kind, url: '' };
    case 'miniprogram':
      return { kind, appId: '' };
    default:
      return { kind, id: '' };
  }
}

type RouteLink = Extract<LinkTarget, { kind: 'route' }>;
type Params = Record<string, string | undefined>;

function ParamControl({
  route,
  param,
  control,
  value,
  onChange,
  readOnly,
}: {
  route: StorefrontRouteKey;
  param: string;
  control: Exclude<RouteParamControl, { kind: 'internal' }>;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  readOnly: boolean;
}) {
  const required = isParamRequired(route, param);
  let input: ReactNode;
  switch (control.kind) {
    case 'record':
      input = (
        <Space.Compact block>
          <div style={{ flex: 1, minWidth: 0 }}>
            <SingleRecordPicker
              kind={control.record}
              value={value || undefined}
              readOnly={readOnly}
              onChange={onChange}
            />
          </div>
          {!required && value ? (
            <Button
              size="small"
              type="text"
              disabled={readOnly}
              onClick={() => onChange(undefined)}
            >
              清除
            </Button>
          ) : null}
        </Space.Compact>
      );
      break;
    case 'category':
      input = (
        <CategoryTreeSelect
          tree={control.tree}
          value={value}
          allowClear={!required}
          readOnly={readOnly}
          placeholder={required ? undefined : '不限'}
          onChange={onChange}
        />
      );
      break;
    case 'enum':
      input = (
        <Select<string>
          size="small"
          style={{ width: '100%' }}
          {...(value ? { value } : {})}
          placeholder={required ? '请选择' : '默认'}
          allowClear={!required}
          disabled={readOnly}
          options={Object.entries(control.options).map(([key, label]) => ({ value: key, label }))}
          onChange={(next) => onChange(next || undefined)}
        />
      );
      break;
    case 'text':
      input = (
        <Input
          size="small"
          value={value ?? ''}
          placeholder={control.placeholder ?? (required ? '' : '可不填')}
          disabled={readOnly}
          maxLength={64}
          onChange={(event) => onChange(event.target.value.trim() || undefined)}
        />
      );
      break;
  }
  return (
    <div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {control.label}
        {required ? '' : '（可选）'}
      </Typography.Text>
      {input}
    </div>
  );
}

function RouteEditor({
  value,
  onChange,
  readOnly,
}: {
  value: RouteLink;
  onChange: (value: RouteLink) => void;
  readOnly: boolean;
}) {
  const route = value.to.route;
  const params = (value.to.params ?? {}) as Params;
  const spec = linkRouteSpec(route);
  const check = checkRoute(route, params);
  const emit = (nextRoute: string, nextParams: Params) => {
    const kept = Object.fromEntries(
      Object.entries(nextParams).filter(([, v]) => v !== undefined && v !== ''),
    );
    onChange({ kind: 'route', to: { route: nextRoute, params: kept } } as RouteLink);
  };
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      <Select<string>
        size="small"
        style={{ width: '100%' }}
        showSearch
        optionFilterProp="label"
        value={route}
        disabled={readOnly}
        aria-label="商城页面"
        options={LINK_ROUTE_KEYS.map((key) => ({ value: key, label: LINK_ROUTES[key].label }))}
        onChange={(next) => emit(next, {})}
      />
      {spec
        ? Object.entries(spec.params).map(([param, control]) =>
            control.kind === 'internal' ? null : (
              <ParamControl
                key={`${route}.${param}`}
                route={route as StorefrontRouteKey}
                param={param}
                control={control}
                value={params[param]}
                readOnly={readOnly}
                onChange={(next) => emit(route, { ...params, [param]: next })}
              />
            ),
          )
        : null}
      {check.ok ? null : (
        <Typography.Text type="warning" style={{ fontSize: 12 }}>
          {check.issue}
        </Typography.Text>
      )}
    </Space>
  );
}

function LinkDetail({
  value,
  onChange,
  readOnly,
}: {
  value: LinkTarget;
  onChange: (value: LinkTarget) => void;
  readOnly: boolean;
}) {
  switch (value.kind) {
    case 'product':
    case 'article':
    case 'page':
      return (
        <SingleRecordPicker
          kind={value.kind}
          value={value.id || undefined}
          readOnly={readOnly}
          onChange={(id) => onChange({ kind: value.kind, id })}
        />
      );
    case 'category':
      return (
        <CategoryTreeSelect
          tree="product"
          value={value.id || undefined}
          readOnly={readOnly}
          onChange={(id) => onChange({ kind: 'category', id: id ?? '' })}
        />
      );
    case 'route':
      return <RouteEditor value={value} onChange={onChange} readOnly={readOnly} />;
    case 'webview':
      return (
        <>
          <Input
            size="small"
            value={value.url}
            placeholder="https://"
            disabled={readOnly}
            onChange={(event) => onChange({ kind: 'webview', url: event.target.value.trim() })}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            仅 https，且须是小程序后台配置的业务域名，否则只复制链接。
          </Typography.Text>
        </>
      );
    case 'miniprogram':
      return (
        <Space direction="vertical" style={{ width: '100%' }} size={4}>
          <Input
            size="small"
            value={value.appId}
            placeholder="AppID，如 wx0123456789abcdef"
            disabled={readOnly}
            onChange={(event) =>
              onChange({ ...value, appId: event.target.value.trim().toLowerCase() })
            }
          />
          <Input
            size="small"
            value={value.path ?? ''}
            placeholder="页面路径（可选）"
            disabled={readOnly}
            onChange={(event) => {
              const path = event.target.value.trim();
              const { path: _drop, ...rest } = value;
              onChange(path ? { ...rest, path } : rest);
            }}
          />
        </Space>
      );
  }
}

export function LinkField({
  field,
  name,
  value,
  onChange,
  readOnly = false,
}: DecorFieldProps<LinkTarget | undefined>) {
  const { optional } = metaOf(field);
  const kindOptions = [
    ...(optional ? [{ value: NO_LINK, label: '不跳转' }] : []),
    ...Object.entries(LINK_KINDS).map(([kind, label]) => ({ value: kind, label })),
  ];
  return (
    <FieldShell field={field} name={name} readOnly={readOnly}>
      <Space direction="vertical" style={{ width: '100%' }} size={6}>
        <Select<string>
          size="small"
          style={{ width: '100%' }}
          value={value?.kind ?? (optional ? NO_LINK : null)}
          placeholder="选择链接类型"
          disabled={readOnly}
          aria-label={`${field.label ?? name}类型`}
          options={kindOptions}
          onChange={(kind) => onChange(kind === NO_LINK ? undefined : emptyLink(kind as LinkKind))}
        />
        {value ? <LinkDetail value={value} onChange={onChange} readOnly={readOnly} /> : null}
      </Space>
    </FieldShell>
  );
}
