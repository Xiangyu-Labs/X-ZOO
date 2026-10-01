import { adminLogin } from '@shop/contracts/auth/auth.contract';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isSessionExpiry, loginUrl, resetApiConfig } from '@/admin/api/config';
import { AdminThemeProvider } from '@/admin/theme/theme-provider';
import { on, respondWithError, stubRoutes } from '@/test/api';
import { renderAdmin } from '@/test/render';

import { LoginForm } from './login-form';

let search = new URLSearchParams();
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => search,
}));

afterEach(() => {
  resetApiConfig();
  search = new URLSearchParams();
  replace.mockReset();
});

function renderLogin() {
  return renderAdmin(
    <AdminThemeProvider>
      <LoginForm />
    </AdminThemeProvider>,
    { identity: null },
  );
}

const profile = {
  id: '1',
  account: 'admin',
  name: '超管',
  avatar: null,
  isSuper: true,
  permissions: [],
};

describe('admin login', () => {
  it('AUTH-011: sends 记住登录状态 with the credentials', async () => {
    const calls = stubRoutes([on(adminLogin, () => profile)]);
    renderLogin();

    await userEvent.type(screen.getByLabelText('账号'), 'admin');
    await userEvent.type(screen.getByLabelText('密码'), 'secret-pass');
    await userEvent.click(screen.getByRole('checkbox', { name: /记住登录状态/ }));
    await userEvent.click(screen.getByRole('button', { name: /登\s*录/ }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ account: 'admin', password: 'secret-pass', remember: true });
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin'));
  });

  it('starts in 账号, and drops a failed attempt’s message once they type again', async () => {
    stubRoutes([
      on(adminLogin, () =>
        respondWithError(401, { code: 'AUTH_INVALID_CREDENTIALS', message: '账号或密码不正确' }),
      ),
    ]);
    renderLogin();
    expect(screen.getByLabelText('账号')).toHaveFocus();

    await userEvent.type(screen.getByLabelText('账号'), 'admin');
    await userEvent.type(screen.getByLabelText('密码'), 'wrong-pass');
    await userEvent.click(screen.getByRole('button', { name: /登\s*录/ }));
    expect(await screen.findByText('账号或密码不正确')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('密码'), 'x');
    expect(screen.queryByText('账号或密码不正确')).not.toBeInTheDocument();
  });

  it('AUTH-011 — says 登录已过期 when a session ran out, and nothing when there was none', () => {
    search = new URLSearchParams(
      loginUrl('/admin/catalog/products', { expired: true }).split('?')[1],
    );
    const { unmount } = renderLogin();
    expect(screen.getByTestId('login-expired').textContent).toContain('登录已过期');
    unmount();

    search = new URLSearchParams('next=%2Fadmin');
    renderLogin();
    expect(screen.queryByTestId('login-expired')).toBeNull();
  });
});

describe('where a 401 sends the admin', () => {
  it('marks the login URL only for a session that ran out', () => {
    expect(isSessionExpiry({ status: 401, code: 'AUTH_SESSION_EXPIRED' })).toBe(true);
    expect(isSessionExpiry({ status: 401, code: 'UNAUTHENTICATED' })).toBe(false);
    expect(loginUrl('/admin/users?page=2', { expired: true })).toBe(
      '/admin/login?next=%2Fadmin%2Fusers%3Fpage%3D2&expired=1',
    );
    expect(loginUrl('/admin')).toBe('/admin/login?next=%2Fadmin');
    expect(loginUrl()).toBe('/admin/login');
  });
});
