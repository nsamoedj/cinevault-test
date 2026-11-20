// A QR code drawn with react-native-svg (qrcode-generator makes the modules).

import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';

/** Dark modules on white, with the quiet zone scanners need around them. */
export function QrCode({ value, size }: { value: string; size: number }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
      }
    }
    return { path: d, count: n + 8 };
  }, [value]);
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${count} ${count}`}
      accessibilityLabel="QR-code om in te loggen met je telefoon"
    >
      <Rect x={0} y={0} width={count} height={count} fill="#FFFFFF" />
      <Path d={path} fill="#101C3D" />
    </Svg>
  );
}
