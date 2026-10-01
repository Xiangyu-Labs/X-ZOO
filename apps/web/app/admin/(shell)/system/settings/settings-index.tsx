'use client';

import { SearchOutlined } from '@ant-design/icons';
import { Card, Col, Empty, Input, List, Row, Skeleton, Space, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useState } from 'react';
import type { ConfigGroupSummary } from '@shop/contracts/system/schemas';
import { systemConfigGroupList } from '@shop/contracts/system/system.settings.contract';

import { useRouteQuery } from '@/admin/api/hooks';
import { InstantText } from '@/admin/kit/instant-text';
import { PageContainer } from '@/admin/kit/page-container';

/** The index's blocks, in page order. A group that names none lands in 业务规则. */
const CATEGORIES = [
  { key: 'basic', title: '基础' },
  { key: 'wechat', title: '微信' },
  { key: 'trade', title: '支付与交易' },
  { key: 'integration', title: '第三方服务' },
  { key: 'rules', title: '业务规则' },
] as const;

const TONE_COLOR = { on: 'success', off: 'default', incomplete: 'warning' } as const;

const groupHref = (group: string, field?: string): string =>
  `/admin/system/settings/${group}${field === undefined ? '' : `?field=${encodeURIComponent(field)}`}`;

/**
 * 系统设置 — the index of config groups.
 *
 * There is no hand-written list here: the groups are whatever the code declared
 * with `defineConfigGroup`, filtered by what the caller may read. A domain that
 * adds a group gets a card on this page and a working settings screen without
 * anybody editing this file, which is the point of the whole arrangement.
 *
 * Each card leads with the state of what is saved (腾讯云, 未启用, 缺 AppCode)
 * and the last test. The search box matches field labels as well as group
 * names, because an operator usually knows the setting they want, not which
 * group it is in.
 */
export function SettingsIndexPage() {
  const { data, isPending } = useRouteQuery(systemConfigGroupList);
  const [query, setQuery] = useState('');

  if (isPending) {
    return (
      <PageContainer>
        <Skeleton active />
      </PageContainer>
    );
  }

  const groups = data?.groups ?? [];
  const needle = query.trim().toLowerCase();

  return (
    <PageContainer subTitle="卡片右上角是当前状态；带「测试」的分组可以在保存前先验证">
      {groups.length === 0 ? (
        <Empty description="没有你有权查看的配置分组" />
      ) : (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Input
            allowClear
            size="large"
            prefix={<SearchOutlined />}
            placeholder="搜索设置项，如：验证码模板、上传大小、AppSecret、主题色"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            style={{ maxWidth: 560 }}
            data-testid="settings-search"
          />
          {needle === '' ? (
            <Categories groups={groups} />
          ) : (
            <SearchResults groups={groups} needle={needle} />
          )}
        </Space>
      )}
    </PageContainer>
  );
}

function Categories({ groups }: { groups: ConfigGroupSummary[] }) {
  return (
    <>
      {CATEGORIES.map((category) => {
        const members = groups.filter((group) => (group.category ?? 'rules') === category.key);
        if (members.length === 0) return null;
        return (
          <section key={category.key}>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              {category.title}
            </Typography.Title>
            <Row gutter={[16, 16]}>
              {members.map((group) => (
                <Col key={group.group} xs={24} sm={12} lg={8} xxl={6}>
                  <GroupCard group={group} />
                </Col>
              ))}
            </Row>
          </section>
        );
      })}
    </>
  );
}

function GroupCard({ group }: { group: ConfigGroupSummary }) {
  return (
    <Link href={groupHref(group.group)}>
      <Card
        hoverable
        title={group.title}
        size="small"
        style={{ height: '100%' }}
        extra={
          group.status ? (
            <Tag
              bordered={false}
              color={TONE_COLOR[group.status.tone]}
              style={{ marginInlineEnd: 0 }}
              data-testid={`group-status-${group.group}`}
            >
              {group.status.text}
            </Tag>
          ) : null
        }
      >
        <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }}>
          {group.description ?? '　'}
        </Typography.Paragraph>
        <Space size={8} wrap>
          <Typography.Text type="secondary">{group.fieldCount} 项</Typography.Text>
          <LastTest group={group} />
          {!group.writable && <Tag color="default">只读</Tag>}
        </Space>
      </Card>
    </Link>
  );
}

function LastTest({ group }: { group: ConfigGroupSummary }) {
  if (!group.testable) return null;
  if (!group.lastTest) {
    return <Typography.Text type="secondary">· 未测试</Typography.Text>;
  }
  return (
    <Typography.Text type={group.lastTest.ok ? 'success' : 'danger'}>
      · {group.lastTest.ok ? '测试通过' : '测试未通过'}{' '}
      <InstantText value={group.lastTest.at} format="relative" />
    </Typography.Text>
  );
}

interface Hit {
  group: ConfigGroupSummary;
  /** Undefined when the group itself matched rather than one of its fields. */
  field?: { key: string; label: string; section?: string | undefined } | undefined;
}

function SearchResults({ groups, needle }: { groups: ConfigGroupSummary[]; needle: string }) {
  const matches = (text: string | undefined): boolean =>
    text !== undefined && text.toLowerCase().includes(needle);

  const hits: Hit[] = [];
  for (const group of groups) {
    if (matches(group.title) || matches(group.description)) hits.push({ group });
    for (const field of group.fieldIndex ?? []) {
      if (matches(field.label) || matches(field.section)) hits.push({ group, field });
    }
  }

  if (hits.length === 0) {
    return <Empty description={`没有找到「${needle}」相关的设置项`} />;
  }
  return (
    <List
      bordered
      style={{ maxWidth: 880 }}
      dataSource={hits}
      data-testid="settings-search-results"
      renderItem={(hit) => (
        <List.Item
          extra={
            hit.group.status ? (
              <Tag bordered={false} color={TONE_COLOR[hit.group.status.tone]}>
                {hit.group.status.text}
              </Tag>
            ) : null
          }
        >
          <Link href={groupHref(hit.group.group, hit.field?.key)}>
            <Space size={4} wrap>
              {hit.field ? (
                <Typography.Text type="secondary">{hit.group.title}</Typography.Text>
              ) : (
                <Typography.Text strong>{hit.group.title}</Typography.Text>
              )}
              {hit.field?.section ? (
                <Typography.Text type="secondary">› {hit.field.section}</Typography.Text>
              ) : null}
              {hit.field ? <Typography.Text strong>› {hit.field.label}</Typography.Text> : null}
            </Space>
          </Link>
        </List.Item>
      )}
    />
  );
}
