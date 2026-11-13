// Read the pixel size of a base64 PNG or JPEG without decoding it.
//
// screenshot reports bitmap size next to the CSS viewport so an agent can turn
// image pixels into click coordinates. The size is measured from the bytes
// Chrome actually returned, not assumed from the requested scale: on a 125%
// display a "60%" capture used to come back at 75% and every click drifted.
export function imageSize(b64) {
  // The header fits in the first few KB; decode a prefix whose length is a
  // multiple of 4 so atob accepts it.
  const head = String(b64 || '').slice(0, 65536);
  const bin = atob(head.slice(0, head.length - (head.length % 4)));
  const at = (i) => bin.charCodeAt(i);
  // PNG: 8-byte signature, then IHDR with big-endian width/height.
  if (bin.length >= 24 && at(0) === 0x89 && bin.slice(1, 4) === 'PNG') {
    const u32 = (i) => ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0;
    return { width: u32(16), height: u32(20) };
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < bin.length) {
      if (at(i) !== 0xff) { i++; continue; }
      const m = at(i + 1);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { width: (at(i + 7) << 8) | at(i + 8), height: (at(i + 5) << 8) | at(i + 6) };
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + ((at(i + 2) << 8) | at(i + 3));
    }
  }
  return null;
}
