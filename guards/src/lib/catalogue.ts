/**
 * Parsing `docs/invariants.md`, the business-rule catalogue.
 *
 * The format is plain Markdown, written for people first:
 *
 *     ## Area
 *
 *     ### PRICE-004
 *
 *     What the rule is, in a paragraph or two.
 *
 *     - `packages/core/src/…/x.test.ts::describe > it`
 *
 * A rule is a `###` heading that is a rule ID. Its citations are the
 * backticked `<file>::<test name>` spans on the bullet lines under it, up to
 * the next heading. Anything else — prose, other bullets — is the rule's text.
 */

/** `PRICE-004`, `RISK-D-002`: upper-case words joined by `-`, ending in three digits. */
export const RULE_ID = /^[A-Z]+(?:-[A-Z0-9]+)*-\d{3}$/;
/** The same, found inside running text such as a test title. */
export const RULE_ID_IN_TEXT = /(?<![\w-])[A-Z]+(?:-[A-Z0-9]+)*-\d{3}(?![\w-])/g;

export interface Rule {
  id: string;
  /** 1-based line of the heading. */
  line: number;
  area: string;
  text: string;
  citations: string[];
}

export interface Catalogue {
  rules: Rule[];
  /** Headings that should have been a rule ID and are not. */
  problems: Array<{ line: number; message: string }>;
}

export function parseCatalogue(markdown: string): Catalogue {
  const rules: Rule[] = [];
  const problems: Catalogue['problems'] = [];
  let area = '';
  let current: Rule | null = null;
  const lines = markdown.split('\n');
  lines.forEach((line, index) => {
    const areaHeading = /^##\s+(.+?)\s*$/.exec(line);
    if (areaHeading && !line.startsWith('###')) {
      area = areaHeading[1] ?? '';
      current = null;
      return;
    }
    const ruleHeading = /^###\s+(.+?)\s*$/.exec(line);
    if (ruleHeading) {
      const id = ruleHeading[1] ?? '';
      if (!RULE_ID.test(id)) {
        problems.push({ line: index + 1, message: `"${id}" is not a rule ID` });
        current = null;
        return;
      }
      current = { id, line: index + 1, area, text: '', citations: [] };
      rules.push(current);
      return;
    }
    if (/^#/.test(line)) {
      current = null;
      return;
    }
    if (!current) return;
    const rule: Rule = current;
    if (/^\s*[-*]\s/.test(line)) {
      // `` `a` `` or ``` `` a `b` `` ``` — a double-backtick span can hold a
      // single backtick of its own.
      const found = [...line.matchAll(/(`+)\s?([\s\S]*?)\s?\1(?!`)/g)]
        .map((span) => span[2] ?? '')
        .filter((body) => body.includes('::'));
      if (found.length > 0) {
        rule.citations.push(...found);
        return;
      }
    }
    rule.text = `${rule.text}\n${line}`.trim();
  });
  return { rules, problems };
}
