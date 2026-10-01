'use client';

import { useState, type ReactNode } from 'react';

import { AssetSourceProvider } from '../kit/asset/asset-source-context';
import { createStorageAssetSource } from './asset-source';

/**
 * Installs the real material library for everything inside the admin shell.
 *
 * The kit has no fallback source: without this provider every
 * `<AssetPicker>` throws, which is the point — a picker that quietly offered
 * files from somewhere else would save them into real records.
 *
 * One instance per browser tab (`useState`), so the source is stable across
 * re-renders and no request is made until a picker actually opens.
 */
export function StorageAssetSourceProvider({ children }: { children: ReactNode }) {
  const [source] = useState(createStorageAssetSource);
  return <AssetSourceProvider source={source}>{children}</AssetSourceProvider>;
}
