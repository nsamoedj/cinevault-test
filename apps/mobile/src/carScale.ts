// In a car whose screen is drawn at a low density (the Polestar 4: about 1×),
// every StyleSheet is scaled up by `carScale` (src/car.ts): text, spacing,
// sizes and corners, also in libraries such as the tab bar. Borders, flex,
// opacity and the like stay as they are. Imported first (index.ts), before any
// module creates its styles. Sizes in code use `px()`.

import { StyleSheet } from 'react-native';
import { carScale } from './car';
import { scaleStyle } from './scaleStyle';

if (carScale > 1) {
  const create = StyleSheet.create.bind(StyleSheet);
  // StyleSheet is a plain object at runtime; its type only says read-only.
  (StyleSheet as { create: unknown }).create = (styles: Record<string, unknown>) => {
    const scaled: Record<string, unknown> = {};
    for (const [name, style] of Object.entries(styles)) scaled[name] = scaleStyle(style, carScale);
    return create(scaled as never);
  };
}
