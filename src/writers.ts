import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { parse as parseToml } from "smol-toml";

import { SERVER_KEY } from "./contract";
import { jsonEntry, tomlBlock, type InstallTarget } from "./entry";
import { displayPath, type Host } from "./hosts";

/**
 * Config-file mutation. Every function here edits a file the USER owns and may
 * have hand-tuned, so two rules hold throughout: never drop a key we don't
 * understand, and never leave a half-written file behind.
 */

export interface WriteResult {
  /** What the file would contain / now contains. Written, never printed. */
  preview: string;
  /**
   * The part this run changes, for --dry-run to print. Never the whole file:
   * that holds the user's OTHER servers, credentials included, and a dry run's
   * output lands in terminals, CI logs and agent transcripts.
   */
  change?: string;
  /** True when the file already had a usable entry and we changed nothing. */
  skipped?: boolean;
  note?: string;
}

/**
 * Write via a temp file + rename so an interrupted run cannot truncate a
 * working config. 0600 because an entry can carry an access token in an
 * `Authorization` header.
 */
export async function atomicWrite(path: string, contents: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  // Through a symlink, not over it: dotfile managers (stow, chezmoi) link these
  // configs, and renaming onto the link would swap it for a plain file.
  const target = await fs.realpath(path).catch(() => path);
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

/** How a JSON config was written, so a rewrite keeps it rather than reformatting it. */
interface JsonStyle {
  bom: boolean;
  eol: string;
  indent: string;
}

const DEFAULT_STYLE: JsonStyle = { bom: false, eol: "\n", indent: "  " };

async function readJson(
  path: string,
): Promise<{ config: Record<string, unknown>; style: JsonStyle }> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: {}, style: DEFAULT_STYLE };
    }
    throw error;
  }
  // A BOM is what PowerShell 5.1's `-Encoding utf8` writes; JSON.parse rejects it.
  const bom = raw.startsWith("﻿");
  const text = bom ? raw.slice(1) : raw;
  const style: JsonStyle = {
    bom,
    eol: dominantEol(text),
    indent: /^([ \t]+)\S/m.exec(text)?.[1] ?? DEFAULT_STYLE.indent,
  };
  if (text.trim() === "") return { config: {}, style };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Refusing beats guessing: the file may be mid-edit, or JSONC — VS Code's
    // mcp.json allows comments and trailing commas — and a rewrite through
    // JSON.stringify would drop every comment the user wrote.
    throw new Error(
      `${displayPath(path)} is not plain JSON (a comment or a trailing comma, perhaps). ` +
        "Rewriting it would lose them, so nothing was written — add the entry by hand",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${displayPath(path)}: expected a JSON object at the root`);
  }
  return { config: parsed as Record<string, unknown>, style };
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
/** A stdio entry's launch fields, which mean nothing to a remote server. */
const STDIO_FIELDS = ["command", "args", "env", "envFile", "cwd", "type"];

/** Every field a host reads the remote endpoint from. */
const ENDPOINT_FIELDS = ["url", "serverUrl", "httpUrl"];

/**
 * Fields that grant something to the server an entry points at: a credential
 * (`headers`, `oauth`) or a skipped confirmation (Gemini's `trust`, the
 * `autoApprove`/`alwaysAllow` lists other hosts use).
 */
const GRANT_FIELDS = ["headers", "oauth", "trust", "autoApprove", "alwaysAllow"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function withoutAuthorization(
  headers: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== "authorization"),
  );
}

export async function writeJsonConfig(
  host: Host,
  path: string,
  target: InstallTarget,
): Promise<WriteResult> {
  const rootKey = host.format === "json-vscode" ? "servers" : "mcpServers";
  const { config, style } = await readJson(path);
  const servers = assertObject(config[rootKey], path, rootKey);
  const entry = jsonEntry(host, target);
  const previous = servers[SERVER_KEY];
  let note: string | undefined;

  if (isPlainObject(previous)) {
    const wasStdio = previous.command !== undefined || previous.args !== undefined;
    const toOrigin = originOf(target.url);
    const endpoints = ENDPOINT_FIELDS.flatMap((field) => {
      const value = previous[field];
      return typeof value === "string" ? [value] : [];
    });
    // The SAME server only when every endpoint the entry names is on our
    // origin. Hosts disagree on which of url/serverUrl/httpUrl wins, so one
    // matching field is not enough.
    const sameServer =
      !wasStdio && endpoints.length > 0 && endpoints.every((url) => originOf(url) === toOrigin);
    if (!sameServer) {
      // What the user granted the server this entry points at now must not pass
      // to a different one without a decision of theirs: a header or an oauth
      // block may be its credential, and trust/autoApprove skip the host's own
      // confirmation for its tools. A failure, not a skip — the run was asked
      // to point this host somewhere and did not.
      const carried = GRANT_FIELDS.filter((field) => {
        const value = previous[field];
        return value !== undefined && !(isPlainObject(value) && Object.keys(value).length === 0);
      });
      if (carried.length > 0) {
        throw new Error(
          `${displayPath(path)}: the ${SERVER_KEY} entry points at another server and carries ` +
            `${carried.join(", ")}, which were granted to that server. They must not pass to ` +
            `${toOrigin ?? target.url} without your say — remove the entry (or those fields) ` +
            "and re-run",
        );
      }
    }
    // Every endpoint alias goes, so the entry names exactly one; the launch
    // fields go when it was a local process — a host given both shapes picks
    // the wrong one. Everything else (`disabled`, the host's own settings) stays.
    const replaced = [...ENDPOINT_FIELDS, ...(wasStdio ? STDIO_FIELDS : [])];
    const kept = Object.fromEntries(
      Object.entries(previous).filter(([field]) => !replaced.includes(field)),
    );
    const previousHeaders =
      sameServer && isPlainObject(previous.headers) ? previous.headers : undefined;
    // Header by header: a new bearer replaces only Authorization (in any
    // case), never the user's other headers.
    const headers =
      entry.headers === undefined
        ? previousHeaders
        : { ...withoutAuthorization(previousHeaders), ...(entry.headers as object) };
    servers[SERVER_KEY] = {
      ...kept,
      ...entry,
      ...(headers === undefined ? {} : { headers }),
    };
    note = wasStdio
      ? "replaced the previous stdio entry — a host given both shapes picks the wrong one; " +
        "its other fields were kept"
      : "updated the existing entry (other fields preserved)";
  } else {
    if (previous !== undefined) note = "replaced a malformed entry";
    servers[SERVER_KEY] = entry;
  }

  config[rootKey] = servers;
  const serialized = JSON.stringify(config, null, style.indent).replaceAll("\n", style.eol);
  const contents = `${style.bom ? "﻿" : ""}${serialized}${style.eol}`;
  const change = JSON.stringify(
    { [rootKey]: { [SERVER_KEY]: previewEntry(servers[SERVER_KEY], entry) } },
    null,
    2,
  );
  return { preview: contents, change: `${change}\n`, note };
}

/** Stands in for a value this run keeps but does not show. */
const KEPT = "<kept, not shown>";

/**
 * The merged entry as a dry run shows it: the values this run sets, and only
 * the NAMES of everything it keeps. A kept field is the user's — an `env` block,
 * a header, anything — and may be a credential for all we know. What we set is
 * shown, which on a dry run is the key's placeholder, never a key.
 */
function previewEntry(merged: unknown, ours: Record<string, unknown>): unknown {
  if (!isPlainObject(merged)) return merged;
  const oursHeaders = isPlainObject(ours.headers) ? ours.headers : {};
  return Object.fromEntries(
    Object.entries(merged).map(([key, value]) => {
      if (key === "headers" && isPlainObject(value)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, header]) => [
              name,
              Object.hasOwn(oursHeaders, name) ? header : KEPT,
            ]),
          ),
        ];
      }
      return [key, Object.hasOwn(ours, key) ? value : KEPT];
    }),
  );
}

/**
 * Whether the config already defines `mcp_servers.backrefs`, in any spelling
 * TOML allows — bare, quoted or dotted keys, a table header, an inline table.
 * Parsed rather than pattern-matched because every one of those is the same
 * key, and Codex rejects a redefinition by failing the WHOLE config, not just
 * our block. Throws on a file that is not valid TOML.
 */
export function codexHasEntry(text: string): boolean {
  const servers = parseToml(text).mcp_servers;
  return isPlainObject(servers) && Object.hasOwn(servers, SERVER_KEY);
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
  let hasEntry: boolean;
  try {
    hasEntry = codexHasEntry(existing);
  } catch (error) {
    // A failure, not a skip: nothing was configured, and Codex cannot load the
    // file either, so the run must not exit as if it had succeeded.
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(
      `${displayPath(path)} is not valid TOML (${detail}). Codex cannot load it either — ` +
        "fix the file and re-run",
    );
  }
  if (hasEntry) {
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
  const next = existing + separator + block + eol;
  // Appending is only safe if the result still parses: a file that already
  // holds `mcp_servers` as an inline table or a plain value cannot take a
  // `[mcp_servers.backrefs]` header, and Codex would reject the whole config.
  let registered: boolean;
  try {
    registered = codexHasEntry(next);
  } catch {
    registered = false;
  }
  if (!registered) {
    throw new Error(
      `${displayPath(path)} defines mcp_servers in a form a [mcp_servers.${SERVER_KEY}] table ` +
        "cannot be added to. Nothing was written — add the entry by hand",
    );
  }
  // Appended, never merged, so the change is exactly the block — which names
  // the key's environment variable and never holds a key.
  return { preview: next, change: block + eol };
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
