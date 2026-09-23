import type { CSSProperties, ReactNode } from 'react';

type Props = {
  slot: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
};

/**
 * Marks a real-UI region the parent shell can align slot hosts to.
 * Prefer attaching `data-ohk-slot` on an existing chrome node when possible;
 * use this when you need an explicit host box.
 */
export function SlotAnchor({ slot, className, style, children }: Props) {
  return (
    <div
      data-ohk-slot={slot}
      className={className}
      style={style}
      data-ohk-anchor=""
    >
      {children}
    </div>
  );
}
