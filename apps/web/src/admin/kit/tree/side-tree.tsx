'use client';

import { Tree, type TreeProps } from 'antd';

export type SideTreeProps = Omit<TreeProps, 'blockNode' | 'titleRender'>;

/**
 * An antd `Tree` for a fixed-width side pane (folder or category columns).
 *
 * antd lets a node title run past its row, so a few levels of indent plus a
 * long name (or a bare numeric id) spilled out of the pane and over the content
 * beside it. Here the tree sizes to its widest row and the pane scrolls
 * sideways instead. Titles are not cut with an ellipsis: the names that run
 * long are ids the operator needs to read in full, and `title` shows the whole
 * name on hover anyway.
 */
export function SideTree({ style, ...rest }: SideTreeProps) {
  return (
    <div className="admin-scroll-area" style={{ overflowX: 'auto', minWidth: 0 }}>
      <Tree
        {...rest}
        blockNode
        style={{ width: 'max-content', minWidth: '100%', ...style }}
        titleRender={(node) => {
          const text = typeof node.title === 'string' ? node.title : undefined;
          return (
            <span title={text} style={{ whiteSpace: 'nowrap' }}>
              {typeof node.title === 'function' ? node.title(node) : node.title}
            </span>
          );
        }}
      />
    </div>
  );
}
