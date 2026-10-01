import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set([
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'coverage',
  '.git',
  'unpackage',
  'build',
]);

export interface SourceFile {
  /** Absolute path. */
  file: string;
  /** Path relative to the root the walk started from, always with `/`. */
  relative: string;
  text: string;
}

/** Every file under `root` whose name matches, read into memory. */
export function walk(root: string, matches: (name: string) => boolean): SourceFile[] {
  const out: SourceFile[] = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (matches(entry.name)) {
        out.push({
          file: full,
          relative: path.relative(root, full).split(path.sep).join('/'),
          text: fs.readFileSync(full, 'utf8'),
        });
      }
    }
  }
  return out.sort((a, b) => a.relative.localeCompare(b.relative));
}

export const isTypeScript = (name: string): boolean =>
  /\.(ts|tsx|mts|cts)$/.test(name) && !name.endsWith('.d.ts');

export const isScript = (name: string): boolean =>
  /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|vue)$/.test(name);

export function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

export function exists(file: string): boolean {
  return fs.existsSync(file);
}

/** Strips `//` and block comments so a scan cannot be fooled by prose. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 1-based line number of a character offset. */
export function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}
