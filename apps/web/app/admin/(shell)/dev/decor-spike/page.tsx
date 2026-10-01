import type { Metadata } from 'next';

import { DecorSpikeLoader } from './decor-spike-loader';

export const metadata: Metadata = { title: '装修组件沙盒' };

export default function DecorSandboxPage() {
  return <DecorSpikeLoader />;
}
