import { z } from 'zod';

/** One server-sent admin notification. Matches the SSE `data:` payload. */
export const adminNotification = z.object({
  id: z.string(),
  /** Domain-ish discriminator, e.g. `order.paid`. Used for the icon/colour. */
  type: z.string(),
  title: z.string(),
  body: z.string(),
  /** In-app path to open, e.g. `/admin/orders/12`. */
  link: z.string().optional(),
  createdAt: z.string(),
});

export type AdminNotification = z.infer<typeof adminNotification>;

export type StreamStatus =
  /** Never connected yet, or between attempts. */
  | 'connecting'
  /** Open and receiving. */
  | 'open'
  /** Gave up: the endpoint does not exist yet (Phase 0) or keeps failing. */
  | 'unavailable';
