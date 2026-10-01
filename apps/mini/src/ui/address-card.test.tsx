import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { maskPhone } from '@/lib/format';
import { taroFake } from '@/test/taro-fake/taro';
import { AddressCard, regionText } from './address-card';

const address = {
  receiverName: '张三',
  receiverPhone: '13800138000',
  provinceName: '广东省',
  cityName: '广州市',
  districtName: '天河区',
  detail: '天河路 1 号',
  isDefault: true,
};

describe('AddressCard', () => {
  it('shows the name, a masked phone and the address, and changes on a tap', () => {
    const onClick = vi.fn();
    render(<AddressCard address={address} onClick={onClick} />);
    expect(screen.getByText('138****8000')).toBeTruthy();
    expect(screen.getByText('广东省 广州市 天河区')).toBeTruthy();
    expect(screen.getByText('默认')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: /收货地址：张三/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('says in red when the address cannot be delivered to', () => {
    render(<AddressCard address={address} undeliverable="该地区暂不支持配送" />);
    expect(screen.getByText('该地区暂不支持配送').className).toContain('shop-address__warning');
  });

  it('with no address, adds one or imports the WeChat address', async () => {
    const onAdd = vi.fn();
    const onImport = vi.fn();
    taroFake.address = {
      userName: '李四',
      telNumber: '13900139000',
      provinceName: '北京市',
      cityName: '北京市',
      countyName: '朝阳区',
      detailInfo: '建国路 2 号',
      postalCode: '100000',
    };
    render(<AddressCard address={null} onAdd={onAdd} onImport={onImport} />);
    fireEvent.click(screen.getByRole('button', { name: '添加收货地址' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '导入微信地址' }));
    await vi.waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport.mock.calls[0]?.[0]).toMatchObject({
      name: '李四',
      phone: '13900139000',
      district: '朝阳区',
    });
  });

  it('says a municipality once and hides the middle of a phone number', () => {
    expect(regionText({ provinceName: '北京市', cityName: '北京市', districtName: '朝阳区' })).toBe(
      '北京市 朝阳区',
    );
    expect(maskPhone('13800138000')).toBe('138****8000');
    expect(maskPhone('010-1234')).toBe('010-1234');
  });
});
