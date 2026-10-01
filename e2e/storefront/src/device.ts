import { devices } from '@playwright/test';

/**
 * The one device every page in this suite is. `playwright.config.ts`'s
 * project and the second shopper's hand-made context (`src/fixtures.ts`)
 * both use it, so group buy is two phones, not a phone and a desktop.
 */
export const DEVICE = devices['Pixel 7'];
