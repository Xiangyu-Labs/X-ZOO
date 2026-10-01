import type { Metadata } from 'next';

import { ShippingTemplatesPage } from './shipping-templates';

export const metadata: Metadata = { title: '运费模板' };

export default function Page() {
  return <ShippingTemplatesPage />;
}
