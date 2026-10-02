# harper-binary-kit

Ship a native binary from a Harper component. One npm package per host carries that host's binaries, the
component depends on them optionally so npm installs only the matching one, and at runtime the component asks
the installed package where its binary landed rather than computing a path.

That last sentence is the whole design, and both halves live here: `stage` writes the module that answers, and
`resolve` is what calls it. They are one package because separately they agree with themselves.

Plain ESM, `node:` builtins only, no build step. A configured sigstore check runs `cosign`. Node 22.18+ or 24+.

## Install

```sh
npm install @helpfulsoftwarecrew/harper-binary-kit          # the runtime half
npm install -D @helpfulsoftwarecrew/harper-binary-kit       # and the CLI, if the same repo builds
```

## Declare

`binary-kit.config.js` at the repo root is the single declaration every step reads:

```js
export default {
	scope: '@acme/agent-binary',
	targets: ['linux-x86_64', 'linux-arm64', 'macos-arm64', 'windows-x86_64'],
	variants: [
		{ suffix: '' },
		{
			suffix: '-probe',
			optional: true,
			carries: 'It carries the probe and 42 MB of precompiled objects, which most nodes never load.',
			// A plain string is carried everywhere this variant publishes. Name targets when only some carry
			// it: the same binary can reach the kernel a different way per platform, and a directory two of
			// three have nothing for would refuse to stage them.
			extraDirs: [{ dir: 'share/probe', onlyOn: ['linux-x86_64', 'linux-arm64'] }],
		},
	],
	binaries: [
		{ shipsAs: 'agent', symbol: 'CONNECTIONS_CHECK' },
		{ shipsAs: 'trace-agent' },
		{ shipsAs: 'probe', variant: '-probe', onlyOn: ['linux-x86_64', 'linux-arm64'] },
	],
	floors: { 'linux-x86_64': { GLIBC: '2.36', GLIBCXX: '3.4.30' } },
	manifest: { license: 'Apache-2.0', repository: { type: 'git', url: '…' } },
	readme: (pkg) => `# ${pkg.name}\n\n…where these bytes came from…`,
};
```

Building is yours. Leave the binaries at `build/<target>/bin` and anything shipped beside them under
`build/<target>/`, and the kit takes it from there. A build step that would rather ask than hardcode those
paths imports them:

```js
import { buildTree } from '@helpfulsoftwarecrew/harper-binary-kit/layout';

const { bin, share } = buildTree(process.cwd(), 'linux-x86_64');
```

Four processes meet at those paths on four separate runners, so a build that recomputes them is a convention
with two owners.

## Fetch a prebuilt release, instead of building

When upstream publishes archives for every target, a `release` block in the same config replaces the build:

```js
export default {
	scope: '@acme/collector-binary',
	targets: ['linux-x86_64', 'linux-arm64', 'macos-arm64', 'windows-x86_64'],
	variants: [{ suffix: '' }],
	binaries: [{ shipsAs: 'otelcol' }],
	release: {
		repo: 'open-telemetry/opentelemetry-collector-releases',
		tag: 'v0.162.0',
		// Where `pin` reads digests from: one combined file, or a per-asset file with {asset} in its name.
		checksums: '{asset}.sha256',
		pins: 'release.sha256', // the default; committed
		sigstore: {
			bundle: '{asset}.sigstore.json',
			issuer: 'https://token.actions.githubusercontent.com',
			identity:
				'https://github.com/open-telemetry/opentelemetry-collector-releases/.github/workflows/base-release.yaml@refs/tags/v0.162.0',
		},
		assets: {
			// Named exactly, never derived from the target: upstreams misname assets.
			'linux-x86_64': {
				name: 'otelcol_0.162.0_linux_amd64.tar.gz',
				binaries: { otelcol: 'otelcol' }, // shipsAs -> member
				files: { 'README.md': 'share/README.md' }, // member -> path under build/<target>; a member ending in / copies a tree
			},
			'windows-x86_64': { name: 'otelcol_0.162.0_windows_amd64.tar.gz', binaries: { otelcol: 'otelcol.exe' } },
			// …one per target
		},
	},
};
```

```sh
harper-binary-kit pin                       # write release.sha256 from the release's own checksums; review and commit it
harper-binary-kit fetch                     # every target: download, check, extract into build/<target>/
harper-binary-kit fetch --only linux-arm64  # one target
```

Or from code, with the same config:

```js
import { fetchRelease, pinRelease } from '@helpfulsoftwarecrew/harper-binary-kit/fetch';
import { targets } from '@helpfulsoftwarecrew/harper-binary-kit/targets';

const written = await fetchRelease({ root, config, targets: targets(config.targets) });
```

A fetch is all or nothing across the targets it was asked for. Every target's asset and pin are found before
anything downloads, and every asset is checked against the committed sha256 and planned before the first file
is written, so one bad target leaves every build tree as it was. The pin file's first line
names the repo and tag it was written for, and a fetch refuses a pin written for another release, since asset
names often stay the same across tags. With `sigstore` set, the asset's bundle is downloaded from the same
release and checked with `cosign verify-blob` against the identity and issuer given. An `identityRegexp` must
match the whole identity: the kit anchors it before cosign sees it, and refuses one that does not parse as a
pattern on its own. A host without `cosign`
fails the fetch rather than skipping the check. Without `sigstore`, the sha256 pin is the only check, so the
pin's diff is the review: `pin` takes the digests the release serves when it runs, and nothing else vouches
for them.

Archives are read in process, `.tar.gz` and `.zip` only. Any member with an absolute path, a drive letter, a
backslash or a `..` segment refuses the whole archive, a member named for extraction that is a link or a
directory is refused, and a destination outside `build/<target>` is refused before anything downloads. Zip64
and encrypted zips are refused. Only the members the config names are written. `fetch` and `pin` download from
`https://github.com`; `HARPER_BINARY_KIT_RELEASE_BASE` points both at a mirror, which is how the tests reach a
loopback server. Neither sends a token.

## Resolve, at runtime

```js
import { createBinaryResolver } from '@helpfulsoftwarecrew/harper-binary-kit/resolve';

const resolver = createBinaryResolver({
	packageName: '@acme/agent-binary',
	packageRoot: `${import.meta.dirname}/..`,
	variants: [{ suffix: '' }, { suffix: '-probe', optional: true, carries: '…' }],
	// From YOUR module: a bare specifier resolves against the file the `import` is written in, so a resolver
	// importing from inside this package would look for your platform packages beside this one.
	load: (name) => import(name),
});

const path = await resolver.resolveBinary({ shipsAs: 'agent', title: 'the agent' });
```

Each variant is asked in order, then a dev checkout's own `build/<target>/bin`. A binary that resolves to the
wrong file is refused rather than returned: a platform package published before a second binary existed
answers every request with the first one, and that path exists on disk.

## Release, in CI

```sh
harper-binary-kit fetch      # a prebuilt upstream release -> build trees, when `release` is declared
harper-binary-kit stage      # build trees -> npm/<name>/, manifest, index.js, README
harper-binary-kit floor linux-x86_64   # symbol versions against the image the binaries ship to
harper-binary-kit verify     # what npm WOULD pack, per package
harper-binary-kit publish    # every package, attempting all of them, then read the registry back
harper-binary-kit deps       # what optionalDependencies should say, for `npm version`
harper-binary-kit names      # every package name, for a workflow that needs the list
```

`.github/workflows/release.yml` is a reusable workflow that calls these in order. Its matrix comes from `targets`, so
the list a package publishes and the list CI builds cannot disagree.

## What each step is defending against

Every one of these shipped before the step existed.

**`stage`** refuses a package whose binary the build did not produce, and refuses an `--only` that matches
nothing. Both used to report success: `--only <name>` filtered against the _current host's_ platform, so on a
developer's machine of another platform it staged nothing and printed "created successfully".

**`floor`** reads the symbol versions a binary needs against what the target image provides. A build on a
newer runner produces a binary that will not load at all on the image it ships to, the failure is at exec time
on the customer's node, and every test on the runner that built it passes.

**`verify`** asks npm what it would pack rather than reading the directory. `files`, `.npmignore` and npm's own
lists all apply at pack time, so a package can look correct in a checkout and ship without the binary it
exists for. A declared `symbol` catches the one defect a file listing cannot see: a binary present, correctly
named, the right size, and compiled without the thing it is for.

**`publish`** attempts every package and collects the failures rather than stopping at the first. npm answers a
publish to a name with no trusted publisher with 404 rather than 403, so "not configured" and "not there" read
identically and trying is the only way to find out. A version the registry already serves is skipped and
reported as already published. That check reads what the registry serves, which has trailed a publish by more
than 20 minutes, so a re-run after a partial publish can still fail inside that window on npm's refusal to
publish a version it holds; a re-run after it finishes the release. Then it reads the registry back, at the
_version_ endpoint: `npm publish` exiting 0 is not the package being there, and the packument lags its own
writes by long enough to send somebody chasing a partial release that never happened.

**The dist-tag** is chosen per package before its publish, because a trusted publisher authorises `npm publish`
and no dist-tag write after it. A version newer than the package's current `latest`, or the first version of a
name, goes out under `latest`; a patch to an older line goes out under `release-<major>.<minor>`, which npm
creates in the same call, so it never takes `latest` from the newer line. A prerelease is refused before
anything reaches the registry. So is a package whose `latest` the registry would not say, since guessing could
hand the older line to every bare `npm install`.

**Publishing** is through npm's trusted publishing alone (OIDC, npm 11.5.1 or later), with no token. A trusted
publisher can only be added to a package that exists, so a name's first version is published by hand; a 404 on
the publish says so.

## Development

`npm test` is `node --test`, no build. `npm run typecheck` is `tsc --noEmit`.

`test/unit/contract.test.js` is the one to read first: every case stages a real package into a temp directory
and resolves a binary back out of it, because a resolver driven by a hand-written fake proves nothing about the
module the staging actually writes.
