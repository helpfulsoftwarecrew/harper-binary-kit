# AGENTS.md

For whoever changes this repository. `README.md` is for whoever uses it.

## What this is

The packaging half of shipping a native binary from a Harper component, taken out of
`@helpfulsoftwarecrew/datadog-agent-binary` where it was written first. That plugin spent 2,680 lines on
`src/` and `scripts/`, and about 800 of them had nothing to do with Datadog. Any plugin shipping a binary
writes the same 800 again.

Three entry points, and the first split is load-bearing:

- `./resolve` runs inside a Harper node. No dependencies, and it must stay that way.
- `./cli` runs on a CI runner. It may grow dependencies; nothing a customer installs loads it.
- `./layout`, `./packages` and `./targets` are the pure derivations, exported because a consumer's own
  tests have to ask what its config resolves to. `./layout` is also what a build step reads before any of
  this runs: a build that hardcodes `build/<target>/bin` is a fifth process agreeing with a declaration
  nothing checks it against. None of the three reads a file or spawns anything.

## Why they are one package

`stage.js` generates the `index.js` that exports `getBinaryPath`. `resolve.js` is the only thing that calls
it. Before this package those two halves lived in two repositories with nothing asserting they agreed, and the
plugin caught a mismatch only because it happened to own both ends.

`test/unit/contract.test.js` is what keeps that honest, and it is the first file to read. Every case stages a
real package into a temp directory and resolves a binary back out of it. A resolver driven by a hand-written
fake proves nothing about the module the staging writes, and a staging test that reads its own output proves
nothing about what a consumer does with it.

## Layout

Ten files under `src/`, ESM with `// @ts-check` and JSDoc, nothing built.

- `targets.js`: the three vocabularies a platform package lives in - node's `process.platform`/`process.arch`, npm's `os`/`cpu`, and the label the packages publish under. They disagree on every axis.
- `layout.js`: `build/<target>/bin` and `npm/<name>`. Four processes meet at these paths and none can see the others.
- `packages.js`: which variant carries what on which target, and what `optionalDependencies` should say.
- `stage.js`: build tree to publishable package, including the generated `index.js`.
- `resolve.js`: the runtime half. Asks each installed platform package by filename and checks the filename that comes back. A consumer passes its own `load`, because a bare specifier resolves against the file that imports it, and a symlinked or nested install would otherwise look beside the kit rather than beside the consumer.
- `verify.js`: what `npm pack` WOULD ship, per package, plus the declared symbols.
- `floor.js`: the symbol versions a binary needs against what the target image provides.
- `publish.js`: refuse a prerelease, then attempt every package the registry does not already hold, each under `latest` when it is newer than that package's current `latest` and under `release-<major>.<minor>` otherwise.
- `published.js`: what a package's `latest` names now, and the read-back, at the version endpoint.
- `cli.js`: one command per step.

## The rule every file here follows

Each one exists because something shipped, and the test that pins a behaviour is the record of why. A comment
is two lines at most, one where one will do, and says why the code is as it is or what a reader would otherwise
break. It carries no incident history, dated or measured; rationale a maintainer needs that neither the code
nor a test shows is written here instead.

Nothing here may report success having done nothing. That is the failure mode this whole package is about:
a staging that wrote no package, a publish that published nothing, a gate whose glob matched no files. Every
step that can be a no-op says so loudly instead.

## Commands

`npm test` is `node --test`, no build. `npm run typecheck` is `tsc --noEmit`, and it covers `test/` too.
`release.yml` is the reusable workflow consumers call; it sits under `.github/workflows/` because GitHub
resolves a called workflow nowhere else. `test.yml` runs `format:check`, `lint`, `typecheck` and `test` on Linux, macOS and Windows against Node 22
and 24, and refuses a run whose test glob matched nothing.

## Releasing

A `v*` tag runs `publish.yml`, which refuses a tag that disagrees with `package.json`, so each released version
is its own commit. Both workflows refuse a prerelease version and publish through npm's trusted publishing
alone, with no token and no `registry-url`, since npm's OIDC exchange authorises `npm publish` and nothing else.
That is why the dist-tag is chosen before each publish rather than written after it: `latest` when the version
is newer than the package's current `latest` or the name is new, `release-<major>.<minor>` for a patch to an
older line. A trusted publisher can only be configured on a package that already exists, so a new name's first
version is published by hand. A re-run of either workflow skips a version the registry already serves. Both
workflows ask the registry before each publish, and the registry has taken more than 20 minutes to serve a
publish it accepted, which is why the read-back in `src/published.js` waits up to 30 minutes. A re-run inside
that lag attempts the publish again and fails on npm's refusal to publish over an existing version; a later
re-run, once the registry serves the version, skips it and finishes the release.

`release.yml` runs `npx harper-binary-kit` after `npm ci` in the calling repository, so it runs the kit that
repository has installed: the tag in a caller's `uses:` line supplies only the workflow YAML, and a fix to the
kit reaches a caller's release only when the caller's dependency on the kit moves.

## Commits

This repository is public. Author and committer are
`HelpfulSoftwareCrew <328022287+helpfulsoftwarecrew@users.noreply.github.com>`, set in the working copy's own
git config rather than taken from a machine's global one, and commits and tags are made with `TZ=UTC` so
their dates carry +0000. No commit or tag message carries a session link or a `Co-authored-by` line, and no
file names a person or a private style guide.

## Voice

Prose here, code comments and commit messages included: no em dashes, no rule-of-three, no reader-validation,
lead with the claim.
