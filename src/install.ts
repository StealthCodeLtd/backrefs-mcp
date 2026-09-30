import { isCancel, multiselect } from "@clack/prompts";

import { claudeAddCommand, claudeMcpAdd, shadowingLocalEntries } from "./claude-cli";
import { DEFAULT_SERVER_URL, HEADLESS_PATH, SERVER_KEY, TOKEN_ENV_VAR } from "./contract";
import { entryHoldsToken, type InstallTarget } from "./entry";
import {
  displayPath,
  HOST_IDS,
  hostList,
  HOSTS,
  pathFor,
  writeMode,
  type Host,
  type HostId,
} from "./hosts";
import { isLoopback, PLAIN_URL } from "./url";
import { atomicWrite, planWrite } from "./writers";

/**
 * `backrefs-mcp install` — detect the MCP hosts on this machine, let the user
 * confirm the selection, and write each host's config.
 *
 * The installer edits files the user owns, so the defaults are conservative:
 * detected hosts are pre-selected but nothing is written until the user
 * confirms, `--dry-run` shows the exact bytes first, and a host with a
 * first-class CLI of its own gets printed instructions instead of a rewrite.
 */

/**
 * `https://host` → `https://host/mcp-headless`, without doubling a slash.
 *
 * A host pointed there never needs its URL changed after signing in, which is
 * what makes `--headless` a one-time edit. The bare origin is deliberately not
 * it: that answers 401 with the challenge that starts the browser flow, which
 * is what a host WITH a browser wants.
 *
 * Only an origin is accepted. The sign-in endpoint sits at the server's root,
 * so a path or query on --url has no place to go: dropping it would break a
 * proxy's routing without a word, and appending to it would turn `/mcp` into
 * `/mcp/mcp-headless`.
 */
export function headlessUrl(origin: string): string {
  const url = new URL(origin);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(
      `--headless needs --url to be an origin such as https://host — the sign-in endpoint is ` +
        `always <origin>/${HEADLESS_PATH}, so the path, query or fragment on ` +
        `${safe(url.origin)} would be lost`,
    );
  }
  return new URL(HEADLESS_PATH, `${url.origin}/`).toString();
}

/**
 * Control characters are stripped before any user input is echoed back: an
 * unescaped ANSI sequence in an error message is an injection into the
 * terminal, and it can rewrite what the user believes the installer just did.
 * Tab is spared — it is the one control character that renders harmlessly.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

function safe(value: string): string {
  return value.replace(CONTROL_CHARACTERS, "?");
}

interface Options {
  url: string;
  headless: boolean;
  only: HostId[];
  exclude: HostId[];
  all: boolean;
  yes: boolean;
  dryRun: boolean;
  help: boolean;
}

/**
 * Whether a hostname can only mean this machine.
 *
 * The named four plus anything under `.localhost`, which RFC 6761 reserves to
 * loopback and browsers treat as a secure context for that reason. Without the
 * suffix this rejects `backrefs.localhost` — the dev origin this project
 * actually serves, and the only one where the session cookie and the OAuth
 * redirect resolve.
 */
/**
 * Reject anything that isn't a URL a host can actually reach, before it lands
 * in someone's config. Plain http is allowed only for loopback: over the open
 * internet it would send the bearer token in clear text.
 */
export function assertSafeUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid --url: ${safe(raw)} is not a valid URL`);
  }
  if (parsed.protocol === "http:") {
    if (!isLoopback(parsed.hostname)) {
      throw new Error("--url may only use http: for localhost; use https: for a remote host");
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error(`--url must use https:; got ${safe(parsed.protocol)}`);
  }
  const canonical = parsed.toString();
  if (!PLAIN_URL.test(canonical)) {
    throw new Error(
      "--url may hold only letters, digits and - . _ ~ : / ? = — anything else could be " +
        "run by the shell a printed command is pasted into",
    );
  }
  return canonical;
}

function validateHost(name: string): HostId {
  if (!(HOST_IDS as readonly string[]).includes(name)) {
    throw new Error(`Unknown host "${safe(name)}". Supported: ${HOST_IDS.join(", ")}`);
  }
  return name as HostId;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Flag conflicts, checked once the whole command line is known. Each of these
 * is a case where two flags ask for different things and guessing which one
 * the user meant would silently configure the wrong hosts.
 *
 * `withKey` is whether `login` will mint a key for this run — the only way a
 * key reaches the installer.
 */
function validateOptions(options: Options, withKey: boolean): void {
  if (options.only.length > 0 && options.all) {
    throw new Error("--only and --all are mutually exclusive. Pick one.");
  }
  const explicit = options.only.length > 0 || options.all;
  if (options.exclude.length > 0 && explicit) {
    throw new Error("--exclude only applies when auto-detecting. Drop --only/--all or --exclude.");
  }
  if (options.yes && explicit) {
    throw new Error("--yes only applies to the auto-detect prompt. Drop --only/--all or --yes.");
  }
  // Both put a credential on the host, by opposite routes: --headless writes an
  // entry with none so the agent can sign itself in, login writes the key it
  // mints. Together the key wins and the flag is a lie about what was written,
  // so refuse rather than pick.
  if (options.headless && withKey) {
    throw new Error(
      "--headless writes no credential and lets the agent sign in with backrefs_login, so it " +
        "cannot take the key login mints. Run `backrefs-mcp install --headless` instead.",
    );
  }
}

/** For `--token` and `--token=…` alike; it never repeats what was typed. */
const TOKEN_REFUSAL =
  "--token is not supported: a key on the command line lands in shell history. Run " +
  "`backrefs-mcp login` to put a key on this machine, and revoke any key you just typed " +
  "under Settings → Connections.";

export function parseArgs(argv: string[], withKey = false): Options {
  const options: Options = {
    url: process.env.BACKREFS_MCP_URL ?? DEFAULT_SERVER_URL,
    headless: false,
    only: [],
    exclude: [],
    all: false,
    yes: false,
    dryRun: false,
    help: false,
  };
  const value = (flag: string, raw: string | undefined): string => {
    if (raw === undefined || raw.startsWith("--")) throw new Error(`${flag} requires a value`);
    return raw;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "--url":
        options.url = value("--url", argv[++i]);
        break;
      case "--headless":
        options.headless = true;
        break;
      // Refused by name rather than as an unknown flag, and its value never
      // echoed: a key typed here is already in shell history and `ps`.
      case "--token":
        throw new Error(TOKEN_REFUSAL);
      case "--only":
        options.only.push(...splitList(value("--only", argv[++i])).map(validateHost));
        break;
      case "--exclude":
        options.exclude.push(...splitList(value("--exclude", argv[++i])).map(validateHost));
        break;
      case "--all":
        options.all = true;
        break;
      case "--yes":
      case "-y":
        options.yes = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default: {
        // The name only: `--token=brf_…` is exactly the argument that must not
        // come back out in an error, a log or a transcript.
        const [name = "", value] = arg.split("=", 2);
        if (name === "--token") throw new Error(TOKEN_REFUSAL);
        throw new Error(
          `Unknown flag: ${safe(name)}${value === undefined ? "" : " (its value is not shown)"}`,
        );
      }
    }
  }

  validateOptions(options, withKey);
  return options;
}

async function detectHosts(exclude: Set<HostId>): Promise<HostId[]> {
  const detected: HostId[] = [];
  for (const host of hostList()) {
    if (exclude.has(host.id)) continue;
    if (await host.detect()) detected.push(host.id);
  }
  return detected;
}

/**
 * Checkbox list of every supported host, with the detected ones ticked. The
 * undetected ones stay listed but unticked so a user can opt into a host the
 * probe missed without reaching for --only.
 */
/** The picked hosts, or null when the prompt was cancelled (Ctrl-C / Esc). */
async function promptSelection(detected: HostId[], withKey: boolean): Promise<HostId[] | null> {
  const detectedSet = new Set(detected);
  const picked = await multiselect({
    message: "Which hosts should be configured? (space toggles, enter confirms)",
    options: hostList().map((host) => {
      const hints: string[] = [];
      if (!detectedSet.has(host.id)) hints.push("not detected");
      // With a key, Claude Code gets printed steps like the manual hosts.
      if (host.id === "claude-code" && !withKey) hints.push("runs `claude mcp add`");
      else if (writeMode(host) === "manual") hints.push("prints steps, writes nothing");
      return { value: host.id, label: host.label, hint: hints.join("; ") || undefined };
    }),
    initialValues: [...detected],
    required: false,
  });
  return isCancel(picked) ? null : picked;
}

/**
 * What the user does once an entry exists. Every host loads MCP servers only at
 * start, so a new entry is invisible until a restart. With a key the entry
 * already authenticates; on --headless the agent signs in with backrefs_login;
 * otherwise the host's own `signIn` step starts the browser flow, because most
 * hosts do not start it by themselves.
 */
function nextStep(host: Host, target: InstallTarget, headless: boolean): string {
  const restart = `restart ${host.label}`;
  if (target.token !== undefined) {
    // A written entry that names the variable instead of holding the key
    // (Codex) works only once that variable is set where the host starts.
    return host.format !== null && !entryHoldsToken(host, target)
      ? `set ${TOKEN_ENV_VAR} to your key wherever ${host.label} starts, then ${restart}`
      : restart;
  }
  if (headless) return `${restart} and ask it to sign in to backrefs`;
  return host.signIn ? `${restart}, then ${host.signIn}` : restart;
}

function manualSteps(host: Host, target: InstallTarget, headless: boolean): string {
  if (host.id === "claude-code") {
    const add = `  ${claudeAddCommand(target.url)}`;
    if (target.token === undefined) {
      return `Claude Code — run:\n${add}\n  Next: ${nextStep(host, target, headless)}.\n`;
    }
    // The header holds the literal `${VAR}` — single quotes stop the shell
    // expanding it, in POSIX shells and PowerShell alike — and Claude Code
    // expands it itself at every connection, at every scope. The key is then in
    // no argv, no shell history and not in ~/.claude.json. cmd.exe has no single
    // quotes, and `${…}` means nothing to it, so there it is double quotes.
    return (
      `Claude Code — make ${TOKEN_ENV_VAR} hold your key wherever Claude Code starts ` +
      "(it reads the variable on every connection), then run:\n" +
      `${add} --header 'Authorization: Bearer \${${TOKEN_ENV_VAR}}'\n` +
      "  (In cmd.exe, use double quotes around the header instead.)\n" +
      `  Next: ${nextStep(host, target, headless)}.\n`
    );
  }
  if (host.id === "claude-desktop") {
    return (
      "Claude Desktop — Customize → Connectors → Add custom connector:\n" +
      `  URL: ${target.url}\n` +
      "  (claude_desktop_config.json does not register remote servers, and a custom\n" +
      "  connector signs in through the browser — it has nowhere to put a key.)\n"
    );
  }
  if (target.token !== undefined) {
    return (
      `${host.label} — configure ${SERVER_KEY} manually:\n` +
      `  URL: ${target.url}\n` +
      `  Header: Authorization: Bearer <your ${TOKEN_ENV_VAR}>\n`
    );
  }
  return `${host.label} — configure ${SERVER_KEY} manually with ${target.url}\n`;
}

function helpText(): string {
  return [
    "backrefs-mcp install — add the backrefs MCP server to your AI tools",
    "",
    "Usage: backrefs-mcp install [options]",
    "",
    "With no options it detects installed hosts and asks you to confirm.",
    "",
    "Options:",
    "  --url <url>            MCP endpoint (default: " + DEFAULT_SERVER_URL + ")",
    "  --headless             Point at the sign-in endpoint; the agent signs itself in",
    "  --only <a,b>           Configure exactly these hosts, no prompt",
    "  --all                  Configure every supported host, no prompt",
    "  --exclude <a,b>        Skip these during auto-detect",
    "  --yes, -y              Accept the detected set without prompting",
    "  --dry-run              Print what would change; write nothing",
    "  -h, --help             Show this help",
    "",
    "Hosts: " + HOST_IDS.join(", "),
    "",
    "With a browser on the machine, pass no flag: the host signs you in and nothing",
    "secret is written. Without one, prefer --headless — it writes an entry with no",
    "credential, and the agent calls backrefs_login, shows you a code to approve from",
    "any device, and stores what it is given. To put a key on the machine yourself,",
    "run `backrefs-mcp login`.",
  ].join("\n");
}

interface Outcome {
  host: HostId;
  status: "written" | "skipped" | "manual" | "failed" | "planned";
  detail?: string;
}

/**
 * Where the run left the credential it was given.
 *
 * A key `login` minted is live on the account, so a run that put it nowhere
 * leaves a credential with no copy of it anywhere.
 * That is why this is returned rather than only printed — `runLogin` prints the
 * key itself when `stored` is 0.
 *
 * "Stored" is about the KEY, not the file: a written Codex entry holds
 * `bearer_token_env_var` and no secret (`entryHoldsToken`), so it counts as work
 * still to do. A --dry-run's printed entry counts as stored when it carries the
 * bearer, because the key reached the user either way.
 */
export interface InstallSummary {
  /** Hosts whose entry now carries the key, printed or written. */
  stored: number;
  /** Hosts still needing the key placed by hand — manual steps, a skip, or Codex. */
  byHand: number;
}

/** A run that touched nothing: --help, or no host to configure. */
const NOTHING_STORED: InstallSummary = { stored: 0, byHand: 0 };

/**
 * Claude Code without a key: run `claude mcp add` for the user, falling back to
 * the printed command when that fails. With a key the command is printed, never
 * run — the key would sit in the process list for as long as `claude` runs.
 */
async function registerClaudeCode(
  host: Host,
  target: InstallTarget,
  dryRun: boolean,
  headless: boolean,
): Promise<Outcome> {
  if (dryRun) {
    process.stdout.write(`\nClaude Code — would run:\n  ${claudeAddCommand(target.url)}\n`);
    return { host: host.id, status: "planned" };
  }
  const result = await claudeMcpAdd(target.url);
  if (result.ok) {
    process.stdout.write(`backrefs: Claude Code → ${SERVER_KEY} (user scope, via claude mcp add)\n`);
    const shadowed = await shadowingLocalEntries();
    if (shadowed.length > 0) {
      process.stderr.write(
        `backrefs: Claude Code also has a ${SERVER_KEY} entry of its own in ${shadowed
          .map(safe)
          .join(", ")}. There it takes precedence over this one; to use this one there, run ` +
          `\`claude mcp remove ${SERVER_KEY} -s local\` in that folder.\n`,
      );
    }
    return { host: host.id, status: "written" };
  }
  if (result.exists) {
    process.stderr.write(
      `backrefs: Claude Code already has a ${SERVER_KEY} server, left as it is. ` +
        `\`claude mcp get ${SERVER_KEY}\` shows it; remove it and run install again to replace it.\n`,
    );
    return { host: host.id, status: "skipped", detail: "already registered" };
  }
  process.stdout.write(
    `\nbackrefs: could not run claude mcp add (${safe(result.reason)}).\n` +
      manualSteps(host, target, headless),
  );
  return { host: host.id, status: "manual" };
}

async function applyToHost(
  host: Host,
  target: InstallTarget,
  dryRun: boolean,
  headless: boolean,
): Promise<Outcome> {
  if (host.id === "claude-code" && target.token === undefined) {
    return registerClaudeCode(host, target, dryRun, headless);
  }
  if (writeMode(host) === "manual") {
    process.stdout.write(`\n${manualSteps(host, target, headless)}`);
    // Claude Code reaches this branch only with a key, and its standing reason
    // (the CLI beats editing the file) does not explain printing instead of
    // running. The printed command sits beside the instruction to set
    // BACKREFS_TOKEN, which the entry needs before it can connect.
    if (host.manual && host.id !== "claude-code") {
      process.stdout.write(`  Why not automatic: ${host.manual}.\n`);
    }
    return { host: host.id, status: "manual" };
  }
  const path = pathFor(host);
  const result = await planWrite(host, path, target);
  if (result.skipped) {
    process.stderr.write(
      `backrefs: ${host.label}: ${displayPath(path)} ${result.note ?? "unchanged"}\n`,
    );
    return { host: host.id, status: "skipped", detail: result.note };
  }
  if (dryRun) {
    process.stdout.write(
      `\n--- ${host.label}: ${displayPath(path)} (dry run; the rest of the file is kept) ---\n` +
        (result.change ?? ""),
    );
    return { host: host.id, status: "planned" };
  }
  await atomicWrite(path, result.preview);
  process.stdout.write(
    `backrefs: ${host.label} → ${displayPath(path)}${result.note ? ` (${result.note})` : ""}\n`,
  );
  return { host: host.id, status: "written", detail: result.note };
}

/**
 * Which hosts to configure. Returns null when the run should stop without
 * writing — nothing detected, or the user cleared the selection.
 *
 * The prompt appears only when auto-detecting: `--only`/`--all` already state
 * intent. Without a terminal there is nobody to answer it, and writing the
 * detected set anyway would edit files nobody confirmed — so that run needs
 * `--yes`, and a --dry-run, which writes nothing, needs nothing.
 */
async function resolveSelection(
  options: Options,
  withKey: boolean,
): Promise<{ hosts: HostId[]; autoDetected: boolean } | null> {
  if (options.all) return { hosts: [...HOST_IDS], autoDetected: false };
  if (options.only.length > 0) return { hosts: [...new Set(options.only)], autoDetected: false };

  const detected = await detectHosts(new Set(options.exclude));
  if (detected.length === 0) {
    process.stderr.write(
      "backrefs: no MCP hosts detected. Launch one of " +
        `${HOST_IDS.join(", ")} once, or pass --only <host> / --all.\n`,
    );
    process.exitCode = 1;
    return null;
  }
  process.stdout.write(`backrefs: detected ${detected.join(", ")}\n`);
  if (options.yes || options.dryRun) return { hosts: detected, autoDetected: true };
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "backrefs: no terminal to confirm the selection in, so nothing was written. Pass --yes " +
        "to accept the detected hosts, or --only <host> to name them.\n",
    );
    process.exitCode = 1;
    return null;
  }
  const picked = await promptSelection(detected, withKey);
  if (picked === null) {
    process.stdout.write("backrefs: cancelled, no changes made.\n");
    process.exitCode = 1;
    return null;
  }
  if (picked.length === 0) {
    process.stdout.write("backrefs: nothing selected, no changes made.\n");
    return null;
  }
  return { hosts: picked, autoDetected: true };
}

/**
 * The endpoint every writer below is handed; `runInstall` adds the key, if any.
 *
 * The URL is validated as an ORIGIN first and extended after: `assertSafeUrl`
 * decides whether a host may be pointed at it at all, and appending a fixed
 * path to something already judged safe cannot make it unsafe.
 */
function resolveTarget(options: Options): InstallTarget {
  const origin = assertSafeUrl(options.url);
  return { url: options.headless ? headlessUrl(origin) : origin };
}

/**
 * The closing block after at least one host was written: one line per host
 * saying exactly what finishes the setup there, then the hosts whose steps were
 * printed mid-run and are still to do. A single "your browser opens" for every
 * host was true of almost none of them, and printed steps scrolled past a
 * summary that called the run done.
 */
function reportWritten(
  outcomes: Outcome[],
  wrote: number,
  target: InstallTarget,
  headless: boolean,
): void {
  const lines = [`\nbackrefs: configured ${wrote} host(s). To finish:`];
  for (const outcome of outcomes) {
    if (outcome.status !== "written") continue;
    const host = HOSTS[outcome.host];
    lines.push(`  ${host.label}: ${nextStep(host, target, headless)}.`);
  }
  const byHand = outcomes
    .filter((o) => o.status === "manual")
    .map((o) => HOSTS[o.host].label);
  if (byHand.length > 0) {
    lines.push(`backrefs: still to do by hand, see the steps above: ${byHand.join(", ")}.`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** What a --dry-run preview shows where `login` would put the key it mints. */
const DRY_RUN_KEY = "<key minted by login>";

/**
 * `mintKey` is `login`'s device flow. It is called only once every flag has
 * validated and at least one host is selected, because the key it returns is
 * live on the account the moment it exists — minting first and failing after
 * strands a credential only the revoke button can clean up. A --dry-run never
 * calls it.
 */
export async function runInstall(
  argv: string[],
  mintKey?: () => Promise<string>,
): Promise<InstallSummary> {
  const options = parseArgs(argv, mintKey !== undefined);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return NOTHING_STORED;
  }
  const endpoint = resolveTarget(options);

  // Before the selection prompt, so it is read before anyone picks hosts.
  if (mintKey && !options.dryRun) {
    process.stderr.write(
      "backrefs: the API key will be written in plain text into the config files of the " +
        "hosts that hold one (readable only by you on macOS and Linux; Windows keeps the " +
        "folder's own permissions). Pick read-only or a daily spend cap on the approval " +
        "page, and revoke it from Settings → Connections if the machine is shared.\n",
    );
  }

  const selection = await resolveSelection(options, mintKey !== undefined);
  if (selection === null) return NOTHING_STORED;
  const { hosts: selected, autoDetected } = selection;

  // Before the mint, like every other refusal: a key minted for hosts that
  // cannot hold it is live on the account with nowhere to go.
  if (mintKey && selected.every((id) => HOSTS[id].keyless)) {
    throw new Error(
      `${selected.map((id) => HOSTS[id].label).join(", ")} cannot hold a key — it signs in ` +
        "through the browser. Run `backrefs-mcp install` for it instead of `login`.",
    );
  }

  // Every file write is planned once with the placeholder BEFORE the mint: a
  // config that cannot take the entry (unreadable, a duplicate Codex table, a
  // server the entry must not be repointed from) would otherwise fail after a
  // key exists, leaving it live with nowhere to go.
  if (mintKey && !options.dryRun) {
    const blocked: string[] = [];
    for (const id of selected) {
      const host = HOSTS[id];
      if (writeMode(host) !== "file") continue;
      try {
        await planWrite(host, pathFor(host), { ...endpoint, token: DRY_RUN_KEY });
      } catch (error) {
        blocked.push(`${host.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (blocked.length > 0) {
      throw new Error(
        `nothing was signed in, because these configs cannot take the entry:\n  ${blocked.join("\n  ")}\n` +
          "Fix them, or leave those hosts out with --only, and run login again.",
      );
    }
  }

  const target: InstallTarget = mintKey
    ? { ...endpoint, token: options.dryRun ? DRY_RUN_KEY : await mintKey() }
    : endpoint;

  const outcomes: Outcome[] = [];
  for (const id of selected) {
    const host = HOSTS[id];
    try {
      outcomes.push(await applyToHost(host, target, options.dryRun, options.headless));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`backrefs: ${host.label} failed: ${detail}\n`);
      outcomes.push({ host: id, status: "failed", detail });
    }
  }

  const wrote = outcomes.filter((o) => o.status === "written").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const keyLanded = (outcome: Outcome): boolean =>
    (outcome.status === "written" || outcome.status === "planned") &&
    entryHoldsToken(HOSTS[outcome.host], target);
  // A skip counts as work still to do for the same reason a manual host does:
  // the file already defined the server and was left alone, so the key is not
  // in it. A failure is excluded — that host got no advice worth following.
  const summary: InstallSummary = {
    stored: outcomes.filter(keyLanded).length,
    // A keyless host (Claude Desktop) signs in through the browser: it never
    // needs the key, so counting it would tell the user to copy one into it.
    byHand: outcomes.filter(
      (o) => o.status !== "failed" && !keyLanded(o) && !HOSTS[o.host].keyless,
    ).length,
  };
  if (options.dryRun) {
    process.stdout.write("\nbackrefs: dry run — nothing was written.\n");
  } else if (wrote > 0) {
    reportWritten(outcomes, wrote, target, options.headless);
  }
  if (failed > 0) process.exitCode = 1;
  if (autoDetected && wrote === 0 && failed === 0 && !options.dryRun) {
    process.stdout.write("\nbackrefs: nothing written — follow the steps above.\n");
  }
  return summary;
}
