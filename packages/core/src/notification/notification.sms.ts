import { resolveSender, smsSenderUsable, type SmsSendResult } from '../sms';
import { findUserPhone } from '../user';
import type { SmsPort } from './notification.ports';

/**
 * The SMS port as the shop runs it: the member's phone, through whichever
 * provider 短信设置 names.
 *
 * What goes out is the params list the template form holds — rendered, in its
 * order, nothing added — never the event's payload: Tencent's templates are
 * positional and refuse a variable count other than the approved one.
 *
 * Two answers are `skipped` rather than failures, because retrying cannot
 * change them: no provider configured, and a member with no phone. The
 * verification-code budgets are not spent here: a burst of order notices must
 * not lock a shopper out of 手机号登录.
 */
export const providerSmsPort: SmsPort = {
  async send(ctx, input) {
    if (!(await smsSenderUsable(ctx))) return { ok: false, skipped: 'no sms provider registered' };
    const phone = await findUserPhone(ctx.db, input.userId);
    if (phone === null) return { ok: false, skipped: 'user has no phone' };

    const sender = await resolveSender(ctx);
    let result: SmsSendResult;
    try {
      result = await sender.send({
        phone,
        templateId: input.templateCode,
        params: input.params,
        signName: input.signName,
      });
    } catch (error) {
      // `send` is documented not to throw; a third party is a third party.
      result = { ok: false, providerCode: 'THREW', error: String(error) };
    }

    if (result.ok) {
      ctx.logger.info(
        { code: input.notificationCode, provider: sender.name, messageId: result.messageId },
        'notification sms sent',
      );
      return { ok: true };
    }
    ctx.logger.warn(
      {
        code: input.notificationCode,
        provider: sender.name,
        providerCode: result.providerCode,
        error: result.error,
      },
      'notification sms refused',
    );
    return {
      ok: false,
      ...(result.providerCode ? { errorCode: result.providerCode } : {}),
      ...(result.error ? { errorMessage: result.error } : {}),
    };
  },
};
