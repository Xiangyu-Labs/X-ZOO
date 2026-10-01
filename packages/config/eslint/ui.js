/**
 * The two people-facing rules of the weapp preset, for UI that does not run in the
 * mini-program: the admin (apps/web). AGENTS.md rules 17 (handlers return their promise) and 1
 * (no raw error text in front of a person); the rules themselves are in ./weapp-rules.js.
 *
 *     import { uiConfig } from '@shop/config/eslint/ui';
 *     export default [
 *       ...,
 *       ...uiConfig({ files: ['app/**\/*.tsx'], ignores: ['**\/*.test.tsx'], uiIgnores: ['src/admin/api/**'] }),
 *     ];
 *
 * In the admin a returned promise is what lets a Popconfirm or Modal `onOk` show its loading
 * state and hold off a second click; an error's own text is a browser's `Failed to fetch` or a
 * `TypeError`. The rules are registered as `ui/…`, so a file's `eslint-disable` names the rule
 * the admin knows.
 */

import { weappPlugin } from './weapp-rules.js';

const uiPlugin = {
  meta: { name: 'ui' },
  rules: {
    'no-void-handler': weappPlugin.rules['no-void-handler'],
    'no-raw-error-text': weappPlugin.rules['no-raw-error-text'],
  },
};

/**
 * @param {{ files: string[], ignores?: string[], uiIgnores?: string[] }} options
 *   `uiIgnores`: further files exempt from `no-raw-error-text` only — the layer that turns raw
 *   errors into Chinese.
 * @returns {import('eslint').Linter.Config[]}
 */
export function uiConfig(options) {
  const { files, ignores = [], uiIgnores = [] } = options;
  return [
    {
      files,
      ignores,
      plugins: { ui: uiPlugin },
      rules: { 'ui/no-void-handler': 'error' },
    },
    {
      files,
      ignores: [...ignores, ...uiIgnores],
      plugins: { ui: uiPlugin },
      rules: { 'ui/no-raw-error-text': 'error' },
    },
  ];
}

export default uiConfig;
