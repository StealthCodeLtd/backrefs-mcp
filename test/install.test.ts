import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { claudeMcpAdd } from "../src/claude-cli";
import { entryHoldsToken, jsonEntry, tomlBlock, type InstallTarget } from "../src/entry";
import { HOSTS, pathFor } from "../src/hosts";
import { assertSafeUrl, headlessUrl, parseArgs, runInstall } from "../src/install";
import { atomicWrite, codexHasEntry, dominantEol, planWrite } from "../src/writers";

/**
 * The installer edits config files the user owns, and every host spells its
 * fields differently. A wrong field name produces a file the host parses
 * happily and then ignores — an install that looks successful and isn't — so
 * the per-host shapes are pinned here rather than trusted to review.
 */

// Never run the real `claude` from a test: it would edit this machine's
// ~/.claude.json. The command text stays real so the printed steps are checked.
vi.mock("../src/claude-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/claude-cli")>()),
  claudeMcpAdd: vi.fn(),
}));

const HTTP: InstallTarget = { url: "https://mcp.backrefs.com/" };
const TOKEN = `brf_${"a".repeat(43)}`;
/**
 * The hosted URL authenticated with a bearer — for a box where nobody will be
 * present to approve anything. NOT the same as `--headless`, which writes no
 * credential at all and leaves the agent to obtain one.
 */
const HTTP_TOKEN: InstallTarget = { ...HTTP, token: TOKEN };

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "backrefs-install-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("per-host endpoint field", () => {
  it.each([
    ["cursor", "url"],
    ["windsurf", "serverUrl"],
    ["gemini-cli", "httpUrl"],
  ] as const)("%s uses %s — the others are read and ignored", (id, field) => {
    expect(jsonEntry(HOSTS[id], HTTP)).toEqual({ [field]: HTTP.url });
  });

  it("vscode declares the transport explicitly", () => {
    expect(jsonEntry(HOSTS.vscode, HTTP)).toEqual({ type: "http", url: HTTP.url });
  });

});

describe("bearer auth over http", () => {
  it.each([
    ["cursor", "url"],
    ["gemini-cli", "httpUrl"],
    ["windsurf", "serverUrl"],
  ] as const)("sends the key as a header for %s", (id, field) => {
    expect(jsonEntry(HOSTS[id], HTTP_TOKEN)).toEqual({
      [field]: HTTP.url,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  it("keeps VS Code's explicit transport alongside the header", () => {
    expect(jsonEntry(HOSTS.vscode, HTTP_TOKEN)).toEqual({
      type: "http",
      url: HTTP.url,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  it("writes no header when there is no token — the host does OAuth instead", () => {
    expect(jsonEntry(HOSTS.cursor, HTTP)).not.toHaveProperty("headers");
  });

  it("gives Codex the variable NAME, so its config holds no secret", () => {
    const block = tomlBlock(HTTP_TOKEN, "\n");

    expect(block).toContain('bearer_token_env_var = "BACKREFS_TOKEN"');
    // The point of the branch: the key itself must not reach the file.
    expect(block).not.toContain(TOKEN);
  });

  it("omits the Codex bearer line entirely without a token", () => {
    expect(tomlBlock(HTTP, "\n")).not.toContain("bearer_token_env_var");
  });
});

describe("json config merging", () => {
  it("creates the file and the root key when absent", async () => {
    const path = join(dir, "mcp.json");
    const { preview } = await planWrite(HOSTS.cursor, path, HTTP);
    expect(JSON.parse(preview)).toEqual({ mcpServers: { backrefs: { url: HTTP.url } } });
  });

  it("uses `servers` for vscode and `mcpServers` for the rest", async () => {
    const vs = await planWrite(HOSTS.vscode, join(dir, "a.json"), HTTP);
    const cursor = await planWrite(HOSTS.cursor, join(dir, "b.json"), HTTP);
    expect(Object.keys(JSON.parse(vs.preview))).toEqual(["servers"]);
    expect(Object.keys(JSON.parse(cursor.preview))).toEqual(["mcpServers"]);
  });

  it("leaves other servers and unrelated top-level keys untouched", async () => {
    const path = join(dir, "mcp.json");
    await fs.writeFile(
      path,
      JSON.stringify({ someOtherKey: 1, mcpServers: { github: { url: "https://gh" } } }),
    );

    const { preview } = await planWrite(HOSTS.cursor, path, HTTP);

    expect(JSON.parse(preview)).toEqual({
      someOtherKey: 1,
      mcpServers: { github: { url: "https://gh" }, backrefs: { url: HTTP.url } },
    });
  });

  it("preserves user-added fields on an existing http entry", async () => {
    const path = join(dir, "mcp.json");
    await fs.writeFile(
      path,
      JSON.stringify({
        // Same origin, other path: the headers were granted to this server.
        mcpServers: {
          backrefs: { url: "https://mcp.backrefs.com/old", headers: { "X-Env": "staging" } },
        },
      }),
    );

    const { preview, note } = await planWrite(HOSTS.cursor, path, HTTP);

    expect(JSON.parse(preview).mcpServers.backrefs).toEqual({
      url: HTTP.url,
      headers: { "X-Env": "staging" },
    });
    expect(note).toContain("preserved");
  });

  it("REPLACES an existing stdio entry — a merged entry would launch the old one", async () => {
    const path = join(dir, "mcp.json");
    await fs.writeFile(
      path,
      JSON.stringify({ mcpServers: { backrefs: { command: "npx", args: ["-y", "old"] } } }),
    );

    const { preview, note } = await planWrite(HOSTS.cursor, path, HTTP);

    expect(JSON.parse(preview).mcpServers.backrefs).toEqual({ url: HTTP.url });
    expect(note).toContain("replaced");
  });

  it("keeps a file's BOM, line endings and indentation", async () => {
    const path = join(dir, "mcp.json");
    await fs.writeFile(path, '﻿{\r\n\t"mcpServers": {}\r\n}\r\n');

    const { preview } = await planWrite(HOSTS.cursor, path, HTTP);

    expect(preview.startsWith("﻿{\r\n\t\"mcpServers\"")).toBe(true);
    expect(preview).not.toMatch(/[^\r]\n/);
  });

  it("writes through a symlinked config instead of replacing the link", async () => {
    const real = join(dir, "real.json");
    const link = join(dir, "mcp.json");
    await fs.writeFile(real, "{}");
    try {
      await fs.symlink(real, link);
    } catch {
      return; // Windows without symlink rights: nothing to check here.
    }

    const { preview } = await planWrite(HOSTS.cursor, link, HTTP);
    await atomicWrite(link, preview);

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(real, "utf8")).toContain(HTTP.url);
  });

  it("keeps a stdio entry's own settings while dropping its launch fields", async () => {
    const path = join(dir, "mcp.json");
    await fs.writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          backrefs: { command: "npx", args: ["old"], env: { API_KEY: "x" }, disabled: true, timeout: 30 },
        },
      }),
    );

    const { preview } = await planWrite(HOSTS.cursor, path, HTTP);

    expect(JSON.parse(preview).mcpServers.backrefs).toEqual({
      url: HTTP.url,
      disabled: true,
      timeout: 30,
    });
  });

  it("refuses to hand a replaced server's approvals to ours", async () => {
    // Gemini's `trust: true` skips every tool confirmation; it was given to the
    // old local server, not to this one.
    const path = join(dir, "settings.json");
    await fs.writeFile(
      path,
      JSON.stringify({ mcpServers: { backrefs: { command: "old-local-server", trust: true } } }),
    );

    await expect(planWrite(HOSTS["gemini-cli"], path, HTTP)).rejects.toThrow(/carries trust/);
  });

  it("judges the server by every endpoint field, not the first one", async () => {
    // Gemini prefers httpUrl; a matching `url` beside it must not vouch for it.
    const path = join(dir, "settings.json");
    await fs.writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          backrefs: {
            url: HTTP.url,
            httpUrl: "https://other.example/",
            headers: { "X-Api-Key": "other-secret" },
          },
        },
      }),
    );

    await expect(planWrite(HOSTS["gemini-cli"], path, HTTP)).rejects.toThrow(/carries headers/);
  });

  it("leaves one endpoint field, so no host reads a stale alias", async () => {
    const path = join(dir, "settings.json");
    await fs.writeFile(
      path,
      JSON.stringify({ mcpServers: { backrefs: { url: HTTP.url, httpUrl: HTTP.url } } }),
    );

    const { preview } = await planWrite(HOSTS["gemini-cli"], path, HTTP);

    expect(JSON.parse(preview).mcpServers.backrefs).toEqual({ httpUrl: HTTP.url });
  });

  it("refuses to overwrite a file that isn't valid JSON", async () => {
    const path = join(dir, "mcp.json");
    await fs.writeFile(path, "{ not json");

    await expect(planWrite(HOSTS.cursor, path, HTTP)).rejects.toThrow(/not plain JSON/);
  });

  it("treats an empty file as an empty config rather than a parse failure", async () => {
    const path = join(dir, "mcp.json");
    await fs.writeFile(path, "   \n");

    const { preview } = await planWrite(HOSTS.cursor, path, HTTP);
    expect(JSON.parse(preview).mcpServers.backrefs).toEqual({ url: HTTP.url });
  });

  it("rejects a non-object mcpServers rather than clobbering it", async () => {
    const path = join(dir, "mcp.json");
    await fs.writeFile(path, JSON.stringify({ mcpServers: ["oops"] }));

    await expect(planWrite(HOSTS.cursor, path, HTTP)).rejects.toThrow(/must be an object/);
  });
});

describe("codex toml", () => {
  it("appends a url block to a fresh file", async () => {
    const { preview } = await planWrite(HOSTS.codex, join(dir, "config.toml"), HTTP);
    expect(preview).toBe(`[mcp_servers.backrefs]\nurl = "${HTTP.url}"\n`);
  });

  it("keeps existing content and separates with one blank line", async () => {
    const path = join(dir, "config.toml");
    await fs.writeFile(path, 'model = "gpt-5"\n');

    const { preview } = await planWrite(HOSTS.codex, path, HTTP);

    expect(preview).toBe(
      'model = "gpt-5"\n\n[mcp_servers.backrefs]\nurl = "https://mcp.backrefs.com/"\n',
    );
  });

  it("preserves CRLF when the file is predominantly CRLF", async () => {
    const path = join(dir, "config.toml");
    await fs.writeFile(path, "a = 1\r\nb = 2\r\n");

    const { preview } = await planWrite(HOSTS.codex, path, HTTP);

    expect(preview.endsWith("\r\n")).toBe(true);
    expect(preview).toContain("[mcp_servers.backrefs]\r\n");
  });

  it("does not let one stray CRLF flip a mostly-LF file", () => {
    expect(dominantEol("a\nb\nc\r\nd\n")).toBe("\n");
    expect(dominantEol("a\r\nb\r\nc\n")).toBe("\r\n");
  });

  it.each([
    '[mcp_servers.backrefs]\nurl = "x"\n',
    'mcp_servers.backrefs = { url = "x" }\n',
    'mcp_servers.backrefs.url = "x"\n',
  ])("detects the existing entry in every TOML spelling", (existing) => {
    expect(codexHasEntry(existing)).toBe(true);
  });

  it("skips rather than appending a duplicate — codex fails the whole config on one", async () => {
    const path = join(dir, "config.toml");
    await fs.writeFile(path, '[mcp_servers.backrefs]\nurl = "https://old"\n');

    const result = await planWrite(HOSTS.codex, path, HTTP);

    expect(result.skipped).toBe(true);
    expect(result.preview).not.toContain("backrefs.com");
  });

  it("sees the entry in every TOML spelling of the same key", () => {
    // Quoted and bare keys are the same key in TOML; appending beside any of
    // these is a duplicate Codex refuses the whole file for.
    for (const text of [
      '[mcp_servers."backrefs"]\nurl = "x"\n',
      "[mcp_servers.'backrefs']\nurl = \"x\"\n",
      '[ mcp_servers . backrefs ]\nurl = "x"\n',
      '[mcp_servers]\nbackrefs = { url = "x" }\n',
      'mcp_servers = { backrefs = { url = "x" } }\n',
    ]) {
      expect(codexHasEntry(text), text).toBe(true);
    }
    expect(codexHasEntry('[mcp_servers.other]\nurl = "x"\n')).toBe(false);
  });

  it("fails rather than append a table the file's mcp_servers cannot take", async () => {
    // Valid TOML either way — but an inline `mcp_servers` cannot be extended by
    // a later `[mcp_servers.backrefs]` header, and Codex rejects the result.
    for (const text of ["mcp_servers = {}\n", 'mcp_servers = "x"\n']) {
      const path = join(dir, "config.toml");
      await fs.writeFile(path, text);

      await expect(planWrite(HOSTS.codex, path, HTTP), text).rejects.toThrow(/by hand/);
    }
  });

  it("fails, rather than skips, on a file that is not valid TOML", async () => {
    const path = join(dir, "config.toml");
    await fs.writeFile(path, "model = \n");

    await expect(planWrite(HOSTS.codex, path, HTTP)).rejects.toThrow(/not valid TOML/);
  });
});

/**
 * An existing entry's headers were granted to the server it points at. They
 * must never follow the entry to a different origin, and a new bearer replaces
 * Authorization alone.
 */
describe("existing headers", () => {
  const OTHER = "https://evil.example/";

  async function seed(entry: Record<string, unknown>): Promise<string> {
    const path = join(dir, "mcp.json");
    await fs.writeFile(path, JSON.stringify({ mcpServers: { backrefs: entry } }));
    return path;
  }

  it("refuses to repoint an entry carrying headers to another origin", async () => {
    const path = await seed({ url: HTTP.url, headers: { Authorization: `Bearer ${TOKEN}` } });

    const attempt = planWrite(HOSTS.cursor, path, { url: OTHER });

    await expect(attempt).rejects.toThrow(/granted to that server/);
    await expect(attempt).rejects.not.toThrow(new RegExp(TOKEN));
  });

  it("repoints an entry with no headers", async () => {
    const path = await seed({ url: HTTP.url });

    const result = await planWrite(HOSTS.cursor, path, { url: OTHER });

    expect(JSON.parse(result.preview).mcpServers.backrefs.url).toBe(OTHER);
  });

  it("replaces only Authorization, in any case, and keeps the user's other headers", async () => {
    const path = await seed({
      url: HTTP.url,
      headers: { "authorization": "Bearer old", "X-Custom": "kept" },
    });

    const result = await planWrite(HOSTS.cursor, path, HTTP_TOKEN);

    expect(JSON.parse(result.preview).mcpServers.backrefs.headers).toEqual({
      "X-Custom": "kept",
      "Authorization": `Bearer ${TOKEN}`,
    });
  });

  it("keeps the headers as they are when no new key is given", async () => {
    const path = await seed({ url: HTTP.url, headers: { "X-Custom": "kept" } });

    const result = await planWrite(HOSTS.cursor, path, HTTP);

    expect(JSON.parse(result.preview).mcpServers.backrefs.headers).toEqual({ "X-Custom": "kept" });
  });
});

describe("assertSafeUrl", () => {
  it("accepts https and canonicalises", () => {
    expect(assertSafeUrl("https://backrefs.com/mcp")).toBe("https://backrefs.com/mcp");
  });

  it("allows http only for loopback", () => {
    expect(assertSafeUrl("http://localhost:3004/mcp")).toContain("http://localhost:3004/mcp");
    expect(() => assertSafeUrl("http://backrefs.com/mcp")).toThrow(/only use http: for localhost/);
  });

  it.each(["http://backrefs.localhost/mcp", "http://127.0.0.1:3004/mcp"])(
    "accepts the dev origin %s over plain http",
    (url) => {
      expect(assertSafeUrl(url)).toContain(url);
    },
  );

  it("is not fooled by a hostname that merely contains localhost", () => {
    expect(() => assertSafeUrl("http://localhost.evil.com/mcp")).toThrow(
      /only use http: for localhost/,
    );
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "not-a-url"])("rejects %s", (bad) => {
    expect(() => assertSafeUrl(bad)).toThrow();
  });
});

describe("parseArgs", () => {
  it("defaults to the hosted server", () => {
    expect(parseArgs([]).url).toContain("mcp.backrefs.com");
  });

  it("refuses --token without echoing the key typed after it", () => {
    // A key on the command line is already in shell history; login is the way
    // to put one on the machine.
    const attempt = (): unknown => parseArgs(["--token", TOKEN]);

    expect(attempt).toThrow(/backrefs-mcp login/);
    expect(attempt).not.toThrow(new RegExp(TOKEN));
  });

  it("refuses --token=… the same way, without echoing it", () => {
    const attempt = (): unknown => parseArgs([`--token=${TOKEN}`]);

    expect(attempt).toThrow(/backrefs-mcp login/);
    expect(attempt).not.toThrow(new RegExp(TOKEN));
  });

  it("never echoes the value of an unknown --flag=value", () => {
    expect(() => parseArgs(["--secret=FAKE_SECRET"])).toThrow(/^Unknown flag: --secret \(its value is not shown\)$/);
  });

  it("defaults to the browser flow, not the sign-in endpoint", () => {
    expect(parseArgs([]).headless).toBe(false);
  });

  it("--headless carries no credential", () => {
    const options = parseArgs(["--headless"]);

    // The whole point: the entry is written with nothing in it, and the agent
    // fetches its own credential afterwards.
    expect(options.headless).toBe(true);
  });

  it("refuses --headless when login is minting a key", () => {
    // They put a credential on the host by opposite routes. Taking both and
    // letting one win would write an entry the flag describes wrongly.
    expect(() => parseArgs(["--headless"], true)).toThrow(/install --headless/);
  });

  it.each([
    [["--only", "cursor", "--all"], /mutually exclusive/],
    [["--all", "--exclude", "cursor"], /only applies when auto-detecting/],
    [["--all", "--yes"], /only applies to the auto-detect prompt/],
    [["--only"], /requires a value/],
    [["--bogus"], /Unknown flag/],
    [["--only", "notahost"], /Unknown host/],
    [["--transport", "stdio"], /Unknown flag/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it("strips control characters from echoed input", () => {
    expect(() => parseArgs(["--only", "ev[31mil"])).toThrow(/ev\?\[31mil/);
  });
});

/**
 * Whole runs against a temp home. `login` hands the installer a callback that
 * mints a live key; it must run only once the key has somewhere to go — every
 * earlier exit would strand it.
 */
describe("runInstall", () => {
  let stdout: string;

  beforeEach(() => {
    // Host paths resolve from the home directory; point it at the temp dir so
    // these runs read and write nothing of this machine's.
    vi.stubEnv("HOME", dir);
    vi.stubEnv("USERPROFILE", dir);
    vi.stubEnv("APPDATA", dir);
    stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("never mints when a flag is invalid", async () => {
    const mintKey = vi.fn(async () => TOKEN);

    await expect(runInstall(["--only", "notahost"], mintKey)).rejects.toThrow(/Unknown host/);
    await expect(runInstall(["--headless"], mintKey)).rejects.toThrow(/install --headless/);
    expect(mintKey).not.toHaveBeenCalled();
  });

  it("mints nothing when a selected config could not take the entry", async () => {
    // VS Code accepts JSONC; this installer will not rewrite it. Finding that
    // out after the mint would leave a live key with nowhere to go.
    // The host's own path: VS Code keeps it in a different place per platform.
    const path = pathFor(HOSTS.vscode);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, '{ // mine\n "servers": {}, }\n');
    const mintKey = vi.fn(async () => TOKEN);

    await expect(runInstall(["--only", "vscode"], mintKey)).rejects.toThrow(/nothing was signed in/);
    expect(mintKey).not.toHaveBeenCalled();
  });

  it("writes Codex's config where CODEX_HOME points", async () => {
    const relocated = join(dir, "elsewhere");
    vi.stubEnv("CODEX_HOME", relocated);

    await runInstall(["--only", "codex"]);

    expect(await fs.readFile(join(relocated, "config.toml"), "utf8")).toContain("[mcp_servers.backrefs]");
    await expect(fs.stat(join(dir, ".codex", "config.toml"))).rejects.toThrow();
  });

  it("never mints a key for hosts that cannot hold one", async () => {
    const mintKey = vi.fn(async () => TOKEN);

    await expect(runInstall(["--only", "claude-desktop"], mintKey)).rejects.toThrow(
      /cannot hold a key/,
    );
    expect(mintKey).not.toHaveBeenCalled();
  });

  it("still mints when a keyless host is picked alongside one that holds the key", async () => {
    const mintKey = vi.fn(async () => TOKEN);

    await runInstall(["--only", "claude-desktop,cursor"], mintKey);

    expect(mintKey).toHaveBeenCalledTimes(1);
  });

  it("never mints for a dry run, and previews a placeholder instead", async () => {
    const mintKey = vi.fn(async () => TOKEN);

    await runInstall(["--only", "cursor", "--dry-run"], mintKey);

    expect(mintKey).not.toHaveBeenCalled();
    expect(stdout).toContain("<key minted by login>");
  });

  it("previews only its own entry, with headers it did not set redacted", async () => {
    // A dry run's output lands in logs and agent transcripts; the file holds
    // other servers' credentials and possibly a header of the user's own.
    await fs.mkdir(join(dir, ".cursor"), { recursive: true });
    await fs.writeFile(
      join(dir, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          other: { url: "https://other.example/", headers: { Authorization: "Bearer other-secret" } },
          backrefs: {
            url: HTTP.url,
            headers: { "X-Custom": "own-secret" },
            env: { API_KEY: "env-secret" },
          },
        },
      }),
    );

    await runInstall(["--only", "cursor", "--dry-run"]);

    expect(stdout).toContain('"backrefs"');
    expect(stdout).toContain(HTTP.url);
    for (const secret of ["other-secret", "own-secret", "env-secret"]) {
      expect(stdout).not.toContain(secret);
    }
    // Named, so the user sees what is kept, but never shown.
    expect(stdout).toContain('"X-Custom": "<kept, not shown>"');
    expect(stdout).toContain('"env": "<kept, not shown>"');
  });

  it("refuses to write the detected hosts without a terminal to confirm in", async () => {
    // Vitest runs without a TTY; detection needs a host on disk, so give it Cursor.
    await fs.mkdir(join(dir, ".cursor"), { recursive: true });

    await runInstall([]);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await expect(fs.stat(join(dir, ".cursor", "mcp.json"))).rejects.toThrow();
  });

  it("writes the detected hosts without a terminal when --yes says so", async () => {
    await fs.mkdir(join(dir, ".cursor"), { recursive: true });

    await runInstall(["--yes"]);

    await expect(fs.stat(join(dir, ".cursor", "mcp.json"))).resolves.toBeTruthy();
  });

  it("fails the run when the Codex config cannot be read as TOML", async () => {
    await fs.mkdir(join(dir, ".codex"), { recursive: true });
    await fs.writeFile(join(dir, ".codex", "config.toml"), "model = \n");

    await runInstall(["--only", "codex"]);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("tells a Codex user with a key to set the variable its entry names", async () => {
    await runInstall(["--only", "codex"], async () => TOKEN);

    expect(stdout).toContain("set BACKREFS_TOKEN to your key wherever Codex CLI starts");
  });

  it("mints once a host is selected and writes the key into it", async () => {
    const mintKey = vi.fn(async () => TOKEN);

    const summary = await runInstall(["--only", "cursor"], mintKey);

    expect(mintKey).toHaveBeenCalledTimes(1);
    expect(summary.stored).toBe(1);
    const written = await fs.readFile(join(dir, ".cursor", "mcp.json"), "utf8");
    expect(written).toContain(`Bearer ${TOKEN}`);
  });

  it("tells a Codex user to run codex mcp login — Codex does not start OAuth itself", async () => {
    await runInstall(["--only", "codex"]);

    expect(stdout).toContain("codex mcp login backrefs");
  });

  it("promises no browser on --headless, where the agent signs in", async () => {
    await runInstall(["--only", "cursor", "--headless"]);

    expect(stdout).not.toContain("browser");
    expect(stdout).not.toContain("codex mcp login");
  });

  it("names each host's own sign-in step rather than promising a browser", async () => {
    await runInstall(["--only", "gemini-cli,vscode"]);

    expect(stdout).toContain("Gemini CLI: restart Gemini CLI, then run /mcp auth backrefs");
    expect(stdout).toContain("VS Code: restart VS Code, then start the backrefs server");
    expect(stdout).not.toContain("first tool call");
  });

  it("repeats the hand-done hosts after the summary, where they are not missed", async () => {
    await runInstall(["--only", "cursor,claude-desktop"]);

    expect(stdout).toMatch(/still to do by hand.*Claude Desktop/);
  });
});

/**
 * Claude Code registers servers through its own CLI. Printing the command and
 * writing nothing left a user who ran `install` with nothing in `/mcp`, so the
 * installer runs it — and says that a restart and `/mcp` finish the job.
 */
describe("Claude Code", () => {
  const add = vi.mocked(claudeMcpAdd);
  let stdout: string;
  let stderr: string;

  beforeEach(() => {
    vi.stubEnv("HOME", dir);
    vi.stubEnv("USERPROFILE", dir);
    vi.stubEnv("APPDATA", dir);
    stdout = "";
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    add.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("registers the server itself and says how to finish", async () => {
    add.mockResolvedValue({ ok: true });

    await runInstall(["--only", "claude-code"]);

    expect(add).toHaveBeenCalledWith("https://mcp.backrefs.com/");
    expect(stdout).toContain("Claude Code: restart Claude Code, then run /mcp");
    expect(stdout).not.toContain("nothing written");
  });

  it("warns when a local-scope entry will shadow the new one", async () => {
    // Claude Code ranks local scope above user scope, and `claude mcp add
    // --scope user` succeeds regardless — so /mcp would keep showing the old one.
    add.mockResolvedValue({ ok: true });
    await fs.writeFile(
      join(dir, ".claude.json"),
      JSON.stringify({
        projects: {
          "/work/app": { mcpServers: { backrefs: { type: "http", url: "http://localhost:3004" } } },
          "/work/other": { mcpServers: {} },
        },
      }),
    );

    await runInstall(["--only", "claude-code"]);

    expect(stderr).toContain("/work/app");
    expect(stderr).not.toContain("/work/other");
    expect(stderr).toContain("claude mcp remove backrefs -s local");
  });

  it("prints the command and the next step when claude mcp add fails", async () => {
    add.mockResolvedValue({ ok: false, exists: false, reason: "spawn claude ENOENT" });

    await runInstall(["--only", "claude-code"]);

    expect(stdout).toContain("could not run claude mcp add (spawn claude ENOENT)");
    expect(stdout).toContain("claude mcp add --transport http backrefs --scope user");
    expect(stdout).toContain("Next: restart Claude Code, then run /mcp");
  });

  it("leaves an existing entry alone and says how to see it", async () => {
    add.mockResolvedValue({ ok: false, exists: true, reason: "already exists" });

    await runInstall(["--only", "claude-code"]);

    expect(stderr).toContain("already has a backrefs server");
    expect(stderr).toContain("claude mcp get backrefs");
  });

  it("only previews the command on a dry run", async () => {
    await runInstall(["--only", "claude-code", "--dry-run"]);

    expect(add).not.toHaveBeenCalled();
    expect(stdout).toContain("would run:");
  });

  it("never runs claude with a key, which would sit in the process list", async () => {
    await runInstall(["--only", "claude-code"], async () => TOKEN);

    expect(add).not.toHaveBeenCalled();
    // Single-quoted, so the shell passes `${BACKREFS_TOKEN}` through and
    // Claude Code expands it at connection time: the key is in no argv.
    expect(stdout).toContain("--header 'Authorization: Bearer ${BACKREFS_TOKEN}'");
    expect(stdout).not.toContain(TOKEN);
  });
});

/**
 * Which entries actually END UP HOLDING the key.
 *
 * `backrefs-mcp login` mints a credential before the installer runs and prints it
 * only when nothing stored it, so a wrong answer here throws a live key away.
 * Codex is the trap: it writes a file, so "a config changed" is true,
 * and what the file contains is `bearer_token_env_var` and no secret.
 */
describe("entryHoldsToken", () => {
  it("is true for the json hosts, which embed the bearer header", () => {
    for (const id of ["cursor", "windsurf", "gemini-cli", "vscode"] as const) {
      expect(entryHoldsToken(HOSTS[id], HTTP_TOKEN), id).toBe(true);
    }
  });

  it("is false for a Codex entry, which stores the variable name", () => {
    expect(entryHoldsToken(HOSTS.codex, HTTP_TOKEN)).toBe(false);
  });

  it("is false whenever no token was supplied", () => {
    expect(entryHoldsToken(HOSTS.cursor, HTTP)).toBe(false);
  });
});

/**
 * The URL a `--headless` install actually writes.
 *
 * Worth its own block because it is the one place the page, the installer and
 * the server have to agree on a literal path: apps/mcp mounts `/mcp-headless`,
 * `MCP_HEADLESS_URL` on /mcp names it, and this derives it a third time.
 */
describe("headlessUrl", () => {
  it("appends the path to a bare origin", () => {
    expect(headlessUrl("https://mcp.backrefs.com")).toBe("https://mcp.backrefs.com/mcp-headless");
  });

  it("does not double the slash on an origin that has one", () => {
    expect(headlessUrl("https://mcp.backrefs.com/")).toBe("https://mcp.backrefs.com/mcp-headless");
  });

  it("refuses a path or query it would otherwise drop", () => {
    for (const url of ["https://example.com/proxy?tenant=a", "https://example.com/mcp", "https://example.com/?a=1"]) {
      expect(() => headlessUrl(url), url).toThrow(/needs --url to be an origin/);
    }
  });
});
