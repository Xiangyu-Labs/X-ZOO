import { defineErrors } from '../_conventions/errors';

/**
 * Readiness has exactly one failure: not ready. Which check failed is
 * `details`, not a separate code — a monitor branches on "can this serve", and
 * a human reads the detail.
 */
export const healthErrors = defineErrors({
  /**
   * 503 rather than 500: the process is fine and answering, the dependency it
   * needs is not. A 500 would tell a load balancer to take the pod out; a 503
   * tells it to stop sending traffic, which is what this means.
   */
  HEALTH_NOT_READY: { status: 503, message: '服务尚未就绪' },
});
