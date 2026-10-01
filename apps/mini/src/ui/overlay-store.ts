import { create } from 'zustand';

/**
 * How many sheets and dialogs are open on the current page. While any is, `PageShell` adds
 * `overflow: hidden` to the page-style so the page behind does not scroll (design.md §4.2).
 */
interface OverlayState {
  open: number;
  push: () => void;
  pop: () => void;
}

export const useOverlayStore = create<OverlayState>()((set) => ({
  open: 0,
  push: () => set((state) => ({ open: state.open + 1 })),
  pop: () => set((state) => ({ open: Math.max(0, state.open - 1) })),
}));
