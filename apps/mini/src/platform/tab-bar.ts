import Taro from '@tarojs/taro';
import { TAB_PAGES, tabIndex, type TabKey } from './tab-pages';

/**
 * The native tab bar, restyled at runtime from `app/config` appearance (docs/mini/design.md
 * §3.1). WeChat refuses tab-bar calls from a page that is not a tab page (`not TabBar page`),
 * so the calls are made from a tab page's `useDidShow` and a refusal is ignored.
 */
export interface TabBarLook {
  color: string;
  selectedColor: string;
  backgroundColor: string;
  items: ReadonlyArray<{
    key: TabKey;
    label: string;
    /** Absolute URL of an uploaded icon, or `null` for the bundled one. */
    iconUrl: string | null;
    selectedIconUrl: string | null;
  }>;
}

/** Remote icon → local temp file. `setTabBarItem` takes local paths only. */
const downloaded = new Map<string, Promise<string | null>>();

function localIcon(url: string | null): Promise<string | null> {
  if (!url) return Promise.resolve(null);
  let pending = downloaded.get(url);
  if (!pending) {
    pending = Taro.downloadFile({ url }).then(
      (result) => (result.statusCode === 200 ? result.tempFilePath : null),
      () => null,
    );
    downloaded.set(url, pending);
  }
  return pending;
}

/**
 * A bundled icon (`assets/tab-bar/`, scripts/tab-icons.mjs), as a package path. Passed when a
 * shop has no uploaded icon, or it failed to download, so a removed upload goes back to it.
 */
export function bundledTabIcon(index: number, selected: boolean): string | null {
  const icon = TAB_PAGES[index]?.icon;
  return icon ? `/assets/tab-bar/${icon}${selected ? '-active' : ''}.png` : null;
}

/** Colours, labels and icons; an icon not uploaded, or not downloaded, is the bundled one. */
export async function applyTabBarLook(look: TabBarLook): Promise<void> {
  if (process.env.TARO_ENV !== 'weapp') return;
  await Taro.setTabBarStyle({
    color: look.color,
    selectedColor: look.selectedColor,
    backgroundColor: look.backgroundColor,
    borderStyle: 'white',
  }).catch(() => undefined);
  await Promise.all(
    look.items.map(async (item) => {
      const index = tabIndex(item.key);
      if (index < 0) return;
      const [uploaded, uploadedSelected] = await Promise.all([
        localIcon(item.iconUrl),
        localIcon(item.selectedIconUrl),
      ]);
      const iconPath = uploaded ?? bundledTabIcon(index, false);
      const selectedIconPath = uploadedSelected ?? bundledTabIcon(index, true);
      await Taro.setTabBarItem({
        index,
        text: item.label || (TAB_PAGES[index]?.text ?? ''),
        ...(iconPath ? { iconPath } : {}),
        ...(selectedIconPath ? { selectedIconPath } : {}),
      }).catch(() => undefined);
    }),
  );
}

/** The cart tab's badge: a count, capped at 99+, or nothing for zero. */
export async function applyCartBadge(count: number): Promise<void> {
  const index = tabIndex('cart');
  if (count > 0) {
    const text = count > 99 ? '99+' : String(count);
    await Taro.setTabBarBadge({ index, text }).catch(() => undefined);
  } else {
    await Taro.removeTabBarBadge({ index }).catch(() => undefined);
  }
}
