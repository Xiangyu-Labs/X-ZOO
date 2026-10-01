import { Field, type FieldProps } from '@/ui/field';

/**
 * WeChat's 昵称 input (`<input type="nickname">`, C05): the keyboard offers the WeChat nickname
 * and WeChat runs its own content check on it. One component for every build; H5 draws it as
 * a plain text input. Pages render this rather than choosing the private input type themselves.
 */
export function NicknameField(props: Omit<FieldProps, 'type'>) {
  return <Field {...props} type="nickname" />;
}
