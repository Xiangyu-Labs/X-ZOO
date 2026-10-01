/**
 * `@shop/config/eslint` is a plain `.js` flat-config factory with no types of
 * its own — every other package consumes it from an `eslint.config.js`, which
 * `tsc` never sees. The `banned` check reads it as *data* (it asserts the clock
 * and eval rules are still errors), so this package does need a type for it.
 *
 * Only the shape that check relies on is declared: a factory returning flat
 * config objects whose `rules` map a rule name to its severity and options.
 */
declare module '@shop/config/eslint' {
  export interface FlatConfig {
    files?: string[];
    ignores?: string[];
    rules?: Record<string, unknown>;
    [key: string]: unknown;
  }

  export function shopConfig(options?: {
    kind?: 'core' | 'contracts' | 'next' | 'tooling' | 'worker' | 'testing';
    [key: string]: unknown;
  }): FlatConfig[];
}
