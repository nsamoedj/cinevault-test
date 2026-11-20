import type { PlaybackPlan, PlanReason } from '@cinevault/shared';
import { codecLabel } from '../format';

function reason(r: PlanReason): string {
  switch (r.kind) {
    case 'video':
      return `videocodec ${codecLabel(r.codec)}`;
    case 'audio':
      return `audio ${codecLabel(r.codec)}`;
    case 'container':
      return `bestandsformaat ${codecLabel(r.codec)}`;
    case 'quality':
      return `kwaliteit ${r.height}p`;
    case 'track':
      return 'ander audiospoor';
  }
}

/** One line: how this file plays on this phone. */
export function planText(plan: PlaybackPlan): string {
  const why = plan.mode === 'direct' ? '' : plan.reasons.map(reason).join(', ');
  switch (plan.mode) {
    case 'direct':
      return 'Direct afspelen, zoals het bestand is';
    case 'remux':
      return `Beeld origineel, omgepakt door de server${why ? ` (${why})` : ''}`;
    case 'transcode':
      return `Omgezet naar H.264 ${plan.video.mode === 'transcode' ? `${plan.video.height}p ` : ''}door de server${why ? ` (${why})` : ''}`;
    case 'unplayable':
      return `Niet af te spelen: ${why}`;
  }
}
