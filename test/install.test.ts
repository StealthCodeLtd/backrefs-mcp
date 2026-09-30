import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { entryHoldsToken, jsonEntry, tomlBlock, type InstallTarget } from "../src/entry";
import { HOSTS } from "../src/hosts";
import { assertSafeUrl, headlessUrl, parseArgs, runInstall } from "../src/install";
import { codexHasEntry, dominantEol, planWrite } from "../src/writers";

/**
 * The installer edits config files the user owns, and every host spells its
 * fields differently. A wrong field name produces a file the host parses
 * happily and then ignores — an install that looks successful and isn't — so
 * the per-host shapes are pinned here rather than trusted to review.
 */

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
        mcpServers: { backrefs: { url: "https://old", headers: { "X-Env": "staging" } } },
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

  it("refuses to overwrite a file that isn't valid JSON", async () => {
    const path = join(dir, "mcp.json");
    await fs.writeFile(path, "{ not json");

    await expect(planWrite(HOSTS.cursor, path, HTTP)).rejects.toThrow(/not valid JSON/);
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

  it("never mints for a dry run, and previews a placeholder instead", async () => {
    const mintKey = vi.fn(async () => TOKEN);

    await runInstall(["--only", "cursor", "--dry-run"], mintKey);

    expect(mintKey).not.toHaveBeenCalled();
    expect(stdout).toContain("<key minted by login>");
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
});
