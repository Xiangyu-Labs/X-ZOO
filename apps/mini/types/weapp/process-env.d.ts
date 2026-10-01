/**
 * `process.env.*` in the phone's code is not Node's `process`: Taro's build replaces each
 * `process.env.X` with its value (config/index.ts). tsconfig.weapp.json leaves `@types/node` out,
 * because it pulls in the ES2020 library and would let `matchAll` & co. through again; this is
 * all of `process` the phone's code may use.
 */
declare const process: { readonly env: NodeJS.ProcessEnv };
