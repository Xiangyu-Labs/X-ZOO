import type { ReactNode } from 'react';
import { Button } from '@tarojs/components';
import { agreePrivacy, PRIVACY_AGREE_BUTTON_ID } from './privacy';

/**
 * The privacy sheet's 「同意」 (C04): `open-type="agreePrivacyAuthorization"` with the id the
 * base library checks. Private open-types live in `src/platform` only (guards [platform]); the
 * kit's `PrivacySheet` renders this with its own button classes. The H5 builds have no such
 * open-type, so a plain tap agrees there, and the element says it is a button (`<taro-button-core>`
 * has no role of its own).
 */
export function PrivacyAgreeButton({
  className,
  children,
}: {
  className?: string | undefined;
  children: ReactNode;
}) {
  const weapp = process.env.TARO_ENV === 'weapp';
  return (
    <Button
      id={PRIVACY_AGREE_BUTTON_ID}
      className={className ?? ''}
      hoverClass="shop-btn--pressed"
      openType="agreePrivacyAuthorization"
      onAgreePrivacyAuthorization={agreePrivacy}
      {...(weapp ? {} : { onClick: agreePrivacy, role: 'button' })}
    >
      {children}
    </Button>
  );
}
