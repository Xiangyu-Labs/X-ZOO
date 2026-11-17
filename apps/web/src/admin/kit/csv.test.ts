import { afterEach, describe, expect, it, vi } from 'vitest';

import { csvCell, downloadCsv, formatCsvTable } from './csv';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('csv helpers', () => {
  it('guards spreadsheet formula prefixes and quotes embedded double quotes', () => {
    expect(csvCell('普通商品')).toBe('"普通商品"');
    expect(csvCell('=HYPERLINK("https://x.test")')).toBe('"\'=HYPERLINK(""https://x.test"")"');
    expect(csvCell('+1')).toBe('"\'+1"');
    expect(csvCell('-1')).toBe('"\'-1"');
    expect(csvCell('@sum')).toBe('"\'@sum"');
  });

  it('formats columns and rows with CRLF line endings', () => {
    const csv = formatCsvTable(
      [
        { key: 'id', title: '编号' },
        { key: 'name', title: '名称' },
      ],
      [
        { id: '1', name: '龙井' },
        { id: '2', name: undefined },
      ],
    );
    expect(csv).toBe('"编号","名称"\r\n"1","龙井"\r\n"2",""');
  });

  it('downloads a UTF-8 CSV blob prefixed with BOM and revokes the object URL', async () => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:csv-test';
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadCsv('orders.csv', 'id,name\n1,test');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:csv-test');
    const bytes = new Uint8Array(await blobs[0]!.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3))).toBe('id,name\n1,test');
  });
});
