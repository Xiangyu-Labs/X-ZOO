import { Text, View } from '@tarojs/components';
import { Button } from '@/ui/button';
import { Icon } from '@/ui/icon';
import { Pressable } from '@/ui/pressable';
import { Sheet } from '@/ui/sheet';
import './share-sheet.scss';

export interface ShareSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 生成海报; hidden when the page offers none (or the shop turned product posters off). */
  onPoster?: (() => void) | undefined;
  title?: string | undefined;
}

/**
 * 分享 (design.md §4.4 ShareSheet): 分享给好友 is WeChat's own share (`open-type="share"`, the
 * page's `useShare` answers it); 生成海报 opens the PosterSheet. Nothing is promised for sharing
 * (C10): no reward, no unlock.
 */
export function ShareSheet({ visible, onClose, onPoster, title = '分享' }: ShareSheetProps) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <View className="shop-share" id="share-sheet">
        <Button variant="text" openType="share" className="shop-share__option" label="分享给好友">
          <View className="shop-share__icon">
            <Icon name="message" />
          </View>
          <Text className="shop-share__text">分享给好友</Text>
        </Button>
        {onPoster ? (
          <Pressable
            label="生成海报"
            className="shop-share__option"
            id="share-poster"
            onClick={() => {
              onClose();
              onPoster();
            }}
          >
            <View className="shop-share__icon">
              <Icon name="download" />
            </View>
            <Text className="shop-share__text">生成海报</Text>
          </Pressable>
        ) : null}
      </View>
    </Sheet>
  );
}
