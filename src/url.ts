/**
 * Plain http is allowed only for loopback, for the MCP endpoint and the api
 * alike: over the open internet it would carry the bearer token, the device
 * code and the key that code is exchanged for in clear text.
 */
/**
 * The only characters an endpoint URL may hold once canonicalised. None of them
 * means anything to cmd.exe, PowerShell or a POSIX shell, inside double quotes
 * or out, and none needs escaping in JSON or TOML — so the URL is safe in every
 * command this package prints or runs and every file it writes. `$`, `%`, `&`,
 * `'`, backtick and the rest are refused rather than quoted per shell: a pasted
 * command runs in whichever shell the user has open, which nothing here knows.
 */
export const PLAIN_URL = /^[A-Za-z0-9\-._~:/?=]+$/;

export function isLoopback(hostname: string): boolean {
  const named = ["localhost", "127.0.0.1", "::1", "[::1]"];
  return named.includes(hostname) || hostname.endsWith(".localhost");
}
