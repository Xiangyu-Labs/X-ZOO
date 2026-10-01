import path from 'node:path';
import { allPermissionAtoms, IMPLICIT_ADMIN_PERMISSIONS } from '@shop/core/auth';
import { menuRegistry } from '../../../apps/web/src/admin/menu/menu.gen';
import { requiredPermissions } from '../../../apps/web/src/admin/shell/route-permission';
import { requirementsOf } from '../../../packages/core/src/system/permission-requirements';
import { defineCheck, fail, result, type Finding } from '../framework';
import { isTypeScript, stripComments, walk, type SourceFile } from '../lib/files';
import { rel, webApp } from '../lib/paths';
import { maskSource, matching } from '../lib/tx-scan';
import '../lib/install-domains';

/**
 * Every admin control is gated on the atom its route requires (AGENTS rule 11).
 *
 * The server re-checks every call, so an ungated control is not a hole — it is
 * a screen that breaks for a role that was set up correctly: a 保存 button that
 * answers 没有权限, or a picker whose options never load and toasts a 403 on
 * every open. This check reads the admin UI the way the shell renders it:
 *
 *  1. each page under `app/admin/(shell)` is guarded by the atoms its menu
 *     entry names (`requiredPermissions`, the same function the shell calls);
 *  2. from the page, the imports are followed (relative, `@/…`, `import()`),
 *     and every atom written as a literal on the way — `<Can permission=…>`,
 *     `useCan()('…')`, `permission="…"` on a kit control — counts as held
 *     below it;
 *  3. a contract route imported from `@shop/contracts` and used (not only
 *     named in an `invalidate` list) must then be covered:
 *       - a write needs its own atom held;
 *       - a read needs its atom held, or granted with a held write atom by
 *         `PERMISSION_REQUIREMENTS` (the role editor adds what an editor reads).
 *
 * The atoms every admin holds (`IMPLICIT_ADMIN_PERMISSIONS`) always pass. A
 * route whose atom ends in `:read` is a read whatever its method (a POST
 * preview is still a read).
 *
 * Lexical, like the other source checks: a gate written as a variable the
 * check cannot see through is a finding; write the atom where the control is.
 */

// ---------------------------------------------------------------------------
// Imports, exports and top-level symbols
// ---------------------------------------------------------------------------

export interface Import {
  spec: string;
  /** `{ a as b }` -> imported a, local b; a default import is `default`; `* as ns` is `*`. */
  names: { imported: string; local: string }[];
  /** `import('…')`: every symbol of the target may run. */
  dynamic: boolean;
}

function namesOf(clause: string): { imported: string; local: string }[] {
  const names: { imported: string; local: string }[] = [];
  const braces = /\{([^}]*)\}/.exec(clause)?.[1];
  for (const part of (braces ?? '').split(',')) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.startsWith('type ')) continue;
    const [imported, local] = trimmed.split(/\s+as\s+/).map((s) => s.trim());
    names.push({ imported: imported!, local: local ?? imported! });
  }
  const outside = clause
    .replace(/\{[^}]*\}/, '')
    .replace(/,/g, ' ')
    .trim();
  const star = /\*\s+as\s+([\w$]+)/.exec(outside);
  if (star) names.push({ imported: '*', local: star[1]! });
  else if (/^[\w$]+$/.test(outside)) names.push({ imported: 'default', local: outside });
  return names;
}

/** Value imports (type-only ones skipped) and `import('…')`. */
export function importsOf(source: string): Import[] {
  const text = stripComments(source);
  const out: Import[] = [];
  for (const match of text.matchAll(
    /(?:^|\n)\s*import\s+(type\s+)?([\w$*{}\s,]*?)\s*from\s*['"]([^'"]+)['"]/g,
  )) {
    if (match[1]) continue;
    out.push({ spec: match[3]!, names: namesOf(match[2] ?? ''), dynamic: false });
  }
  for (const match of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push({ spec: match[1]!, names: [], dynamic: true });
  }
  return out;
}

export interface ReExports {
  /** `export { a as b } from 'x'`: b -> (x, a). */
  named: Map<string, { spec: string; imported: string }>;
  /** `export * from 'x'`. */
  star: string[];
}

export function reExportsOf(source: string): ReExports {
  const text = stripComments(source);
  const named = new Map<string, { spec: string; imported: string }>();
  const star: string[] = [];
  for (const match of text.matchAll(
    /(?:^|\n)\s*export\s+(type\s+)?(\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g,
  )) {
    if (match[1]) continue;
    if (match[2] === '*') star.push(match[3]!);
    else {
      for (const name of namesOf(match[2]!)) {
        named.set(name.local, { spec: match[3]!, imported: name.imported });
      }
    }
  }
  return { named, star };
}

/**
 * The file's top-level declarations by name, each with its text: from its
 * first line (at column 0, as prettier writes them) to the next one. An
 * `export default` of a named function answers to both names.
 */
export function topLevelChunks(source: string): Map<string, string> {
  const text = stripComments(source);
  const starts: { at: number; names: string[] }[] = [];
  for (const match of text.matchAll(
    /^(export\s+)?(default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|enum)\s+([\w$]+)/gm,
  )) {
    starts.push({ at: match.index, names: match[2] ? [match[3]!, 'default'] : [match[3]!] });
  }
  for (const match of text.matchAll(/^export\s+default\s+(?!(?:async\s+)?function|class)/gm)) {
    starts.push({ at: match.index, names: ['default'] });
  }
  for (const match of text.matchAll(/^(?:import|export\s+(?:type\s+)?[{*]|type\s|interface\s)/gm)) {
    starts.push({ at: match.index, names: [] });
  }
  starts.sort((a, b) => a.at - b.at);
  const chunks = new Map<string, string>();
  starts.forEach((start, index) => {
    const body = text.slice(start.at, starts[index + 1]?.at ?? text.length);
    for (const name of start.names) chunks.set(name, (chunks.get(name) ?? '') + body);
  });
  return chunks;
}

/** A chunk and every other chunk of the file it names, transitively. */
export function closureOf(chunks: ReadonlyMap<string, string>, name: string): string {
  const seen = new Set<string>();
  const queue = [name];
  let text = '';
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const body = chunks.get(next);
    if (body === undefined) continue;
    text += `\n${body}`;
    for (const other of chunks.keys()) {
      if (!seen.has(other) && other !== 'default' && mentions(body, other)) queue.push(other);
    }
  }
  return text;
}

const mentions = (text: string, word: string): boolean =>
  new RegExp(`(^|[^\\w$.])${word.replace(/\$/g, '\\$')}\\b`).test(text);

const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** A relative or `@/` import to a file, or null (a package, or missing). */
export function resolveImport(
  from: string,
  spec: string,
  exists: (file: string) => boolean,
): string | null {
  let base: string;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else if (spec.startsWith('@/')) base = path.join(webApp, 'src', spec.slice(2));
  else return null;
  for (const ext of EXTENSIONS) {
    const file = base + ext;
    if (/\.(ts|tsx)$/.test(file) && exists(file)) return file;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Routes and atoms
// ---------------------------------------------------------------------------

export interface RouteDef {
  id: string;
  auth: string;
  method: string;
  permission?: string | undefined;
}

export interface RouteUse {
  local: string;
  route: RouteDef;
}

const ATOM_LITERAL = /['"`]([a-z][a-z-]*:[a-z][a-z-]*:[a-z][a-z-]*)['"`]/g;

/** Atom literals written in the text, and `route.permission` read off a route it imports. */
export function atomsIn(text: string, uses: readonly RouteUse[]): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(ATOM_LITERAL)) out.add(match[1]!);
  for (const use of uses) {
    if (use.route.permission && new RegExp(`\\b${use.local}\\.permission\\b`).test(text)) {
      out.add(use.route.permission);
    }
  }
  return out;
}

/**
 * Is `local` used for a call, not only named where a cache is invalidated?
 * `invalidate: [a, b]`, `invalidate={[a]}`, `routeKeyPrefix(a)` and
 * `routeQueryKey(a, …)` name a route without requesting it.
 */
export function isCalled(text: string, local: string): boolean {
  const masked = maskSource(text);
  const blanked = masked.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i <= to; i += 1) if (blanked[i] !== '\n') blanked[i] = ' ';
  };
  for (const match of masked.matchAll(/\binvalidate\s*[:=]\s*\{?\s*\[/g)) {
    const open = match.index + match[0].length - 1;
    const close = matching(masked, open);
    if (close > 0) blank(open, close);
  }
  for (const match of masked.matchAll(/\b(?:routeKeyPrefix|routeQueryKey)\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = matching(masked, open);
    if (close > 0) blank(open, close);
  }
  const body = blanked.join('').replace(/(^|\n)\s*import\s[^;]*;/g, '$1');
  return mentions(body, local);
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export interface Tree {
  /** Absolute file -> source. */
  files: ReadonlyMap<string, string>;
  /** Entry files (pages, layouts) and the atoms the shell requires for them. */
  roots: ReadonlyArray<{ file: string; atoms: readonly string[] }>;
  /** Contract routes a file imports, by local name. */
  uses: (file: string) => RouteUse[];
  requirements: (atom: string) => readonly string[];
  implicit: ReadonlySet<string>;
}

export interface Gap {
  file: string;
  route: RouteDef;
  kind: 'write' | 'read';
  roots: string[];
}

export const isRead = (route: RouteDef): boolean =>
  route.permission?.endsWith(':read') === true || route.method === 'GET';

interface Parsed {
  chunks: Map<string, string>;
  imports: Import[];
  reExports: ReExports;
}

export function gaps(tree: Tree): Gap[] {
  const exists = (file: string) => tree.files.has(file);
  const parsed = new Map<string, Parsed>();
  const parse = (file: string): Parsed => {
    let hit = parsed.get(file);
    if (!hit) {
      const source = tree.files.get(file)!;
      hit = {
        chunks: topLevelChunks(source),
        imports: importsOf(source),
        reExports: reExportsOf(source),
      };
      parsed.set(file, hit);
    }
    return hit;
  };

  /** Where `name` exported by `file` is declared, following re-exports. */
  const declaration = (file: string, name: string, depth = 0): [string, string][] => {
    if (depth > 8) return [];
    const p = parse(file);
    if (name === '*') return [...p.chunks.keys()].map((n) => [file, n]);
    if (p.chunks.has(name)) return [[file, name]];
    const named = p.reExports.named.get(name);
    if (named) {
      const target = resolveImport(file, named.spec, exists);
      return target ? declaration(target, named.imported, depth + 1) : [];
    }
    for (const spec of p.reExports.star) {
      const target = resolveImport(file, spec, exists);
      const found = target ? declaration(target, name, depth + 1) : [];
      if (found.length > 0) return found;
    }
    return [];
  };

  const found = new Map<string, Gap>();
  const covered = (atom: string, held: ReadonlySet<string>, read: boolean): boolean => {
    if (tree.implicit.has(atom) || held.has(atom)) return true;
    if (!read) return false;
    for (const holding of held) if (tree.requirements(holding).includes(atom)) return true;
    return false;
  };

  for (const root of tree.roots) {
    const visited = new Set<string>();
    const visit = (file: string, name: string, inherited: ReadonlySet<string>): void => {
      const key = `${file}#${name}`;
      if (visited.has(key)) return;
      visited.add(key);
      const p = parse(file);
      const text = closureOf(p.chunks, name);
      const uses = tree.uses(file).filter((use) => mentions(text, use.local));
      const held = new Set([...inherited, ...atomsIn(text, uses)]);

      for (const use of uses) {
        if (!isCalled(text, use.local)) continue;
        const atom = use.route.permission;
        if (!atom) continue;
        const read = isRead(use.route);
        if (covered(atom, held, read)) continue;
        const gapKey = `${file}\0${use.route.id}`;
        const gap = found.get(gapKey) ?? {
          file,
          route: use.route,
          kind: read ? 'read' : 'write',
          roots: [],
        };
        if (!gap.roots.includes(root.file)) gap.roots.push(root.file);
        found.set(gapKey, gap);
      }

      for (const imp of p.imports) {
        const target = resolveImport(file, imp.spec, exists);
        if (!target) continue;
        if (imp.dynamic) {
          if (text.includes(imp.spec)) {
            for (const [f, n] of declaration(target, '*')) visit(f, n, held);
          }
          continue;
        }
        for (const binding of imp.names) {
          if (!mentions(text, binding.local)) continue;
          for (const [f, n] of declaration(target, binding.imported)) visit(f, n, held);
        }
      }
    };
    visit(root.file, 'default', new Set(root.atoms));
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Over the tree
// ---------------------------------------------------------------------------

const adminDirs = [path.join(webApp, 'app/admin'), path.join(webApp, 'src/admin')];

const isAdminSource = (name: string): boolean =>
  isTypeScript(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.gen.ts');

/** `app/admin/(shell)/catalog/products/[id]/page.tsx` -> `/admin/catalog/products/[id]`. */
export function urlOfPage(file: string): string {
  const relative = path.relative(path.join(webApp, 'app'), path.dirname(file));
  return `/${relative
    .split(path.sep)
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .join('/')}`;
}

const moduleCache = new Map<string, Record<string, unknown>>();

async function contractModule(spec: string): Promise<Record<string, unknown>> {
  let mod = moduleCache.get(spec);
  if (!mod) {
    mod = (await import(spec)) as Record<string, unknown>;
    moduleCache.set(spec, mod);
  }
  return mod;
}

const isRouteDef = (value: unknown): value is RouteDef =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as RouteDef).id === 'string' &&
  typeof (value as RouteDef).method === 'string' &&
  typeof (value as RouteDef).auth === 'string';

/**
 * Admin screens that deliberately use a route without its atom, with the
 * reason. Keyed on the file and the route id; exactly compared.
 */
export const UNGATED_ALLOW: ReadonlyArray<{ file: string; route: string; why: string }> = [];

export const adminPermissions = defineCheck(
  'admin-permissions',
  'every admin control is gated on its route’s atom, or granted with the screen’s',
  async () => {
    const files = new Map<string, string>();
    const sources: SourceFile[] = adminDirs.flatMap((dir) => walk(dir, isAdminSource));
    for (const file of sources) files.set(file.file, file.text);

    // Resolve every contract import once, up front: `gaps` is synchronous.
    const usesByFile = new Map<string, RouteUse[]>();
    for (const file of sources) {
      const uses: RouteUse[] = [];
      for (const imp of importsOf(file.text)) {
        if (!imp.spec.startsWith('@shop/contracts/')) continue;
        const mod = await contractModule(imp.spec);
        for (const name of imp.names) {
          const value = mod[name.imported];
          if (isRouteDef(value) && value.auth === 'admin') {
            uses.push({ local: name.local, route: value });
          }
        }
      }
      usesByFile.set(file.file, uses);
    }

    // Dev-only screens (the sider hides them and production 404s them) are
    // not entry points.
    const roots = sources
      .filter((file) => /\/app\/admin\/(.*\/)?(page|layout)\.tsx$/.test(file.file))
      .filter((file) => !file.file.includes('/(shell)/dev/'))
      .map((file) => ({
        file: file.file,
        atoms: file.file.endsWith('page.tsx')
          ? requiredPermissions(menuRegistry, urlOfPage(file.file)).filter(
              (p): p is string => typeof p === 'string',
            )
          : [],
      }));

    const found = gaps({
      files,
      roots,
      uses: (file) => usesByFile.get(file) ?? [],
      requirements: requirementsOf,
      implicit: new Set(IMPLICIT_ADMIN_PERMISSIONS),
    });

    const findings: Finding[] = [];
    const used = new Set<(typeof UNGATED_ALLOW)[number]>();
    for (const gap of found.sort((a, b) => a.file.localeCompare(b.file))) {
      const where = rel(gap.file);
      const allowed = UNGATED_ALLOW.find((e) => e.file === where && e.route === gap.route.id);
      if (allowed) {
        used.add(allowed);
        continue;
      }
      const screens = [...new Set(gap.roots.map((root) => urlOfPage(root)))].join(', ');
      findings.push(
        fail(
          where,
          gap.kind === 'write'
            ? `${gap.route.id} needs "${gap.route.permission}", and no <Can>/can() on the way from ${screens} checks it — the control answers 没有权限 for a role without it`
            : `${gap.route.id} reads with "${gap.route.permission}", which ${screens} neither requires nor gates, and no write atom there lists it in PERMISSION_REQUIREMENTS — gate the query (enabled: can('${gap.route.permission}')) or add the requirement`,
        ),
      );
    }
    for (const entry of UNGATED_ALLOW) {
      if (!used.has(entry)) {
        findings.push(
          fail(entry.file, `UNGATED_ALLOW names ${entry.route}, which is gated now — delete it`),
        );
      }
    }

    const declared = new Set(allPermissionAtoms().map((a) => a.atom));
    for (const [file, text] of files) {
      for (const match of stripComments(text).matchAll(ATOM_LITERAL)) {
        if (!declared.has(match[1]!) && /^(?:[a-z-]+:){2}[a-z-]+$/.test(match[1]!)) {
          // Only strings shaped like an atom *and* used as one: a gate on an
          // atom nobody declares never opens.
          if (/permission|can\(/i.test(text.slice(Math.max(0, match.index - 40), match.index))) {
            findings.push(
              fail(rel(file), `gates on "${match[1]}", which no permissions.ts declares`),
            );
          }
        }
      }
    }

    const uses = [...usesByFile.values()].reduce((n, list) => n + list.length, 0);
    return result(
      'admin-permissions',
      'admin UI permission gates',
      `${uses} admin route uses in ${files.size} admin files, followed from ${roots.length} pages and layouts`,
      findings,
    );
  },
);
