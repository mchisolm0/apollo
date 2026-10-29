# Upstream Attribution

`image-fit.ts` and `fit-image.ts` port T3 Code's composer image fitting from
`apps/mobile/src/lib/composerImageFit.ts` and
`packages/client-runtime/src/imageAttachmentSize.ts` at commit `960d5761c1`,
including the photo-library PNG fix from `7632c3dc70`. The composer attachment
strip (`src/features/relay/attachment-strip.tsx`) and the + menu follow the
layout of T3 Code's `ComposerAttachmentStrip.tsx` and
`ComposerAttachmentButton.tsx`.

Apollo writes the fitted image to a file instead of base64, uses a 5 MB image
cap, and keeps the 2000px edge, 0.85 JPEG quality, and byte-limit shrink loop.

T3 Code is Copyright (c) 2026 T3 Tools Inc. and licensed under the MIT License
included as `T3CODE_LICENSE`.
