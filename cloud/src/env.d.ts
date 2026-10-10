// Secrets wrangler types can't see. EXPO_ACCESS_TOKEN is only needed when the
// Expo project has enhanced push security turned on.
interface Env {
  EXPO_ACCESS_TOKEN?: string;
}
