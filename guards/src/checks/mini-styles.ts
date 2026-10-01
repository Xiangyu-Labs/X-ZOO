import path from 'node:path';
import { defineCheck, fail, result, type Finding } from '../framework';
import { lineOf, walk } from '../lib/files';
import { miniApp, rel, storefrontBlocksSrc } from '../lib/paths';

/**
 * What the mini-program's stylesheets may not say.
 *
 * WeChat's WXSS compiler rejects some CSS outright (the upload fails with -80056), and the
 * phone's WebView lacks some that DevTools' simulator and the H5 e2e build accept, so nothing
 * before a real device showed either: `> *` went out in a trial build twice (cf779f01a,
 * ca110d376). `apps/mini/scripts/size-report.mjs` still checks the built `.wxss` for `*`; this
 * reads the source, on every commit, with the line to fix.
 *
 * Supported floor: iOS 12 (babel.config.js). Flex `gap` (iOS 14.1) is knowingly used and not
 * checked here.
 */

const ROOTS = [path.join(miniApp, 'src'), storefrontBlocksSrc];

/**
 * Not compiled for WeChat: the admin's DOM stand-ins for Taro's components, which the editor
 * canvas loads in a browser (`packages/storefront-blocks/src/dom/`).
 */
const NOT_WEAPP = /^packages\/storefront-blocks\/src\/dom\//;

export interface StyleRule {
  id: string;
  message: string;
}

interface SelectorRule extends StyleRule {
  pattern: RegExp;
}

const SELECTOR_RULES: readonly SelectorRule[] = [
  {
    id: 'universal',
    pattern: /(^|[\s,>+~(])\*(?=$|[\s,>+~.:#[{)])/,
    message: 'WXSS rejects the universal selector `*` (name the children instead)',
  },
  {
    id: 'modern-pseudo',
    pattern: /:(is|where|has|focus-visible)\(|:focus-visible\b/,
    message:
      'WXSS and the iOS 12 WebView do not support :is() / :where() / :has() / :focus-visible',
  },
  {
    id: 'hover',
    pattern: /:hover\b/,
    message: "a phone has no hover; use the component's hover-class (Pressable) instead",
  },
  {
    id: 'html-tag',
    pattern:
      /(^|[\s,>+~(])(div|span|p|a|img|ul|ol|li|h[1-6]|section|header|footer|nav|main|article|table|tr|td|th|i|b|strong|em|small|body|html)(?=$|[\s,>+~.:#[{)])/,
    message: 'the mini-program renders no HTML tags (view, text, image…); select by class',
  },
  {
    id: 'attribute',
    pattern: /\[[^\]]*\]/,
    message: 'WXSS does not document attribute selectors; select by class',
  },
];

interface DeclarationRule extends StyleRule {
  property: string;
}

const DECLARATION_RULES: readonly DeclarationRule[] = [
  {
    id: 'aspect-ratio',
    property: 'aspect-ratio',
    message: '`aspect-ratio` needs iOS 15; use the padding-top box (see ui/image-uploader.scss)',
  },
  {
    id: 'inset',
    property: 'inset',
    message: '`inset` needs iOS 14.1; write top / right / bottom / left',
  },
];

/**
 * Exactly compared: an entry no finding matches fails until it is deleted. `file` is
 * repo-relative; `id` is the rule it excuses.
 */
const ALLOW: ReadonlyArray<{ file: string; id: string; why: string }> = [
  {
    file: 'apps/mini/src/ui/tokens/_mixins.scss',
    id: 'attribute',
    why: "`&[class]` lifts a width over WeChat's own `button:not([size=mini])`; it has passed upload and draws on phones",
  },
];

export interface StyleFinding extends StyleRule {
  line: number;
  text: string;
}

/**
 * Comments blanked (keeping line breaks, so line numbers hold), and SCSS interpolation
 * `#{…}` replaced by a placeholder word, so neither reads as a selector.
 */
function prepare(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(
      /(^|[^:])(\/\/[^\n]*)/g,
      (_all, lead: string, comment: string) => lead + blank(comment),
    )
    .replace(/#\{[^}]*\}/g, (text) => `x${' '.repeat(text.length - 1)}`);
}

/** Every construct in one stylesheet (SCSS or CSS) that a rule forbids. */
export function scanStylesheet(source: string): StyleFinding[] {
  const text = prepare(source);
  const found: StyleFinding[] = [];

  // A selector is the text before a `{`, back to the previous `{`, `}` or `;`. At-rules
  // (`@media`, `@include`, `@if`…) are not selectors; `@supports` is checked on its own.
  for (const match of text.matchAll(/([^{};]*)\{/g)) {
    const prelude = match[1] ?? '';
    const selector = prelude.trim();
    const start = (match.index ?? 0) + prelude.length - prelude.trimStart().length;
    if (selector.startsWith('@')) {
      if (/^@supports\b/.test(selector)) {
        found.push({
          id: 'supports',
          message: 'WXSS does not support @supports',
          line: lineOf(source, start),
          text: selector,
        });
      }
      continue;
    }
    // A keyframe step (`from`, `to`, `50%`) is not a selector either.
    if (/^(from|to|[\d.]+%)(\s*,\s*(from|to|[\d.]+%))*$/.test(selector)) continue;
    for (const rule of SELECTOR_RULES) {
      if (rule.pattern.test(selector)) {
        found.push({
          id: rule.id,
          message: rule.message,
          line: lineOf(source, start),
          text: selector,
        });
      }
    }
  }

  for (const rule of DECLARATION_RULES) {
    const declaration = new RegExp(`(^|[{;\\s])${rule.property}\\s*:`, 'g');
    for (const match of text.matchAll(declaration)) {
      const at = (match.index ?? 0) + (match[1]?.length ?? 0);
      found.push({
        id: rule.id,
        message: rule.message,
        line: lineOf(source, at),
        text: `${rule.property}:`,
      });
    }
  }

  return found.sort((a, b) => a.line - b.line);
}

export const miniStyles = defineCheck(
  'mini-styles',
  'the mini-program stylesheets use only what WXSS and the iOS 12 WebView accept',
  () => {
    const findings: Finding[] = [];
    const allowHit = new Set<number>();
    let scanned = 0;

    for (const root of ROOTS) {
      for (const file of walk(root, (name) => /\.(s?css)$/.test(name))) {
        const where = rel(file.file);
        if (NOT_WEAPP.test(where)) continue;
        scanned += 1;
        for (const finding of scanStylesheet(file.text)) {
          const allowed = ALLOW.findIndex(
            (entry) => entry.file === where && entry.id === finding.id,
          );
          if (allowed >= 0) {
            allowHit.add(allowed);
            continue;
          }
          findings.push(
            fail(
              `${where}:${finding.line}`,
              `${finding.message} (${finding.id}: \`${finding.text}\`)`,
            ),
          );
        }
      }
    }

    ALLOW.forEach((entry, index) => {
      if (!allowHit.has(index)) {
        findings.push(
          fail(entry.file, `allow-list entry for ${entry.id} no longer applies; delete it`),
        );
      }
    });

    return result(
      'mini-styles',
      'the mini-program stylesheets use only what WXSS and the iOS 12 WebView accept',
      `${scanned} stylesheets under ${ROOTS.map((root) => rel(root)).join(', ')}`,
      findings,
    );
  },
);
