import fs from 'node:fs';
import path from 'node:path';
import { defineCheck, fail, result, type Finding } from '../framework';
import { RULE_ID_IN_TEXT, parseCatalogue } from '../lib/catalogue';
import { walk, type SourceFile } from '../lib/files';
import { invariantsDoc, rel, repoRoot } from '../lib/paths';
import {
  closest,
  isTestModule,
  mentions,
  splitCitation,
  titleMatches,
  titlesIn,
} from '../lib/test-titles';

/**
 * `docs/invariants.md`, the business-rule catalogue, kept honest.
 *
 *   1. Every rule cites at least one test, and no rule ID appears twice.
 *   2. Every citation resolves to a test that exists: `<file>::<test name>`,
 *      the file read relative to the repository root. A test file
 *      must write the leaf title; any other file must write the name on one of
 *      its lines.
 *   3. A test title that names a rule ID names one that exists. Only IDs from
 *      a family the catalogue uses are read (`PAY-…`, `RISK-D-…`), so a title
 *      mentioning `AES-256` is not taken for a rule.
 *
 * A stale citation is reported with the closest title the file does write,
 * because the usual cause is a test that was renamed.
 */

/**
 * Where test files live: the whole repository — the workspace and the
 * mini-program with the packages it is built from (`apps/mini`,
 * `packages/api-client`, `packages/storefront-blocks`, `e2e/storefront/specs-mini`).
 * One root rather than a list, so a new app's tests are read without an edit
 * here; `walk` skips `node_modules` and build output.
 */
const TEST_ROOTS = [repoRoot];

/** Every test module the title scan reads. */
export function testModules(): SourceFile[] {
  return TEST_ROOTS.flatMap((root) => walk(root, isTestModule));
}

interface ReadFile {
  absolute: string;
  source: string;
}

function readCited(file: string, cache: Map<string, ReadFile | null>): ReadFile | null {
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  const absolute = path.join(repoRoot, file);
  const read = fs.existsSync(absolute)
    ? { absolute, source: fs.readFileSync(absolute, 'utf8') }
    : null;
  cache.set(file, read);
  return read;
}

/** Why a citation does not resolve, or null when it does. */
export function citationProblem(
  citation: string,
  read: (file: string) => string | null,
): string | null {
  const parts = splitCitation(citation);
  if (!parts) return `"${citation}" is not <file>::<test name>`;
  const source = read(parts.file);
  if (source === null) return `no such file: ${parts.file}`;
  if (!isTestModule(parts.file)) {
    return mentions(source, parts.leaf) ? null : `${parts.file} writes no "${parts.leaf}"`;
  }
  const titles = titlesIn(source);
  if (titles.some((title) => titleMatches(title, parts.leaf))) return null;
  const near = closest(parts.leaf, titles);
  return `${parts.file} has no test named "${parts.leaf}"${near ? ` — renamed to "${near}"?` : ''}`;
}

/** The family of an ID: `RISK-D-002` -> `RISK-D`. */
function familyOf(id: string): string {
  return id.replace(/-\d{3}$/, '');
}

export const invariants = defineCheck(
  'invariants',
  'every business rule cites a test that exists, and every rule a test names exists',
  () => {
    const findings: Finding[] = [];
    const doc = rel(invariantsDoc);
    if (!fs.existsSync(invariantsDoc)) {
      findings.push(fail(doc, 'is missing — there is no rule catalogue to check'));
      return result('invariants', 'business rules', 'no catalogue', findings);
    }
    const { rules, problems } = parseCatalogue(fs.readFileSync(invariantsDoc, 'utf8'));
    for (const problem of problems) findings.push(fail(`${doc}:${problem.line}`, problem.message));

    // --- 1 and 2: the catalogue itself -------------------------------------
    const ids = new Set<string>();
    const cache = new Map<string, ReadFile | null>();
    const read = (file: string): string | null => readCited(file, cache)?.source ?? null;
    let citations = 0;
    for (const rule of rules) {
      const where = `${doc}:${rule.line} ${rule.id}`;
      if (ids.has(rule.id)) findings.push(fail(where, 'appears twice'));
      ids.add(rule.id);
      if (rule.citations.length === 0) {
        findings.push(fail(where, 'cites no test'));
        continue;
      }
      for (const citation of rule.citations) {
        citations += 1;
        const problem = citationProblem(citation, read);
        if (problem) findings.push(fail(where, problem));
      }
    }

    // --- 3: rule IDs named by test titles ----------------------------------
    const families = new Set([...ids].map(familyOf));
    let testFiles = 0;
    for (const file of testModules()) {
      testFiles += 1;
      const unknown = new Set<string>();
      for (const title of titlesIn(file.text)) {
        for (const match of title.matchAll(RULE_ID_IN_TEXT)) {
          const id = match[0];
          if (families.has(familyOf(id)) && !ids.has(id)) unknown.add(id);
        }
      }
      for (const id of unknown) {
        findings.push(
          fail(rel(file.file), `names ${id} in a test title, which ${doc} does not have`),
        );
      }
    }

    return result(
      'invariants',
      'business rules',
      `${rules.length} rules, ${citations} citations resolved; rule IDs in the titles of ${testFiles} test files`,
      findings,
    );
  },
);
