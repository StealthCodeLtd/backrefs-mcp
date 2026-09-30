import { hostname } from "node:os";

import {
  CLIENT_NAME_MAX,
  DEFAULT_API_ORIGIN,
  PollDeviceGrantResponseSchema,
  StartDeviceGrantResponseSchema,
  type PollDeviceGrantResponse,
} from "./contract";
import { postDevice } from "./device-client";

/**
 * `backrefs-mcp login` — the device sign-in (RFC 8628) from the agent's side.
 *
 * The problem it solves: getting a key onto a machine nobody can browse from
 * used to mean creating it in a browser elsewhere, then moving a live credential
 * by hand through a clipboard, a chat window or a scp. Here the machine that
 * needs the key is the one that receives it, and the only thing that crosses the
 * gap is an 8-character code that grants nothing on its own.
 *
 * What this process can and cannot decide is the whole design. It sends a NAME
 * and gets back a code. The scopes and the daily spend cap are chosen by whoever
 * approves, in a browser, on a screen this process never sees — so a compromised
 * or over-eager agent cannot widen what it ends up holding by asking for more.
 *
 * Everything prints to stderr except the secret, and the secret prints only when
 * nothing is going to store it. Both rules exist so this command is safe to use
 * in a pipeline: `backrefs-mcp login --print-token` is the one invocation whose
 * stdout is meaningful for a caller that asked for it.
 *
 * The installer mints the key only once its flags have validated and a host is
 * selected, so a bad flag or an empty selection costs nothing. "Nothing stored
 * it" is still an ordinary outcome: every selected host can be one the installer
 * prints steps for instead of writing (Claude Code is; a Codex entry names
 * BACKREFS_TOKEN and carries no secret). The key is live
 * on the account by then, so it is printed rather than dropped — a discarded
 * secret is a credential nobody can use and only the revoke button can clean up.
 */

/**
 * How long to keep polling. The grant expires by itself (the api's lifetime is
 * 15 minutes today) and says so in `expiresAt`; this is the backstop for the case where that deadline
 * never arrives because the api stopped answering.
 */
const MAX_WAIT_MS = 20 * 60_000;

/** RFC 8628 §3.5: back off by this much when told to slow down. */
const SLOW_DOWN_INCREMENT_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface LoginOptions {
  /** The api ORIGIN, e.g. `https://backrefs.com`. */
  apiOrigin: string;
  /** What to call this agent on the approval screen. */
  clientName: string;
}

/** stderr, always: stdout is reserved for a token the caller asked to capture. */
function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Run the flow to completion and return the minted secret.
 *
 * Throws on every outcome that is not a key: denied, expired, or an api that
 * stopped answering. The caller decides what to do with the secret — this
 * function never prints it and never writes it anywhere.
 */
async function deviceLogin(options: LoginOptions): Promise<string> {
  const started = await postDevice(
    options.apiOrigin,
    "/device/start",
    { clientName: options.clientName },
    StartDeviceGrantResponseSchema,
  );
  if (!started.ok) throw new Error(started.message);

  // Blank lines around it: this is the one thing a human has to read and act on,
  // and it is competing with whatever else is on their terminal.
  say("");
  say(`  Open  ${started.data.verificationUri}`);
  say(`  Code  ${started.data.userCode}`);
  say("");
  // From the grant's own deadline, so the sentence follows the api's lifetime
  // instead of a copy of it.
  const minutesLeft = Math.round((Date.parse(started.data.expiresAt) - Date.now()) / 60_000);
  say(
    `Waiting for approval as "${options.clientName}"` +
      (Number.isFinite(minutesLeft) && minutesLeft > 0
        ? ` — this code lasts about ${minutesLeft} minutes.`
        : "."),
  );
  say("The permissions are chosen on that page, not here.");

  let intervalMs = started.data.intervalSeconds * 1000;
  const deadline = Date.now() + MAX_WAIT_MS;

  // Set once a poll goes unanswered. The api may have handled that poll —
  // approved grant consumed, key minted — with the answer lost on the way back.
  let lostPoll = false;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const polled = await postDevice(
      options.apiOrigin,
      "/device/poll",
      { deviceCode: started.data.deviceCode },
      PollDeviceGrantResponseSchema,
    );
    if (!polled.ok) {
      // A poll that fails is not a flow that failed: the grant is usually still
      // open and the next tick may well succeed. Only the deadline ends this loop.
      lostPoll = true;
      say(`  (still waiting — ${polled.message})`);
      continue;
    }

    const result: PollDeviceGrantResponse = polled.data;
    switch (result.status) {
      case "authenticated":
        say("");
        say(`Approved. Key "${result.key.name}" can ${result.key.scopes.join(" + ")}.`);
        if (result.key.maxCommitTokens !== null) {
          say(`Daily spend cap: ${result.key.maxCommitTokens} tokens.`);
        }
        return result.secret;
      case "denied":
        throw new Error("The sign-in was denied in the browser.");
      case "expired":
        throw new Error("The code expired before it was approved. Run login again.");
      case "unknown":
        // The grant is gone: consumed by an earlier poll, or swept. Either way
        // this process is polling a handle that will never resolve — and if a
        // poll went unanswered, that one may have consumed it and minted a key.
        throw new Error(
          lostPoll
            ? "That sign-in is no longer valid. An earlier check went unanswered and may " +
                "already have created a key: look under Settings → Connections, revoke any " +
                "you don't recognise, then run login again."
            : "That sign-in is no longer valid. Run login again.",
        );
      case "slow_down":
        intervalMs += SLOW_DOWN_INCREMENT_MS;
        continue;
      case "pending":
        continue;
    }
  }
  throw new Error("Timed out waiting for approval. Run login again.");
}

interface Parsed extends LoginOptions {
  printToken: boolean;
  installArgs: string[];
  help: boolean;
}

/**
 * A sensible default name, because this is what a human sees on the approval
 * screen and "backrefs-mcp" tells them nothing about WHICH machine is asking.
 */
function defaultClientName(): string {
  // os.hostname(), not $HOSTNAME: bash does not export that variable on most
  // systems. Cut to the api's clientName cap (60), or /device/start refuses a
  // long cloud hostname and login fails before it begins.
  const prefix = "backrefs-mcp on ";
  const host = hostname().trim().slice(0, CLIENT_NAME_MAX - prefix.length);
  return host ? `${prefix}${host}` : "backrefs-mcp";
}

function parseLoginArgs(argv: string[]): Parsed {
  const parsed: Parsed = {
    apiOrigin: process.env.BACKREFS_API_URL ?? DEFAULT_API_ORIGIN,
    clientName: defaultClientName(),
    printToken: false,
    installArgs: [],
    help: false,
  };
  const value = (flag: string, raw: string | undefined): string => {
    if (raw === undefined || raw.startsWith("--")) throw new Error(`${flag} requires a value`);
    return raw;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "--api-url":
        parsed.apiOrigin = value("--api-url", argv[++i]);
        break;
      case "--name":
        parsed.clientName = value("--name", argv[++i]);
        break;
      case "--print-token":
        parsed.printToken = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        // Everything else is the installer's to validate — this command's job is
        // to obtain a key and hand it over, not to re-declare --only/--all/etc.
        parsed.installArgs.push(arg);
    }
  }
  return parsed;
}

function loginHelp(): string {
  return [
    "backrefs-mcp login — sign this machine in without a browser on it",
    "",
    "Usage: backrefs-mcp login [options] [install options]",
    "",
    "  --name <text>        What to call this agent on the approval screen",
    "  --api-url <origin>   The backrefs origin (default the hosted one)",
    "  --print-token        Print the key to stdout and configure nothing",
    "",
    "Prints a code, waits for someone to approve it in a browser on any device,",
    "then configures your MCP hosts with the key it receives. Unrecognised flags",
    "are passed to `install`, so --only/--all/--dry-run work here too.",
    "",
    "The scopes and the daily spend cap are chosen on the approval page. This",
    "command cannot ask for them, which is the point: an agent gets what a human",
    "granted it on a screen they read.",
    "",
  ].join("\n");
}

export async function runLogin(argv: string[]): Promise<void> {
  const options = parseLoginArgs(argv);
  if (options.help) {
    process.stdout.write(loginHelp());
    return;
  }

  if (options.printToken) {
    // Refused BEFORE the device flow: the key is live the moment it is minted,
    // and --print-token configures nothing, so an install flag here (a
    // --dry-run above all) means the caller expected something this path
    // never does.
    if (options.installArgs.length > 0) {
      throw new Error(
        "--print-token prints the key and configures nothing, so it takes no install " +
          "options — drop them, or leave out --print-token to configure your hosts",
      );
    }
    // The one path where stdout carries the secret: the caller asked for it and
    // is storing it themselves. Nothing else is written, so the output is
    // pipeable as-is.
    process.stdout.write(`${await deviceLogin(options)}\n`);
    return;
  }

  // Hand the key straight to the installer rather than making the user move it.
  // The installer mints it (through this callback) only after every flag has
  // validated and a host is selected. Imported lazily so `login --print-token`
  // never loads the host detection it has no use for.
  const { runInstall } = await import("./install");
  const minted: { secret?: string } = {};
  const summary = await runInstall(options.installArgs, async () => {
    minted.secret = await deviceLogin(options);
    return minted.secret;
  });
  const { secret } = minted;
  // Nothing minted: --help, a --dry-run, or no host to hold a key.
  if (!secret) return;

  if (summary.stored === 0) {
    // Nothing holds it, so this is the only copy that will ever exist.
    say("");
    say("Nothing stored the key, so here it is — it is already live on the account:");
    process.stdout.write(`${secret}\n`);
    say("Put it where the steps above ask for it, or revoke it under Settings → Connections.");
    return;
  }
  if (summary.byHand > 0) {
    // At least one config carries it, so the key is recoverable without
    // reprinting it here — say where from rather than putting it on stdout twice.
    say("");
    say(
      "Some hosts above still need the key: copy it from the Authorization header of a config " +
        "just written.",
    );
  }
}
