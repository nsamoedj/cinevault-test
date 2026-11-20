// Scaling one style's sizes, for the bigger layout in a car (carScale.ts).

const SCALED = new Set([
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'top',
  'right',
  'bottom',
  'left',
  'start',
  'end',
  'inset',
  'margin',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'marginHorizontal',
  'marginVertical',
  'marginStart',
  'marginEnd',
  'padding',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'paddingHorizontal',
  'paddingVertical',
  'paddingStart',
  'paddingEnd',
  'gap',
  'rowGap',
  'columnGap',
  'borderRadius',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
  'textShadowRadius',
  'shadowRadius',
]);

/** One style with its sizes scaled; hairlines (under 2) stay sharp. */
export function scaleStyle<T>(style: T, factor: number): T {
  if (!style || typeof style !== 'object' || Array.isArray(style)) return style;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style)) {
    out[key] =
      SCALED.has(key) && typeof value === 'number' && Math.abs(value) >= 2
        ? Math.round(value * factor * 10) / 10
        : value;
  }
  return out as T;
}
