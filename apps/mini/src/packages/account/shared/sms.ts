import type { InputOf } from '@shop/api-client';
import { api } from '@/data/api';

export type SmsScene = InputOf<'auth.sendSmsCode'>['body']['scene'];

/** Sends a code for `scene`; resolves with the seconds before another may be asked for. */
export async function sendSmsCode(phone: string, scene: SmsScene): Promise<number> {
  const result = await api.call('auth.sendSmsCode', { body: { phone, scene } });
  return result.resendAfterSec;
}

/** What the server takes as an SMS code. */
export const SMS_CODE_PATTERN = /^\d{6}$/;
