/**
 * `backrefs-mcp` — configure AI tools to use the hosted Backrefs MCP server.
 *
 *   backrefs-mcp install [options]   configure the MCP hosts on this machine
 *   backrefs-mcp login [options]     sign in from a machine with no browser
 *
 * `login` is `install` plus the step that obtains the credential: it runs the
 * device flow, then hands the key it receives to the installer. On a machine
 * with a browser neither is needed for auth — a plain `install` writes a URL and
 * the host signs the user in itself.
 */

const HELP = [
  "backrefs-mcp — connect your AI tools to Backrefs",
  "",
  "  backrefs-mcp install [options]   Configure your AI tools to use it",
  "  backrefs-mcp login [options]     Sign in with a code (no browser needed here)",
  "",
  "Run `backrefs-mcp install --help` or `backrefs-mcp login --help` for options.",
  "",
].join("\n");

const [subcommand, ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (subcommand) {
    case "install": {
      const { runInstall } = await import("./install");
      await runInstall(rest);
      return;
    }
    case "login": {
      const { runLogin } = await import("./login");
      await runLogin(rest);
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`backrefs-mcp: unknown command\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`backrefs-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
