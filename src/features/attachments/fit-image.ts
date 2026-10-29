import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { fitImageSize, IMAGE_JPEG_QUALITY, imageFitFormat, MAX_BYTE_LIMIT_SHRINKS, shrinkToByteLimit, type ImageFormat } from './image-fit';

/**
 * Re-encodes an image into the cache when it is too large to send as-is. Returns null when the
 * original bytes can be sent unchanged. The caller owns the returned file.
 */
export async function fitImage(source: { uri: string; mimeType: string; bytes: number }): Promise<{ uri: string; format: ImageFormat } | null> {
  let image = await ImageManipulator.manipulate(source.uri).renderAsync();
  try {
    const format = imageFitFormat({ ...source, width: image.width, height: image.height });
    if (format === null) return null;
    let size = fitImageSize(image);
    for (let shrinks = 0; ; shrinks += 1) {
      if (size !== null) {
        const resized = await ImageManipulator.manipulate(image).resize(size).renderAsync();
        image.release();
        image = resized;
      }
      const saved = await image.saveAsync({ format: format === 'png' ? SaveFormat.PNG : SaveFormat.JPEG, compress: IMAGE_JPEG_QUALITY });
      const file = new File(saved.uri);
      size = shrinks < MAX_BYTE_LIMIT_SHRINKS ? shrinkToByteLimit(image, file.size) : null;
      if (size === null) return { uri: saved.uri, format };
      file.delete();
    }
  } finally {
    image.release();
  }
}
