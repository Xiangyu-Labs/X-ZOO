import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderAdmin, testIdentity } from '@/test/render';

import { Can, RequirePermission, requirePermission } from './can';

describe('<Can>', () => {
  it('renders children when the admin holds the atom', () => {
    renderAdmin(
      <Can permission="demo:widget:create">
        <span>新建</span>
      </Can>,
    );
    expect(screen.getByText('新建')).toBeInTheDocument();
  });

  it('renders nothing when the admin does not', () => {
    renderAdmin(
      <Can permission="demo:widget:delete">
        <span>删除</span>
      </Can>,
    );
    expect(screen.queryByText('删除')).not.toBeInTheDocument();
  });

  it('renders the fallback instead when one is given', () => {
    renderAdmin(
      <Can permission="demo:widget:delete" fallback={<span>无权限</span>}>
        <span>删除</span>
      </Can>,
    );
    expect(screen.getByText('无权限')).toBeInTheDocument();
  });

  it('treats an array as "any of"', () => {
    renderAdmin(
      <Can permission={['nope:one', 'demo:widget:list']}>
        <span>列表</span>
      </Can>,
    );
    expect(screen.getByText('列表')).toBeInTheDocument();
  });

  it('renders for everyone when no permission is required', () => {
    renderAdmin(
      <Can>
        <span>公开</span>
      </Can>,
    );
    expect(screen.getByText('公开')).toBeInTheDocument();
  });

  it('lets a super admin through anything', () => {
    renderAdmin(
      <Can permission="never:granted:atom">
        <span>超级管理员可见</span>
      </Can>,
      { identity: { ...testIdentity, isSuper: true, permissions: [] } },
    );
    expect(screen.getByText('超级管理员可见')).toBeInTheDocument();
  });
});

describe('route guards', () => {
  it('<RequirePermission> shows the 403 page instead of the content', () => {
    renderAdmin(
      <RequirePermission permission="demo:widget:delete">
        <span>机密内容</span>
      </RequirePermission>,
    );
    expect(screen.queryByText('机密内容')).not.toBeInTheDocument();
    expect(screen.getByText('403')).toBeInTheDocument();
    expect(screen.getByText('抱歉，你没有权限访问该页面。')).toBeInTheDocument();
  });

  it('<RequirePermission> renders the content when allowed', () => {
    renderAdmin(
      <RequirePermission permission="demo:widget:list">
        <span>列表内容</span>
      </RequirePermission>,
    );
    expect(screen.getByText('列表内容')).toBeInTheDocument();
  });

  it('requirePermission() wraps a page component', () => {
    const Page = () => <span>页面</span>;
    const Guarded = requirePermission('demo:widget:delete', Page);
    renderAdmin(<Guarded />);
    expect(screen.queryByText('页面')).not.toBeInTheDocument();
    expect(screen.getByText('403')).toBeInTheDocument();
  });
});
