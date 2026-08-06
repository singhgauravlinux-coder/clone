/** btoa/atob only handle latin1, so round-trip through UTF-8 bytes. */

export function encodeBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

export function decodeBase64(input: string): string {
  try {
    const binary = atob(input);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return input;
  }
}

export function isBase64(input: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(input.replace(/\s+/g, '')) && input.trim().length % 4 === 0;
}
