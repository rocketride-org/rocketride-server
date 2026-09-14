/**
 * Creates an RFC 4122 version 4 UUID in browsers served from either secure or
 * local-development origins. `crypto.randomUUID` is restricted to secure
 * contexts, while `crypto.getRandomValues` remains available for HTTP-based
 * development hosts such as LAN and Tailscale addresses.
 */
export function randomUuid(): string {
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
	return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}
