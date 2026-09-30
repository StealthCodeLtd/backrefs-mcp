import { SERVER_KEY, TOKEN_ENV_VAR } from "./contract";
import type { Host } from "./hosts";

/**
 * Builds the per-host config fragment for one server entry.
 *
 * One transport — the hosted server over http — and three ways to
 * authenticate over it:
 *
 *  - no key, at the bare origin: the host signs the user in through their
 *    browser (OAuth). Nothing secret is written. The default.
 *  - no key, at `/mcp-headless` (`--headless`): the AGENT signs itself in with
 *    `backrefs_login`, storing what a human approves from some other device.
 *  - a key, which only `login` supplies: sent as a bearer on every request.
 *
 * Only the key distinguishes these shapes HERE: `--headless` is carried in the
 * url the caller passes, so this file writes the same entry either way.
 *
 * Every format writes the bearer where its schema allows a header. Codex is
 * the exception: it takes the NAME of an environment variable and reads the key
 * itself at startup, so its config holds no secret.
 */

export interface InstallTarget {
  /** The hosted MCP endpoint. */
  url: string;
  /** A `brf_…` key minted by `login`. Absent: the host signs in by itself. */
  token?: string;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** The JSON object a `mcpServers` / `servers` key maps the server name to. */
export function jsonEntry(host: Host, target: InstallTarget): Record<string, unknown> {
  const headers = target.token === undefined ? {} : { headers: authHeaders(target.token) };
  // VS Code is explicit about transport; the others infer it from the keys.
  if (host.format === "json-vscode") return { type: "http", url: target.url, ...headers };
  const field = host.urlField ?? "url";
  return { [field]: target.url, ...headers };
}

/** The TOML block Codex appends. */
export function tomlBlock(target: InstallTarget, eol: string): string {
  const lines = [`[mcp_servers.${SERVER_KEY}]`, `url = ${tomlString(target.url)}`];
  // Codex reads the variable itself at startup, so what goes in the file is
  // its NAME. It is the only shape Codex accepts for a bearer.
  if (target.token !== undefined) {
    lines.push(`bearer_token_env_var = ${tomlString(TOKEN_ENV_VAR)}`);
  }
  return lines.join(eol);
}

/**
 * Whether the entry written for a host CARRIES the key, rather than naming an
 * environment variable the host reads for itself.
 *
 * `login` reads this to tell "the key has a home now" from "a file changed",
 * because it minted that key and a run that stored it nowhere has thrown it
 * away — so a wrong answer here loses a live credential. It therefore ASKS THE
 * BUILDERS instead of restating what they do, so a new host or format is
 * covered by construction.
 */
export function entryHoldsToken(host: Host, target: InstallTarget): boolean {
  if (target.token === undefined) return false;
  const written =
    host.format === "toml-codex"
      ? tomlBlock(target, "\n")
      : JSON.stringify(jsonEntry(host, target));
  return written.includes(target.token);
}

/**
 * TOML basic strings use JSON's escaping rules for `"`, `\`, and control
 * characters, so JSON.stringify produces a correctly quoted TOML string.
 */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}
