import { Text, View } from '@tarojs/components';
import {
  disagreePrivacy,
  openPrivacyContract,
  PrivacyAgreeButton,
  usePrivacyPrompt,
} from '@/platform';
import { Button, buttonClassName } from './button';
import { Pressable } from './pressable';
import { Sheet } from './sheet';
import './privacy-sheet.scss';

/**
 * The global privacy sheet (C04), mounted by every `PageShell`. WeChat raises it when a private
 * API is used before the shopper agreed; 「同意」 is `open-type="agreePrivacyAuthorization"`
 * with `id="privacy-agree"`, as the base library checks. 「拒绝」 fails only the feature that
 * asked; browsing continues.
 */
export function PrivacySheet() {
  const { open, purpose } = usePrivacyPrompt();
  return (
    <Sheet
      visible={open}
      onClose={disagreePrivacy}
      title="用户隐私保护提示"
      dismissible={false}
      closable={false}
      footer={
        <View className="shop-privacy__actions">
          <Button variant="outline" size="lg" onClick={disagreePrivacy}>
            拒绝
          </Button>
          <PrivacyAgreeButton className={buttonClassName({ variant: 'primary', size: 'lg' })}>
            同意
          </PrivacyAgreeButton>
        </View>
      }
    >
      {/* The link is a Pressable (role and name for a screen reader, like AgreementCheck's), so
          the lead is a View: WeChat's <text> may hold only <text>. */}
      <View className="shop-privacy__lead">
        <Text>{purpose ? `为了${purpose}，` : ''}我们需要你同意</Text>
        <Pressable
          role="link"
          label="用户隐私保护指引"
          pressedTint={false}
          className="shop-privacy__link"
          onClick={openPrivacyContract}
        >
          <Text>《用户隐私保护指引》</Text>
        </Pressable>
        <Text>。请阅读后选择是否同意。</Text>
      </View>
      <Text className="shop-privacy__note">拒绝后仅这项功能不可用，你仍可继续浏览和购物。</Text>
    </Sheet>
  );
}
