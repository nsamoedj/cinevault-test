import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NotificationList } from '../components/Notifications';
import { IconButton, text } from '../components/ui';
import { colors, gutter } from '../theme';

/** The inbox: what the server told this profile, the newest first. */
export default function NotificationsScreen() {
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.head}>
        <IconButton icon="back" label="Terug" onPress={() => router.back()} />
        <Text style={text.h1}>Meldingen</Text>
      </View>
      <ScrollView contentContainerStyle={styles.page}>
        <NotificationList />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 },
  page: { padding: gutter, paddingBottom: 32 },
});
