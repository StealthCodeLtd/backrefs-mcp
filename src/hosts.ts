import { promises as fs } from "node:fs";
import { homedir, platform } from "node:os";
import { join, delimiter as PATH_DELIMITER, relative } from "node:path";

/**
 * The MCP hosts this installer knows how to configure.
 *
 * Every field name below is load-bearing and host-specific — there is no shared
 * schema across hosts, and a wrong field name produces a config the host reads
 * without error and then ignores. That silent-failure mode is why the URL field
 * is declared per host rather than assumed:
 *
 *   Cursor      mcpServers.<k>.url
 *   Windsurf    mcpServers.<k>.serverUrl   ← NOT `url`; `url` is ignored
 *   Gemini CLI  mcpServers.<k>.httpUrl     ← `url` there means SSE, not HTTP
 *   VS Code     servers.<k>.{ type: "http", url }   ← `servers`, not `mcpServers`
 *   Codex       [mcp_servers.<k>] url = …  (TOML)
 */

export const HOST_IDS = [
  "claude-code",
  "claude-desktop",
  "codex",
  "cursor",
  "gemini-cli",
  "vscode",
  "windsurf",
] as const;
export type HostId = (typeof HOST_IDS)[number];

/** How a host's config file is shaped. `null` = we print steps, write nothing. */
export type ConfigFormat = "json-mcp-servers" | "json-vscode" | "toml-codex" | null;

export interface Host {
  id: HostId;
  label: string;
  format: ConfigFormat;
  /** Where the config lives. Null for instruction-only hosts. */
  configPath: (() => string) | null;
  /** Which field carries the endpoint. Only for `json-mcp-servers`. */
  urlField?: "url" | "serverUrl" | "httpUrl";
  /** Is this host installed on this machine? */
  detect: () => Promise<boolean>;
  /**
   * Why we deliberately do NOT write a file for this host. Some hosts register
   * remote servers only through their own UI or CLI, where hand-editing the
   * config silently does nothing.
   */
  manual?: string;
}

/** Whether this host is a file write or printed steps. */
export function writeMode(host: Host): "file" | "manual" {
  if (host.manual !== undefined) return "manual";
  return host.configPath ? "file" : "manual";
}

function claudeDesktopDir(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "Claude");
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude");
  }
  return join(homedir(), ".config", "Claude");
}

/**
 * VS Code's user-profile config directory. Servers written here apply across
 * every workspace. Named (non-default) profiles keep their own copy under
 * `User/profiles/<id>/`, which this installer does not touch — a user on a
 * custom profile has to run "MCP: Open User Configuration" and paste.
 */
function vscodeUserDir(): string {
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "Code", "User");
  }
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Code", "User");
  }
  return join(homedir(), ".config", "Code", "User");
}

export function pathFor(host: Host): string {
  if (!host.configPath) throw new Error(`internal: ${host.id} has no config path`);
  return host.configPath();
}

/**
 * Strip $HOME from a path before printing it. Installer output ends up in
 * screenshots, CI logs, and bug reports; the OS username adds nothing there.
 */
export function displayPath(target: string): string {
  const rel = relative(homedir(), target);
  if (!rel.startsWith("..") && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel)) {
    return `~${rel ? `/${rel.replaceAll("\\", "/")}` : ""}`;
  }
  return target;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    // A permission error means the path may well exist but is unreadable.
    // Treat it as absent for detection, but say so — a silently skipped host
    // looks identical to one that isn't installed.
    process.stderr.write(
      `backrefs: cannot stat ${displayPath(target)}: ${code ?? "unknown error"} (treating as absent)\n`,
    );
    return false;
  }
}

/**
 * Is `name` an executable on PATH? Config directories outlive uninstalls and
 * are created by one-shot `npx` runs, so for CLI hosts the binary is the
 * honest signal.
 */
async function commandExists(name: string): Promise<boolean> {
  const searchPath = process.env.PATH;
  if (!searchPath) return false;
  const extensions =
    platform() === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of searchPath.split(PATH_DELIMITER)) {
    if (!dir) continue;
    for (const extension of extensions) {
      try {
        const stat = await fs.stat(join(dir, name + extension.toLowerCase()));
        if (stat.isFile()) return true;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return false;
}

export const HOSTS: Record<HostId, Host> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    format: null,
    configPath: null,
    // Both signals required: ~/.claude.json survives an uninstall and is also
    // written by a one-shot `npx claude`, so on its own it is too noisy.
    detect: async () =>
      (await pathExists(join(homedir(), ".claude.json"))) && commandExists("claude"),
    manual: "`claude mcp add` is first-class here and more reliable than editing the config",
  },
  "claude-desktop": {
    id: "claude-desktop",
    label: "Claude Desktop",
    format: "json-mcp-servers",
    urlField: "url",
    configPath: () => join(claudeDesktopDir(), "claude_desktop_config.json"),
    detect: () => pathExists(claudeDesktopDir()),
    // claude_desktop_config.json registers LOCAL servers only. A remote one
    // written there is read and ignored, so the install looks done and isn't.
    manual:
      "remote servers are added through Customize → Connectors; claude_desktop_config.json only registers local (stdio) servers",
  },
  "codex": {
    id: "codex",
    label: "Codex CLI",
    format: "toml-codex",
    configPath: () => join(homedir(), ".codex", "config.toml"),
    detect: () => pathExists(join(homedir(), ".codex")),
  },
  "cursor": {
    id: "cursor",
    label: "Cursor",
    format: "json-mcp-servers",
    urlField: "url",
    configPath: () => join(homedir(), ".cursor", "mcp.json"),
    detect: () => pathExists(join(homedir(), ".cursor")),
  },
  "gemini-cli": {
    id: "gemini-cli",
    label: "Gemini CLI",
    format: "json-mcp-servers",
    // `url` in Gemini CLI means an SSE endpoint. Streamable HTTP is `httpUrl`.
    urlField: "httpUrl",
    configPath: () => join(homedir(), ".gemini", "settings.json"),
    detect: () => pathExists(join(homedir(), ".gemini")),
  },
  "vscode": {
    id: "vscode",
    label: "VS Code",
    format: "json-vscode",
    configPath: () => join(vscodeUserDir(), "mcp.json"),
    detect: () => pathExists(vscodeUserDir()),
  },
  "windsurf": {
    id: "windsurf",
    label: "Windsurf",
    format: "json-mcp-servers",
    // Windsurf reads `serverUrl` for remote servers. A `url` key is accepted by
    // the JSON parser and then ignored, which looks like a working install.
    urlField: "serverUrl",
    configPath: () => join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
    detect: () => pathExists(join(homedir(), ".codeium", "windsurf")),
  },
};

export function hostList(): Host[] {
  return HOST_IDS.map((id) => HOSTS[id]);
}
