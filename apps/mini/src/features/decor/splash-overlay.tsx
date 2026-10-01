import { useEffect, useState } from 'react';
import { Text, View } from '@tarojs/components';
import { useAppConfig } from '@/app-config';
import { assetUrl } from '@/lib/asset-url';
import { serverNow } from '@/lib/server-clock';
import { openLinkTarget, storage } from '@/platform';
import { Image } from '@/ui/image';
import { useOverlayStore } from '@/ui/overlay-store';
import { Pressable } from '@/ui/pressable';
import { SPLASH_DAY_KEY, shopDay, splashDue } from './splash';
import './splash-overlay.scss';

/** A phone screen, portrait: what operators design the picture for (750 × 1334). */
const SCREEN_RATIO = 750 / 1334;

/**
 * 开屏浮层 on 首页 (pages.md §2.1; replaces the old 启动引导页): the shop's picture over the
 * page, a 跳过 button counting down, closes itself when the count ends. Shown at most once a
 * shop day, whatever the number of launches.
 */
export function SplashOverlay() {
  const config = useAppConfig();
  const ad = config?.splashAd;
  const [today] = useState(() => shopDay(serverNow()));
  const [phase, setPhase] = useState<'waiting' | 'open' | 'closed'>('waiting');
  const [left, setLeft] = useState(0);

  // The config may arrive after the first render (no cached copy yet): decided while rendering,
  // once, the way React derives state from props.
  if (phase === 'waiting' && ad && splashDue(ad, storage.get(SPLASH_DAY_KEY), today)) {
    setPhase('open');
    setLeft(Math.max(1, ad.seconds));
  }

  useEffect(() => {
    if (phase === 'open') storage.set(SPLASH_DAY_KEY, today);
  }, [phase, today]);

  useEffect(() => {
    if (phase !== 'open') return;
    const timer = setTimeout(() => {
      if (left <= 1) setPhase('closed');
      else setLeft(left - 1);
    }, 1000);
    return () => clearTimeout(timer);
  }, [phase, left]);

  const open = phase === 'open' && ad !== undefined;
  // It covers the page like a sheet: the page behind stops scrolling, and a 视频 block shows its
  // poster (a native player would draw above the picture).
  const push = useOverlayStore((state) => state.push);
  const pop = useOverlayStore((state) => state.pop);
  useEffect(() => {
    if (!open) return;
    push();
    return pop;
  }, [open, push, pop]);

  if (!open || !ad) return null;
  const link = ad.link;
  const close = () => setPhase('closed');
  return (
    <View className="splash" id="splash-overlay">
      {link ? (
        <Pressable
          label="查看活动"
          role="link"
          pressedTint={false}
          className="splash__picture"
          onClick={() => {
            close();
            return openLinkTarget(link);
          }}
        >
          <Image src={assetUrl(ad.imageUrl)} label="开屏图片" ratio={SCREEN_RATIO} lazy={false} />
        </Pressable>
      ) : (
        <View className="splash__picture">
          <Image src={assetUrl(ad.imageUrl)} label="开屏图片" ratio={SCREEN_RATIO} lazy={false} />
        </View>
      )}
      <Pressable label={`跳过，${left} 秒`} className="splash__skip" onClick={close}>
        <Text>跳过 {left}</Text>
      </Pressable>
    </View>
  );
}
