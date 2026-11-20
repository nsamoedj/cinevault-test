// A picture of the moment while seeking (the timeline on a phone, left and
// right on a TV): one picture cut out of the server's sheets of previews.

import { thumbnailAt, type Thumbnails } from '@cinevault/shared';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { clockLabel } from '../format';
import { keys } from '../keys';
import { useSession } from '../session';
import { colors, radius } from '../theme';

/** The previews of a file, once the server made them (it does when nobody watches). */
export function useThumbnails(fileId: string): Thumbnails | undefined {
  const { api } = useSession();
  const query = useQuery({
    queryKey: keys.thumbnails(fileId),
    queryFn: () => api.thumbnails(fileId),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return query.data?.thumbnails;
}

export function SeekPreview({
  thumbnails,
  time,
  center,
  bounds,
  width,
}: {
  thumbnails: Thumbnails;
  time: number;
  /** Where the middle of the picture should be, in the parent's pixels. */
  center: number;
  /** Width of the parent, to keep the picture inside it. */
  bounds: number;
  /** Width of the picture on screen. */
  width: number;
}) {
  const { api, authHeaders } = useSession();
  const place = thumbnailAt(thumbnails, time);
  if (!place) return null;
  const scale = width / thumbnails.width;
  const height = Math.round(thumbnails.height * scale);
  const left = Math.min(Math.max(0, bounds - width), Math.max(0, center - width / 2));
  const uri = api.resolveUrl(place.sheet);
  return (
    <View pointerEvents="none" style={[styles.preview, { left, width }]}>
      <View style={[styles.frame, { width, height }]}>
        <Image
          source={{ uri, headers: authHeaders }}
          cachePolicy="disk"
          recyclingKey={uri}
          style={{
            position: 'absolute',
            width: thumbnails.columns * thumbnails.width * scale,
            height: thumbnails.rows * height,
            left: -place.x * scale,
            top: -place.y * scale,
          }}
        />
      </View>
      <Text style={styles.time}>{clockLabel(time)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { position: 'absolute', bottom: '100%', alignItems: 'center', gap: 4 },
  frame: {
    overflow: 'hidden',
    borderRadius: radius.s,
    borderWidth: 2,
    borderColor: colors.text,
    backgroundColor: '#000',
  },
  time: {
    color: colors.text,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    backgroundColor: 'rgba(0,0,0,0.8)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
});
