'use client';

import { Card, Flex, Skeleton } from 'antd';

/**
 * Between a menu click and the page: the shape of a page — breadcrumb, title,
 * then a card — so the content does not jump when it arrives.
 */
export default function ShellLoading() {
  return (
    <Flex vertical gap={16}>
      <div>
        <Skeleton.Input active size="small" style={{ width: 160, marginBottom: 8 }} />
        <Skeleton title={{ width: 220 }} paragraph={false} active />
      </div>
      <Card>
        <Skeleton active paragraph={{ rows: 8 }} />
      </Card>
    </Flex>
  );
}
