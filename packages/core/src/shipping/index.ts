/**
 * The shipping domain's public surface.
 *
 * `docs/conventions.md`: "A domain in `core` may import another domain only
 * through that domain's `index.ts`". Everything not re-exported here is private
 * — `shipping.repo.ts` above all, which no other domain may reach.
 *
 * | Export               | Caller     | When                                      |
 * | -------------------- | ---------- | ----------------------------------------- |
 * | `expressCompanies.*` | routes     | the 发货 picker and its management screen |
 * | `cityTree`           | routes     | 省市区 picker, storefront and admin       |
 * | `templates.*`        | routes     | 运费模板 management                        |
 * | `freightTrial`       | routes     | 运费试算 in the template drawer            |
 *
 * Registering the `FreightPort` and the `LogisticsPort` is a **side effect of
 * importing this file**, exactly like the order domain's state machine:
 * checkout quotes through `getFreightPort()` and never imports an
 * implementation. Until this import happens, `fallbackFreightQuote` answers and
 * every 运费模板 line costs zero.
 */
import { registerShippingFreightPort } from './shipping.freight.port';
import { registerShippingConfigTest } from './shipping.config-test';
import { registerShippingLogisticsPort } from './shipping.logistics.port';

registerShippingFreightPort();
registerShippingLogisticsPort();

export { shippingPermissions } from './permissions';

/**
 * Wires what cannot run at import time; called once per process from the gen'd
 * bootstrap. The 「测试查询」 hook reads `logisticsConfig`, and `system` is
 * still evaluating when this file is first imported.
 */
export function registerShippingDomain(): void {
  registerShippingConfigTest();
}

export * as expressCompanies from './shipping.express.service';
export * as templates from './shipping.template.service';
export { trial as freightTrial } from './shipping.freight.trial';
export { cityTree, resetCityTreeCache } from './shipping.city.service';
export { freightPort, registerShippingFreightPort } from './shipping.freight.port';
export {
  logisticsPort,
  registerShippingLogisticsPort,
  resetTrackingFetch,
  setTrackingFetch,
} from './shipping.logistics.port';
