// screenshot reports the bitmap size measured from the image bytes, so the
// agent's pixel → CSS conversion never relies on the requested scale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSize } from '../extension/image-size.js';

// 1×1 PNG and a tiny baseline JPEG header, widened to known sizes.
const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b.toString('base64');
};
const jpeg = (w, h) => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]).toString('base64');
};

test('PNG and JPEG sizes come from the headers', () => {
  assert.deepEqual(imageSize(png(1466, 863)), { width: 1466, height: 863 });
  assert.deepEqual(imageSize(jpeg(880, 518)), { width: 880, height: 518 });
});

test('unknown or empty data gives null instead of a guess', () => {
  assert.equal(imageSize(''), null);
  assert.equal(imageSize(Buffer.from('GIF89a......').toString('base64')), null);
});
