import { exec, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SERVER_KEY } from "./contract";
import { PLAIN_URL } from "./url";

/**
 * Claude Code registers remote servers through its own CLI, so for that host
 * the installer runs `claude mcp add` rather than editing `~/.claude.json`.
 *
 * assertSafeUrl admits only PLAIN_URL characters, and this module checks
 * again rather than trust its caller: POSIX runs `claude` with an argument list
 * and no shell, and Windows — where `claude` is often an npm `.cmd` shim that
 * only a shell can start — runs a command string that PLAIN_URL keeps inert.
 */

/** --scope user matches the user-level files written for every other host. */
function addArgs(url: string): string[] {
  return ["mcp", "add", "--transport", "http", SERVER_KEY, "--scope", "user", url];
}

/**
 * The command as a user would type it: POSIX single quotes, Windows double
 * quotes. Either is inert only for a PLAIN_URL, which is all assertSafeUrl lets
 * through; the POSIX form escapes `'` anyway, since it costs nothing.
 */
export function claudeAddCommand(url: string): string {
  const quoted =
    process.platform === "win32" ? `"${url}"` : `'${url.replaceAll("'", `'\\''`)}'`;
  return `claude ${addArgs(url).slice(0, -1).join(" ")} ${quoted}`;
}

export type ClaudeAddResult = { ok: true } | { ok: false; exists: boolean; reason: string };

/**
 * Folders where a LOCAL-scope `backrefs` entry exists. Claude Code ranks local
 * above user scope, so there the new user entry is shadowed and `/mcp` keeps
 * showing the old one — `claude mcp add --scope user` succeeds regardless.
 * Read-only: ~/.claude.json is Claude Code's file, never written from here.
 */
export async function shadowingLocalEntries(): Promise<string[]> {
  let config: unknown;
  try {
    config = JSON.parse(await fs.readFile(join(homedir(), ".claude.json"), "utf8"));
  } catch {
    return [];
  }
  const projects = (config as { projects?: unknown }).projects;
  if (typeof projects !== "object" || projects === null) return [];
  return Object.entries(projects)
    .filter(([, project]) => {
      const servers = (project as { mcpServers?: unknown } | null)?.mcpServers;
      return typeof servers === "object" && servers !== null && Object.hasOwn(servers, SERVER_KEY);
    })
    .map(([path]) => path);
}

/**
 * Run `claude mcp add` for a credential-free entry. Never throws: a failure
 * comes back with its reason so the caller can print the command instead.
 */
export function claudeMcpAdd(url: string): Promise<ClaudeAddResult> {
  const windows = process.platform === "win32";
  if (windows && !PLAIN_URL.test(url)) {
    return Promise.resolve({
      ok: false,
      exists: false,
      reason: "the URL has characters the Windows shell would interpret",
    });
  }
  return new Promise((resolve) => {
    const done = (error: Error | null, stdout: string, stderr: string): void => {
      if (!error) return resolve({ ok: true });
      const output = `${stderr}\n${stdout}`;
      const reason =
        output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ?? error.message;
      resolve({ ok: false, exists: /already exists/i.test(output), reason });
    };
    const options = { timeout: 30_000, windowsHide: true };
    // Windows: one command string through the shell (an argument list with
    // `shell` is deprecated), safe only because PLAIN_URL admitted the URL.
    if (windows) exec(claudeAddCommand(url), options, done);
    else execFile("claude", addArgs(url), options, done);
  });
}
