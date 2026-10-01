/**
 * The server's rules: 6 to 64 characters (`changePasswordBody` / `resetPasswordBody`), and at
 * least two of letters, digits and symbols (`checkPasswordShape`).
 */
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 64;

export interface PasswordPair {
  password: string;
  confirm: string;
}

/** Per-field messages for a new password and its repeat; `{}` when both are fine. */
export function checkNewPassword({ password, confirm }: PasswordPair): {
  password?: string;
  confirm?: string;
} {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return { password: `密码为 ${PASSWORD_MIN}–${PASSWORD_MAX} 位` };
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((re) => re.test(password));
  if (classes.length < 2) return { password: '密码需包含字母、数字或符号中的至少两类' };
  if (confirm !== password) return { confirm: '两次输入的密码不一致' };
  return {};
}
