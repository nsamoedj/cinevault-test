import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { ErrorView, Loading } from '../../components/ui';
import { keys } from '../../keys';
import { Player } from '../../player/Player';
import { useSession } from '../../session';

export default function PlayScreen() {
  const { fileId = '', start } = useLocalSearchParams<{ fileId: string; start?: string }>();
  const { api } = useSession();
  const context = useQuery({
    queryKey: keys.file(fileId),
    queryFn: () => api.file(fileId),
    // Always fresh: the player starts where this profile stopped.
    gcTime: 0,
  });

  if (context.isPending) return <Loading />;
  if (context.isError) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <ErrorView error={context.error} onRetry={() => router.back()} />
      </View>
    );
  }
  // A new file means a new player (and a new session).
  return <Player key={context.data.file.id} context={context.data} fromStart={start === '0'} />;
}
