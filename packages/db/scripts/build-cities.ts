/**
 * Rebuilds `seed-data/cities.json` from the Ministry of Civil Affairs list
 * 《中华人民共和国县以上行政区划代码》, saved as the HTML page the ministry
 * publishes (https://www.mca.gov.cn/mzsj/xzqh/2023/202301xzqh.html).
 *
 *   pnpm --filter @shop/db exec tsx scripts/build-cities.ts <list.html>
 *
 * The list has three kinds of six-digit code: a province (`xx0000`), a
 * prefecture (`xxxx00`) and a county. It is turned into the three levels the
 * shop uses:
 *
 *  - a municipality's districts hang under one city row per first-four digits
 *    (`1101` → 北京市, `5002` → 县), which the list does not have;
 *  - a province's directly administered counties (`xx90xx`) hang under a
 *    `省直辖县级行政区划` city row (`xx9000`);
 *  - 台湾省, 香港 and 澳门 have no lower divisions in the list, so each gets
 *    one city row of its own name, with no code;
 *  - a prefecture with no counties (东莞市, 中山市, 嘉峪关市, 儋州市) has no
 *    district rows, which the address form already handles.
 *
 * Ids are stable: a row whose code (or, for a code-less row, whose parent and
 * name) is already in the current file keeps its id, so addresses, freight
 * rules and shipments that store one keep pointing at the same division.
 * Anything new takes the next id after the current maximum.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Row = {
  id: number;
  parentId: number | null;
  level: number;
  code: string | null;
  name: string;
  mergerName: string;
  lng: null;
  lat: null;
  isVisible: true;
};

type Existing = { id: number; parentId: number | null; code: string | null; name: string };

const output = resolve(dirname(fileURLToPath(import.meta.url)), '../seed-data/cities.json');

const NO_LOWER_DIVISIONS = new Set(['71', '81', '82']);
/** Earlier files named a few divisions differently; they keep their id. */
const FORMER_NAMES: Record<string, string> = { 台湾省: '台湾' };
const MUNICIPALITIES = new Set(['11', '12', '31', '50']);

function decode(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .trim();
}

/** `[code, name]` for every row of the list's table. */
function parseList(html: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const tr of html.split(/<tr[\s>]/i).slice(1)) {
    const cells = (tr.split(/<\/tr>/i)[0] ?? '')
      .split(/<td[^>]*>/i)
      .slice(1)
      .map((cell) => decode(cell.split(/<\/td>/i)[0] ?? ''))
      .filter((cell) => cell !== '');
    const [code, name] = cells;
    if (code !== undefined && name !== undefined && /^\d{6}$/.test(code)) {
      // The list marks directly administered counties with a trailing `*`.
      entries.push([code, name.replace(/\*+$/, '').trim()]);
    }
  }
  return entries;
}

function main(): void {
  const source = process.argv[2];
  if (!source) {
    process.stderr.write('usage: tsx scripts/build-cities.ts <list.html>\n');
    process.exitCode = 1;
    return;
  }
  const entries = parseList(readFileSync(source, 'utf8'));
  if (entries.length < 3000) {
    throw new Error(`only ${entries.length} divisions parsed from ${source}; is it the list page?`);
  }

  const existing = JSON.parse(readFileSync(output, 'utf8')) as Existing[];
  const idByCode = new Map(existing.filter((r) => r.code).map((r) => [r.code, r.id]));
  const idByParentName = new Map(existing.map((r) => [`${r.parentId}:${r.name}`, r.id]));
  let nextId = Math.max(...existing.map((r) => r.id)) + 1;
  const used = new Set<number>();

  const rows: Row[] = [];
  const rowByCode = new Map<string, Row>();

  function add(level: number, code: string | null, name: string, parent: Row | null): Row {
    const full = code === null ? null : `${code}000000`;
    const known =
      (full !== null ? idByCode.get(full) : undefined) ??
      idByParentName.get(`${parent?.id ?? null}:${name}`) ??
      idByParentName.get(`${parent?.id ?? null}:${FORMER_NAMES[name] ?? name}`);
    const id = known !== undefined && !used.has(known) ? known : nextId++;
    used.add(id);
    const row: Row = {
      id,
      parentId: parent?.id ?? null,
      level,
      code: full,
      name,
      mergerName: parent ? `${parent.mergerName},${name}` : name,
      lng: null,
      lat: null,
      isVisible: true,
    };
    rows.push(row);
    if (code !== null) rowByCode.set(code, row);
    return row;
  }

  const provinceName = new Map<string, string>();
  for (const [code, name] of entries) {
    if (code.endsWith('0000')) provinceName.set(code.slice(0, 2), name);
  }

  // Provinces, then cities, then districts: `parent_id` is a foreign key and
  // the seed inserts in file order.
  for (const [code, name] of entries) {
    if (code.endsWith('0000')) add(0, code, name, null);
  }

  function cityFor(code: string): Row {
    const prefix = code.slice(0, 4);
    const province = rowByCode.get(`${code.slice(0, 2)}0000`);
    if (!province) throw new Error(`no province for ${code}`);
    const existingCity = rowByCode.get(`${prefix}00`);
    if (existingCity) return existingCity;
    if (MUNICIPALITIES.has(code.slice(0, 2))) {
      const name = code.slice(2, 4) === '01' ? province.name : '县';
      return add(1, `${prefix}00`, name, province);
    }
    if (code.slice(2, 4) === '90') return add(1, `${prefix}00`, '省直辖县级行政区划', province);
    throw new Error(`no city for ${code}`);
  }

  for (const [code, name] of entries) {
    if (!code.endsWith('0000') && code.endsWith('00')) {
      const province = rowByCode.get(`${code.slice(0, 2)}0000`);
      if (!province) throw new Error(`no province for ${code}`);
      add(1, code, name, province);
    }
  }
  for (const [prefix] of provinceName) {
    if (NO_LOWER_DIVISIONS.has(prefix)) {
      const province = rowByCode.get(`${prefix}0000`);
      if (province) add(1, null, province.name, province);
    }
  }
  const counties = entries.filter(([code]) => !code.endsWith('00'));
  // Create the synthetic city rows before any district, so the file stays
  // ordered by level.
  for (const [code] of counties) cityFor(code);
  for (const [code, name] of counties) add(2, code, name, cityFor(code));

  rows.sort(
    (a, b) => a.level - b.level || (a.code ?? '').localeCompare(b.code ?? '') || a.id - b.id,
  );
  writeFileSync(output, `${JSON.stringify(rows)}\n`);
  const kept = rows.filter((r) => existing.some((e) => e.id === r.id)).length;
  process.stdout.write(`${rows.length} divisions written (${kept} keep their id)\n`);
}

main();
