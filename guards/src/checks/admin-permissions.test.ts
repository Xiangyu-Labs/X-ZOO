import { describe, expect, it } from 'vitest';
import {
  adminPermissions,
  gaps,
  importsOf,
  isCalled,
  topLevelChunks,
  type RouteDef,
  type RouteUse,
  type Tree,
} from './admin-permissions';

/** A whole-tree scan: seconds on a CI runner, far past the 5 s unit default. */
const WHOLE_TREE_MS = 60_000;

/**
 * The `admin-permissions` walk over small made-up admin trees: a page, the
 * components it imports, and the contract routes each file uses.
 */

const route = (id: string, method: string, permission: string): RouteDef => ({
  id,
  auth: 'admin',
  method,
  permission,
});

const ROUTES: Record<string, RouteDef> = {
  itemList: route('shop.itemList', 'GET', 'shop:item:read'),
  itemDelete: route('shop.itemDelete', 'DELETE', 'shop:item:delete'),
  tagList: route('shop.tagList', 'GET', 'shop:tag:read'),
  tagUpdate: route('shop.tagUpdate', 'PUT', 'shop:tag:write'),
  whoAmI: route('auth.me', 'GET', 'auth:profile:read'),
};

/** Files under /x; each file's contract imports are read off its source. */
function tree(
  files: Record<string, string>,
  pageAtoms: readonly string[],
  requirements: Record<string, string[]> = {},
): Tree {
  const map = new Map(Object.entries(files).map(([name, text]) => [`/x/${name}`, text]));
  const uses = (file: string): RouteUse[] =>
    importsOf(map.get(file) ?? '')
      .filter((imp) => imp.spec.startsWith('@shop/contracts/'))
      .flatMap((imp) => imp.names)
      .filter((name) => ROUTES[name.imported])
      .map((name) => ({ local: name.local, route: ROUTES[name.imported]! }));
  return {
    files: map,
    roots: [{ file: '/x/page.tsx', atoms: pageAtoms }],
    uses,
    requirements: (atom) => requirements[atom] ?? [],
    implicit: new Set(['auth:profile:read']),
  };
}

const verdict = (t: Tree) => gaps(t).map((g) => `${g.file.slice(3)} ${g.kind} ${g.route.id}`);

const PAGE = `
import { ItemsPage } from './items';

export default function Page() {
  return <ItemsPage />;
}
`;

describe('admin permission gates', () => {
  it('GUARD-005 — fails a delete button no <Can> gates', () => {
    const items = `
import { itemDelete, itemList } from '@shop/contracts/shop';

export function ItemsPage() {
  return <CrudTable route={itemList} actions={<ConfirmButton route={itemDelete} />} />;
}
`;
    expect(verdict(tree({ 'page.tsx': PAGE, 'items.tsx': items }, ['shop:item:read']))).toEqual([
      'items.tsx write shop.itemDelete',
    ]);
  });

  it('passes the same button inside <Can permission>, and the page’s own read', () => {
    const items = `
import { itemDelete, itemList } from '@shop/contracts/shop';

export function ItemsPage() {
  return (
    <CrudTable
      route={itemList}
      actions={
        <Can permission="shop:item:delete">
          <ConfirmButton route={itemDelete} />
        </Can>
      }
    />
  );
}
`;
    expect(verdict(tree({ 'page.tsx': PAGE, 'items.tsx': items }, ['shop:item:read']))).toEqual([]);
  });

  it('GUARD-005 — fails a picker whose read the page neither requires nor gates', () => {
    const items = `
import { itemList } from '@shop/contracts/shop';
import { TagPicker } from './tag-picker';

export function ItemsPage() {
  return <CrudTable route={itemList} filters={<TagPicker />} />;
}
`;
    const picker = `
import { tagList } from '@shop/contracts/shop';

export function TagPicker() {
  const tags = useRouteQuery(tagList);
  return <Select options={tags.data} />;
}
`;
    const files = { 'page.tsx': PAGE, 'items.tsx': items, 'tag-picker.tsx': picker };
    expect(verdict(tree(files, ['shop:item:read']))).toEqual(['tag-picker.tsx read shop.tagList']);
  });

  it('passes the picker when gated above it, or granted with a held write atom', () => {
    const gated = `
import { itemList } from '@shop/contracts/shop';
import { TagPicker } from './tag-picker';

export function ItemsPage() {
  const can = useCan();
  return <CrudTable route={itemList} filters={can('shop:tag:read') ? <TagPicker /> : null} />;
}
`;
    const granted = `
import { itemList } from '@shop/contracts/shop';
import { TagPicker } from './tag-picker';

export function ItemsPage() {
  return (
    <Can permission="shop:item:write">
      <TagPicker />
    </Can>
  );
}
`;
    const picker = `
import { tagList } from '@shop/contracts/shop';

export function TagPicker() {
  return <Select options={useRouteQuery(tagList).data} />;
}
`;
    expect(
      verdict(tree({ 'page.tsx': PAGE, 'items.tsx': gated, 'tag-picker.tsx': picker }, [])),
    ).toEqual(['items.tsx read shop.itemList']);
    expect(
      verdict(
        tree({ 'page.tsx': PAGE, 'items.tsx': granted, 'tag-picker.tsx': picker }, [], {
          'shop:item:write': ['shop:tag:read'],
        }),
      ),
    ).toEqual([]);
  });

  it('follows symbols, not files: an ungated component the page never renders is not a finding', () => {
    const items = `
import { itemList, tagUpdate } from '@shop/contracts/shop';

export function ItemsPage() {
  return <CrudTable route={itemList} />;
}

export function TagEditor() {
  return <ConfirmButton route={tagUpdate} />;
}
`;
    expect(verdict(tree({ 'page.tsx': PAGE, 'items.tsx': items }, ['shop:item:read']))).toEqual([]);
  });

  it('counts neither an invalidate list nor an implicit atom', () => {
    const items = `
import { itemList, tagList, whoAmI } from '@shop/contracts/shop';

export function ItemsPage() {
  const me = useRouteQuery(whoAmI);
  const save = useRouteMutation(saveRoute, { invalidate: [itemList, tagList] });
  return <span>{me.data?.name}</span>;
}
`;
    expect(isCalled(items, 'tagList')).toBe(false);
    expect(isCalled(items, 'whoAmI')).toBe(true);
    expect(verdict(tree({ 'page.tsx': PAGE, 'items.tsx': items }, []))).toEqual([]);
  });
});

describe('source reading', () => {
  it('reads value imports, skips type imports, and splits top-level declarations', () => {
    const source = `
import type { A } from './a';
import B, { c as d } from './b';
import * as ns from './n';

export default function Page() {}
const helper = () => 1;
`;
    expect(importsOf(source).map((i) => [i.spec, i.names.map((n) => n.local)])).toEqual([
      ['./b', ['d', 'B']],
      ['./n', ['ns']],
    ]);
    expect([...topLevelChunks(source).keys()].sort()).toEqual(['Page', 'default', 'helper']);
  });
});

describe('admin-permissions over the tree', () => {
  it(
    'GUARD-005 — every admin control and picker read is gated or granted with its screen',
    { timeout: WHOLE_TREE_MS },
    async () => {
      const failures = (await adminPermissions.run()).findings.filter((f) => f.level === 'fail');
      expect(failures.map((f) => `${f.where}: ${f.message}`).join('\n')).toBe('');
    },
  );
});
