import { describe, expect, it } from 'vitest';
import { invoiceTitleFixture } from '@/test/invoice-fixture';
import {
  EMPTY_INVOICE_DRAFT,
  checkInvoiceDraft,
  draftFromChosen,
  invoiceRequestFromTitle,
  invoiceTitleBody,
} from './invoice';

describe('发票抬头 rules', () => {
  it('asks a company for its 税号, and a 专票 for the bank details', () => {
    expect(checkInvoiceDraft({ ...EMPTY_INVOICE_DRAFT, name: '某公司' })).toEqual({
      dutyNumber: '企业抬头需要填写税号',
    });
    expect(
      Object.keys(
        checkInvoiceDraft({
          ...EMPTY_INVOICE_DRAFT,
          name: '某公司',
          dutyNumber: '9144',
          invoiceType: 'special',
        }),
      ),
    ).toEqual(['registeredAddress', 'registeredTel', 'bankName', 'bankAccount']);
  });

  it('asks a person for a name only, and a personal title is always 普票', () => {
    const personal = { ...EMPTY_INVOICE_DRAFT, headerType: 'personal' as const };
    expect(checkInvoiceDraft(personal)).toEqual({ name: '请填写抬头名称' });
    expect(
      invoiceTitleBody({ ...personal, name: ' 李四 ', invoiceType: 'special', dutyNumber: 'x' }),
    ).toEqual({ headerType: 'personal', invoiceType: 'plain', name: '李四', isDefault: false });
  });

  it('checks the optional phone and e-mail only when given', () => {
    const base = { ...EMPTY_INVOICE_DRAFT, headerType: 'personal' as const, name: '李四' };
    expect(checkInvoiceDraft({ ...base, drawerPhone: '123', email: 'x@' })).toEqual({
      drawerPhone: '请填写正确的手机号',
      email: '请填写正确的邮箱',
    });
  });

  it('takes a WeChat title over the form, keeping the rest', () => {
    const draft = { ...EMPTY_INVOICE_DRAFT, email: 'a@b.cn', dutyNumber: 'old' };
    expect(draftFromChosen(draft, { headerType: 'personal', name: '王五' })).toMatchObject({
      headerType: 'personal',
      name: '王五',
      dutyNumber: '',
      email: 'a@b.cn',
    });
  });

  it('copies a saved title into a request, leaving empty fields out', () => {
    expect(invoiceRequestFromTitle(invoiceTitleFixture)).toEqual({
      headerType: 'company',
      invoiceType: 'plain',
      name: '深圳某某科技有限公司',
      dutyNumber: '91440300MA5XXXXX1B',
      email: 'finance@example.com',
    });
  });
});
