import { describe, expect, it } from 'vitest';
import { taroFake } from '@/test/taro-fake/taro';
import { chooseInvoiceTitle } from './invoice-title';
import { fromWechatInvoiceTitle } from './invoice-title-map';

describe('从微信导入发票抬头', () => {
  it('maps a company title to the shop’s fields, leaving out what WeChat sent empty', () => {
    expect(
      fromWechatInvoiceTitle({
        type: '0',
        title: ' 广州某某科技有限公司 ',
        taxNumber: '91440101MA5XXXXX0A',
        companyAddress: '',
        telephone: '020-12345678',
        bankName: '',
        bankAccount: '',
      }),
    ).toEqual({
      headerType: 'company',
      name: '广州某某科技有限公司',
      dutyNumber: '91440101MA5XXXXX0A',
      registeredTel: '020-12345678',
    });
  });

  it('reads type 1 (a number in the typings, a string on devices) as personal', () => {
    expect(fromWechatInvoiceTitle({ type: 1, title: '张三' })).toEqual({
      headerType: 'personal',
      name: '张三',
    });
  });

  it('answers null when the shopper cancels', async () => {
    taroFake.invoiceTitle = null;
    await expect(chooseInvoiceTitle()).resolves.toBeNull();
    expect(taroFake.calls.map((call) => call.api)).toEqual(['chooseInvoiceTitle']);
  });

  it('answers the chosen title', async () => {
    taroFake.invoiceTitle = { type: '1', title: '李四', taxNumber: '' };
    await expect(chooseInvoiceTitle()).resolves.toEqual({ headerType: 'personal', name: '李四' });
  });
});
