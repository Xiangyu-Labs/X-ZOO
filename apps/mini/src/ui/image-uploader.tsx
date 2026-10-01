import { useEffect, useRef, useState } from 'react';
import { Image as TaroImage, Text, View } from '@tarojs/components';
import { isApiError } from '@shop/api-client';
import { uploadImage } from '@/data/upload';
import { assetUrl } from '@/lib/asset-url';
import { cx } from '@/lib/cx';
import { platform, previewImages } from '@/platform';
import { toast } from './feedback';
import { Icon } from './icon';
import { Pressable } from './pressable';
import './image-uploader.scss';

interface Pending {
  key: number;
  localPath: string;
  state: 'uploading' | 'error';
}

export interface ImageUploaderProps {
  /** The uploaded pictures' URLs (what the form sends). */
  value: readonly string[];
  onChange: (urls: string[]) => void;
  /** 评价 9, 售后 6. The add tile disappears at the limit. */
  max: number;
  purpose: 'review' | 'refund';
  /** Told when uploads start and finish, so the form can hold 提交 until they are done. */
  onBusyChange?: ((busy: boolean) => void) | undefined;
  label?: string | undefined;
}

/**
 * Pictures for a review or a refund (design.md §4.3): pick with `chooseMedia`, upload each to
 * `POST /uploads?purpose=…`, tap to preview, × to remove. A failed one stays with 「重试」.
 */
export function ImageUploader({
  value,
  onChange,
  max,
  purpose,
  onBusyChange,
  label = '上传图片',
}: ImageUploaderProps) {
  const [pending, setPending] = useState<Pending[]>([]);
  const nextKey = useRef(0);
  // The latest value, for uploads that finish after the shopper removed another picture.
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);
  const inFlight = useRef(0);

  const busy = (delta: number) => {
    const before = inFlight.current;
    inFlight.current += delta;
    if ((before === 0) !== (inFlight.current === 0)) onBusyChange?.(inFlight.current > 0);
  };

  const upload = async (item: Pending) => {
    busy(1);
    try {
      const result = await uploadImage(item.localPath, purpose);
      setPending((list) => list.filter((entry) => entry.key !== item.key));
      const next = [...latest.current, result.url];
      latest.current = next;
      onChange(next);
    } catch (error) {
      setPending((list) =>
        list.map((entry) => (entry.key === item.key ? { ...entry, state: 'error' } : entry)),
      );
      toast.text(isApiError(error) ? error.message : '上传失败');
    } finally {
      busy(-1);
    }
  };

  const room = max - value.length - pending.length;

  const add = async () => {
    const paths = await platform.chooseImages(room).catch(() => [] as string[]);
    const items = paths.slice(0, room).map((localPath) => {
      nextKey.current += 1;
      return { key: nextKey.current, localPath, state: 'uploading' as const };
    });
    if (items.length === 0) return;
    setPending((list) => [...list, ...items]);
    // One at a time (the upload route is rate-limited per shopper), busy throughout.
    busy(1);
    try {
      for (const item of items) await upload(item);
    } finally {
      busy(-1);
    }
  };

  const retry = (item: Pending) => {
    setPending((list) =>
      list.map((entry) => (entry.key === item.key ? { ...entry, state: 'uploading' } : entry)),
    );
    void upload({ ...item, state: 'uploading' });
  };

  const urls = value.map((url) => assetUrl(url) ?? url);

  return (
    <View className="shop-uploader" ariaLabel={label}>
      {value.map((url, index) => (
        <View key={url} className="shop-uploader__tile">
          <Pressable
            label={`查看第 ${index + 1} 张图片`}
            className="shop-uploader__thumb"
            onClick={() => previewImages(urls, urls[index] ?? url)}
          >
            <TaroImage className="shop-uploader__img" src={urls[index] ?? url} mode="aspectFill" />
          </Pressable>
          <Pressable
            label={`删除第 ${index + 1} 张图片`}
            className="shop-uploader__remove"
            onClick={() => onChange(value.filter((_, at) => at !== index))}
          >
            <Icon name="close" />
          </Pressable>
        </View>
      ))}
      {pending.map((item) => (
        <View key={item.key} className="shop-uploader__tile">
          <TaroImage className="shop-uploader__img" src={item.localPath} mode="aspectFill" />
          {item.state === 'uploading' ? (
            <View className="shop-uploader__veil" ariaLabel="上传中">
              <View className="shop-spinner" />
              <Text className="shop-uploader__veil-text">上传中</Text>
            </View>
          ) : (
            <Pressable
              label="上传失败，点击重试"
              className="shop-uploader__veil shop-uploader__veil--error"
              onClick={() => retry(item)}
            >
              <Icon name="warning" />
              <Text className="shop-uploader__veil-text">重试</Text>
            </Pressable>
          )}
          {item.state === 'error' ? (
            <Pressable
              label="删除这张图片"
              className="shop-uploader__remove"
              onClick={() => setPending((list) => list.filter((entry) => entry.key !== item.key))}
            >
              <Icon name="close" />
            </Pressable>
          ) : null}
        </View>
      ))}
      {room > 0 ? (
        <Pressable
          label={`${label}，还可以添加 ${room} 张`}
          className={cx('shop-uploader__tile', 'shop-uploader__add')}
          onClick={() => add()}
        >
          <Icon name="camera" className="shop-uploader__add-icon" />
          <Text className="shop-uploader__count">
            {value.length + pending.length}/{max}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
