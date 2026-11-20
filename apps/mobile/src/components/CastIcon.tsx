// The Cast button: Google's own, in the app's colours. It opens the list of
// Chromecasts on the network and shows when one is connected. Not in a car.

import { CastButton } from 'react-native-google-cast';
import { isCar } from '../car';
import { colors } from '../theme';

export function CastIcon({ size = 26, color = colors.text }: { size?: number; color?: string }) {
  if (isCar) return null;
  return <CastButton style={{ width: size + 14, height: size + 14, tintColor: color }} />;
}
