import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Turbopack (Next 16.3–16.4) writes the same server chunk once per group of routes: the
 * `@shop/core` + `@shop/db` graph every API route needs comes out as ~60 files of 2 MB that
 * differ only in their `sourceMappingURL` comment. The runtime remembers loaded chunks by
 * *path*, so each copy is `require`d and compiled again, and `preloadEntriesOnStart` loads
 * them all at boot. The idle heap was 326 MB of the container's 384 MB (78 MB once
 * deduplicated), so ordinary traffic ran the production web container out of memory
 * anywhere from half an hour to a day and a half after each start.
 *
 * This keeps one file per distinct chunk, points every reference at it and deletes the
 * rest. It runs from `compiler.runAfterProductionCompile`, before Next collects page data
 * and traces the standalone tree, so both see the deduplicated set.
 */

const SOURCE_MAP_COMMENT = /\s*\/\/# sourceMappingURL=[^\n]*\s*$/;

export interface DedupeResult {
  /** How many duplicate chunk files were deleted. */
  removed: number;
  /** Their size in bytes, i.e. JavaScript no longer loaded. */
  bytes: number;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : Promise.resolve([full]);
    }),
  );
  return nested.flat();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deduplicate `<distDir>/server/chunks`. `distDir` is the absolute `.next` directory.
 */
export async function dedupeServerChunks(distDir: string): Promise<DedupeResult> {
  const serverDir = path.join(distDir, 'server');
  const chunksDir = path.join(serverDir, 'chunks');
  const chunkFiles = (await walk(chunksDir)).filter((file) => file.endsWith('.js')).sort();

  const canonicalByHash = new Map<string, string>();
  // duplicate → canonical, both relative to `server/chunks` with forward slashes
  const replacements = new Map<string, string>();
  let bytes = 0;
  for (const file of chunkFiles) {
    const body = (await readFile(file, 'utf8')).replace(SOURCE_MAP_COMMENT, '');
    const hash = createHash('sha256').update(body).digest('hex');
    const rel = path.relative(chunksDir, file).split(path.sep).join('/');
    const canonical = canonicalByHash.get(hash);
    if (canonical === undefined) {
      canonicalByHash.set(hash, rel);
    } else {
      replacements.set(rel, canonical);
      bytes += Buffer.byteLength(body);
    }
  }
  if (replacements.size === 0) return { removed: 0, bytes: 0 };

  // A reference is always `…chunks/<rel>` inside a string: `R.c("server/chunks/x.js")` in
  // an entry, `"../../chunks/x.js"` in its `.nft.json`.
  const pattern = new RegExp(
    `(chunks/)(${[...replacements.keys()].map(escapeRegExp).join('|')})(?=["'])`,
    'g',
  );
  const duplicates = new Set([...replacements.keys()].map((rel) => path.join(chunksDir, rel)));
  const referrers = (await walk(serverDir)).filter(
    (file) => /\.(js|json)$/.test(file) && !duplicates.has(file),
  );
  for (const file of referrers) {
    const text = await readFile(file, 'utf8');
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;
    let next = text.replace(pattern, (_, prefix: string, rel: string) => {
      return prefix + replacements.get(rel)!;
    });
    if (file.endsWith('.nft.json')) {
      const trace = JSON.parse(next) as { files?: string[] };
      if (Array.isArray(trace.files)) trace.files = [...new Set(trace.files)];
      next = JSON.stringify(trace);
    }
    await writeFile(file, next);
  }

  for (const file of duplicates) {
    await rm(file);
    await rm(`${file}.map`, { force: true });
  }
  return { removed: replacements.size, bytes };
}
