/**
 * `%keyword%` for an ILIKE "contains" search, with the keyword's own `%`, `_`
 * and `\` escaped (Postgres' default LIKE escape is the backslash). Without it
 * a search for `100%` or `a_b` matches rows that do not contain it, and a lone
 * `%` or `_` lists everything.
 */
export function containsPattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
