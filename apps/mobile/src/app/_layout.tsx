import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { openNotification } from '../components/Notifications';
import { keys } from '../keys';
import { checkNotifications, ensurePhoneNotifications } from '../notifications/phone';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from '../session';
import { colors } from '../theme';

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.bg,
    primary: colors.brass,
    text: colors.text,
    border: colors.line,
  },
};

/**
 * A tap on a notification opens what it is about (the notification service's
 * own ones open their screen by a cinevault:// link). While the app is open it
 * asks every minute for new ones and shows them, unless the service is
 * connected: Android doesn't run the background task then.
 */
function NotificationTaps({
  signedIn,
  role,
  servers,
}: {
  signedIn: boolean;
  role?: string;
  /** The addresses: changed, the notification service gets them too. */
  servers: string;
}) {
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (!signedIn || !response) return;
    const data = response.notification.request.content.data as { itemId?: string; path?: string };
    openNotification(data);
    void Notifications.clearLastNotificationResponseAsync();
  }, [response, signedIn]);

  // Once the role is known: the channels go with it; the service gets the login and addresses.
  useEffect(() => {
    if (!signedIn || !role) return;
    void ensurePhoneNotifications(role === 'ADMIN').catch(() => undefined);
  }, [signedIn, role, servers]);

  useEffect(() => {
    if (!signedIn) return;
    const check = () => {
      if (AppState.currentState !== 'active') return;
      void checkNotifications()
        .then((shown) => {
          if (shown > 0) void queryClient.invalidateQueries({ queryKey: keys.notifications });
        })
        .catch(() => undefined);
    };
    check();
    const timer = setInterval(check, 60_000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [signedIn]);
  return null;
}

/** Which screens exist depends on the server and the login. */
function Screens() {
  const { ready, server, servers, token, user } = useSession();
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);
  if (!ready) return null;
  const signedIn = Boolean(server && token);
  return (
    <>
      <NotificationTaps signedIn={signedIn} role={user?.role} servers={servers.join(' ')} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: 'fade_from_bottom',
        }}
      >
        <Stack.Protected guard={!server}>
          <Stack.Screen name="connect" />
        </Stack.Protected>
        <Stack.Protected guard={Boolean(server) && !token}>
          <Stack.Screen name="login" />
        </Stack.Protected>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="item/[id]" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="my-list" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="collections" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="collection/[id]" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="calendar" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="notifications" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="requests" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="accounts" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="admin" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="attention" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="markers" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="request-settings" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="discover-row" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="discover-title" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen
            name="play/[fileId]"
            options={{
              animation: 'fade',
              orientation: 'landscape',
              statusBarHidden: true,
              navigationBarHidden: true,
              contentStyle: { backgroundColor: '#000' },
            }}
          />
        </Stack.Protected>
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <ThemeProvider value={theme}>
            <StatusBar style="light" />
            <Screens />
          </ThemeProvider>
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
