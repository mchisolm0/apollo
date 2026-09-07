import { Stack } from 'expo-router';

export const unstable_settings = { initialRouteName: 'index' };

export default function SessionLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#000' } }} />;
}
