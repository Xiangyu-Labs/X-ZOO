'use client';

import { Spin } from 'antd';
import dynamic from 'next/dynamic';

/**
 * Client-only, in its own chunk: the editor library, its CSS and the blocks'
 * stylesheet load when this page opens and never with the rest of the admin.
 */
const DecorSpike = dynamic(() => import('./decor-spike'), {
  ssr: false,
  loading: () => <Spin style={{ display: 'block', margin: '80px auto' }} />,
});

export function DecorSpikeLoader() {
  return <DecorSpike />;
}
