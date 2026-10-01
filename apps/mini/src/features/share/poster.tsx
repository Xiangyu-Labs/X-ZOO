import { useEffect } from 'react';
import { create } from 'zustand';
import { useDisplay } from '@/app-config';
import { requireLogin } from '@/session/session';
import { PosterSheet, type PosterSubject as PosterContent } from './poster-sheet';

/**
 * 生成海报 from a page's own share sheet (商品详情). The page calls `openPoster` and renders
 * `PosterHost` with what the poster shows; the host opens `PosterSheet` (canvas 2D, 小程序码,
 * 保存到相册) for that subject. 拼团进度 renders `PosterSheet` itself.
 *
 * `useProductPosterEnabled` is the shop's switch for product posters (小程序外观 → 页面显示
 * 「允许生成商品海报」, `app/config.display.productPoster`, on by default). Off, 商品详情 offers
 * no 生成海报; sharing to a WeChat friend stays. The 拼团 invite poster is not covered by it.
 * A poster carries the product picture (the shopper may leave it out), its name and price, and
 * the 小程序码; never anything about the shopper.
 */
export type PosterSubject = { kind: 'product'; id: string };

export function useProductPosterEnabled(): boolean {
  return useDisplay().productPoster;
}

const usePosterRequest = create<{ open: PosterSubject | null }>()(() => ({ open: null }));

/** Opens the poster of `subject` on the page showing it, after a login if there is none. */
export function openPoster(subject: PosterSubject): void {
  void (async () => {
    if (!(await requireLogin({ route: 'product', params: { id: subject.id } }))) return;
    usePosterRequest.setState({ open: subject });
  })();
}

export interface PosterHostProps {
  subject: PosterSubject;
  /** What the poster shows: name, price (and the struck price), picture. */
  content: Omit<PosterContent, 'route' | 'id'>;
}

/** The page's poster sheet, shown while `openPoster` asked for this subject. */
export function PosterHost({ subject, content }: PosterHostProps) {
  const open = usePosterRequest((state) => state.open);
  const visible = open?.kind === subject.kind && open.id === subject.id;
  // A request never outlives the page that asked for it.
  useEffect(() => () => usePosterRequest.setState({ open: null }), []);
  return (
    <PosterSheet
      visible={visible}
      onClose={() => usePosterRequest.setState({ open: null })}
      subject={{ route: subject.kind, id: subject.id, ...content }}
    />
  );
}
