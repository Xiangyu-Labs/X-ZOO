import type { Metadata } from 'next';
import { Suspense } from 'react';

import { LoginForm } from './login-form';

export const metadata: Metadata = { title: '登录' };

export default function LoginPage() {
  // `useSearchParams` (for `?next=`) needs a Suspense boundary above it.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
