# AGENTS.md

`@stealth-code/backrefs-mcp` is an installer: it writes config entries that point AI tools at the hosted Backrefs MCP server (`https://mcp.backrefs.com`). It contains no server code and nothing here runs as an MCP server.

## Rules

- **`src/contract.ts` is a hand-kept copy** of the api's device sign-in schemas (`packages/api-schemas/src/device/device.ts` in the private Backrefs monorepo). A change to one is a change to both. The api ships first, and any field the api adds stays optional here: a published installer can't be recalled.
- **Keep the copy looser than the api** where this package only displays a value. The `authenticated` poll response carries the key and can be read once, so a parse failure there loses a live key. `test/contract.test.ts` pins this.
- **No key on the command line.** There is no `--token` flag, and none may be added: a key in argv ends up in shell history and `ps`. A key reaches the installer only through `login`'s `mintKey` callback.
- **`runInstall` mints the key last:** after every flag has validated and at least one host is selected, and never on `--dry-run`. A key minted before a failure is live with nowhere to go.
- **Every host config key is load-bearing** and differs per host (`url`, `serverUrl`, `httpUrl`, `servers` vs `mcpServers`). A wrong key is read without error and ignored. Check the host's current docs before changing one, and keep the per-host tests in `test/install.test.ts` in step.
- **Never drop a key from a user's config** that this package didn't write, and never leave a half-written file (`atomicWrite`).
- Tests must not touch the real home directory. Stub `HOME` and `USERPROFILE` (and `APPDATA` for VS Code on Windows) to a temp dir.

## Commands

```sh
npm ci
npm run check-types
npm test
npm run build
node dist/cli.js install --all --dry-run
```

Releases publish from `.github/workflows/release.yml` on a `v*` tag. Don't run `npm publish` by hand except for the very first version.
