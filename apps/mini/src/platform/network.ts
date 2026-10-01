import Taro from '@tarojs/taro';

type Unsubscribe = () => void;

/** Network reachability: the current state once, then every change. */
export function onNetworkReachability(listener: (online: boolean) => void): Unsubscribe {
  let active = true;
  const onChange = (result: { isConnected: boolean }) => listener(result.isConnected);
  Taro.onNetworkStatusChange(onChange);
  Taro.getNetworkType()
    .then((result) => {
      if (active) listener(result.networkType !== 'none');
    })
    .catch(() => {
      // Unknown is treated as online: a request that then fails is retried by the query layer.
    });
  return () => {
    active = false;
    Taro.offNetworkStatusChange(onChange);
  };
}
