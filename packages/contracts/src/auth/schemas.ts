import { z } from 'zod';
import { id } from '../_conventions/common';

/**
 * What the admin shell needs to render the frame: who am I, and what may I see.
 * `permissions` holds the granted atoms (`<domain>:<resource>:<action>`); a
 * super admin gets `isSuper: true` and an empty-or-full list is irrelevant —
 * `<Can>` must short-circuit on `isSuper`.
 */
export const adminProfile = z.object({
  id,
  account: z.string(),
  name: z.string(),
  avatar: z.string().nullish(),
  isSuper: z.boolean(),
  permissions: z.array(z.string()),
});
export type AdminProfile = z.infer<typeof adminProfile>;

export const adminLoginBody = z.object({
  account: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
  /** Present once the slider captcha is switched on; ignored while it is off. */
  captchaToken: z.string().max(4096).optional(),
  /**
   * 「记住登录状态」: the session survives seven idle days and a closed
   * browser. Without it, eight idle hours or closing the browser end it.
   */
  remember: z.boolean().optional(),
});
export type AdminLoginBody = z.infer<typeof adminLoginBody>;

export const adminProfileExample: AdminProfile = {
  id: '1',
  account: 'admin',
  name: '超级管理员',
  avatar: null,
  isSuper: true,
  permissions: [
    'auth:profile:read',
    'auth:profile:update',
    'auth:session:delete',
    'auth:session:read',
  ],
};
