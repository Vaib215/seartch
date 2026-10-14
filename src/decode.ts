/**
 * Decodes using the charset from the Content-Type header or a <meta> tag,
 * since res.text() always assumes UTF-8.
 */
export async function decodeBody(res: Response, contentType: string): Promise<string> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    // Byte-for-byte decode of the head is enough to read an ASCII meta tag.
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
