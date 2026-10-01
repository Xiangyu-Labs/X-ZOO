import { describe, expect, it } from 'vitest';
import { invoiceRequestBody } from '../order/order.fulfil.schemas';
import {
  invoiceRequestFromTitle,
  invoiceTitleExample,
  invoiceTitleForm,
  invoiceTitleSpecialExample,
  type InvoiceTitle,
} from './schemas';

/**
 * The 发票抬头 book and the 申请开票 request share one header schema, so a
 * saved title always prefills a body the invoice route accepts (USER-017).
 */

const personal: InvoiceTitle = {
  ...invoiceTitleExample,
  headerType: 'personal',
  name: '张三',
  dutyNumber: null,
  drawerPhone: null,
  email: null,
};

describe('USER-017 — a saved title prefills the invoice request', () => {
  it.each([
    ['a personal title', personal],
    ['a company 普票', invoiceTitleExample],
    ['a company 专票', invoiceTitleSpecialExample],
  ])('copies %s into a body the request schema accepts', (_label, title) => {
    const body = invoiceRequestFromTitle(title);
    expect(invoiceRequestBody.safeParse(body).success).toBe(true);
  });

  it('omits what the title does not have, instead of sending null', () => {
    expect(invoiceRequestFromTitle(personal)).toEqual({
      headerType: 'personal',
      invoiceType: 'plain',
      name: '张三',
    });
  });

  it('never carries the title id, the default flag or the timestamps into the request', () => {
    const body = invoiceRequestFromTitle(invoiceTitleSpecialExample);
    expect(Object.keys(body).sort()).toEqual(
      [
        'bankAccount',
        'bankName',
        'drawerPhone',
        'dutyNumber',
        'email',
        'headerType',
        'invoiceType',
        'name',
        'registeredAddress',
        'registeredTel',
      ].sort(),
    );
  });
});

describe('invoice title form', () => {
  it('holds the request rules: a company needs a 税号', () => {
    const result = invoiceTitleForm.safeParse({ headerType: 'company', name: '某某公司' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['dutyNumber']);
  });

  it('holds the request rules: a 专票 needs the bank and registration fields', () => {
    const result = invoiceTitleForm.safeParse({
      headerType: 'company',
      invoiceType: 'special',
      name: '某某公司',
      dutyNumber: '91330100MA2XXXXX0A',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['registeredAddress']);
  });

  it('defaults to a 普票 that does not ask to be the default', () => {
    expect(invoiceTitleForm.parse({ headerType: 'personal', name: '张三' })).toEqual({
      headerType: 'personal',
      invoiceType: 'plain',
      name: '张三',
      isDefault: false,
    });
  });
});
