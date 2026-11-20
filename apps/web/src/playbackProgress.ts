// Where the profile is in a file: picked up when the player opens, and
// reported while playing, so "Verder kijken" works on every device.

export { resumePoint } from '@cinevault/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { api, keys } from './api.js';

const REPORT_MS = 10_000;

/**
 * Reports the position every few seconds while playing, on pause, at the end
 * and when the player closes. Returns true once the file played to its end.
 */
export function useProgressReporter({
  fileId,
  video,
  position,
  duration,
}: {
  fileId: string;
  video: HTMLVideoElement | null;
  /** Seconds from the start of the file (the player's own clock). */
  position: RefObject<number>;
  duration: number;
}): boolean {
  const queryClient = useQueryClient();
  const [ended, setEnded] = useState(false);
  const lastSent = useRef(-1);

  useEffect(() => {
    if (!video) return;
    const durationMs = duration > 0 ? duration * 1000 : undefined;
    const send = (keepalive = false, at = position.current, end = false) => {
      // Nothing worth keeping yet, or nothing new.
      if (!end && (at < 5 || Math.abs(at - lastSent.current) < 1)) return;
      lastSent.current = at;
      void api.reportProgress(fileId, at * 1000, durationMs, { keepalive }).catch(() => {});
    };
    const timer = setInterval(() => {
      if (!video.paused) send();
    }, REPORT_MS);
    const onPause = () => send();
    const onEnded = () => {
      send(false, duration || position.current, true);
      setEnded(true);
    };
    const onPlay = () => setEnded(false);
    const onLeave = () => send(true);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('play', onPlay);
    window.addEventListener('pagehide', onLeave);
    return () => {
      clearInterval(timer);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('play', onPlay);
      window.removeEventListener('pagehide', onLeave);
      send(true);
      // The start page and posters show the new progress.
      void queryClient.invalidateQueries({ queryKey: keys.continue });
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      void queryClient.invalidateQueries({ queryKey: ['item'] });
    };
  }, [fileId, video, position, duration, queryClient]);

  return ended;
}
