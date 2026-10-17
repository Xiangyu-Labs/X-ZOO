import { useState } from 'react';
import { Video as NativeVideo, View } from '@tarojs/components';
import { assetUrl } from '@/lib/asset-url';
import { cx } from '@/lib/cx';
import { Image } from './image';
import { useOverlayStore } from './overlay-store';
import { Pressable } from './pressable';
import './video-player.scss';

export interface VideoPlayerProps {
  /** The video as stored (`/uploads/…` or absolute); resolved here. */
  src: string;
  /** The cover until it plays, as stored. Without one the frame is black with ▶. */
  poster?: string | null | undefined;
  /** Read out for the play control: 播放{label}. */
  label?: string | undefined;
  /** `fill` takes the parent's box (a swiper slide); `wide` is its own 16:9 frame. */
  layout?: 'fill' | 'wide' | undefined;
  /** `false` stops it and shows the cover again (the slide was swiped away). */
  active?: boolean | undefined;
  className?: string | undefined;
}

/**
 * A video as its cover with ▶. A tap mounts the native player, which plays at once with its
 * progress bar, pause and full screen. Nothing loads until then.
 *
 * A native `video` draws above every view, so while a sheet or dialog is open it is
 * unmounted (which stops it) and the cover shows (design.md §2.6). Swiping it away does the
 * same, through `active`.
 */
export function VideoPlayer({
  src,
  poster,
  label = '视频',
  layout = 'wide',
  active = true,
  className,
}: VideoPlayerProps) {
  const [playing, setPlaying] = useState(false);
  const covered = useOverlayStore((state) => state.open > 0);
  if (playing && !active) setPlaying(false);
  const url = assetUrl(src);
  const cover = assetUrl(poster ?? null);
  const live = playing && active && !covered && url !== null;
  return (
    <View className={cx('shop-video', `shop-video--${layout}`, className)}>
      {live ? (
        <NativeVideo
          className="shop-video__player"
          src={url}
          {...(cover ? { poster: cover } : {})}
          autoplay
          controls
          showProgress
          showCenterPlayBtn
          objectFit="contain"
          onEnded={() => setPlaying(false)}
        />
      ) : (
        <Pressable
          label={`播放${label}`}
          pressedTint={false}
          className="shop-video__still"
          onClick={() => setPlaying(true)}
        >
          {poster ? (
            <View className="shop-video__poster">
              <Image src={poster} ratio={layout === 'wide' ? 16 / 9 : 1} lazy={false} />
            </View>
          ) : null}
          <View className="shop-video__play">
            <View className="shop-video__triangle" />
          </View>
        </Pressable>
      )}
    </View>
  );
}
