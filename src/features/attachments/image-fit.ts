/** Models reject very large images, and Anthropic refuses ones over 2000px once a request holds many. */
export const IMAGE_MAX_EDGE = 2000;
/** Anthropic's API limit per image; Hermes passes attached images to the model unchanged. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_JPEG_QUALITY = 0.85;
export const MAX_BYTE_LIMIT_SHRINKS = 3;

type Size = { readonly width: number; readonly height: number };
export type ImageFormat = 'jpeg' | 'png';

const animatedTypes = new Set(['image/gif', 'image/webp']);
const keptTypes = new Set(['image/png', 'image/jpeg', ...animatedTypes]);

export function fitImageSize(size: Size): { width: number; height: number } | null {
  const longestEdge = Math.max(size.width, size.height);
  if (longestEdge <= IMAGE_MAX_EDGE) return null;
  const scale = IMAGE_MAX_EDGE / longestEdge;
  return {
    width: Math.max(1, Math.min(IMAGE_MAX_EDGE, Math.round(size.width * scale))),
    height: Math.max(1, Math.min(IMAGE_MAX_EDGE, Math.round(size.height * scale))),
  };
}

/** PNG ignores JPEG quality, so a resampled PNG can still be too big; shrink it by pixel count. */
export function shrinkToByteLimit(size: Size, bytes: number): { width: number; height: number } | null {
  if (bytes <= MAX_IMAGE_BYTES) return null;
  const scale = Math.sqrt(MAX_IMAGE_BYTES / bytes) * 0.9;
  const next = { width: Math.max(1, Math.floor(size.width * scale)), height: Math.max(1, Math.floor(size.height * scale)) };
  return next.width < size.width || next.height < size.height ? next : null;
}

/**
 * Returns the format to re-encode in, or null to send the original bytes. Small originals pass
 * through so PNG transparency and GIF/WebP animation survive; HEIC and others become JPEG.
 */
export function imageFitFormat(image: Size & { readonly mimeType: string; readonly bytes: number }): ImageFormat | null {
  const mimeType = image.mimeType.toLowerCase().replace('image/jpg', 'image/jpeg');
  const fits = image.bytes <= MAX_IMAGE_BYTES && (fitImageSize(image) === null || animatedTypes.has(mimeType));
  if (keptTypes.has(mimeType) && fits) return null;
  return mimeType === 'image/png' ? 'png' : 'jpeg';
}

/** Gives a re-encoded image the extension of its new format. */
export function imageNameForFormat(name: string, format: ImageFormat): string {
  const pattern = format === 'png' ? /\.png$/i : /\.jpe?g$/i;
  return pattern.test(name) ? name : `${name.replace(/\.[^./]+$/, '')}.${format === 'png' ? 'png' : 'jpg'}`;
}
