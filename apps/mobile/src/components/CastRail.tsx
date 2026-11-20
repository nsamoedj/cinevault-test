// The actors of a title, in a rail: on its page and in "Ontdekken".

import type { CastMemberDto } from '@cinevault/shared';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { Rail, ServerImage, text } from './ui';

export function CastRail({ cast }: { cast: CastMemberDto[] }) {
  if (cast.length === 0) return null;
  return (
    <Rail
      title="Cast"
      data={cast}
      keyOf={(person) => `${person.name}-${person.character ?? ''}`}
      render={(person) => (
        <View style={styles.person}>
          <ServerImage
            path={person.profileUrl}
            style={styles.photo}
            fallback={person.name.charAt(0)}
          />
          <Text style={styles.name} numberOfLines={2}>
            {person.name}
          </Text>
          {person.character ? (
            <Text style={text.small} numberOfLines={1}>
              {person.character}
            </Text>
          ) : null}
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  person: { width: 96, alignItems: 'center', gap: 4 },
  photo: { width: 88, height: 88, borderRadius: 44 },
  name: { color: colors.text, fontWeight: '700', fontSize: 13, textAlign: 'center' },
});
