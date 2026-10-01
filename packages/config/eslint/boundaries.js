/**
 * A tiny ESLint plugin that enforces the import boundaries in
 * `docs/conventions.md` ("Import boundaries (ESLint-enforced)").
 *
 * Two rules, both deliberately dumb:
 *
 * - `boundaries/no-restricted-source` — deny an import source by regex, optionally
 *   only from files whose path matches (or does not match) a regex. This covers
 *   "core never imports next/react", "admin UI never imports @shop/core" and
 *   "only *.repo.ts touches @shop/db/schema/*".
 * - `boundaries/core-cross-domain` — inside `packages/core/src/<domain>/`, a
 *   relative import that leaves the domain must land on another domain's
 *   `index.ts` or on `order/ports.ts`. `kernel/` is shared and always allowed.
 *
 * Regexes are matched against POSIX-style absolute filenames and against the raw
 * import source string. We do not use glob libraries on purpose: the matching
 * semantics of `no-restricted-imports` patterns have changed between ESLint
 * majors and this needs to be boringly predictable.
 */

import path from 'node:path';

/** @param {string} p */
const posix = (p) => p.split(path.sep).join('/');

/** @type {import('eslint').Rule.RuleModule} */
const noRestrictedSource = {
  meta: {
    type: 'problem',
    docs: { description: 'Deny import sources per file pattern (rewrite import boundaries).' },
    schema: [
      {
        type: 'object',
        properties: {
          deny: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string' },
                from: { type: 'string' },
                exceptFrom: { type: 'string' },
                message: { type: 'string' },
              },
              required: ['source', 'message'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: { denied: '{{message}}（禁止从这里 import "{{source}}"）' },
  },
  create(context) {
    const deny = context.options[0]?.deny ?? [];
    const filename = posix(context.filename ?? context.getFilename());
    const rules = deny
      .map((d) => ({
        source: new RegExp(d.source),
        from: d.from ? new RegExp(d.from) : undefined,
        exceptFrom: d.exceptFrom ? new RegExp(d.exceptFrom) : undefined,
        message: d.message,
      }))
      .filter((d) => (d.from ? d.from.test(filename) : true))
      .filter((d) => (d.exceptFrom ? !d.exceptFrom.test(filename) : true));

    if (rules.length === 0) return {};

    /**
     * @param {import('estree').Node & { loc?: unknown }} node
     * @param {string} source
     */
    const check = (node, source) => {
      for (const rule of rules) {
        if (rule.source.test(source)) {
          context.report({
            node: /** @type {never} */ (node),
            messageId: 'denied',
            data: { message: rule.message, source },
          });
          return;
        }
      }
    };

    return {
      ImportDeclaration: (node) => check(node, String(node.source.value)),
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node, String(node.source.value));
      },
      ExportAllDeclaration: (node) => {
        if (node.source) check(node, String(node.source.value));
      },
      ImportExpression: (node) => {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
          check(node, node.source.value);
        }
      },
    };
  },
};

/** Domain folders under `core/src` that are not domains. */
const CORE_SHARED = new Set(['kernel', 'effects', 'auth']);

/** @type {import('eslint').Rule.RuleModule} */
const coreCrossDomain = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A core domain may reach another domain only through its index.ts or order/ports.ts.',
    },
    schema: [],
    messages: {
      reachIn:
        '跨域引用只能经过 `{{other}}/index.ts` 或 `order/ports.ts`，不能直接引用 "{{source}}"。',
    },
  },
  create(context) {
    const filename = posix(context.filename ?? context.getFilename());
    const marker = '/packages/core/src/';
    const at = filename.indexOf(marker);
    if (at === -1) return {};
    const rel = filename.slice(at + marker.length); // e.g. "order/order.service.ts"
    const domain = rel.split('/')[0];
    if (!domain || rel.split('/').length < 2) return {};

    const fileDir = path.posix.dirname(rel);

    /**
     * @param {import('estree').Node} node
     * @param {string} source
     */
    const check = (node, source) => {
      if (!source.startsWith('.')) return;
      const resolved = path.posix.normalize(path.posix.join(fileDir, source));
      const parts = resolved.split('/');
      const target = parts[0];
      if (!target || target === domain || target === '..') return;
      if (CORE_SHARED.has(target)) return;
      const rest = parts.slice(1).join('/');
      const ok =
        rest === '' ||
        rest === 'index' ||
        rest === 'index.ts' ||
        (target === 'order' && (rest === 'ports' || rest === 'ports.ts'));
      if (!ok) {
        context.report({
          node: /** @type {never} */ (node),
          messageId: 'reachIn',
          data: { other: target, source },
        });
      }
    };

    return {
      ImportDeclaration: (node) => check(node, String(node.source.value)),
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node, String(node.source.value));
      },
      ExportAllDeclaration: (node) => {
        if (node.source) check(node, String(node.source.value));
      },
    };
  },
};

/** @type {import('eslint').ESLint.Plugin} */
export const boundariesPlugin = {
  meta: { name: 'boundaries', version: '0.0.0' },
  rules: {
    'no-restricted-source': noRestrictedSource,
    'core-cross-domain': coreCrossDomain,
  },
};

export default boundariesPlugin;
