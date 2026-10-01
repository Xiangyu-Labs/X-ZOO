import Taro from '@tarojs/taro';
import { showToast } from './feedback';
import { isPrivacyRefusal } from './privacy';

/**
 * Copies text (order numbers, tracking numbers, return addresses, links; C04 declares
 * `setClipboardData`). WeChat shows its own 「内容已复制」; a refusal (privacy) says so.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await Taro.setClipboardData({ data: text });
    return true;
  } catch (error) {
    showToast(
      isPrivacyRefusal(error)
        ? '未同意隐私保护指引，无法复制，请长按手动复制'
        : '复制失败，请长按手动复制',
    );
    return false;
  }
}
