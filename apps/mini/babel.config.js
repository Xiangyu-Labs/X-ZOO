// babel-preset-taro options: https://docs.taro.zone/docs/next/babel-config
//
// One syntax target for both builds. In a mini-program the JS engine is the phone's: iOS
// runs it in the system JavaScriptCore, so an iPhone on iOS 12 gets iOS 12 syntax, whatever
// the WeChat base library. ES2018 is what iOS 12 parses; `scripts/size-report.mjs` fails a
// build whose output does not parse as ES2018. H5 shares the target so e2e runs the same code.
module.exports = {
  presets: [
    [
      'taro',
      {
        framework: 'react',
        ts: true,
        compiler: 'webpack5',
        targets: { ios: '12', chrome: '70' },
        // `catch {` is ES2019. iOS 12 parses it, so preset-env would keep it, but the ES2018
        // gate would not; transforming it costs nothing (it first came in with @shop/api-client).
        include: ['transform-optional-catch-binding'],
      },
    ],
  ],
};
