import { useEffect, useState } from 'react';
import { Canvas, Image as TaroImage, Text, View } from '@tarojs/components';
import { useRouteQuery } from '@shop/api-client/react';
import { useAppConfig } from '@/app-config';
import { assetUrl } from '@/lib/asset-url';
import {
  downloadPosterImage,
  openAlbumSetting,
  previewImages,
  renderPoster,
  saveImageToAlbum,
} from '@/platform';
import { useThemeStore } from '@/theme/store';
import { Button } from '@/ui/button';
import { Switch } from '@/ui/choice';
import { toast } from '@/ui/feedback';
import { Pressable } from '@/ui/pressable';
import { Sheet } from '@/ui/sheet';
import { posterLayout, type PosterColors } from './poster-layout';
import './poster-sheet.scss';
import { errorMessage } from '@/lib/error-message';

/** What a poster is of: a catalogue route a 小程序码 can open, and what it shows. */
export interface PosterSubject {
  route: 'product' | 'groupbuyTeam';
  id: string;
  title: string;
  price: string;
  originalPrice?: string | null | undefined;
  imageUrl: string | null;
  /** A factual line: 「2 人团 · 还差 1 人成团」. */
  badge?: string | undefined;
}

export const POSTER_CANVAS_ID = 'shop-poster-canvas';

/**
 * The canvas cannot read CSS variables: the neutrals mirror `ui/tokens/_colors.scss`'s defaults
 * (surface, text, text-tertiary, surface-sunken); primary and price follow the shop's theme.
 */
function posterColors(): PosterColors {
  const { theme } = useThemeStore.getState();
  return {
    background: '#ffffff',
    text: '#1a1a1a',
    muted: '#707070',
    placeholder: '#f2f2f2',
    price: theme.price,
    primary: theme.primaryText,
  };
}

type Phase =
  | { kind: 'drawing' }
  | { kind: 'ready'; path: string }
  | { kind: 'saving'; path: string }
  | { kind: 'saved'; path: string }
  | { kind: 'denied'; path: string }
  | { kind: 'failed'; message: string };

export interface PosterSheetProps {
  visible: boolean;
  onClose: () => void;
  /** `null` while the page's data loads. The shopper must be signed in (the code needs it). */
  subject: PosterSubject | null;
}

/**
 * 生成海报 (design.md §4.4 PosterSheet, SMOKE-009, C10): the client draws a canvas-2D poster of
 * the subject (picture, name, price, the 小程序码 from `wechat.shareMiniCode`) and offers
 * 保存到相册. States: drawing → ready → saving → saved; a refused 相册 permission shows 去设置,
 * a privacy refusal says why; a failure offers 重试.
 *
 * 「不显示商品图片」 redraws the poster without the product picture, for a shopper who would
 * rather share the name and price only.
 */
export function PosterSheet({ visible, onClose, subject }: PosterSheetProps) {
  const config = useAppConfig();
  const [hideImage, setHideImage] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [drawn, setDrawn] = useState<{ key: string; phase: Phase } | null>(null);

  const code = useRouteQuery(
    'wechat.shareMiniCode',
    { query: { route: subject?.route ?? 'home', ...(subject ? { id: subject.id } : {}) } },
    { enabled: visible && subject !== null, staleTime: Infinity, retry: false },
  );
  const codeUrl = code.data?.url;
  const codeError = code.isError ? errorMessage(code.error, '海报生成失败') : null;

  // One drawing per (subject, code, options): keyed by value, since a page may rebuild the
  // subject object on every render.
  const drawKey =
    visible && subject && codeUrl
      ? JSON.stringify([subject, codeUrl, hideImage, attempt, config?.name ?? ''])
      : null;

  useEffect(() => {
    if (drawKey === null) return;
    const [subject, url, noImage, , shopName] = JSON.parse(drawKey) as [
      PosterSubject,
      string,
      boolean,
      number,
      string,
    ];
    let cancelled = false;
    const settle = (phase: Phase) => {
      if (!cancelled) setDrawn({ key: drawKey, phase });
    };
    void (async () => {
      try {
        const productUrl = noImage ? null : assetUrl(subject.imageUrl);
        const [product, miniCode] = await Promise.all([
          productUrl ? downloadPosterImage(productUrl) : Promise.resolve(null),
          downloadPosterImage(assetUrl(url) ?? url),
        ]);
        if (!miniCode) throw new Error('小程序码下载失败');
        const path = await renderPoster(
          POSTER_CANVAS_ID,
          (measure) =>
            posterLayout(
              {
                shopName,
                title: subject.title,
                price: subject.price,
                originalPrice: subject.originalPrice,
                badge: subject.badge,
                hideImage: noImage,
              },
              posterColors(),
              measure,
            ),
          { product, code: miniCode },
        );
        settle({ kind: 'ready', path });
      } catch (error) {
        settle({
          kind: 'failed',
          message: errorMessage(error, '海报生成失败'),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [drawKey]);

  const phase: Phase = codeError
    ? { kind: 'failed', message: codeError }
    : drawn && drawn.key === drawKey
      ? drawn.phase
      : { kind: 'drawing' };
  const setPhase = (next: Phase) => {
    if (drawKey !== null) setDrawn({ key: drawKey, phase: next });
  };

  const retry = () => {
    if (code.isError) void code.refetch();
    setAttempt((n) => n + 1);
  };

  const save = async (path: string) => {
    setPhase({ kind: 'saving', path });
    const outcome = await saveImageToAlbum(path);
    switch (outcome) {
      case 'saved':
        toast.success('已保存到相册');
        setPhase({ kind: 'saved', path });
        return;
      case 'denied':
        setPhase({ kind: 'denied', path });
        return;
      case 'privacy':
        toast.text('未同意隐私保护指引，无法保存到相册');
        setPhase({ kind: 'ready', path });
        return;
      case 'cancelled':
        setPhase({ kind: 'ready', path });
        return;
      case 'failed':
        toast.text('保存失败，可点开海报后长按保存');
        setPhase({ kind: 'ready', path });
        return;
    }
  };

  const openSettings = async (path: string) => {
    if (await openAlbumSetting()) await save(path);
  };

  const path = 'path' in phase ? phase.path : null;

  return (
    <Sheet visible={visible} onClose={onClose} title="生成海报" height="tall">
      <View className="shop-poster" id="poster-sheet">
        {visible ? (
          <Canvas type="2d" id={POSTER_CANVAS_ID} className="shop-poster__canvas" />
        ) : null}
        <View className="shop-poster__stage">
          {phase.kind === 'drawing' ? (
            <Text className="shop-poster__note" id="poster-drawing">
              海报生成中…
            </Text>
          ) : phase.kind === 'failed' ? (
            <View className="shop-poster__failed" id="poster-failed">
              <Text className="shop-poster__note">{phase.message}</Text>
              <Button variant="outline" size="sm" onClick={retry}>
                重试
              </Button>
            </View>
          ) : path ? (
            <Pressable
              label="查看海报大图"
              className="shop-poster__preview"
              onClick={() => previewImages([path], path)}
            >
              <TaroImage
                className="shop-poster__image"
                src={path}
                mode="widthFix"
                ariaLabel="分享海报"
                id="poster-image"
              />
            </Pressable>
          ) : null}
        </View>
        <View className="shop-poster__option">
          <Switch checked={hideImage} onChange={setHideImage} label="不显示商品图片" />
          <Text className="shop-poster__option-text">不显示商品图片</Text>
        </View>
        {phase.kind === 'denied' ? (
          <View className="shop-poster__denied" id="poster-denied">
            <Text className="shop-poster__note">
              保存海报需要「添加到相册」权限，可在设置中开启；也可点开海报后长按保存
            </Text>
            <Button variant="primary" block onClick={() => openSettings(phase.path)}>
              去设置
            </Button>
          </View>
        ) : (
          <Button
            variant="primary"
            size="lg"
            block
            id="poster-save"
            disabled={!path}
            loading={phase.kind === 'saving'}
            onClick={() => {
              if (path) void save(path);
            }}
          >
            {phase.kind === 'saved' ? '已保存，可再次保存' : '保存到相册'}
          </Button>
        )}
      </View>
    </Sheet>
  );
}
