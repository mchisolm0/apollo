// Secrets wrangler types can't see. EXPO_ACCESS_TOKEN is only needed when the
// Expo project has enhanced push security turned on.
interface Env {
  EXPO_ACCESS_TOKEN?: string;
  /** Store reviews (src/reviews.ts): a producer token scoped to `reviews`, and the store credentials. */
  REVIEWS_TOKEN?: string;
  ASC_ISSUER_ID?: string;
  ASC_KEY_ID?: string;
  ASC_PRIVATE_KEY?: string;
  GOOGLE_SERVICE_ACCOUNT?: string;
}
