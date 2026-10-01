import { describe, expect, it } from 'vitest';
import { clientIp } from './request-meta';

function request(headers: Record<string, string>): Request {
  return new Request('http://shop.test/api/v1/visits', { headers });
}

describe('clientIp — the edge is the trust boundary', () => {
  it('reads the address the edge set', () => {
    expect(clientIp(request({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientIp(request({ 'x-real-ip': ' 2001:db8::1 ' }))).toBe('2001:db8::1');
  });

  it('ignores an X-Forwarded-For the client wrote, with or without X-Real-IP', () => {
    expect(
      clientIp(request({ 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' })),
    ).toBe('203.0.113.9');
    expect(clientIp(request({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }))).toBeNull();
  });

  it('refuses anything that is not an address', () => {
    expect(clientIp(request({}))).toBeNull();
    expect(clientIp(request({ 'x-real-ip': '' }))).toBeNull();
    expect(clientIp(request({ 'x-real-ip': '203.0.113.9, 10.0.0.1' }))).toBeNull();
    expect(clientIp(request({ 'x-real-ip': "'; drop table users; --" }))).toBeNull();
  });
});
