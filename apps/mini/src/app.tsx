import type { PropsWithChildren } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { useLaunch } from '@tarojs/taro';
import { ApiClientProvider } from '@shop/api-client/react';
import { loadAppConfig } from '@/app-config';
import { api } from '@/data/api';
import { createQueryClient, installQueryAdapters } from '@/data/query-client';
import {
  installLaunchTracking,
  installPrivacyHandler,
  installUpdateManager,
  useLaunchContext,
} from '@/platform';
import { onSessionChange, startSession } from '@/session/session';
import './app.scss';

const queryClient = createQueryClient();
installQueryAdapters();

// A shopper who signs out (or whose session ends) leaves nothing of theirs in the cache: the
// next one on this phone must not see the last one's cart or orders.
onSessionChange((session, previous) => {
  if (previous.status === 'signed-in' && session.status !== 'signed-in') queryClient.clear();
});

/**
 * The app shell: providers, and what runs once at launch, none of which blocks the first page:
 *
 * - the privacy handler (C04), before any page can call a private API;
 * - launch-scene tracking (the timeline's single-page mode, codes, shares);
 * - the update manager (a new version asks to restart);
 * - `app/config`: theme, tab bar, share card, subscribe templates, from storage first;
 * - the silent `wx.login`, so the session is ready (or asking for a phone number) by the time
 *   a page needs it (not in the timeline's single-page mode, where there is no login).
 */
function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    installPrivacyHandler();
    installLaunchTracking();
    installUpdateManager();
    void loadAppConfig();
    // The timeline's single-page mode has no wx.login and no session (C10): browse only.
    if (!useLaunchContext.getState().isTimelineSinglePage) void startSession();
  });
  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={api}>{children}</ApiClientProvider>
    </QueryClientProvider>
  );
}

export default App;
