import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import type { StorefrontRoute } from '@shop/api-client/routes';
import type { BlockHost, BlockIntent, ImageResolver } from '@shop/storefront-blocks';
import { claimFailureText, useClaimCoupon } from '@/features/coupon/use-claim';
import { assetUrl, imageUrl } from '@/lib/asset-url';
import { serverNow } from '@/lib/server-clock';
import { callPhone, officialAccountBar } from '@/platform';
import { requireLogin, useSignedIn } from '@/session/session';
import { ContactArea, sessionFromOf, useSupport } from '@/ui/contact-button';
import { toast } from '@/ui/feedback';
import { useOverlayStore } from '@/ui/overlay-store';
import { usePageShown } from '@/ui/second-ticker';
import { errorMessage } from '@/lib/error-message';

/** 客服's session source for a decorated page: the route, and the 微页面's id. */
export function decorSessionFrom(route: StorefrontRoute): string {
  const params: Readonly<Record<string, unknown>> = route.params;
  return sessionFromOf(route.route, params.id ? String(params.id) : undefined);
}

type RenderIntent = (intent: BlockIntent, face: ReactNode) => ReactNode;

/**
 * The native wrappers a block's intent needs (docs/mini/decor.md §2.4 `renderIntent`):
 *
 * - `contact`: per `useSupport()`, WeChat's `open-type="contact"` button around the face (no
 *   look of its own), a call on a hotline, or `null` when the shop has neither: 悬浮客服 then
 *   draws nothing and the 服务宫格 cell stays empty.
 * - `officialAccount`: WeChat's 关注公众号 bar in the mini-program, `null` on H5.
 * - anything else: the face as it is.
 */
export function useDecorRenderIntent(sessionFrom: string): RenderIntent {
  const { kind: supportKind } = useSupport();
  return useCallback(
    (intent, face) => {
      if (intent.kind === 'contact') {
        if (supportKind === 'none') return null;
        return <ContactArea sessionFrom={sessionFrom}>{face}</ContactArea>;
      }
      if (intent.kind === 'officialAccount') return officialAccountBar();
      return face;
    },
    [sessionFrom, supportKind],
  );
}

/**
 * `BlockHost.resolveImage` for the mini-program: a stored `/uploads/…` path against the API
 * origin (a block drew it as it was before, which loads nothing here), and the server's 480 or
 * 960 px copy where one exists.
 */
export const resolveDecorImage: ImageResolver = (src, width) =>
  (width === undefined ? assetUrl(src) : imageUrl(src, width === 480 ? 'small' : 'medium')) ?? src;

export interface DecorHost {
  host: BlockHost;
  onIntent: (intent: BlockIntent) => void;
  renderIntent: RenderIntent;
}

/**
 * Everything a page drawing `BlockList` adds (docs/mini/decor.md §2.4): the `host` facts
 * (signed in, the server clock, a sheet open over the page, how to load a picture) and the answers to the blocks'
 * intents.
 *
 * - `login`, `claimNewcomerCoupons`: through `requireLogin(route)`. Signed in on the spot (a
 *   silent sign-in), the page is fetched again; otherwise the login page comes back to `route`,
 *   whose sign-in change fetches it again. 新人券 are granted at registration, so asking for
 *   them is signing up.
 * - `claimCoupon`: a guest goes through the same gate and comes back to tap 领取 again; a
 *   shopper claims (`coupon.claim`), sees the result, and the page is fetched again. The
 *   claimed state lives only in the page's personal layer (DECOR-015): the button is never
 *   flipped here. One claim at a time.
 * - `contact`: only when no `renderIntent` wrapped it: a call on a hotline, nothing otherwise.
 */
export function useDecorHost(route: StorefrontRoute, reload: () => unknown): DecorHost {
  const signedIn = useSignedIn();
  const overlayOpen = useOverlayStore((state) => state.open > 0);
  const { kind: supportKind, phone } = useSupport();
  const renderIntent = useDecorRenderIntent(decorSessionFrom(route));
  const { mutate: claim } = useClaimCoupon();
  const claiming = useRef(false);

  const onIntent = useCallback(
    (intent: BlockIntent) => {
      switch (intent.kind) {
        case 'login':
        case 'claimNewcomerCoupons':
          requireLogin(route)
            .then((signed) => {
              if (signed) void reload();
            })
            .catch((error: unknown) => toast.text(errorMessage(error)));
          return;
        case 'claimCoupon': {
          if (claiming.current) return;
          claiming.current = true;
          requireLogin(route)
            .then((signed) => {
              if (!signed) {
                claiming.current = false;
                return;
              }
              claim(
                { params: { id: intent.templateId } },
                {
                  onSuccess: () => toast.success('领取成功'),
                  onError: (error) => toast.text(claimFailureText(error)),
                  onSettled: () => {
                    claiming.current = false;
                    void reload();
                  },
                },
              );
            })
            .catch((error: unknown) => {
              // A sign-in that threw must not leave 领取 locked for the rest of the visit.
              claiming.current = false;
              toast.text(errorMessage(error));
            });
          return;
        }
        case 'contact':
          if (supportKind === 'phone' && phone) callPhone(phone);
          return;
        case 'officialAccount':
          return;
      }
    },
    [route, reload, claim, supportKind, phone],
  );

  // Hidden under another page or behind another tab: the blocks' timers stop until shown.
  const hidden = !usePageShown();
  const host = useMemo<BlockHost>(
    () => ({ signedIn, serverNow, overlayOpen, hidden, resolveImage: resolveDecorImage }),
    [signedIn, overlayOpen, hidden],
  );
  return { host, onIntent, renderIntent };
}
