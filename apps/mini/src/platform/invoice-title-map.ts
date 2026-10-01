/**
 * A 发票抬头 from WeChat's own title book (`wx.chooseInvoiceTitle`, C04), already in the
 * shop's field names. Empty strings are left out: WeChat sends `''` for what the shopper never
 * filled in.
 */
export interface ChosenInvoiceTitle {
  headerType: 'company' | 'personal';
  name: string;
  dutyNumber?: string;
  registeredAddress?: string;
  registeredTel?: string;
  bankName?: string;
  bankAccount?: string;
}

/** What `wx.chooseInvoiceTitle` answers, in the fields this shop reads. */
export interface WechatInvoiceTitle {
  /** `0` 单位, `1` 个人 (a string on real devices, a number in the typings). */
  type: string | number;
  title: string;
  taxNumber?: string | undefined;
  companyAddress?: string | undefined;
  telephone?: string | undefined;
  bankName?: string | undefined;
  bankAccount?: string | undefined;
}

export function fromWechatInvoiceTitle(raw: WechatInvoiceTitle): ChosenInvoiceTitle {
  const title: ChosenInvoiceTitle = {
    headerType: String(raw.type) === '1' ? 'personal' : 'company',
    name: raw.title.trim(),
  };
  const optional = (value: string | undefined) => (value ?? '').trim() || undefined;
  const fields = {
    dutyNumber: optional(raw.taxNumber),
    registeredAddress: optional(raw.companyAddress),
    registeredTel: optional(raw.telephone),
    bankName: optional(raw.bankName),
    bankAccount: optional(raw.bankAccount),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) title[key as keyof typeof fields] = value;
  }
  return title;
}
