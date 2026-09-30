import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { SERVER_KEY } from "./contract";
import { jsonEntry, tomlBlock, type InstallTarget } from "./entry";
import { displayPath, type Host } from "./hosts";

/**
 * Config-file mutation. Every function here edits a file the USER owns and may
 * have hand-tuned, so two rules hold throughout: never drop a key we don't
 * understand, and never leave a half-written file behind.
 */

export interface WriteResult {
  /** What the file would contain / now contains. Used by --dry-run. */
  preview: string;
  /** True when the file already had a usable entry and we changed nothing. */
  skipped?: boolean;
  note?: string;
}

/**
 * Write via a temp file + rename so an interrupted run cannot truncate a
 * working config. 0600 because an entry can carry an access token in an
 * `Authorization` header.
 */
export async function atomicWrite(target: string, contents: string): Promise<void> {
  await fs.mkdir(dirname(target), { recursive: true });
  const temp = `${target}.backrefs.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, contents, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  // Windows ignores the mode argument (its permissions are ACL-based), so the
  // explicit chmod is POSIX-only and best-effort.
  if (process.platform !== "win32") await fs.chmod(target, 0o600).catch(() => undefined);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Refusing beats guessing: a host config that fails to parse may be
    // mid-edit or may use JSONC, and overwriting it would destroy real work.
    throw new Error(`${displayPath(path)} is not valid JSON — fix or move it, then re-run`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${displayPath(path)}: expected a JSON object at the root`);
  }
  return parsed as Record<string, unknown>;
}

function assertObject(value: unknown, path: string, key: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${displayPath(path)}: "${key}" must be an object`);
  }
  return { ...(value as Record<string, unknown>) };
}

/**
 * Merge one server entry into a JSON host config.
 *
 * The subtle case is a PRE-EXISTING local (stdio) entry, written by hand or by
 * another tool. A host handed both `command` and a url field generally picks
 * `command` and ignores the url, so merging the two shapes yields a config that
 * looks updated and connects to the wrong thing. Such an entry is replaced
 * wholesale and the replacement is announced. Otherwise unknown keys the user
 * added (headers, timeout, disabled) are preserved.
 */
export async function writeJsonConfig(
  host: Host,
  path: string,
  target: InstallTarget,
): Promise<WriteResult> {
  const rootKey = host.format === "json-vscode" ? "servers" : "mcpServers";
  const config = await readJson(path);
  const servers = assertObject(config[rootKey], path, rootKey);
  const entry = jsonEntry(host, target);
  const previous = servers[SERVER_KEY];
  let note: string | undefined;

  if (typeof previous === "object" && previous !== null && !Array.isArray(previous)) {
    const previousEntry = previous as Record<string, unknown>;
    const wasStdio = previousEntry.command !== undefined || previousEntry.args !== undefined;
    if (wasStdio) {
      servers[SERVER_KEY] = entry;
      note = "replaced the previous stdio entry — a host given both shapes picks the wrong one";
    } else {
      servers[SERVER_KEY] = { ...previousEntry, ...entry };
      note = "updated the existing entry (other fields preserved)";
    }
  } else {
    if (previous !== undefined) note = "replaced a malformed entry";
    servers[SERVER_KEY] = entry;
  }

  config[rootKey] = servers;
  const contents = `${JSON.stringify(config, null, 2)}\n`;
  return { preview: contents, note };
}

/**
 * The three TOML spellings of the same table. Codex's parser rejects a
 * redefinition and then fails the WHOLE config, not just our block, so any hit
 * here means we must not append.
 */
const CODEX_ENTRY_PATTERNS = [
  new RegExp(String.raw`^\s*\[mcp_servers\.${SERVER_KEY}\s*\]`, "m"),
  new RegExp(String.raw`^\s*mcp_servers\s*\.\s*${SERVER_KEY}\s*=`, "m"),
  new RegExp(String.raw`^\s*mcp_servers\s*\.\s*${SERVER_KEY}\s*\.`, "m"),
];

export function codexHasEntry(text: string): boolean {
  return CODEX_ENTRY_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Append the Codex block, preserving the file's dominant line ending — a
 * mostly-CRLF config rewritten with LF shows up as a whole-file diff.
 * "Any CRLF wins" would misread a mostly-LF file that picked up one stray
 * CRLF from a paste, so the vote is by majority.
 */
export function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

export async function writeCodexConfig(path: string, target: InstallTarget): Promise<WriteResult> {
  let existing = "";
  try {
    existing = await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (codexHasEntry(existing)) {
    return {
      preview: existing,
      skipped: true,
      note:
        `already defines mcp_servers.${SERVER_KEY}. Codex fails to load a config with a ` +
        "duplicate table, so nothing was appended — remove the existing block and re-run, " +
        "or edit it by hand",
    };
  }
  const eol = dominantEol(existing);
  const block = tomlBlock(target, eol);
  // Land the block after exactly one blank line, whatever the file ended with.
  let separator = "";
  if (existing.length > 0 && !existing.endsWith(eol + eol)) {
    separator = existing.endsWith(eol) ? eol : eol + eol;
  }
  return { preview: existing + separator + block + eol };
}

/** Produce the file contents for a host without touching the disk. */
export async function planWrite(
  host: Host,
  path: string,
  target: InstallTarget,
): Promise<WriteResult> {
  if (host.format === "toml-codex") return writeCodexConfig(path, target);
  return writeJsonConfig(host, path, target);
}
