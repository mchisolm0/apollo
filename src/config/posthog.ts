import Constants from 'expo-constants';
import PostHog from 'posthog-react-native';

const projectToken = Constants.expoConfig?.extra?.posthogProjectToken as string | undefined;
const host = (Constants.expoConfig?.extra?.posthogHost as string | undefined) ?? 'https://us.i.posthog.com';

// No token means analytics is disabled, including in local development.
export const posthog = new PostHog(projectToken ?? 'disabled', {
  host,
  disabled: !projectToken || projectToken === 'phc_your_project_token_here',
  captureAppLifecycleEvents: true,
});
