'use client';

import { Alert, Typography } from 'antd';
import { useState } from 'react';
import { wechatOaReplySimulate } from '@shop/contracts/wechat-oa/wechat-oa.reply.contract';
import type {
  WechatMenuButtonShape,
  WechatReplySimulateResult,
} from '@shop/contracts/wechat-oa/schemas';

import { useRouteMutation } from '@/admin/api/hooks';
import { useCan } from '@/admin/session/session-provider';

import { replySummary } from '../wechat-oa-enums';

/**
 * WeChat cuts a menu label at 4 汉字 on the bar and 8 in a drawer (counted in
 * half-width units: a 汉字 is two), and shows the rest as `…`. The API accepts
 * the long name, so the first anyone hears of it is a follower's screenshot.
 */
const TOP_UNITS = 8;
const SUB_UNITS = 16;

function units(char: string): number {
  return char.charCodeAt(0) > 0xff ? 2 : 1;
}

/** The label as the phone draws it. */
export function shownLabel(name: string, limit: number): string {
  let used = 0;
  let out = '';
  for (const char of name) {
    used += units(char);
    if (used > limit) return `${out}…`;
    out += char;
  }
  return out;
}

/** What a tap does, in the operator's words — `null` for a parent, which only opens its drawer. */
function actionOf(button: WechatMenuButtonShape): string | null {
  if ((button.sub_button ?? []).length > 0) return null;
  switch (button.type) {
    case 'view':
      return button.url ? `打开网页 ${button.url}` : '打开网页（还没填网址）';
    case 'miniprogram':
      return `打开小程序 ${button.pagepath || '（首页）'}`;
    case 'click':
      return `向公众号发送事件 key = ${button.key || '（还没填）'}`;
    default:
      return '没有设置动作';
  }
}

/** Every problem a follower would see: a cut label, a button that does nothing. */
export function menuWarnings(buttons: readonly WechatMenuButtonShape[]): string[] {
  const warnings: string[] = [];
  const check = (button: WechatMenuButtonShape, limit: number, where: string): void => {
    const label = button.name || '（未命名）';
    const shown = shownLabel(button.name, limit);
    if (shown !== button.name) {
      warnings.push(`${where}「${label}」太长，手机上显示为「${shown}」`);
    }
    if ((button.sub_button ?? []).length > 0) return;
    if (button.type === 'view' && !button.url) warnings.push(`${where}「${label}」还没填网址`);
    if (button.type === 'click' && !button.key) warnings.push(`${where}「${label}」还没填 key`);
    if (button.type === 'miniprogram' && !button.appid) {
      warnings.push(`${where}「${label}」还没填小程序 AppID`);
    }
  };
  for (const button of buttons) {
    check(button, TOP_UNITS, '按钮');
    for (const child of button.sub_button ?? []) check(child, SUB_UNITS, '子菜单');
  }
  return warnings;
}

type Bubble = { from: 'user' | 'shop' | 'system'; text: string };

/**
 * The menu as a follower's phone draws it, from the tree being edited. Tapping
 * a button says what it would do; a `click` button asks 回复模拟 which saved
 * auto-reply answers its key, so the menu and the replies can be checked
 * together.
 */
export function MenuPhonePreview({ buttons }: { buttons: readonly WechatMenuButtonShape[] }) {
  const can = useCan();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const simulate = useRouteMutation(wechatOaReplySimulate, { presentError: false });

  const tap = (button: WechatMenuButtonShape, index: number | null): void => {
    const action = actionOf(button);
    if (action === null) {
      setOpenIndex(openIndex === index ? null : index);
      return;
    }
    setOpenIndex(null);
    const tapped: Bubble[] = [{ from: 'system', text: `点了「${button.name}」：${action}` }];
    setBubbles(tapped);
    if (button.type !== 'click' || !button.key || !can('wechat-oa:reply:read')) return;
    simulate.mutate(
      { body: { kind: 'click', text: button.key } },
      {
        onSuccess: (data) => {
          const result = data as WechatReplySimulateResult;
          setBubbles([
            ...tapped,
            result.reply
              ? { from: 'shop', text: replySummary(result.reply.replyType, result.reply.payload) }
              : { from: 'system', text: result.explanation },
          ]);
        },
      },
    );
  };

  const warnings = menuWarnings(buttons);
  const open = openIndex === null ? undefined : buttons[openIndex];

  return (
    <div data-testid="menu-phone-preview">
      <div
        style={{
          width: 280,
          height: 460,
          border: '8px solid #1f1f1f',
          borderRadius: 28,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          background: '#ededed',
          fontSize: 13,
        }}
      >
        <div
          style={{
            height: 40,
            lineHeight: '40px',
            textAlign: 'center',
            background: '#ededed',
            borderBottom: '1px solid #d9d9d9',
            fontWeight: 600,
          }}
        >
          公众号
        </div>

        <div style={{ flex: 1, padding: 10, overflowY: 'auto', position: 'relative' }}>
          {bubbles.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              点下面的菜单试试
            </Typography.Text>
          ) : null}
          {bubbles.map((bubble, index) => (
            <div
              key={index}
              style={{
                margin: '6px 0',
                display: 'flex',
                justifyContent: bubble.from === 'shop' ? 'flex-start' : 'center',
              }}
            >
              <div
                style={
                  bubble.from === 'shop'
                    ? {
                        background: '#fff',
                        borderRadius: 6,
                        padding: '6px 10px',
                        maxWidth: '85%',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                      }
                    : { color: '#888', fontSize: 12, textAlign: 'center', wordBreak: 'break-all' }
                }
              >
                {bubble.text}
              </div>
            </div>
          ))}
          {simulate.isPending ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              查找自动回复…
            </Typography.Text>
          ) : null}

          {open ? (
            <div
              style={{
                position: 'absolute',
                bottom: 6,
                left: `${(100 / buttons.length) * (openIndex ?? 0)}%`,
                width: `${100 / buttons.length}%`,
                padding: '0 4px',
              }}
            >
              <div style={{ background: '#fff', borderRadius: 4, boxShadow: '0 1px 4px #0002' }}>
                {(open.sub_button ?? []).map((child, index) => (
                  <div
                    key={index}
                    role="button"
                    tabIndex={0}
                    onClick={() => tap(child, null)}
                    onKeyDown={(event) => event.key === 'Enter' && tap(child, null)}
                    style={{
                      padding: '9px 4px',
                      textAlign: 'center',
                      borderTop: index === 0 ? 'none' : '1px solid #f0f0f0',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {shownLabel(child.name, SUB_UNITS) || '（未命名）'}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: 'flex',
            height: 46,
            background: '#f7f7f7',
            borderTop: '1px solid #d9d9d9',
          }}
        >
          <div style={{ width: 40, display: 'grid', placeItems: 'center', color: '#666' }}>⌨</div>
          {buttons.map((button, index) => (
            <div
              key={index}
              role="button"
              tabIndex={0}
              onClick={() => tap(button, index)}
              onKeyDown={(event) => event.key === 'Enter' && tap(button, index)}
              style={{
                flex: 1,
                display: 'grid',
                placeItems: 'center',
                borderLeft: '1px solid #e0e0e0',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                background: openIndex === index ? '#e8e8e8' : undefined,
              }}
            >
              <span>
                {(button.sub_button ?? []).length > 0 ? '≡ ' : ''}
                {shownLabel(button.name, TOP_UNITS) || '（未命名）'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {warnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12, width: 280 }}
          message={
            <ul style={{ margin: 0, paddingInlineStart: 16 }}>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          }
        />
      ) : null}
    </div>
  );
}
