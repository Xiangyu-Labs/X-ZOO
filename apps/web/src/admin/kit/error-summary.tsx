'use client';

import { Button, Popover, Tooltip, Typography } from 'antd';

export interface ErrorSummaryProps {
  /** What went wrong, in Chinese: the record's `lastErrorSummary`. */
  summary: string | null;
  /**
   * The raw text the server recorded (a gateway's errmsg, an exception
   * message): the record's `lastError`. Shown only under 技术详情.
   */
  detail: string | null;
  /** One line, cut with a tooltip, for a table cell. Off: wraps, for a detail panel. */
  ellipsis?: boolean | undefined;
  placeholder?: string | undefined;
}

/**
 * A failure as staff read it (AGENTS.md rule 1): the Chinese summary, and the
 * raw text behind a 技术详情 toggle, labelled as being for whoever they ask for
 * help, with a copy button so it reaches them whole.
 */
export function ErrorSummary({
  summary,
  detail,
  ellipsis = false,
  placeholder = '—',
}: ErrorSummaryProps) {
  if (summary === null && detail === null) {
    return <Typography.Text type="secondary">{placeholder}</Typography.Text>;
  }
  // A row the server has no words for still says something a person can act on.
  const text = summary ?? '出错了，请把技术详情发给技术人员';
  const toggle =
    detail === null ? null : (
      <Popover
        trigger="click"
        placement="bottomRight"
        title="技术详情"
        content={
          <div style={{ maxWidth: 420 }}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              供技术人员排查问题，可复制后发给技术支持。
            </Typography.Paragraph>
            <Typography.Paragraph
              copyable={{ text: detail }}
              style={{ marginBottom: 0, wordBreak: 'break-all', fontFamily: 'monospace' }}
            >
              {detail}
            </Typography.Paragraph>
          </div>
        }
      >
        <Button type="link" size="small" style={{ paddingInline: 0, flex: 'none' }}>
          技术详情
        </Button>
      </Popover>
    );

  if (!ellipsis) {
    return (
      <span>
        <Typography.Text>{text}</Typography.Text> {toggle}
      </span>
    );
  }
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <Tooltip title={text}>
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {text}
        </span>
      </Tooltip>
      {toggle}
    </span>
  );
}
