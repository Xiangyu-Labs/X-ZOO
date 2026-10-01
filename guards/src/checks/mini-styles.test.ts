import { describe, expect, it } from 'vitest';
import { miniStyles, scanStylesheet } from './mini-styles';

const ids = (source: string) => scanStylesheet(source).map((f) => `${f.line}:${f.id}`);

describe('scanStylesheet', () => {
  it('finds the universal selector however it is written', () => {
    expect(ids('.a > * {}\n.b{&--on > *{color:red}}\n* + .c {}')).toEqual([
      '1:universal',
      '2:universal',
      '3:universal',
    ]);
  });

  it('leaves a `*` in a value, a comment or an interpolation alone', () => {
    expect(ids('.a { width: calc(100% * 2); }\n// > * {}\n/* * {} */\n.b-#{$x * 2} {}')).toEqual(
      [],
    );
  });

  it('finds modern pseudo-classes, :hover, @supports, HTML tags and attribute selectors', () => {
    expect(
      ids(
        [
          '.a:is(.b) {}',
          '.a:hover {}',
          '@supports (display: grid) { .a {} }',
          '.a span {}',
          '.a[disabled] {}',
          '.a:focus-visible {}',
        ].join('\n'),
      ),
    ).toEqual([
      '1:modern-pseudo',
      '2:hover',
      '3:supports',
      '4:html-tag',
      '5:attribute',
      '6:modern-pseudo',
    ]);
  });

  it('finds aspect-ratio and inset as properties, not inside other values', () => {
    expect(
      ids(
        '.a {\n  aspect-ratio: 1;\n  inset: 0;\n  box-shadow: inset 0 0 1px red;\n}\n@media (min-aspect-ratio: 1/2) {}',
      ),
    ).toEqual(['2:aspect-ratio', '3:inset']);
  });

  it('accepts what the mini-program does use', () => {
    expect(
      ids(
        [
          '@use "tokens" as *;',
          'page { color: red; }',
          '.a { &__b > .c + .d ~ .e { display: flex; gap: 8px; } }',
          '.a::after, .a:not(.b):first-child {}',
          '@keyframes spin { from { opacity: 0 } 50% { opacity: .5 } to { opacity: 1 } }',
          '@include respond(md) { .a { top: 0; } }',
          '@media (prefers-reduced-motion: reduce) { .a {} }',
          'view, text, image {}',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('the mini-styles guard', () => {
  it('passes on the tree', async () => {
    const failures = (await miniStyles.run()).findings.filter((f) => f.level === 'fail');
    expect(failures.map((f) => `${f.where}: ${f.message}`).join('\n')).toBe('');
  });
});
