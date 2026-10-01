import { describe, expect, it } from 'vitest';
import {
  describeItems,
  isShunfeng,
  maskPhone,
  rfc3339Shanghai,
  uploadShippingBody,
  type MiniUploadShipping,
} from './wechat.shipping';

describe('describeItems', () => {
  it('joins name×quantity with ；', () => {
    expect(
      describeItems([
        { name: ' 按摩棒 ', quantity: 2 },
        { name: '润滑液', quantity: 1 },
      ]),
    ).toBe('按摩棒×2；润滑液×1');
  });

  it('cuts at 120 characters by code point, ending in …', () => {
    const text = describeItems([{ name: '😀'.repeat(200), quantity: 1 }]);
    expect([...text]).toHaveLength(120);
    expect(text.endsWith('…')).toBe(true);
    expect(text.includes('�')).toBe(false);
  });

  it('never sends an empty description', () => {
    expect(describeItems([])).toBe('商品');
  });
});

describe('maskPhone', () => {
  it('keeps the first three and last four digits of a mobile number', () => {
    expect(maskPhone('13800138000')).toBe('138****8000');
  });
  it('keeps only the last four of anything shorter', () => {
    expect(maskPhone('0101234')).toBe('****1234');
    expect(maskPhone('12')).toBe('****12');
  });
});

describe('rfc3339Shanghai', () => {
  it('writes Beijing time with the offset', () => {
    expect(rfc3339Shanghai(new Date('2026-06-01T00:00:00.000Z'))).toBe(
      '2026-06-01T08:00:00.000+08:00',
    );
  });
});

describe('isShunfeng', () => {
  it('knows SF by code or by name', () => {
    expect(isShunfeng({ name: '顺丰速运', wechatDeliveryId: null })).toBe(true);
    expect(isShunfeng({ name: 'x', wechatDeliveryId: 'SF' })).toBe(true);
    expect(isShunfeng({ name: '圆通', wechatDeliveryId: 'YTO' })).toBe(false);
  });
});

describe('uploadShippingBody', () => {
  const base: MiniUploadShipping = {
    key: { kind: 'transaction', transactionId: '4200' },
    logisticsType: 1,
    deliveryMode: 1,
    isAllDelivered: true,
    packages: [
      { trackingNo: 'SF1', expressCompany: 'SF', itemDesc: 'a×1', receiverContact: '138****8000' },
    ],
    uploadTime: new Date('2026-06-01T00:00:00.000Z'),
    payerOpenid: 'o-1',
  };

  it('is exactly WeChat’s body for a unified upload, without is_all_delivered', () => {
    expect(uploadShippingBody(base)).toEqual({
      order_key: { order_number_type: 2, transaction_id: '4200' },
      logistics_type: 1,
      delivery_mode: 1,
      shipping_list: [
        {
          tracking_no: 'SF1',
          express_company: 'SF',
          item_desc: 'a×1',
          contact: { receiver_contact: '138****8000' },
        },
      ],
      upload_time: '2026-06-01T08:00:00.000+08:00',
      payer: { openid: 'o-1' },
    });
  });

  it('carries is_all_delivered on a split part, and the merchant key when asked', () => {
    const body = uploadShippingBody({
      ...base,
      key: { kind: 'merchant', mchId: '1900', outTradeNo: 'P1' },
      deliveryMode: 2,
      isAllDelivered: false,
    });
    expect(body['is_all_delivered']).toBe(false);
    expect(body['order_key']).toEqual({ order_number_type: 1, mchid: '1900', out_trade_no: 'P1' });
  });

  it('sends only item_desc for a virtual delivery', () => {
    const body = uploadShippingBody({
      ...base,
      logisticsType: 3,
      packages: [{ itemDesc: '卡密×1' }],
    });
    expect(body['shipping_list']).toEqual([{ item_desc: '卡密×1' }]);
  });
});
