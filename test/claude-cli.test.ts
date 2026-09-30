import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { claudeAddCommand, claudeMcpAdd } from "../src/claude-cli";

/**
 * The URL `claude mcp add` receives may still hold shell metacharacters after
 * canonicalisation (`'`, `;`, `$` survive in a path), so no path may hand it to
 * a shell as text it can interpret.
 */

const child = vi.hoisted(() => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock("node:child_process", () => child);

const HOSTILE = "https://example.com/';id;#";
const PLAIN = "https://mcp.backrefs.com/";

function onPlatform(name: NodeJS.Platform): void {
  vi.spyOn(process, "platform", "get").mockReturnValue(name);
}

beforeEach(() => {
  // Both answer success through their callback, whatever they were given.
  const succeed = (...args: unknown[]) => {
    (args.at(-1) as (error: null, stdout: string, stderr: string) => void)(null, "", "");
  };
  child.exec.mockReset().mockImplementation(succeed);
  child.execFile.mockReset().mockImplementation(succeed);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("claudeMcpAdd", () => {
  it("passes the URL as one argument with no shell on POSIX", async () => {
    onPlatform("linux");

    await claudeMcpAdd(HOSTILE);

    expect(child.exec).not.toHaveBeenCalled();
    const [file, args, options] = child.execFile.mock.calls[0] ?? [];
    expect(file).toBe("claude");
    expect(args).toEqual(["mcp", "add", "--transport", "http", "backrefs", "--scope", "user", HOSTILE]);
    expect(options).not.toHaveProperty("shell");
  });

  it("runs nothing on Windows for a URL the shell would interpret", async () => {
    onPlatform("win32");

    const result = await claudeMcpAdd(HOSTILE);

    expect(result).toMatchObject({ ok: false, exists: false });
    expect(child.exec).not.toHaveBeenCalled();
    expect(child.execFile).not.toHaveBeenCalled();
  });

  it("runs a plain URL through the Windows shell, where the npm shim needs one", async () => {
    onPlatform("win32");

    await claudeMcpAdd(PLAIN);

    expect(child.exec.mock.calls[0]?.[0]).toBe(
      `claude mcp add --transport http backrefs --scope user "${PLAIN}"`,
    );
  });

  it("reports an existing entry apart from other failures", async () => {
    onPlatform("linux");
    child.execFile.mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error, stdout: string, stderr: string) => void)(
        new Error("exit 1"),
        "",
        "MCP server backrefs already exists in user config",
      );
    });

    expect(await claudeMcpAdd(PLAIN)).toMatchObject({ ok: false, exists: true });
  });
});

describe("claudeAddCommand", () => {
  it("prints a POSIX command whose quoting survives an apostrophe", () => {
    onPlatform("linux");

    expect(claudeAddCommand(HOSTILE)).toBe(
      `claude mcp add --transport http backrefs --scope user 'https://example.com/'\\'';id;#'`,
    );
  });
});
