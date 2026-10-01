declare module 'vitest' {
  export interface ProvidedContext {
    /** Which React the current Vitest project renders with (see vitest.config.ts). */
    reactMajor: '18' | '19';
  }
}

export {};
