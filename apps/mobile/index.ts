// The app's entry. First the bigger styles for a car (before any module
// creates its styles), then the notification task, which must be defined
// before anything else, also when Android starts the app only to run it in
// the background.
import './src/carScale';
import './src/notifications/phone';
import 'expo-router/entry';
