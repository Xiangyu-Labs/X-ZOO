'use client';

import { Button, Result } from 'antd';
import { useRouter } from 'next/navigation';

/** An admin URL nothing serves: inside the shell, so the menu is still there to go elsewhere. */
export default function ShellNotFound() {
  const router = useRouter();
  return (
    <Result
      status="404"
      title="404"
      subTitle="抱歉，你访问的页面不存在。"
      extra={
        <Button type="primary" onClick={() => router.push('/admin')}>
          返回首页
        </Button>
      }
    />
  );
}
