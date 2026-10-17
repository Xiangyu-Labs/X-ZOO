'use client';

import { CaretRightOutlined } from '@ant-design/icons';
import { Modal } from 'antd';
import { useState, type CSSProperties } from 'react';

import { CopyImage } from '../image-copy';

/** Whether a picked asset is a video the mini-program's `<Video>` can play. */
export function isPlayableVideo(asset: { mime: string }): boolean {
  return asset.mime === 'video/mp4' || asset.mime === 'video/quicktime';
}

/** The ▶ drawn over a cover, the same mark the mini-program shows. */
export function PlayMark({ size = 32 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'rgba(0, 0, 0, 0.5)',
        color: '#fff',
        display: 'grid',
        placeItems: 'center',
        fontSize: size * 0.55,
        pointerEvents: 'none',
      }}
    >
      <CaretRightOutlined />
    </span>
  );
}

export interface VideoThumbProps {
  src: string;
  /** A cover image; without one the video's first frame shows. */
  poster?: string | null | undefined;
  width: number;
  height?: number | undefined;
  /** Accessible name; also the player's title. */
  name?: string | undefined;
  /** `false` draws the thumbnail only (inside another control). Default `true`. */
  playable?: boolean | undefined;
  style?: CSSProperties | undefined;
}

/**
 * A video as a thumbnail with ▶ over it. A click opens the player. Only the
 * metadata loads until then, so a page of videos does not download them all.
 */
export function VideoThumb({
  src,
  poster,
  width,
  height = width,
  name = '视频',
  playable = true,
  style,
}: VideoThumbProps) {
  const [open, setOpen] = useState(false);
  const face = (
    <span
      style={{
        position: 'relative',
        display: 'block',
        width,
        height,
        background: '#000',
        overflow: 'hidden',
        borderRadius: 6,
        ...style,
      }}
    >
      {poster ? (
        <CopyImage
          src={poster}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <video
          src={src}
          muted
          preload="metadata"
          aria-hidden
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      )}
      <PlayMark size={Math.max(18, Math.min(40, Math.round(Math.min(width, height) / 2.5)))} />
    </span>
  );
  if (!playable) return face;
  return (
    <>
      <button
        type="button"
        aria-label={`播放${name}`}
        data-testid="video-thumb"
        onClick={() => setOpen(true)}
        style={{ padding: 0, border: 0, background: 'none', cursor: 'pointer', display: 'block' }}
      >
        {face}
      </button>
      <VideoPlayerModal
        src={src}
        poster={poster}
        title={name}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/**
 * The player: native controls (progress bar, pause and continue, full screen).
 * Unmounted on close, so the sound stops with it.
 */
export function VideoPlayerModal({
  src,
  poster,
  title = '播放视频',
  open,
  onClose,
}: {
  src: string;
  poster?: string | null | undefined;
  title?: string | undefined;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      footer={null}
      width={720}
      onCancel={onClose}
      destroyOnHidden
      centered
    >
      <video
        src={src}
        {...(poster ? { poster } : {})}
        controls
        autoPlay
        playsInline
        data-testid="video-player"
        style={{ width: '100%', maxHeight: '70vh', background: '#000', display: 'block' }}
      />
    </Modal>
  );
}
