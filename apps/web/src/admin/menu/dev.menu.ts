import { defineMenu } from './types';

/**
 * `devOnly` entries are filtered out of production builds by the shell, so the
 * kit demo never appears in a deployed admin.
 */
export default defineMenu({
  key: 'dev',
  label: '开发工具',
  icon: 'ExperimentOutlined',
  order: 9000,
  devOnly: true,
  children: [
    {
      key: 'dev.kit',
      label: '组件套件演示',
      path: '/admin/dev/kit',
      icon: 'BlockOutlined',
      order: 10,
      devOnly: true,
    },
    {
      key: 'dev.decorSpike',
      label: '装修组件沙盒',
      path: '/admin/dev/decor-spike',
      icon: 'BuildOutlined',
      order: 20,
      devOnly: true,
    },
  ],
});
