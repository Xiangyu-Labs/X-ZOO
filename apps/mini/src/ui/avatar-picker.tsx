import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import { isApiError } from '@shop/api-client';
import { useRouteMutation } from '@shop/api-client/react';
import { uploadImage } from '@/data/upload';
import { platform, type AvatarResult } from '@/platform';
import { cx } from '@/lib/cx';
import { toast } from './feedback';
import { Icon } from './icon';
import { Image } from './image';
import './avatar-picker.scss';

export interface AvatarPickerProps {
  /** The current avatar URL, or `null` for the default. */
  src: string | null;
  /** The profile was saved with the new avatar. */
  onChange?: ((avatarUrl: string) => void) | undefined;
  size?: 'md' | 'lg' | undefined;
}

/**
 * 头像 (design.md §4.3): WeChat's avatar picker (`open-type="chooseAvatar"`, through
 * `@/platform`) → `POST /uploads?purpose=avatar` → `PUT /profile`. The new picture shows at once
 * and the old one comes back if saving fails.
 */
export function AvatarPicker({ src, onChange, size = 'lg' }: AvatarPickerProps) {
  const { AvatarButton } = platform;
  const [preview, setPreview] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'uploading' | 'error'>('idle');
  const save = useRouteMutation('user.updateProfile', { invalidate: ['user.getProfile'] });

  const onResult = async (result: AvatarResult) => {
    if (!result.ok) {
      if (result.message) toast.text(result.message);
      return;
    }
    setPreview(result.tempPath);
    setState('uploading');
    try {
      const uploaded = await uploadImage(result.tempPath, 'avatar');
      await save.mutateAsync({ body: { avatarUrl: uploaded.url } });
      setState('idle');
      setPreview(null);
      onChange?.(uploaded.url);
      toast.success('头像已更新');
    } catch (error) {
      setState('error');
      setPreview(null);
      toast.text(isApiError(error) ? error.message : '头像上传失败，请重试');
    }
  };

  return (
    <AvatarButton
      className={cx('shop-avatar', `shop-avatar--${size}`)}
      label={state === 'uploading' ? '头像上传中' : '更换头像'}
      onResult={(result) => onResult(result)}
    >
      <View className="shop-avatar__frame">
        {(preview ?? src) ? (
          <Image src={preview ?? src} radius="none" lazy={false} placeholder="user" />
        ) : (
          <View className="shop-avatar__default">
            <Icon name="user" />
          </View>
        )}
        {state === 'uploading' ? (
          <View className="shop-avatar__veil">
            <View className="shop-spinner" />
          </View>
        ) : null}
      </View>
      <View className="shop-avatar__edit" ariaHidden>
        <Icon name="camera" />
      </View>
      {state === 'error' ? <Text className="shop-avatar__error">上传失败</Text> : null}
    </AvatarButton>
  );
}
