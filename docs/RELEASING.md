# Releasing

Publishing is off by default. Nothing in this repository publishes automatically; the release workflow runs only after it is enabled in the repository settings and started by hand.

## 0. One-time setup

These steps need maintainer accounts and two-factor authentication. Never put tokens in a file in this repository.

1. Confirm you can publish the npm package `dialogues-mcp` (before the first release, `npm view dialogues-mcp` returns 404).
2. Bootstrap npm trusted publishing (npm documents the current flow at docs.npmjs.com/trusted-publishers). A brand-new package may need a first publish from your own machine (`npm login`, then `npm publish <the preflight .tgz> --access public`) before its settings page offers trusted publishing; configure it near the release, because new trust has an activation window. Point it at repository `panth-net/dialogues-mcp`, workflow `release.yml`, environment `release`.
3. In the repository settings, create the `release` environment (optionally with required reviewers) and set the variable `DIALOGUES_RELEASE_ENABLED` to `true` only when you intend to publish.
4. The MCP Registry name `io.github.panth-net/dialogues` is verified through GitHub OIDC for the `panth-net` organization and through `mcpName` in package.json.

## 1. Prepare the version

1. Update `version` in package.json (`npm version <x.y.z> --no-git-tag-version` also updates the lockfile).
2. Update `server.json` (`version` and `packages[0].version`).
3. Rename the `## Unreleased` section of CHANGELOG.md to `## <x.y.z>`.
4. Run `node scripts/sync-prompts.mjs` and, for the landing page, `node scripts/sync-prompts.mjs --landing <path-to-landing-repo>`.
5. Commit, then tag: `git tag v<x.y.z>`.

## 2. Local rehearsal

```bash
node scripts/preflight.mjs --tag v<x.y.z>
```

Preflight checks that the tag, package.json, lockfile, server.json, changelog, and the built CLI all agree; that the tree is clean; that the privacy scan, prompt sync, schema validation, typecheck, tests, and the production audit (no high or critical findings) pass. It then packs once into `.release/`, records the sha512 integrity and sha256 in `.release/manifest.json`, and installs that exact tarball outside the checkout (production-only and without optional dependencies) to run setup, search, fetch, and both MCP protocol eras.

Also run, by hand, the checks automation cannot do: connect each app you claim to support (Claude Desktop chat and its Code tab, Claude Code, Codex, Cursor, VS Code) from the same tarball, record the app versions, and check that Dialogues appears after a restart. A passing server check is not proof that an app loaded its entry.

## 3. Publish (only when explicitly requested)

Push the tag, then run the **Release** workflow with the version and the confirmation text `publish <x.y.z>`. It:

1. repeats preflight on the tag and uploads the artifact;
2. publishes that artifact to npm with provenance, skipping only if the same version already exists with the same integrity (a different artifact under the same version fails; npm versions are immutable);
3. creates the GitHub release with the same file;
4. publishes `server.json` to the MCP Registry with `mcp-publisher login github-oidc` (pinned v1.8.1, checksum verified).

If a stage fails, fix the cause and rerun the workflow: completed stages are verified and skipped. The release is complete only when all three stages succeeded.

## 4. After publishing

- Sync the landing page's prompt copy (step 1.4), then verify its install prompt and links against the published package.
