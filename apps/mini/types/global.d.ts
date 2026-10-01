/// <reference types="@tarojs/taro" />

declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}
// CSS modules are typed per file, next to the stylesheet (`x.module.d.scss.ts`, found through
// `allowArbitraryExtensions`), so a misspelt class name is a type error. Plain stylesheets are
// side-effect imports.
declare module '*.scss';
declare module '*.css';

declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV: 'development' | 'production' | 'test';
    /** The platform Taro is building for; `weapp` is the product, `h5` the dev by-product. */
    TARO_ENV: 'weapp' | 'h5';
    /** The mini-program AppID; `touristappid` in the committed env files. */
    TARO_APP_ID: string;
    /**
     * The shop's https origin the mini-program calls (`''` = same origin, H5). Set it in
     * `.env.production.local`; it must also be a request 合法域名 in the WeChat console.
     */
    TARO_APP_API_ORIGIN: string;
    /** `mp` in the e2e suite's H5 build only (`build:h5:mp-emulation`), `''` otherwise. */
    TARO_APP_PLATFORM_EMULATION: '' | 'mp';
    /** The release version, sent as `X-Client-Version` (config/index.ts). */
    TARO_APP_VERSION: string;
    /** `1` keeps the dev-only demo package in a production weapp build (app.config.ts). */
    TARO_APP_DEMO?: '' | '1';
  }
}
