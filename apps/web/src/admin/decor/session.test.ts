import { pageRootProps, type StoredDocument } from '@shop/contracts/decor/document';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../api';
import { toPuckData } from './document';
import {
  classifyFailure,
  h5PreviewUrl,
  isDirty,
  locateIssues,
  miniPreviewPath,
  snapshotOf,
} from './session';

const document: StoredDocument = {
  schemaVersion: 2,
  root: { props: pageRootProps.parse({ title: '春季首页' }) },
  blocks: [
    { id: 'hero', type: 'carousel', v: 1, props: { slides: [] } },
    { id: 'grid', type: 'productGrid', v: 1, props: {} },
  ],
};

function apiError(status: number, code: string, details?: unknown): ApiError {
  return new ApiError({ status, code, message: code, details });
}

describe('the unsaved-changes check', () => {
  it('treats a document that went in and came out unchanged as saved', () => {
    const snapshot = snapshotOf(toPuckData(document));
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(isDirty(snapshotOf(toPuckData(document)), snapshot.json)).toBe(false);
  });

  it('sees an edit, and ignores key order and undefined', () => {
    const data = toPuckData(document);
    const saved = snapshotOf(data);
    if (!saved.ok) throw new Error('snapshot');

    const reordered = structuredClone(data);
    reordered.root.props = Object.fromEntries(
      (Object.entries(reordered.root.props ?? {}) as [string, unknown][])
        .reverse()
        .concat([['extra', undefined]]),
    );
    expect(isDirty(snapshotOf(reordered), saved.json)).toBe(false);

    const edited = structuredClone(data);
    (edited.root.props as { title: string }).title = '夏季首页';
    expect(isDirty(snapshotOf(edited), saved.json)).toBe(true);
  });

  it('counts a document it cannot convert as unsaved', () => {
    const data = toPuckData(document);
    const broken = { ...data, zones: { 'hero:inner': [data.content[0]!] } };
    const snapshot = snapshotOf(broken);
    expect(snapshot).toMatchObject({ ok: false });
    expect(isDirty(snapshot, 'anything')).toBe(true);
  });
});

describe('classifyFailure', () => {
  it('carries the current token of a conflict, for an overwrite', () => {
    expect(classifyFailure(apiError(409, 'DECOR_VERSION_CONFLICT', { version: '12' }))).toEqual({
      kind: 'conflict',
      version: '12',
    });
    expect(classifyFailure(apiError(409, 'DECOR_VERSION_CONFLICT'))).toEqual({
      kind: 'conflict',
      version: undefined,
    });
  });

  it('keeps the issues of an invalid document and drops malformed ones', () => {
    const issue = { path: 'blocks.0.props.slides', message: '至少一张' };
    expect(
      classifyFailure(apiError(422, 'DECOR_DOCUMENT_INVALID', { issues: [issue, { path: 1 }] })),
    ).toEqual({ kind: 'invalid', issues: [issue] });
  });

  it('tells nothing-to-publish apart, and leaves everything else to the toast', () => {
    expect(classifyFailure(apiError(409, 'DECOR_NOTHING_TO_PUBLISH'))).toEqual({
      kind: 'nothing-to-publish',
    });
    const other = apiError(403, 'FORBIDDEN');
    expect(classifyFailure(other)).toEqual({ kind: 'other', error: other });
    expect(classifyFailure(new Error('x'))).toMatchObject({ kind: 'other' });
  });
});

describe('locateIssues', () => {
  it('names the block by position and label, and keeps its id to select it by', () => {
    const [issue] = locateIssues(
      [{ path: 'blocks.1.props.source.ids', message: '请选择商品' }],
      document,
    );
    expect(issue).toMatchObject({
      where: '第 2 个组件「商品列表」',
      field: 'source.ids',
      blockId: 'grid',
      root: false,
      message: '请选择商品',
    });
  });

  it('points a root issue at the page settings, and anything else at the page', () => {
    const [root, other] = locateIssues(
      [
        { path: 'root.props.shareTitle', message: '太长' },
        { path: 'blocks', message: '组件太多' },
      ],
      document,
    );
    expect(root).toMatchObject({ where: '页面设置', field: 'shareTitle', root: true });
    expect(other).toMatchObject({ where: '页面', field: 'blocks', root: false });
    expect(other?.blockId).toBeUndefined();
  });

  it('survives a path past the end of the document', () => {
    const [issue] = locateIssues([{ path: 'blocks.9.type', message: '未知组件' }], document);
    expect(issue).toMatchObject({ where: '第 10 个组件', blockId: undefined });
  });
});

describe('preview URLs', () => {
  it('fills the template, encoded, and is off without one', () => {
    const values = { id: '7', previewToken: 'a/b+c', kind: 'home' as const };
    expect(
      h5PreviewUrl(
        'http://h5.test/#/packages/page/index?id={id}&previewToken={previewToken}',
        values,
      ),
    ).toBe('http://h5.test/#/packages/page/index?id=7&previewToken=a%2Fb%2Bc');
    expect(h5PreviewUrl('/p/{kind}/{id}', values)).toBe('/p/home/7');
    expect(h5PreviewUrl(null, values)).toBeNull();
    expect(h5PreviewUrl('', values)).toBeNull();
  });

  it('gives the 体验版 path of the page package', () => {
    expect(miniPreviewPath('7', 'x y')).toBe('packages/page/index?id=7&previewToken=x%20y');
  });
});
