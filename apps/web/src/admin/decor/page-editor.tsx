'use client';

import {
  ArrowLeftOutlined,
  EyeOutlined,
  HistoryOutlined,
  SaveOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { Data } from '@puckeditor/core';
import {
  decorDesignations,
  decorDocumentGet,
  decorDocumentList,
  decorDraftSave,
  decorPublish,
  decorRevisionGet,
  decorRevisionList,
  decorRollback,
} from '@shop/contracts/decor/decor.admin.contract';
import type { ResponseOf } from '@shop/contracts/_conventions/route';
import type { StoredDocument } from '@shop/contracts/decor/document';
import type { DecorDocumentDetail, RevisionSummary } from '@shop/contracts/decor/schemas';
import {
  Alert,
  App,
  Badge,
  Button,
  Input,
  Modal,
  Result,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';

import {
  callRoute,
  presentApiError,
  useInvalidateRoutes,
  useRouteMutation,
  useRouteQuery,
} from '../api';
import { InstantText, StatusTag, useListReturn } from '../kit';
import { useLeaveGuard } from '../kit/leave-guard';
import { useCan } from '../session';
import { createAdminCanvasData, DecorCanvasDataProvider } from './canvas-data';
import { toPuckData } from './document';
import { DecorEditor, useDecorSelect } from './editor';
import { PreviewDrawer } from './preview';
import { createDecorRecordSource, DecorRecordSourceProvider } from './records';
import { RevisionsDrawer } from './revisions';
import {
  DESIGNATION_LABELS,
  KIND_LABELS,
  classifyFailure,
  isDirty,
  locateIssues,
  snapshotOf,
  type LocatedIssue,
} from './session';

/**
 * The page editor, full window. Load it with `next/dynamic`: it carries the
 * editor library.
 *
 * - **Saving is explicit** (保存草稿); nothing is written while editing. A save
 *   sends the draft token it was loaded with, and a draft someone else saved
 *   meanwhile comes back `DECOR_VERSION_CONFLICT`: the operator reloads theirs
 *   or overwrites it, knowingly.
 * - **Publishing** saves first when there is something unsaved, then
 *   publishes that exact draft (its token goes with the publish).
 * - What the server says of a saved draft — issues that block publishing,
 *   warnings that do not — is listed under the toolbar, each pointing at its
 *   block.
 * - Leaving with unsaved changes asks first: the back button here, the
 *   browser's own prompt for a reload or a closed tab.
 */

const INVALIDATE = [decorDocumentGet, decorDocumentList, decorDesignations];

function Overlay({ children }: { children: ReactNode }) {
  // Covers the admin shell: the canvas and both side panels need the room,
  // and the sidebar must not offer a way out past the unsaved-changes guard.
  return (
    <div
      data-testid="decor-page-editor"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 900,
        background: 'var(--ant-color-bg-container)',
      }}
    >
      {children}
    </div>
  );
}

export function DecorPageEditor({ id, previewUrl }: { id: string; previewUrl: string | null }) {
  const router = useRouter();
  const { listHref } = useListReturn('/admin/decor');
  const detail = useRouteQuery(decorDocumentGet, { params: { id } });
  const [generation, setGeneration] = useState(0);
  const records = useMemo(() => createDecorRecordSource(), []);
  const canvas = useMemo(() => createAdminCanvasData(), []);
  // The document as it was when this editor session began; the query itself
  // keeps refreshing (after a save, a publish) for the status in the toolbar.
  const [loaded, setLoaded] = useState<DecorDocumentDetail | undefined>(undefined);
  if (detail.data && (!loaded || loaded.id !== detail.data.id)) setLoaded(detail.data);

  if (!loaded) {
    return (
      <Overlay>
        {detail.isError ? (
          <Result
            status="warning"
            title="页面不存在或已删除"
            extra={<Button onClick={() => router.push(listHref)}>返回列表</Button>}
          />
        ) : (
          <Spin style={{ display: 'block', margin: '120px auto' }} />
        )}
      </Overlay>
    );
  }

  const reload = async () => {
    const fresh = await detail.refetch();
    if (fresh.data) {
      setLoaded(fresh.data);
      setGeneration((value) => value + 1);
    }
  };

  return (
    <Overlay>
      <DecorRecordSourceProvider source={records}>
        <DecorCanvasDataProvider value={canvas}>
          <EditorSession
            key={`${loaded.id}:${generation}`}
            loaded={loaded}
            live={detail.data ?? loaded}
            previewUrl={previewUrl}
            onReload={reload}
          />
        </DecorCanvasDataProvider>
      </DecorRecordSourceProvider>
    </Overlay>
  );
}

// ─── one editing session: from a load to the next reload ─────────────────────

interface Saved {
  version: string;
  json: string;
  issues: LocatedIssue[];
  warnings: LocatedIssue[];
}

interface Conflict {
  /** The current token, to overwrite with. */
  version: string | undefined;
  /** What to do once the overwrite is saved. */
  then: { publish: string } | null;
}

type RevisionDetail = ResponseOf<typeof decorRevisionGet>;
type RollbackResult = ResponseOf<typeof decorRollback>;

interface Viewing {
  revision: RevisionDetail;
  data: Data;
}

function EditorSession({
  loaded,
  live,
  previewUrl,
  onReload,
}: {
  loaded: DecorDocumentDetail;
  live: DecorDocumentDetail;
  previewUrl: string | null;
  onReload: () => Promise<void>;
}) {
  const { id, kind } = loaded;
  const { listHref } = useListReturn('/admin/decor');
  const { message, modal } = App.useApp();
  const can = useCan();
  const canWrite = can('decor:page:write');
  const canPublish = can('decor:page:publish');

  // What the editor was (re)mounted with; `key` bumps remount it.
  const [start, setStart] = useState(() => ({ key: 0, data: toPuckData(loaded.draft) }));
  const [data, setData] = useState<Data>(start.data);
  const [saved, setSaved] = useState<Saved>(() => {
    const snapshot = snapshotOf(start.data);
    return {
      version: loaded.draftVersion,
      json: snapshot.ok ? snapshot.json : '',
      issues: locateIssues(loaded.issues, loaded.draft),
      warnings: locateIssues(loaded.warnings, loaded.draft),
    };
  });
  // Draft tokens this session has seen. One the live query reports that is
  // not among them means another operator (or tab) saved this draft.
  const [known, setKnown] = useState<ReadonlySet<string>>(() => new Set([loaded.draftVersion]));
  const invalidate = useInvalidateRoutes();
  const snapshot = useMemo(() => snapshotOf(data), [data]);
  const dirty = isDirty(snapshot, saved.json);
  // Closed on load — a page fresh from a template has every picture still to
  // pick, and that is work to do, not an alarm; the toolbar counts it. A save
  // or a publish that comes back with issues opens it.
  const [showIssues, setShowIssues] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [note, setNote] = useState('');
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [viewing, setViewing] = useState<Viewing | null>(null);

  const leaveTo = useLeaveGuard(dirty);

  // The detail query is refreshed by hand after a save, once the new token is
  // known, so the toolbar never takes our own save for someone else's.
  const saveDraft = useRouteMutation(decorDraftSave, {
    presentError: false,
    invalidate: [decorDocumentList, decorDesignations],
  });
  const publishDraft = useRouteMutation(decorPublish, {
    presentError: false,
    invalidate: [...INVALIDATE, decorRevisionList],
  });
  const busy = saveDraft.isPending || publishDraft.isPending;
  const staleElsewhere = !known.has(live.draftVersion);

  /** A failed save or publish: the conflict dialog, the issue list, or the usual toast. */
  const fail = (error: unknown, then: Conflict['then']): null => {
    const failure = classifyFailure(error);
    switch (failure.kind) {
      case 'conflict':
        setConflict({ version: failure.version, then });
        break;
      case 'invalid': {
        const issues = snapshot.ok ? locateIssues(failure.issues, snapshot.document) : [];
        setSaved((current) => ({ ...current, issues }));
        setShowIssues(true);
        void message.error(
          issues.length > 0
            ? `还有 ${issues.length} 处问题，修改后才能发布`
            : '页面内容有误，请按提示修改',
        );
        break;
      }
      case 'nothing-to-publish':
        void message.info('没有需要发布的修改');
        break;
      default:
        presentApiError(failure.error);
    }
    return null;
  };

  /** Saves the editor's draft; the new token, or `null` if it did not save. */
  const save = async (
    options: { version?: string | undefined; then?: Conflict['then'] } = {},
  ): Promise<string | null> => {
    if (!snapshot.ok) {
      void message.error(snapshot.error);
      return null;
    }
    const { document, json } = snapshot;
    try {
      const result = await saveDraft.mutateAsync({
        params: { id },
        body: { document, version: options.version ?? saved.version },
      });
      setKnown((current) => new Set(current).add(result.version));
      const issues = locateIssues(result.issues, document);
      setSaved({
        version: result.version,
        json,
        issues,
        warnings: locateIssues(result.warnings, document),
      });
      void invalidate(decorDocumentGet);
      if (issues.length > 0) {
        setShowIssues(true);
        void message.warning(`草稿已保存，还有 ${issues.length} 处问题需修改后才能发布`);
      } else if (!options.then) {
        void message.success('草稿已保存');
      }
      return result.version;
    } catch (error) {
      return fail(error, options.then ?? null);
    }
  };

  /** Saves when needed, then publishes that draft. */
  const publish = async (publishNote: string, version?: string): Promise<boolean> => {
    let token = version ?? saved.version;
    if (version === undefined && dirty) {
      const next = await save({ then: { publish: publishNote } });
      if (!next) return false;
      token = next;
    }
    try {
      const result = await publishDraft.mutateAsync({
        params: { id },
        body: { version: token, note: publishNote },
      });
      setSaved((current) => ({
        ...current,
        issues: [],
        warnings: snapshot.ok ? locateIssues(result.warnings, snapshot.document) : [],
      }));
      setPublishing(false);
      setNote('');
      void message.success(`已发布第 ${result.revision.number} 版`);
      return true;
    } catch (error) {
      fail(error, { publish: publishNote });
      return false;
    }
  };

  const overwrite = async () => {
    if (!conflict) return;
    const { version, then } = conflict;
    setConflict(null);
    const next = await save({ version, then });
    if (next && then) await publish(then.publish, next);
  };

  const leave = () => leaveTo(listHref);

  const openPreview = async () => {
    // The preview shows the stored draft: save first so it shows what is on screen.
    if (dirty && canWrite) {
      const next = await save();
      if (!next) return;
    }
    setPreviewOpen(true);
  };

  const view = async (revision: RevisionSummary) => {
    try {
      const detail = await callRoute(decorRevisionGet, {
        params: { id, number: revision.number },
      });
      setViewing({ revision: detail, data: toPuckData(detail.content) });
    } catch (error) {
      presentApiError(error);
    }
  };

  /** Puts a revision's content into the editor, as unsaved changes. */
  const loadIntoEditor = (content: StoredDocument) => {
    const next = toPuckData(content);
    setStart((current) => ({ key: current.key + 1, data: next }));
    setData(next);
    setViewing(null);
    void message.info('已载入编辑器，保存草稿后生效');
  };

  const rolledBack = (result: RollbackResult, from: RevisionSummary) => {
    void message.success(`已回滚：线上现在是第 ${result.revision.number} 版`);
    if (!canWrite) return;
    modal.confirm({
      title: `把第 ${from.number} 版的内容载入编辑器？`,
      content: dirty
        ? '草稿没有随回滚改变。载入后，编辑器里未保存的修改会被替换。'
        : '草稿没有随回滚改变。载入后保存草稿，草稿即与线上一致。',
      okText: '载入',
      cancelText: '保持草稿',
      zIndex: 1100,
      onOk: async () => {
        try {
          const detail = await callRoute(decorRevisionGet, {
            params: { id, number: from.number },
          });
          loadIntoEditor(detail.content);
        } catch (error) {
          presentApiError(error);
        }
      },
    });
  };

  const liveNumber = live.published?.number;
  const issueCount = saved.issues.length;
  const warningCount = saved.warnings.length;

  const toolbar = (
    <>
      <Tooltip title="返回列表">
        <Button icon={<ArrowLeftOutlined />} aria-label="返回列表" onClick={leave} />
      </Tooltip>
      <Space size={6} style={{ minWidth: 0 }} wrap>
        <Typography.Text strong ellipsis style={{ maxWidth: 220 }}>
          {live.name}
        </Typography.Text>
        <StatusTag value={kind} map={KIND_LABELS} />
        {live.designation ? <StatusTag value={live.designation} map={DESIGNATION_LABELS} /> : null}
        {dirty ? (
          <Tag color="orange">未保存</Tag>
        ) : live.published ? (
          live.hasUnpublishedChanges ? (
            <Tag color="gold">草稿未发布 · 线上第 {liveNumber} 版</Tag>
          ) : (
            <Tag color="success">已发布第 {liveNumber} 版</Tag>
          )
        ) : (
          <Tag>未发布</Tag>
        )}
        {staleElsewhere ? (
          <Tooltip title="保存时可选择载入对方的版本或覆盖">
            <Tag color="red" icon={<WarningOutlined />}>
              草稿已在别处被修改
            </Tag>
          </Tooltip>
        ) : null}
      </Space>
      <div style={{ flex: 1 }} />
      {issueCount + warningCount > 0 ? (
        <Badge count={issueCount} size="small" offset={[-4, 4]}>
          <Button
            size="small"
            danger={issueCount > 0}
            icon={<WarningOutlined />}
            onClick={() => setShowIssues((value) => !value)}
          >
            {issueCount > 0 ? `${issueCount} 个问题` : `${warningCount} 条提示`}
          </Button>
        </Badge>
      ) : null}
      <Button icon={<HistoryOutlined />} onClick={() => setRevisionsOpen(true)}>
        发布记录
      </Button>
      <Button icon={<EyeOutlined />} loading={saveDraft.isPending} onClick={() => openPreview()}>
        预览
      </Button>
      {canWrite ? (
        <Button
          icon={<SaveOutlined />}
          loading={saveDraft.isPending}
          disabled={publishDraft.isPending || (!dirty && !staleElsewhere)}
          onClick={() => save()}
        >
          保存草稿
        </Button>
      ) : null}
      {canPublish ? (
        <Button type="primary" disabled={busy} onClick={() => setPublishing(true)}>
          发布
        </Button>
      ) : null}
    </>
  );

  const banner = (
    <>
      {canWrite ? null : <Alert banner type="info" title="你没有编辑权限，当前为只读查看。" />}
      {showIssues && issueCount + warningCount > 0 ? (
        <IssuesPanel
          issues={saved.issues}
          warnings={saved.warnings}
          stale={dirty}
          onClose={() => setShowIssues(false)}
        />
      ) : null}
    </>
  );

  return (
    <>
      <div style={{ height: '100%', display: viewing ? 'none' : 'block' }}>
        <DecorEditor
          key={start.key}
          kind={kind}
          data={start.data}
          onChange={setData}
          toolbar={toolbar}
          banner={banner}
          readOnly={!canWrite}
        />
      </div>
      {viewing ? (
        <div style={{ height: '100%' }} data-testid="decor-revision-view">
          <DecorEditor
            key={`revision-${viewing.revision.number}`}
            kind={kind}
            data={viewing.data}
            readOnly
            toolbar={
              <RevisionToolbar
                viewing={viewing}
                live={viewing.revision.number === liveNumber}
                canLoad={canWrite}
                onBack={() => setViewing(null)}
                onLoad={() => loadIntoEditor(viewing.revision.content)}
                onRevisions={() => setRevisionsOpen(true)}
              />
            }
          />
        </div>
      ) : null}

      <RevisionsDrawer
        id={id}
        open={revisionsOpen}
        onClose={() => setRevisionsOpen(false)}
        liveNumber={liveNumber}
        viewing={viewing?.revision.number}
        onView={(revision) => view(revision)}
        onRolledBack={rolledBack}
      />
      <PreviewDrawer
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        id={id}
        kind={kind}
        previewUrl={previewUrl}
      />

      <Modal
        open={publishing}
        title="发布页面"
        okText={dirty ? '保存并发布' : '发布'}
        confirmLoading={busy}
        onOk={() => publish(note.trim())}
        onCancel={() => setPublishing(false)}
        zIndex={1100}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            发布后立即对顾客生效
            {live.designation ? '' : '（页面被设为首页 / 个人中心或被链接后可见）'}。
            {dirty ? '未保存的修改会先保存为草稿。' : ''}
          </Typography.Text>
          {issueCount > 0 ? (
            <Alert
              type="warning"
              showIcon
              title={`上次保存时还有 ${issueCount} 处问题，需修改后才能发布`}
            />
          ) : null}
          <Input.TextArea
            aria-label="发布说明"
            placeholder="发布说明（可选），如：换上春季主图"
            maxLength={200}
            showCount
            autoSize={{ minRows: 2, maxRows: 4 }}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Space>
      </Modal>

      <Modal
        open={conflict !== null}
        title="草稿已被其他人修改"
        onCancel={() => setConflict(null)}
        zIndex={1100}
        footer={[
          <Button key="cancel" onClick={() => setConflict(null)}>
            取消
          </Button>,
          <Button
            key="reload"
            onClick={() => {
              setConflict(null);
              return onReload();
            }}
          >
            载入对方的版本
          </Button>,
          <Button key="overwrite" type="primary" danger onClick={() => overwrite()}>
            用我的覆盖
          </Button>,
        ]}
      >
        <Typography.Paragraph>在你编辑期间，这个页面的草稿已在别处保存过。</Typography.Paragraph>
        <ul style={{ paddingLeft: 18, marginBottom: 0 }}>
          <li>
            <b>载入对方的版本</b>：放弃你在这里未保存的修改。
          </li>
          <li>
            <b>用我的覆盖</b>：保存你当前的页面，对方的修改会丢失
            {conflict?.then ? '，然后发布' : ''}。
          </li>
        </ul>
      </Modal>
    </>
  );
}

// ─── the issue list under the toolbar ────────────────────────────────────────

function IssueRow({ issue }: { issue: LocatedIssue }) {
  const select = useDecorSelect();
  const target = issue.blockId ?? (issue.root ? null : undefined);
  return (
    <li style={{ lineHeight: '22px' }}>
      <Typography.Text strong>{issue.where}</Typography.Text>
      {issue.field ? (
        <Typography.Text code style={{ fontSize: 12 }}>
          {issue.field}
        </Typography.Text>
      ) : null}
      ：{issue.message}
      {target !== undefined ? (
        <Button type="link" size="small" onClick={() => select(target)}>
          定位
        </Button>
      ) : null}
    </li>
  );
}

function IssuesPanel({
  issues,
  warnings,
  stale,
  onClose,
}: {
  issues: readonly LocatedIssue[];
  warnings: readonly LocatedIssue[];
  /** The editor has changed since these were computed. */
  stale: boolean;
  onClose: () => void;
}) {
  return (
    <div
      data-testid="decor-issues"
      style={{ maxHeight: 180, overflow: 'auto', padding: '4px 16px 8px' }}
    >
      {issues.length > 0 ? (
        <Alert
          type="error"
          showIcon
          closable
          onClose={onClose}
          style={{ marginBottom: warnings.length > 0 ? 8 : 0 }}
          title={`${issues.length} 个问题需修改后才能发布${stale ? '（以上次保存为准）' : ''}`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {issues.map((issue) => (
                <IssueRow key={issue.key} issue={issue} />
              ))}
            </ul>
          }
        />
      ) : null}
      {warnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          closable={issues.length === 0}
          onClose={onClose}
          title={`${warnings.length} 条提示（不影响发布）`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {warnings.map((issue) => (
                <IssueRow key={issue.key} issue={issue} />
              ))}
            </ul>
          }
        />
      ) : null}
    </div>
  );
}

// ─── looking at a revision ───────────────────────────────────────────────────

function RevisionToolbar({
  viewing,
  live,
  canLoad,
  onBack,
  onLoad,
  onRevisions,
}: {
  viewing: Viewing;
  live: boolean;
  canLoad: boolean;
  onBack: () => void;
  onLoad: () => void;
  onRevisions: () => void;
}) {
  const { revision } = viewing;
  return (
    <>
      <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
        返回编辑
      </Button>
      <Space size={6} wrap>
        <Typography.Text strong>查看第 {revision.number} 版（只读）</Typography.Text>
        {live ? <Tag color="success">当前线上</Tag> : null}
        <Typography.Text type="secondary">
          <InstantText value={revision.createdAt} format="minute" />
        </Typography.Text>
        {revision.note ? (
          <Typography.Text type="secondary">· {revision.note}</Typography.Text>
        ) : null}
      </Space>
      <div style={{ flex: 1 }} />
      <Button icon={<HistoryOutlined />} onClick={onRevisions}>
        发布记录
      </Button>
      {canLoad ? <Button onClick={onLoad}>载入到编辑器</Button> : null}
    </>
  );
}
