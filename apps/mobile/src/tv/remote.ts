// The TV remote's buttons. React Native on Android reports them as
// "onHWKeyEvent" (ReactAndroidHWInputDeviceHelper), for whatever has the focus.

import { useEffect, useEffectEvent } from 'react';
import { DeviceEventEmitter } from 'react-native';
import { type HWKeyEvent, type RemoteKey, remoteKey } from './remoteKeys';

export { type RemoteKey, seekStep } from './remoteKeys';

/** Calls `onKey` for each button press while `enabled`. */
export function useRemote(onKey: (key: RemoteKey) => void, enabled = true) {
  const handle = useEffectEvent((event: HWKeyEvent) => {
    const key = remoteKey(event);
    if (key) onKey(key);
  });
  useEffect(() => {
    if (!enabled) return;
    const subscription = DeviceEventEmitter.addListener('onHWKeyEvent', handle);
    return () => subscription.remove();
  }, [enabled]);
}
