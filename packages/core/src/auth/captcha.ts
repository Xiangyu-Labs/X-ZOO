/**
 * Slider-captcha hook — interface only.
 *
 * The admin login contract already carries `captchaToken`, and the login
 * service already calls this, so switching the captcha on later is a
 * registration and a config flag rather than a contract change. No
 * implementation ships: the shop has one admin account and a per-account
 * throttle, and a captcha nobody has configured that fails closed would lock
 * the only operator out.
 *
 * TODO: implement against the chosen provider and register it.
 */

export interface CaptchaVerifier {
  name: string;
  /**
   * Returns `true` when the token proves a human solved the challenge.
   * Must fail *closed* (return false) on a provider error — but see
   * `captchaRequired` below for how the service decides to ask at all.
   */
  verify(token: string, context: { subject: string }): Promise<boolean>;
}

let verifier: CaptchaVerifier | undefined;

export function registerCaptchaVerifier(impl: CaptchaVerifier): void {
  verifier = impl;
}

export function getCaptchaVerifier(): CaptchaVerifier | undefined {
  return verifier;
}

/** Test helper. Never call this from app code. */
export function resetCaptchaVerifier(): void {
  verifier = undefined;
}

/**
 * Whether this login attempt must present a captcha. Nothing is registered by
 * default, so this is `false` and the token is ignored — the throttle is the
 * live defence.
 */
export function captchaRequired(options: { failedAttempts: number; threshold?: number }): boolean {
  if (!verifier) return false;
  return options.failedAttempts >= (options.threshold ?? 3);
}
