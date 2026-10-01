import Taro from '@tarojs/taro';
import { fromWechatInvoiceTitle, type ChosenInvoiceTitle } from './invoice-title-map';

/**
 * 从微信导入 on 发票抬头 (C04, declared in `PRIVACY_APIS`). `null` when the shopper cancelled
 * or refused: the form stays as it was, for typing in.
 *
 * Its own module (not `MiniPlatform`) so the H5 builds can answer it from `invoice-title.h5.ts`.
 */
export async function chooseInvoiceTitle(): Promise<ChosenInvoiceTitle | null> {
  try {
    return fromWechatInvoiceTitle(await Taro.chooseInvoiceTitle());
  } catch {
    return null;
  }
}
