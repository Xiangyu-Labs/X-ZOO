import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ADMIN_LOGIN_AUDIT_ROUTE } from '../auth/index';
import { AUDIT_TARGET_NOUNS, operationName, routeIdsNamed, targetText } from './audit-labels';
import './site.config';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Every `.ts`/`.tsx` file under `dir`, tests and node_modules left out. */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === 'node_modules' || entry.name === '.next' ? [] : sources(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const allSources = (): string[] => [
  ...sources(path.join(repoRoot, 'apps/web/app')),
  ...sources(path.join(repoRoot, 'apps/web/src')),
  ...sources(path.join(repoRoot, 'packages/core/src')),
];

describe('操作日志 in words', () => {
  it('names every target prefix a handler writes with ctx.audit', () => {
    const prefixes = new Set<string>();
    for (const file of allSources()) {
      for (const match of fs
        .readFileSync(file, 'utf8')
        .matchAll(/\.audit\(\s*[`'"]([a-z][a-z-]*):/g)) {
        prefixes.add(match[1]!);
      }
    }
    expect(prefixes.size).toBeGreaterThan(30);
    expect([...prefixes].filter((prefix) => AUDIT_TARGET_NOUNS[prefix] === undefined)).toEqual([]);
  });

  it('names the operation and the target of every row written straight with insertAudit', () => {
    const routeIds = new Set<string>([ADMIN_LOGIN_AUDIT_ROUTE]);
    const prefixes = new Set<string>();
    const writers = allSources().filter(
      (file) =>
        /\binsertAudit\(/.test(fs.readFileSync(file, 'utf8')) && !file.endsWith('audit.repo.ts'),
    );
    expect(writers.length).toBeGreaterThanOrEqual(3);
    for (const file of writers) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/routeId: '([\w.]+)'/g)) routeIds.add(match[1]!);
      for (const match of text.matchAll(/target: [^\n]*?[`'"]([a-z][a-z-]*):/g))
        prefixes.add(match[1]!);
    }
    expect(routeIds.has('oauth.authorizeDecision')).toBe(true);
    expect([...routeIds].filter((id) => operationName(id) === '已下线的功能')).toEqual([]);
    expect([...prefixes].filter((prefix) => AUDIT_TARGET_NOUNS[prefix] === undefined)).toEqual([]);
  });

  it('names the operation by its route, and a removed route as removed', () => {
    expect(operationName('coupon.adminSetStatus')).toBe('启用/停用优惠券');
    expect(operationName('coupon.adminGone')).toBe('已下线的功能');
    expect(operationName('oauth.authorizeDecision')).toBe('外部应用授权');
    expect(routeIdsNamed('外部应用授权')).toEqual(['oauth.authorizeDecision']);
  });

  it('finds the routes whose name holds the keyword', () => {
    expect(routeIdsNamed('启用/停用优惠券')).toEqual(['coupon.adminSetStatus']);
    expect(routeIdsNamed('  ')).toEqual([]);
  });

  it('reads each shape of target in words', () => {
    expect(targetText(null)).toBeNull();
    expect(targetText(null, '/admin-api/coupons/987654')).toBe('#987654');
    expect(targetText(null, '/admin-api/config/site')).toBeNull();
    expect(targetText('product:12')).toBe('商品 #12');
    expect(targetText('orders:3,4')).toBe('订单 #3、#4');
    expect(targetText('config:site')).toBe('系统设置：站点设置');
    expect(targetText('decor:designation:home')).toBe('页面装修：当前首页');
    expect(targetText('decor:document:5:revision:3')).toBe('页面装修：页面 #5 第 3 版');
    expect(targetText('cms:article-category:7')).toBe('文章分类 #7');
    expect(targetText('cms:article:8')).toBe('文章 #8');
    expect(targetText('order-export:120')).toBe('订单导出（120 条）');
    expect(targetText('reviews:6')).toBe('6 条评价');
    expect(targetText('user-labels:add:9')).toBe('用户标签（9 个用户）');
    expect(targetText('wechat-media:sync')).toBe('公众号素材同步');
    expect(targetText('scan-token:abcd1234')).toBe('扫码上传');
    expect(targetText('admin:self')).toBe('自己的账号');
    expect(targetText('notification-template:order_paid:test:sms:user:42')).toMatch(
      /^通知模板：.+ 试发（短信）给用户 #42$/,
    );
    expect(targetText('notification-template:order_paid:wechatMini')).toMatch(
      /^通知模板：.+（小程序订阅消息）$/,
    );
    expect(
      targetText(
        'oauth-client:abc',
        '/oauth/authorize/decision',
        JSON.stringify({ decision: 'allow', clientName: '记账助手' }),
      ),
    ).toBe('外部应用：记账助手（允许）');
    expect(targetText('oauth-client:abc', '', JSON.stringify({ decision: 'deny' }))).toBe(
      '外部应用：未命名应用（拒绝）',
    );
    // A prefix nobody named shows nothing rather than code; 技术信息 still has it.
    expect(targetText('mystery:1')).toBeNull();
  });
});
