import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRIVACY_APIS, PRIVACY_PURPOSES } from './privacy';

const COMPLIANCE = path.resolve(import.meta.dirname, '../../../../docs/mini/wechat-compliance.md');

/** C04's table, 指引条目 → 用途: what the guide on the WeChat platform is filled in with. */
function guideRows(): Map<string, string> {
  const doc = fs.readFileSync(COMPLIANCE, 'utf8');
  const section = doc.slice(doc.indexOf('## C04'), doc.indexOf('## C05'));
  const rows = new Map<string, string>();
  for (const line of section.split('\n')) {
    // | 指引条目 | 接口 | 用途 | 调用位置 |
    const [, item = '', , purpose = ''] = line.split('|').map((cell) => cell.trim());
    if (/^(收集|使用|访问)你/.test(item)) rows.set(item, purpose);
  }
  return rows;
}

describe('PRIVACY_PURPOSES', () => {
  it('says word for word what the privacy guide says (C04)', () => {
    const rows = guideRows();
    for (const api of PRIVACY_APIS) {
      const { item, purpose } = PRIVACY_PURPOSES[api];
      expect(rows.get(item), item).toBe(purpose);
    }
  });

  it('leaves the camera to the guide: 拍照 comes with chooseMedia, no API of its own', () => {
    expect(guideRows().get('访问你的摄像头')).toBe('拍摄评价图片和售后凭证');
  });
});
