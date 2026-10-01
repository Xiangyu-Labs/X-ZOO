import Taro from '@tarojs/taro';

/**
 * A new version downloaded in the background: offer to restart into it. Called once at launch
 * (weapp only; the H5 builds have no update manager).
 */
export function installUpdateManager(): void {
  if (process.env.TARO_ENV !== 'weapp') return;
  if (typeof Taro.getUpdateManager !== 'function') return;
  const manager = Taro.getUpdateManager();
  manager.onUpdateReady(() => {
    void Taro.showModal({
      title: '发现新版本',
      content: '新版本已经准备好，重启后即可使用',
      confirmText: '立即重启',
      cancelText: '稍后',
    }).then((result) => {
      if (result.confirm) manager.applyUpdate();
    });
  });
}
