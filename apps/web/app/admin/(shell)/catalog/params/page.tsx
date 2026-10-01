import type { Metadata } from 'next';

import { ParamTemplatesPage } from './param-templates';

export const metadata: Metadata = { title: '商品参数' };

export default function Page() {
  return <ParamTemplatesPage />;
}
