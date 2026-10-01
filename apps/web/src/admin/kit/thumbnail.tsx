'use client';

import { EyeOutlined } from '@ant-design/icons';
import { Image, Typography } from 'antd';
import { useState, type CSSProperties } from 'react';

export interface ThumbnailProps {
  src: string;
  /** Square edge in px. */
  size?: number | undefined;
  radius?: number | undefined;
}

function frame(size: number, radius: number): CSSProperties {
  return {
    width: size,
    height: size,
    objectFit: 'cover',
    borderRadius: radius,
    display: 'block',
    background: 'var(--ant-color-fill-quaternary)',
  };
}

/**
 * A square thumbnail that opens full size on click.
 *
 * Every picture in the admin is small — a product in a table row, a buyer's
 * photo on a review or a refund — and the operator needs to see it properly
 * before deciding anything. A plain `<img>` gave them no way to.
 */
export function Thumbnail({ src, size = 44, radius = 4 }: ThumbnailProps) {
  return (
    <Image
      src={src}
      alt=""
      width={size}
      height={size}
      style={frame(size, radius)}
      preview={{ cover: <EyeOutlined /> }}
    />
  );
}

export interface ThumbnailGroupProps {
  urls: readonly string[];
  /** How many to show inline; the rest are behind 「+N」, in the same viewer. */
  max?: number | undefined;
  size?: number | undefined;
  radius?: number | undefined;
}

/**
 * Several thumbnails that page through one viewer. 「+N」 opens the viewer on
 * the first picture not shown, so none of a buyer's photos is out of reach.
 */
export function ThumbnailGroup({ urls, max = 4, size = 32, radius = 3 }: ThumbnailGroupProps) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(0);
  if (urls.length === 0) return null;

  const shown = urls.slice(0, max);
  const hidden = urls.length - shown.length;

  return (
    <Image.PreviewGroup
      items={[...urls]}
      preview={{
        open,
        current,
        onOpenChange: (next, info) => {
          setOpen(next);
          setCurrent(info.current);
        },
        onChange: (next) => setCurrent(next),
      }}
    >
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
        {shown.map((url, index) => (
          <Image
            key={`${url}-${index}`}
            src={url}
            alt=""
            width={size}
            height={size}
            style={frame(size, radius)}
            preview={{ cover: <EyeOutlined /> }}
          />
        ))}
        {hidden > 0 ? (
          <Typography.Link
            onClick={() => {
              setCurrent(shown.length);
              setOpen(true);
            }}
          >
            +{hidden}
          </Typography.Link>
        ) : null}
      </span>
    </Image.PreviewGroup>
  );
}
