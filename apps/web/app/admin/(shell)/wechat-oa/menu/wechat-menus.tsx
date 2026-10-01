'use client';

import { Alert, Button, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import {
  wechatOaMenuCreate,
  wechatOaMenuCurrent,
  wechatOaMenuDelete,
  wechatOaMenuList,
  wechatOaMenuPublish,
  wechatOaMenuUpdate,
} from '@shop/contracts/wechat-oa/wechat-oa.menu.contract';
import { wechatMenuForm, type WechatMenu } from '@shop/contracts/wechat-oa/schemas';

import { useInvalidateRoutes, useRouteMutation, useRouteQuery } from '@/admin/api/hooks';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ErrorSummary } from '@/admin/kit/error-summary';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import { actionsColumn, idColumn, instantColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';
import { MenuTreeEditor } from '@/admin/wechat-oa/menu-tree-editor';

import { MenuPhonePreview } from './menu-phone-preview';

/**
 * 自定义菜单 — the bottom menu of the Official Account.
 *
 * Saving and publishing are two buttons because they are two decisions. With
 * one, a WeChat outage loses the operator's edits and a typo goes live the
 * moment it is typed. Here a menu is a row, several may be
 * kept side by side (a 春节 menu next to the everyday one), and only 发布
 * touches `cgi-bin/menu/create` — which is also why it holds its own
 * permission atom.
 */
export function WechatMenusPage() {
  const modal = useFormModal<WechatMenu>();
  const current = useRouteQuery(wechatOaMenuCurrent);

  return (
    <PageContainer subTitle="保存只改草稿，发布才会改变关注者手机上看到的菜单">
      {current.data?.publishError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="上次发布失败"
          description={
            <ErrorSummary
              summary={current.data.publishErrorSummary}
              detail={current.data.publishError}
            />
          }
        />
      ) : null}

      <CrudTable
        route={wechatOaMenuList}
        toolbar={
          <Can permission="wechat-oa:menu:write">
            <Button type="primary" onClick={() => modal.show()}>
              新建菜单
            </Button>
          </Can>
        }
        columns={[
          idColumn<WechatMenu>(),
          textColumn<WechatMenu>({ title: '名称', dataIndex: 'name', ellipsis: true }),
          {
            title: '按钮',
            key: 'buttons',
            render: (_value: unknown, row: WechatMenu) => (
              <Typography.Text type="secondary">{describe(row)}</Typography.Text>
            ),
          },
          {
            title: '状态',
            key: 'isActive',
            width: 220,
            render: (_value: unknown, row: WechatMenu) => <MenuStatus row={row} />,
          },
          instantColumn<WechatMenu>({ title: '发布时间', dataIndex: 'publishedAt' }),
          actionsColumn<WechatMenu>({
            width: 200,
            render: (row) => (
              <>
                <Can permission="wechat-oa:menu:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                </Can>
                <PublishButton id={row.id} />
                <Tooltip title={row.isActive ? '生效中的菜单不能删除，先发布另一套' : ''}>
                  <span>
                    <ConfirmButton
                      route={wechatOaMenuDelete}
                      input={{ params: { id: row.id } }}
                      title={`删除菜单「${row.name}」？`}
                      description="微信上已经生效的菜单不会因此消失。"
                      invalidate={[wechatOaMenuList]}
                      successMessage="已删除"
                      permission="wechat-oa:menu:write"
                      buttonProps={{
                        type: 'link',
                        size: 'small',
                        danger: true,
                        disabled: row.isActive,
                      }}
                    >
                      删除
                    </ConfirmButton>
                  </span>
                </Tooltip>
              </>
            ),
          }),
        ]}
      />

      <ModalForm
        {...modal.props}
        title={modal.record ? `编辑：${modal.record.name}` : '新建菜单'}
        width={1180}
        schema={wechatMenuForm}
        fields={[
          { kind: 'text', name: 'name', label: '名称', placeholder: '例如「春节菜单」' },
          {
            kind: 'custom',
            name: 'buttons',
            label: '按钮',
            help: '最多 3 个一级按钮，每个下面最多 5 个子菜单。右边是关注者手机上的样子，可以点。',
            render: ({ value, onChange, disabled }) => {
              const buttons = Array.isArray(value) ? value : [];
              return (
                <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <MenuTreeEditor value={buttons} onChange={onChange} disabled={disabled} />
                  </div>
                  <MenuPhonePreview buttons={buttons} />
                </div>
              );
            },
          },
        ]}
        initialValues={
          modal.record
            ? { name: modal.record.name, buttons: modal.record.buttons }
            : { name: '', buttons: [{ name: '', type: 'view', url: '' }] }
        }
        route={modal.record ? wechatOaMenuUpdate : wechatOaMenuCreate}
        toInput={(values) =>
          modal.record ? { params: { id: modal.record.id }, body: values } : { body: values }
        }
        invalidate={[wechatOaMenuList, wechatOaMenuCurrent]}
        successMessage="已保存草稿"
      />
    </PageContainer>
  );
}

/**
 * 已生效 / 草稿, and — on whichever row WeChat last refused — the refusal.
 *
 * `publish()` writes WeChat's refusal to `publish_error` (raw, under 技术详情)
 * and `publish_error_summary` (what staff read) on the row that was being
 * published. The alert above the table reads `/current`, the *live*
 * menu, so a refused **draft** (the common case: WeChat checks every URL
 * against the account's 业务域名) would be shown nowhere once the toast went.
 * The row is where the operator is looking when they press 发布.
 */
function MenuStatus({ row }: { row: WechatMenu }) {
  const state = row.isActive ? <Tag color="success">已生效</Tag> : <Tag color="default">草稿</Tag>;
  if (!row.publishError) return state;
  return (
    <Space direction="vertical" size={2}>
      <Space size={4}>
        {state}
        <Tag color="error">发布失败</Tag>
      </Space>
      <span style={{ fontSize: 12 }}>
        <ErrorSummary summary={row.publishErrorSummary} detail={row.publishError} />
      </span>
    </Space>
  );
}

/**
 * 发布, which refreshes the list and the alert whether WeChat accepted or not.
 *
 * `ConfirmButton` invalidates on success only; a refusal is exactly when the
 * page has something new to show (`publish_error` on the row, and on `/current`
 * when the live menu was the one refused), and the toast that says so lasts
 * three seconds.
 */
function PublishButton({ id }: { id: string }) {
  const refresh = useInvalidateRoutes();
  const mutation = useRouteMutation(wechatOaMenuPublish, {
    invalidate: [wechatOaMenuList, wechatOaMenuCurrent],
    successMessage: '已发布到微信',
    // Not awaited: the button is free again as soon as the refusal is back,
    // and the rows and the alert catch up when the re-read lands.
    onError: () => {
      void refresh(wechatOaMenuList, wechatOaMenuCurrent);
    },
  });
  return (
    <Can permission="wechat-oa:menu:publish">
      <Popconfirm
        title="确认发布这套菜单？"
        description="发布后，所有关注者的底部菜单会在几分钟内变成这一套。"
        okText="发布"
        cancelText="取消"
        okButtonProps={{ loading: mutation.isPending }}
        onConfirm={() => mutation.mutate({ params: { id } })}
      >
        <Button type="link" size="small" loading={mutation.isPending}>
          发布
        </Button>
      </Popconfirm>
    </Can>
  );
}

/** "商城（2） · 联系客服" — enough to tell two drafts apart without opening them. */
function describe(menu: WechatMenu): string {
  if (menu.buttons.length === 0) return '（空）';
  return menu.buttons
    .map((button) => {
      const children = button.sub_button ?? [];
      return children.length > 0 ? `${button.name}（${children.length}）` : button.name;
    })
    .join(' · ');
}
