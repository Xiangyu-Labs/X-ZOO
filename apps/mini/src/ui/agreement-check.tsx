import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { navigate } from '@/platform';
import { Checkbox } from './choice';
import { Pressable } from './pressable';
import './agreement-check.scss';

export interface AgreementCheckProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Bump to shake it (the shopper tapped 登录 without ticking it). */
  shake?: number | undefined;
}

/**
 * 「我已阅读并同意《用户协议》《隐私政策》」 for login (C05). Never ticked by default: the shopper
 * ticks it. A login tapped without it shakes this and says why (the caller toasts).
 */
export function AgreementCheck({ checked, onChange, shake = 0 }: AgreementCheckProps) {
  // Two identical animations, alternated, so every bump restarts it.
  const shakeClass = shake === 0 ? null : `shop-agreement--shake-${shake % 2}`;
  return (
    <View className={cx('shop-agreement', shakeClass)}>
      <Checkbox checked={checked} onChange={onChange} label="我已阅读并同意用户协议和隐私政策">
        <Text className="shop-agreement__text">我已阅读并同意</Text>
      </Checkbox>
      <Pressable
        role="link"
        label="用户协议"
        pressedTint={false}
        className="shop-agreement__link"
        onClick={() => navigate({ route: 'agreement', params: { key: 'user' } })}
      >
        《用户协议》
      </Pressable>
      <Pressable
        role="link"
        label="隐私政策"
        pressedTint={false}
        className="shop-agreement__link"
        onClick={() => navigate({ route: 'agreement', params: { key: 'privacy' } })}
      >
        《隐私政策》
      </Pressable>
    </View>
  );
}
