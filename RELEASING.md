# Releasing

Releases publish from GitHub Actions with npm trusted publishing and provenance. No npm token is stored.

1. Bump `version` in `package.json` and `server.json`, and commit.
2. Push a matching tag: `git tag v0.1.1 && git push --tags`.
3. The `release` workflow runs the typecheck, tests and build, then publishes.

## First release only

npm can't link a package to this repo until the package exists, so the first version is published by hand:

1. From a clean checkout: `npm ci && npm run build && npm publish --access public`. Leave out `--provenance`, which only works in CI.
2. On npmjs.com, open the package → Settings → Trusted publishers, and add: repository `StealthCodeLtd/backrefs-mcp`, workflow `release.yml`, environment `npm`.
3. In GitHub, protect the `npm` environment (Settings → Environments) so only `main` maintainers can release.
