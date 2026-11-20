import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router';
import { api, keys } from '../api.js';
import { ErrorBox, Loading } from '../components/common.js';
import { Player } from '../components/Player.js';

/** Direct play when the browser can, otherwise HLS from the transcoder (hls.js). */
export function PlayerPage() {
  const { fileId = '' } = useParams();
  const [params] = useSearchParams();
  // "Vanaf het begin" on the detail page.
  const fromStart = params.get('start') === '0';
  const context = useQuery({
    queryKey: keys.file(fileId),
    queryFn: () => api.file(fileId),
    // Always fresh: the player starts where this profile stopped.
    gcTime: 0,
  });

  if (context.isPending)
    return (
      <div className="player-page">
        <Loading />
      </div>
    );
  if (context.isError)
    return (
      <div className="player-page">
        <ErrorBox error={context.error} />
      </div>
    );

  // A new file means a new player (and a new session).
  return (
    <Player
      key={context.data.file.id}
      context={context.data}
      fromStart={fromStart}
      backTo={`/items/${context.data.item.id}`}
    />
  );
}
