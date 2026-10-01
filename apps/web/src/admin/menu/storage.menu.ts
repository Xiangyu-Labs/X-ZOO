import { defineMenu } from './types';

/**
 * 素材管理 — the media library.
 *
 * One entry: the library itself. Categories are edited inside it rather than on
 * a page of their own, because a folder tree with no files next to it is not
 * something anybody wants to look at.
 */
export default defineMenu({
  key: 'storage',
  label: '素材管理',
  icon: 'PictureOutlined',
  order: 800,
  children: [
    {
      key: 'storage.attachments',
      label: '素材库',
      path: '/admin/storage/attachments',
      permission: 'storage:attachment:read',
      order: 10,
    },
  ],
});
