# @stealth-code/backrefs-mcp

[![npm](https://img.shields.io/npm/v/@stealth-code/backrefs-mcp)](https://www.npmjs.com/package/@stealth-code/backrefs-mcp) [![license](https://img.shields.io/npm/l/@stealth-code/backrefs-mcp)](LICENSE)

Connect your AI tools to [Backrefs](https://backrefs.com) and run your backlink campaigns from chat.

You need a Backrefs account. The server is hosted at `https://mcp.backrefs.com`, so nothing runs on your machine. This package only adds that address to your tools' settings.

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=backrefs&config=eyJ1cmwiOiJodHRwczovL21jcC5iYWNrcmVmcy5jb20ifQ%3D%3D) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=backrefs&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.backrefs.com%22%7D)

## Install

```sh
npx -y @stealth-code/backrefs-mcp install
```

It finds Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, VS Code and Windsurf, asks which to set up, and configures them. Restart the tool. The first time it calls Backrefs, your browser opens so you can sign in.

To check it worked, ask your AI: *"How many tokens do I have left?"*

## No browser on this machine?

```sh
npx -y @stealth-code/backrefs-mcp login
```

It shows a short code. Approve it from any device with a browser, even your phone. On that page you choose whether the tool may spend tokens, and how many per day.

## What you can ask

- *"What backlinks did I get this week?"*
- *"Read my pricing page and suggest a campaign for it."*
- *"Boost these guest posts. Price it first."*

Reading is free. Anything that spends tokens asks for your yes first.

## Set it up without the installer

Every tool can add the server itself. Run the command, or paste it to your AI and ask it to run it.

<details>
<summary>Claude Code</summary>

```sh
claude mcp add --transport http backrefs --scope user https://mcp.backrefs.com
```

Then run `/mcp`, pick backrefs, and approve in the browser.
</details>

<details>
<summary>Claude Desktop</summary>

Customize → Connectors → Add custom connector, and paste `https://mcp.backrefs.com`.
</details>

<details>
<summary>Codex</summary>

```sh
codex mcp add backrefs --url https://mcp.backrefs.com
```

If the browser didn't open, run `codex mcp login backrefs`.
</details>

<details>
<summary>Cursor</summary>

Use the button above, or paste this to Cursor's chat. Then restart Cursor.

```text
Add the backrefs MCP server to Cursor: merge { "mcpServers": { "backrefs": { "url": "https://mcp.backrefs.com" } } } into ~/.cursor/mcp.json, keeping any servers already there.
```
</details>

<details>
<summary>Gemini CLI</summary>

```sh
gemini mcp add --transport http --scope user backrefs https://mcp.backrefs.com
```

Then run `/mcp auth backrefs`.
</details>

<details>
<summary>VS Code</summary>

Use the button above, or run:

```sh
code --add-mcp '{"name":"backrefs","type":"http","url":"https://mcp.backrefs.com"}'
```
</details>

<details>
<summary>Windsurf</summary>

Paste this to Cascade. Then restart Windsurf.

```text
Add the backrefs MCP server to Windsurf: merge { "mcpServers": { "backrefs": { "serverUrl": "https://mcp.backrefs.com" } } } into ~/.codeium/windsurf/mcp_config.json, keeping any servers already there. The key must be serverUrl, not url.
```
</details>

<details>
<summary>Any other tool</summary>

Add a remote MCP server named `backrefs` at `https://mcp.backrefs.com`.
</details>

### Chat agents and servers

For Hermes, OpenClaw, or Claude Code and Codex running on a server, sign in to Backrefs and open [Connect → By agent](https://backrefs.com/connect?via=agents). It gives you one prompt to paste to your agent, which sets itself up and signs in with a code you approve.

## Options

| Flag | What it does |
|---|---|
| `--only cursor,codex` | Set up only these tools |
| `--all` | Set up every supported tool |
| `--yes` | Skip the question and set up what it found |
| `--dry-run` | Show what would change without writing anything |
| `--headless` | Let the agent sign itself in with the `backrefs_login` tool |

## Remove it

| Tool | How |
|---|---|
| Claude Code | `claude mcp remove backrefs --scope user` |
| Claude Desktop | Remove the connector under Customize → Connectors |
| Codex | `codex mcp remove backrefs` |
| Cursor | Delete `backrefs` from `~/.cursor/mcp.json` |
| Gemini CLI | Delete `backrefs` from `~/.gemini/settings.json` |
| VS Code | Delete `backrefs` from `mcp.json` in your VS Code user folder |
| Windsurf | Delete `backrefs` from `~/.codeium/windsurf/mcp_config.json` |

Removing the entry doesn't revoke access. Do that in Backrefs under Settings → Connections.

## Troubleshooting

**Only `backrefs_login` shows up.** The tool hasn't signed in yet. Ask it to call `backrefs_login`, or run `npx -y @stealth-code/backrefs-mcp login`.

**Codex never asked me to sign in.** Run `codex mcp login backrefs`.

**"is not valid JSON".** The tool's config file has comments or a typo, so the installer leaves it alone. Fix it, or add the entry by hand (see above).

## Security

- There's no `--token` flag, because a key typed on the command line ends up in your shell history. Use `login` instead.
- A key from `login` is saved in your tools' config files (mode `0600`). Codex reads it from the `BACKREFS_TOKEN` environment variable instead.
- To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Links

- Setup guide in the app (sign in first): [backrefs.com/connect](https://backrefs.com/connect)
- Issues: [github.com/StealthCodeLtd/backrefs-mcp/issues](https://github.com/StealthCodeLtd/backrefs-mcp/issues)
- Releasing: [RELEASING.md](RELEASING.md)
