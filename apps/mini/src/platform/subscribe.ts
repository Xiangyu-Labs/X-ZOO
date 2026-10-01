import type { AppSubscribeScene } from '@shop/contracts/system/app.schemas';
import { platform } from './runtime';
import type { SubscribeResult } from './types';

/**
 * Subscribe messages (C08). The one call site of `requestSubscribeMessage` is the platform
 * implementation behind `subscribe()`.
 *
 * `subscribe(scene)` must be called **synchronously inside the tap handler, before the first
 * `await`**: iOS treats a request that follows a network round-trip as not user-initiated.
 * It never rejects and its result never changes what the page does next (a refusal still
 * submits the order); the answer only goes to `onSubscribeResult` listeners (analytics).
 *
 * ```ts
 * onClick = () => { const sub = subscribe('checkout'); submit().finally(() => sub) }
 * ```
 */
export type SubscribeScene = AppSubscribeScene;

/** WeChat's limit per request. */
export const MAX_TEMPLATES = 3;

let templates: Partial<Record<SubscribeScene, readonly string[]>> = {};

/** Template ids per scene: `app/config.subscribeScenes` (src/app-config). */
export function setSubscribeTemplates(byScene: Partial<Record<SubscribeScene, readonly string[]>>) {
  templates = byScene;
}

type ResultListener = (scene: SubscribeScene, result: SubscribeResult | { error: string }) => void;
const listeners = new Set<ResultListener>();

export function onSubscribeResult(listener: ResultListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ask for the scene's templates. Resolves when the shopper answered, or at once if none. */
export function subscribe(scene: SubscribeScene): Promise<void> {
  const ids = [...new Set((templates[scene] ?? []).filter((id) => id.trim() !== ''))].slice(
    0,
    MAX_TEMPLATES,
  );
  if (ids.length === 0) return Promise.resolve();
  // Synchronous from here to the platform call: nothing may be awaited before it.
  return platform.requestSubscribe(ids).then(
    (result) => {
      for (const listener of listeners) listener(scene, result);
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      for (const listener of listeners) listener(scene, { error: message });
    },
  );
}
