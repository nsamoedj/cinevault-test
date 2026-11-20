import type { CSSProperties } from 'react';

/** A profile's initial on its colour. */
export function Avatar({
  name,
  color,
  size = 'small',
}: {
  name: string;
  color?: string | undefined;
  size?: 'small' | 'large';
}) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      className={`avatar ${size}`}
      style={{ '--avatar': color ?? '#E0B04F' } as CSSProperties}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
