export async function computeAssetId(blobOrArrayBuffer) {
  let arrayBuffer;

  if (blobOrArrayBuffer instanceof ArrayBuffer) {
    arrayBuffer = blobOrArrayBuffer;
  } else if (blobOrArrayBuffer instanceof Blob || blobOrArrayBuffer instanceof File) {
    arrayBuffer = await blobOrArrayBuffer.arrayBuffer();
  } else {
    throw new Error(`computeAssetId: unsupported input type. Expected Blob, File, or ArrayBuffer, got ${typeof blobOrArrayBuffer}`);
  }

  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256-${hashHex}`;
}
