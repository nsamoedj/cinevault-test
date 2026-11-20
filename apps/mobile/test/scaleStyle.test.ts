import { describe, expect, it } from 'vitest';
import { scaleStyle } from '../src/scaleStyle';

describe('scaleStyle', () => {
  it('scales text, spacing and sizes, not borders, flex or colours', () => {
    expect(
      scaleStyle(
        {
          fontSize: 20,
          lineHeight: 27,
          paddingHorizontal: 16,
          marginTop: -40,
          minHeight: 56,
          borderRadius: 6,
          borderWidth: 1.5,
          flex: 1,
          opacity: 0.8,
          color: '#fff',
          width: '38%',
          top: 0,
        },
        1.4,
      ),
    ).toEqual({
      fontSize: 28,
      lineHeight: 37.8,
      paddingHorizontal: 22.4,
      marginTop: -56,
      minHeight: 78.4,
      borderRadius: 8.4,
      borderWidth: 1.5,
      flex: 1,
      opacity: 0.8,
      color: '#fff',
      width: '38%',
      top: 0,
    });
  });

  it('keeps hairlines and leaves non-objects alone', () => {
    expect(scaleStyle({ height: 1, gap: 2 }, 1.5)).toEqual({ height: 1, gap: 3 });
    expect(scaleStyle(undefined, 1.5)).toBeUndefined();
  });
});
