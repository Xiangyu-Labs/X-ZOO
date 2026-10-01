import type { Metadata } from 'next';

import { KitDemo } from './kit-demo';

export const metadata: Metadata = { title: '组件套件演示' };

export default function KitDemoPage() {
  return <KitDemo />;
}
