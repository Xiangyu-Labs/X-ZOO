/** Joins class names, dropping falsy ones: `cx('a', on && 'b')`. */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}
