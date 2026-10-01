'use client';

import { Avatar, Button, Modal, Space, Tag, Tooltip, Typography, message } from 'antd';
import Link from 'next/link';
import { useState } from 'react';
import {
  userAdminBatchSetGroups,
  userAdminBatchSetLabels,
  userAdminCreate,
  userAdminDetail,
  userAdminList,
  userAdminResetPassword,
  userAdminSetStatus,
  userAdminUpdate,
} from '@shop/contracts/user/user.admin.contract';
import { userGroupList, userLabelList } from '@shop/contracts/user/user.taxonomy.contract';
import { couponAdminUserCouponList } from '@shop/contracts/coupon/coupon.admin.contract';
import { orderAdminList } from '@shop/contracts/order/order.admin.contract';
import { refundAdminList } from '@shop/contracts/refund/refund.admin.contract';
import { MAX_GRANT_AUDIENCE } from '@shop/contracts/coupon/schemas';
import {
  adminUserCreateBody,
  adminUserForm,
  adminUserPasswordBody,
  type AdminUserDetail,
  type AdminUserListItem,
} from '@shop/contracts/user/schemas';

import { useRouteMutation, useRouteQuery } from '@/admin/api/hooks';
import { DescriptionsCard } from '@/admin/kit/descriptions-card';
import { DetailDrawer } from '@/admin/kit/detail-drawer';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { InstantText } from '@/admin/kit/instant-text';
import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag, statusOptions } from '@/admin/kit/status-tag';
import {
  actionsColumn,
  enumColumn,
  idColumn,
  instantColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { ConfirmAction } from '@/admin/kit/confirm-action';
import { Can } from '@/admin/session/can';
import { useCan } from '@/admin/session/session-provider';

import { REGISTER_SOURCE, USER_STATUS } from '../user-enums';
import { GrantCouponModal, type GrantTarget } from './grant-coupon-modal';

/**
 * 用户列表.
 *
 * Three things here are deliberate and easy to get wrong the other way:
 *
 *  - the list shows a **masked** number (`138****8000`). An operator browsing
 *    ten thousand customers has no business reading every number, and a
 *    screenshot of an unmasked table is a leak. The unmasked one is on the
 *    detail route, which carries its own permission;
 *  - 禁用 and 重置密码 sit behind their own permission atoms, not 编辑's,
 *    because they end every live session of a paying customer while renaming a
 *    nickname does not;
 *  - the group and label pickers are fed by the taxonomy routes, so a group
 *    added on the next page is selectable here without a deploy;
 *  - 发优惠券 is coupon's write (`coupon:grant:write`), not 编辑's: it hands
 *    out money. It goes to the ticked rows, or to everyone the filters match
 *    (at most `MAX_GRANT_AUDIENCE`, resolved again by the server).
 */
export function CustomersPage() {
  // The edit form loads the whole customer first. 真实姓名 / 生日 /
  // 管理员备注 are on the detail and not on the list row, so a form seeded from
  // the row would open those three blank — and an empty antd box submits `''`,
  // which the service would write over whatever was stored.
  const edit = useFormModal<AdminUserListItem, typeof userAdminDetail>({
    detail: { route: userAdminDetail, params: (row) => ({ id: row.id }), select: editValuesOf },
  });
  const create = useFormModal<AdminUserListItem>();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [resetting, setResetting] = useState<AdminUserListItem | null>(null);
  // Who 发优惠券 goes to, and what to do once it has: a grant to ticked rows
  // clears the ticks, as the other batch actions do.
  const [granting, setGranting] = useState<{ target: GrantTarget; done?: () => void } | null>(null);

  // Options for the filters and the form. 100 is the list cap; a role that may
  // not read groups or labels gets no options rather than a 403 toast.
  const can = useCan();
  const groups = useRouteQuery(
    userGroupList,
    { query: { page: 1, pageSize: 100 } },
    { enabled: can('user:group:read') },
  );
  const labels = useRouteQuery(
    userLabelList,
    { query: { page: 1, pageSize: 100 } },
    { enabled: can('user:label:read') },
  );

  const groupOptions = (groups.data?.items ?? []).map((group) => ({
    value: group.id,
    label: group.name,
  }));
  const labelOptions = (labels.data?.items ?? []).map((label) => ({
    value: label.id,
    label: label.categoryName ? `${label.categoryName} / ${label.name}` : label.name,
  }));

  const setStatus = useRouteMutation(userAdminSetStatus, {
    invalidate: [userAdminList],
    successMessage: '已更新状态',
  });
  const setGroups = useRouteMutation(userAdminBatchSetGroups, { invalidate: [userAdminList] });
  const setLabels = useRouteMutation(userAdminBatchSetLabels, { invalidate: [userAdminList] });

  return (
    <PageContainer subTitle="商城注册与后台录入的用户；列表里的手机号是打码的，完整号码在详情里">
      <CrudTable
        route={userAdminList}
        scrollX={1500}
        toolbar={({ filters, total }) => (
          <>
            <Can permission="user:customer:write">
              <Button type="primary" onClick={() => create.show()}>
                新增用户
              </Button>
            </Can>
            <Can permission="coupon:grant:write">
              <GrantToFilterButton
                filtered={Object.keys(filters).length > 0}
                total={total}
                onClick={(matched) =>
                  setGranting({ target: { kind: 'filter', filter: filters, matched } })
                }
              />
            </Can>
          </>
        )}
        filters={[
          { kind: 'text', name: 'keyword', label: '用户', placeholder: '账号、手机号或昵称' },
          { kind: 'select', name: 'status', label: '状态', options: statusOptions(USER_STATUS) },
          {
            kind: 'select',
            name: 'registerSource',
            label: '注册来源',
            options: statusOptions(REGISTER_SOURCE),
          },
          { kind: 'select', name: 'groupId', label: '分组', options: groupOptions },
          { kind: 'select', name: 'labelId', label: '标签', options: labelOptions },
          {
            kind: 'select',
            name: 'hasWechat',
            label: '微信绑定',
            options: [
              { value: 'true', label: '已绑定' },
              { value: 'false', label: '未绑定' },
            ],
          },
          { kind: 'dateRange', names: ['createdFrom', 'createdTo'], label: '注册时间' },
        ]}
        batchActions={({ selectedRowKeys, clear }) => {
          const userIds = selectedRowKeys.map(String);
          return (
            <Space>
              <Can permission="coupon:grant:write">
                <Button
                  size="small"
                  onClick={() => setGranting({ target: { kind: 'users', userIds }, done: clear })}
                >
                  发优惠券
                </Button>
              </Can>
              <Can permission="user:customer:write">
                <Space>
                  <BatchPicker
                    label="设置分组"
                    noun="分组"
                    options={groupOptions}
                    count={userIds.length}
                    pending={setGroups.isPending}
                    onSubmit={async (selected) => {
                      const result = await setGroups.mutateAsync({
                        body: { userIds, groupIds: selected, mode: 'replace' },
                      });
                      void message.success(`已更新 ${result.affected} 个用户`);
                      clear();
                    }}
                  />
                  <BatchPicker
                    label="设置标签"
                    noun="标签"
                    options={labelOptions}
                    count={userIds.length}
                    pending={setLabels.isPending}
                    onSubmit={async (selected) => {
                      const result = await setLabels.mutateAsync({
                        body: { userIds, labelIds: selected, mode: 'replace' },
                      });
                      void message.success(`已更新 ${result.affected} 个用户`);
                      clear();
                    }}
                  />
                </Space>
              </Can>
            </Space>
          );
        }}
        columns={[
          idColumn<AdminUserListItem>({ sortable: true }),
          textColumn<AdminUserListItem>({ title: '账号', dataIndex: 'account', ellipsis: true }),
          textColumn<AdminUserListItem>({ title: '手机号', dataIndex: 'phone', width: 130 }),
          {
            title: '昵称',
            key: 'nickname',
            ellipsis: { showTitle: false },
            render: (_value: unknown, row: AdminUserListItem) => <Identity user={row} />,
          },
          enumColumn<AdminUserListItem, AdminUserListItem['status']>({
            title: '状态',
            dataIndex: 'status',
            map: USER_STATUS,
          }),
          enumColumn<AdminUserListItem, NonNullable<AdminUserListItem['registerSource']>>({
            title: '注册来源',
            dataIndex: 'registerSource',
            map: REGISTER_SOURCE,
            width: 120,
          }),
          {
            title: '分组 / 标签',
            key: 'taxonomy',
            width: 220,
            render: (_value: unknown, row: AdminUserListItem) =>
              row.groups.length + row.labels.length === 0 ? (
                <Typography.Text type="secondary">—</Typography.Text>
              ) : (
                <Space size={[0, 4]} wrap>
                  {row.groups.map((group) => (
                    <Tag key={`g${group.id}`} color="blue">
                      {group.name}
                    </Tag>
                  ))}
                  {row.labels.map((label) => (
                    <Tag key={`l${label.id}`}>{label.name}</Tag>
                  ))}
                </Space>
              ),
          },
          instantColumn<AdminUserListItem>({
            title: '最近登录',
            dataIndex: 'lastLoginAt',
            sortable: true,
          }),
          instantColumn<AdminUserListItem>({
            title: '注册时间',
            dataIndex: 'createdAt',
            sortable: true,
          }),
          actionsColumn<AdminUserListItem>({
            width: 250,
            render: (row) => (
              <>
                <Button type="link" size="small" onClick={() => setDetailId(row.id)}>
                  详情
                </Button>
                <Can permission="user:customer:write">
                  <Button type="link" size="small" onClick={() => edit.show(row)}>
                    编辑
                  </Button>
                </Can>
                <Can permission="user:customer:status">
                  <ConfirmAction
                    type="link"
                    size="small"
                    danger={row.status === 'active'}
                    loading={setStatus.isPending && setStatus.variables?.params?.id === row.id}
                    confirm={
                      row.status === 'active'
                        ? {
                            title: `禁用用户「${row.nickname ?? row.account}」？`,
                            description: '禁用后该用户立即退出登录，无法下单。',
                            okText: '禁用',
                          }
                        : undefined
                    }
                    onAction={() =>
                      setStatus.mutate({
                        params: { id: row.id },
                        body: { status: row.status === 'active' ? 'disabled' : 'active' },
                      })
                    }
                  >
                    {row.status === 'active' ? '禁用' : '启用'}
                  </ConfirmAction>
                </Can>
                <Can permission="user:customer:password">
                  <Button type="link" size="small" onClick={() => setResetting(row)}>
                    重置密码
                  </Button>
                </Can>
              </>
            ),
          }),
        ]}
      />

      <ModalForm
        {...edit.props}
        title={`编辑用户 ${edit.record?.account ?? ''}`}
        schema={adminUserForm}
        columns={2}
        fields={[
          { kind: 'text', name: 'nickname', label: '昵称' },
          { kind: 'text', name: 'realName', label: '真实姓名' },
          { kind: 'date', name: 'birthday', label: '生日' },
          {
            kind: 'select',
            name: 'groupIds',
            label: '分组',
            mode: 'multiple',
            options: groupOptions,
          },
          {
            kind: 'select',
            name: 'labelIds',
            label: '标签',
            mode: 'multiple',
            options: labelOptions,
          },
          { kind: 'textarea', name: 'adminRemark', label: '管理员备注', span: 24, rows: 2 },
        ]}
        route={userAdminUpdate}
        toInput={(values) => ({ params: { id: edit.record?.id ?? '' }, body: values })}
        invalidate={[userAdminList]}
        successMessage="已保存"
      />

      <ModalForm
        {...create.props}
        title="新增用户"
        schema={adminUserCreateBody}
        columns={2}
        fields={[
          {
            kind: 'text',
            name: 'phone',
            label: '手机号',
            maxLength: 11,
            help: '即登录账号；用户之后用这个手机号短信或微信登录，进的就是这个账号',
          },
          {
            kind: 'password',
            name: 'password',
            label: '登录密码',
            maxLength: 64,
            help: '可不填：不填则只能短信或微信登录。至少 6 位，含两类字符',
          },
          { kind: 'text', name: 'nickname', label: '昵称', help: '不填则按手机号自动生成' },
          { kind: 'text', name: 'realName', label: '真实姓名' },
          { kind: 'date', name: 'birthday', label: '生日' },
          {
            kind: 'select',
            name: 'groupIds',
            label: '分组',
            mode: 'multiple',
            options: groupOptions,
          },
          {
            kind: 'select',
            name: 'labelIds',
            label: '标签',
            mode: 'multiple',
            options: labelOptions,
          },
          { kind: 'textarea', name: 'adminRemark', label: '管理员备注', span: 24, rows: 2 },
        ]}
        route={userAdminCreate}
        toInput={(values) => ({ body: values })}
        invalidate={[userAdminList]}
        successMessage="已新增用户"
        okText="保存"
      />

      <ResetPasswordModal record={resetting} onClose={() => setResetting(null)} />

      <CustomerDrawer id={detailId} onClose={() => setDetailId(null)} />
      <GrantCouponModal
        target={granting?.target ?? null}
        onGranted={granting?.done}
        onClose={() => setGranting(null)}
      />
    </PageContainer>
  );
}

/**
 * The detail as `adminUserForm` wants it.
 *
 * `null` becomes absent rather than `''`: `exactOptionalPropertyTypes` means an
 * optional field is either missing or a real value, and the service skips a key
 * it was not sent — so a customer who never had a 真实姓名 keeps not having one
 * instead of gaining an empty string. `birthday` is `nullish`, so `null` is a
 * value the form may legitimately hold and send back.
 */
function editValuesOf(user: AdminUserDetail) {
  return {
    ...(user.nickname === null ? {} : { nickname: user.nickname }),
    ...(user.realName === null ? {} : { realName: user.realName }),
    ...(user.adminRemark === null ? {} : { adminRemark: user.adminRemark }),
    birthday: user.birthday,
    groupIds: user.groups.map((group) => group.id),
    labelIds: user.labels.map((label) => label.id),
  };
}

/** The avatar the shopper set in the mini-program, beside their nickname. */
function Identity({ user }: { user: Pick<AdminUserListItem, 'nickname' | 'avatarUrl'> }) {
  return (
    <Space size={8}>
      <Avatar size="small" src={user.avatarUrl ?? undefined}>
        {(user.nickname ?? '?').slice(0, 1)}
      </Avatar>
      <Typography.Text ellipsis={{ tooltip: user.nickname }}>
        {user.nickname ?? '—'}
      </Typography.Text>
    </Space>
  );
}

// ---------------------------------------------------------------------------
// detail
// ---------------------------------------------------------------------------

/**
 * The detail drawer.
 *
 * Orders, coupons and refunds are deliberately *not* fetched here: they are
 * the owning domains' own admin lists filtered by `userId`, so this page never
 * reads another domain's tables. The drawer's foot links to each of them, for
 * the viewer who may read it — "what has this customer bought" is the first
 * question after "who is this".
 */
function CustomerDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useRouteQuery(userAdminDetail, id === null ? undefined : { params: { id } }, {
    enabled: id !== null,
    presentError: false,
  });
  const can = useCan();
  const links = [
    { label: '订单', href: '/admin/orders', permission: orderAdminList.permission },
    { label: '售后', href: '/admin/trade/refunds', permission: refundAdminList.permission },
    {
      label: '优惠券',
      href: '/admin/coupon/user-coupons',
      permission: couponAdminUserCouponList.permission,
    },
  ].filter((link) => can(link.permission));

  return (
    <DetailDrawer
      open={id !== null}
      onClose={onClose}
      title="用户详情"
      query={detail}
      footer={
        links.length === 0
          ? undefined
          : (row) =>
              links.map((link) => (
                <Link key={link.href} href={`${link.href}?userId=${row.id}`}>
                  查看{link.label}
                </Link>
              ))
      }
    >
      {(row) => (
        <DescriptionsCard
          column={2}
          items={[
            { label: 'ID', value: row.id ?? '—' },
            { label: '账号', value: row.account ?? '—' },
            { label: '手机号', value: row.phone ?? '未绑定' },
            { label: '昵称', value: <Identity user={row} /> },
            { label: '真实姓名', value: row.realName ?? '—' },
            {
              label: '状态',
              value: <StatusTag value={row.status} map={USER_STATUS} />,
            },
            {
              label: '注册来源',
              value: row.registerSource ? (
                <StatusTag value={row.registerSource} map={REGISTER_SOURCE} />
              ) : (
                '—'
              ),
            },
            { label: '登录密码', value: row.hasPassword ? '已设置' : '未设置（仅验证码登录）' },
            {
              label: '微信绑定',
              value:
                row.boundWechat.length > 0
                  ? row.boundWechat
                      .map((platform) => (platform === 'oa' ? '公众号' : '小程序'))
                      .join('、')
                  : '未绑定',
            },
            { label: '收货地址', value: `${row.addressCount} 条` },
            { label: '注册 IP', value: row.registerIp ?? '—' },
            { label: '最近登录 IP', value: row.lastLoginIp ?? '—' },
            { label: '最近登录', value: <InstantText value={row.lastLoginAt ?? null} /> },
            { label: '注册时间', value: <InstantText value={row.createdAt ?? null} /> },
            { label: '分组', value: row.groups.map((group) => group.name).join('、') || '—' },
            { label: '标签', value: row.labels.map((label) => label.name).join('、') || '—' },
            { label: '管理员备注', value: row.adminRemark ?? '—', span: 2 },
            {
              label: '注销时间',
              value: <InstantText value={row.deletedAt ?? null} />,
              hidden: !row.deletedAt,
              span: 2,
            },
          ]}
        />
      )}
    </DetailDrawer>
  );
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

/**
 * 重置密码.
 *
 * The new password is typed by the operator and read out to the customer: it is
 * never mailed and never returned by the route. Every live session of that
 * account dies, which is the feature — a reset is what support does when an
 * account is suspected stolen.
 */
function ResetPasswordModal({
  record,
  onClose,
}: {
  record: AdminUserListItem | null;
  onClose: () => void;
}) {
  return (
    <ModalForm
      open={record !== null}
      onClose={onClose}
      title={`重置 ${record?.account ?? ''} 的登录密码`}
      size="small"
      okText="确认重置"
      header={
        <Typography.Paragraph type="secondary">
          重置后该用户的所有登录态立即失效，需要用新密码重新登录。密码请当面或电话告知本人，系统不会发送。
        </Typography.Paragraph>
      }
      schema={adminUserPasswordBody}
      fields={[{ kind: 'password', name: 'password', label: '新密码', placeholder: '至少 6 位' }]}
      route={userAdminResetPassword}
      toInput={(values) => ({ params: { id: record?.id ?? '' }, body: values })}
      onSuccess={(result) => {
        void message.success(`已重置，注销了 ${result.revokedSessions} 个登录态`);
      }}
    />
  );
}

/** 批量设置分组 / 标签 for the ticked rows. */
/**
 * 给筛选结果发券: the toolbar's "everyone listed" action. Disabled until the
 * list for these filters has loaded, when it is empty, and over
 * `MAX_GRANT_AUDIENCE` — the server would refuse it, so say so here.
 */
function GrantToFilterButton({
  filtered,
  total,
  onClick,
}: {
  filtered: boolean;
  total: number | undefined;
  onClick: (matched: number) => void;
}) {
  const label = `${filtered ? '给筛选结果发券' : '给全部用户发券'}${total === undefined ? '' : `（${total} 人）`}`;
  const tooLarge = total !== undefined && total > MAX_GRANT_AUDIENCE;
  const button = (
    <Button
      disabled={total === undefined || total === 0 || tooLarge}
      onClick={() => {
        if (total !== undefined) onClick(total);
      }}
    >
      {label}
    </Button>
  );
  return tooLarge ? (
    <Tooltip title={`超过 ${MAX_GRANT_AUDIENCE} 人，请先缩小筛选范围`}>
      <span>{button}</span>
    </Tooltip>
  ) : (
    button
  );
}

function BatchPicker({
  label,
  noun,
  options,
  count,
  pending,
  onSubmit,
}: {
  label: string;
  noun: string;
  options: Array<{ value: string; label: string }>;
  count: number;
  pending: boolean;
  onSubmit: (selected: string[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  return (
    <>
      <Button size="small" disabled={count === 0} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Modal
        open={open}
        title={`${label}（已选 ${count} 个用户）`}
        okText="覆盖设置"
        confirmLoading={pending}
        destroyOnHidden
        onCancel={() => setOpen(false)}
        onOk={() => {
          onSubmit(selected).then(
            () => {
              setSelected([]);
              setOpen(false);
            },
            () => {
              /* the global presenter already showed the failure */
            },
          );
        }}
      >
        <Typography.Paragraph type="secondary">
          覆盖设置：所选用户的{noun}将被替换为下面勾选的内容，全部不选即清空。
        </Typography.Paragraph>
        <Space size={[8, 8]} wrap>
          {options.map((option) => (
            <Tag.CheckableTag
              key={option.value}
              checked={selected.includes(option.value)}
              onChange={(checked) =>
                setSelected((current) =>
                  checked
                    ? [...current, option.value]
                    : current.filter((value) => value !== option.value),
                )
              }
            >
              {option.label}
            </Tag.CheckableTag>
          ))}
          {options.length === 0 ? (
            <Typography.Text type="secondary">暂无可选项</Typography.Text>
          ) : null}
        </Space>
      </Modal>
    </>
  );
}
