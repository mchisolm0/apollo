import { Stack } from 'expo-router';

export const unstable_settings = { initialRouteName: 'index' };

export default function SessionLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#000' } }}>
    <Stack.Screen name="session/[id]" options={({ route }) => ({
      presentation: route.params && (('id' in route.params && route.params.id === 'new') || ('presentation' in route.params && route.params.presentation === 'sheet')) ? 'formSheet' : 'card',
      sheetAllowedDetents: [0.92],
      sheetGrabberVisible: true,
      sheetCornerRadius: 32,
    })} />
  </Stack>;
}
