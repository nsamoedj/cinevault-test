// CineVault's colours (CLAUDE.md: ink #101C3D, brass #E0B04F, white #F2F4FA),
// the same as the web app.

export const colors = {
  bg: '#0A1230',
  ink: '#101C3D',
  surface: '#142249',
  surface2: '#1B2B58',
  surface3: '#24376B',
  line: 'rgba(242,244,250,0.12)',
  lineStrong: 'rgba(242,244,250,0.24)',
  text: '#F2F4FA',
  text2: 'rgba(242,244,250,0.74)',
  text3: 'rgba(242,244,250,0.52)',
  brass: '#E0B04F',
  brassSoft: 'rgba(224,176,79,0.16)',
  danger: '#F08A7A',
  ok: '#8FD19E',
  glass: 'rgba(242,244,250,0.16)',
  scrim: 'rgba(5,9,26,0.72)',
} as const;

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 } as const;
export const radius = { s: 6, m: 10, l: 16 } as const;
export const gutter = 16;
