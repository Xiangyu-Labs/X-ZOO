/**
 * Downloads a UTF-8 CSV file with a leading BOM so Windows Excel does not
 * misinterpret headings as GBK.
 */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Always quoted. A leading `=`, `+`, `-` or `@` gets a `'` first so a
 * spreadsheet cell such as `=HYPERLINK(…)` is treated as text instead of a formula.
 */
export function csvCell(value: string): string {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}

export function formatCsvTable(
  columns: readonly { key: string; title: string }[],
  rows: readonly Record<string, string | undefined>[],
): string {
  const header = columns.map((column) => csvCell(column.title)).join(',');
  const body = rows
    .map((row) => columns.map((column) => csvCell(row[column.key] ?? '')).join(','))
    .join('\r\n');
  return `${header}\r\n${body}`;
}
