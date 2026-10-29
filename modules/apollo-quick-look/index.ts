import { requireOptionalNativeModule } from 'expo';

type QuickLookModule = { preview(uris: readonly string[], titles: readonly string[], index: number): Promise<void> };

/** Null on Android, web, and builds made before this module existed. */
const native = requireOptionalNativeModule<QuickLookModule>('ApolloQuickLook');

/** Presents local files in Quick Look and resolves once the preview is dismissed. */
export const quickLook = native ? (uris: readonly string[], titles: readonly string[], index: number) => native.preview(uris, titles, index) : null;
