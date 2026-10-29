import test from 'node:test';
import assert from 'node:assert/strict';
import { fitImageSize, imageFitFormat, imageNameForFormat, MAX_IMAGE_BYTES, shrinkToByteLimit } from './image-fit.ts';

test('the long edge is capped at 2000px and the aspect ratio is kept', () => {
  assert.deepEqual(fitImageSize({ width: 4032, height: 3024 }), { width: 2000, height: 1500 });
  assert.deepEqual(fitImageSize({ width: 1668, height: 2388 }), { width: 1397, height: 2000 });
  assert.deepEqual(fitImageSize({ width: 100_000, height: 1 }), { width: 2000, height: 1 });
  assert.equal(fitImageSize({ width: 2000, height: 1200 }), null);
});

test('a re-encode over the byte cap shrinks by pixel count until it fits', () => {
  const size = { width: 1397, height: 2000 };
  const next = shrinkToByteLimit(size, size.width * size.height * 4);
  assert.ok(next && next.width < size.width && next.height < size.height);
  assert.ok(next.width * next.height * 4 <= MAX_IMAGE_BYTES);
  assert.equal(shrinkToByteLimit(size, MAX_IMAGE_BYTES), null);
  assert.equal(shrinkToByteLimit({ width: 1, height: 1 }, MAX_IMAGE_BYTES * 2), null);
});

test('small originals pass through and everything else is re-encoded', () => {
  const small = { width: 1200, height: 800, bytes: 400_000 };
  const large = { width: 4032, height: 3024, bytes: 400_000 };
  assert.equal(imageFitFormat({ ...small, mimeType: 'image/png' }), null);
  assert.equal(imageFitFormat({ ...small, mimeType: 'image/jpg' }), null);
  assert.equal(imageFitFormat({ ...large, mimeType: 'image/gif' }), null);
  assert.equal(imageFitFormat({ ...large, mimeType: 'image/png' }), 'png');
  assert.equal(imageFitFormat({ ...large, mimeType: 'image/jpeg' }), 'jpeg');
  assert.equal(imageFitFormat({ ...small, mimeType: 'image/png', bytes: MAX_IMAGE_BYTES + 1 }), 'png');
  assert.equal(imageFitFormat({ ...small, mimeType: 'image/heic' }), 'jpeg');
  assert.equal(imageFitFormat({ ...small, mimeType: 'image/gif', bytes: MAX_IMAGE_BYTES + 1 }), 'jpeg');
});

test('a re-encoded image takes its new extension', () => {
  assert.equal(imageNameForFormat('IMG_0001.HEIC', 'jpeg'), 'IMG_0001.jpg');
  assert.equal(imageNameForFormat('IMG_0001.JPEG', 'jpeg'), 'IMG_0001.JPEG');
  assert.equal(imageNameForFormat('shot.png', 'png'), 'shot.png');
  assert.equal(imageNameForFormat('photo', 'jpeg'), 'photo.jpg');
});
