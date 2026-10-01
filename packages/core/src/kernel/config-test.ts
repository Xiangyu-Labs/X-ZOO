import type { z } from 'zod';
import type { Ctx } from './context';
import type { ConfigFieldUi, ConfigGroupDef } from './config-registry';

/**
 * 「测试」 on a settings screen.
 *
 * A config group can say "here is how to find out whether these values work":
 * send one SMS, write and delete one object, exchange an AppSecret for a token.
 * The hook runs against the values **on the screen**, saved or not — the stored
 * secrets fill in any password box left empty — and it writes nothing back, so
 * an operator can try a key before it goes live instead of after.
 *
 * Hooks are registered from a domain's `register<Name>Domain()` rather than
 * declared in the `*.config.ts` file, because running one needs the domain's
 * adapters and a config file must stay importable by everybody.
 */

export interface ConfigTestStep {
  /** What was tried, e.g. 「写入探针文件」. */
  name: string;
  ok: boolean;
  /** What came back: an id, a URL, or the provider's own error code and text. */
  detail?: string;
  ms?: number;
}

export interface ConfigTestResult {
  ok: boolean;
  steps: ConfigTestStep[];
}

export interface ConfigTestHook<S extends z.ZodObject = z.ZodObject> {
  /** The button's text, e.g. 「发送测试短信」. */
  label: string;
  /**
   * Asked before running. Set it when the test has a cost or a visible effect
   * outside the shop (an SMS is billed and lands on a real phone).
   */
  confirm?: string;
  /** Extra inputs the operator fills in before running, e.g. the phone number. */
  input?: z.ZodObject;
  inputUi?: Record<string, ConfigFieldUi>;
  run(ctx: Ctx, config: z.infer<S>, input: Record<string, unknown>): Promise<ConfigTestResult>;
}

const hooks = new Map<string, ConfigTestHook>();

export function registerConfigTest<S extends z.ZodObject>(
  group: ConfigGroupDef<S>,
  hook: ConfigTestHook<S>,
): void {
  hooks.set(group.group, hook as unknown as ConfigTestHook);
}

export function getConfigTest(group: string): ConfigTestHook | undefined {
  return hooks.get(group);
}

/** Test helper. Never call this from app code. */
export function resetConfigTests(): void {
  hooks.clear();
}

/**
 * Runs steps in order and stops at the first failure: a probe object that was
 * never written cannot be read back, and saying so twice is noise.
 *
 * A step returns the detail to show, or throws; a thrown error's message is the
 * detail of a failed step, never a 500.
 */
export function testSteps(ctx: Pick<Ctx, 'clock'>) {
  const steps: ConfigTestStep[] = [];
  let failed = false;
  return {
    async step(name: string, fn: () => Promise<string | undefined>): Promise<boolean> {
      if (failed) return false;
      const started = ctx.clock.now().getTime();
      try {
        const detail = await fn();
        steps.push({
          name,
          ok: true,
          ...(detail === undefined ? {} : { detail }),
          ms: ctx.clock.now().getTime() - started,
        });
        return true;
      } catch (error) {
        failed = true;
        steps.push({
          name,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          ms: ctx.clock.now().getTime() - started,
        });
        return false;
      }
    },
    /** A failure that was decided without running anything, e.g. 「未选择服务商」. */
    fail(name: string, detail: string): void {
      failed = true;
      steps.push({ name, ok: false, detail });
    },
    result(): ConfigTestResult {
      return { ok: !failed && steps.length > 0, steps };
    },
  };
}
