// The package set a release publishes, derived from one declaration so no step has to rediscover it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { allPackages, binariesFor, expectedFiles, optionalDependencies, packagesFor } from '../../src/packages.js';
import { currentTargetName, target, targets } from '../../src/targets.js';
import { one } from '../support/sandbox.js';

const CONFIG = {
	scope: '@x/agent',
	variants: [
		{ suffix: '' },
		{ suffix: '-probe', optional: true, carries: 'It carries the probe.', extraDirs: ['share/probe'] },
	],
	binaries: [
		{ shipsAs: 'agent', symbol: 'RUNTIME_MARKER' },
		{ shipsAs: 'trace-agent' },
		{ shipsAs: 'probe', variant: '-probe', onlyOn: ['linux-x86_64', 'linux-arm64'] },
	],
};
const LINUX = target('linux-x86_64');
const MAC = target('macos-arm64');

test('a target publishes one package per variant that carries something', () => {
	const names = packagesFor(CONFIG, LINUX).map((pkg) => pkg.name);
	assert.deepEqual(names, ['@x/agent-linux-x86_64', '@x/agent-probe-linux-x86_64']);
});

// A description claiming a binary the package does not have, and a package promising an accessor for a file
// it never staged, both come from publishing a variant a target carries nothing for.
test('NEGATIVE: a variant with nothing to carry on this target publishes no package', () => {
	const names = packagesFor(CONFIG, MAC).map((pkg) => pkg.name);
	assert.deepEqual(names, ['@x/agent-macos-arm64'], 'macOS has no probe, so it must publish no probe package');
	assert.deepEqual(binariesFor(CONFIG.binaries, one(CONFIG.variants, 'variant', 1), MAC), []);
});

test('the directory name is the npm name without the scope, so the two cannot drift', () => {
	for (const pkg of allPackages(CONFIG, targets(['linux-x86_64', 'macos-arm64']))) {
		assert.ok(pkg.name.endsWith(pkg.dirName), `${pkg.name} is staged in npm/${pkg.dirName}`);
	}
});

test('npm is told the os and cpu it filters the install on', () => {
	const base = one(packagesFor(CONFIG, LINUX), 'package');
	assert.equal(base.target.npmOs, 'linux');
	assert.equal(base.target.npmCpu, 'x64');
	const mac = one(packagesFor(CONFIG, MAC), 'package');
	assert.equal(mac.target.npmOs, 'darwin', 'the label is macos and npm calls it darwin');
	assert.equal(mac.target.npmCpu, 'arm64');
});

// An add-on listed as an optionalDependency installs on every matching host, the cost the split refuses.
test('NEGATIVE: an add-on variant is never an optionalDependency', () => {
	const pinned = optionalDependencies(CONFIG, targets(['linux-x86_64', 'macos-arm64']), '2.0.0');
	assert.deepEqual(Object.keys(pinned).sort(), ['@x/agent-linux-x86_64', '@x/agent-macos-arm64']);
	assert.ok(!Object.keys(pinned).some((name) => name.includes('probe')));
	assert.deepEqual(Object.values(pinned), ['2.0.0', '2.0.0']);
});

// One version across the release, because the base package pins its optionalDependencies at exactly this one:
// a platform package a version behind is not installed, it is refused as unresolvable.
test('every optional dependency is pinned at the release version, never a range', () => {
	const pinned = optionalDependencies(CONFIG, targets(['linux-x86_64']), '8.0.0-rc.1');
	assert.deepEqual(Object.values(pinned), ['8.0.0-rc.1']);
	assert.ok(!Object.values(pinned).some((v) => /[\^~*]/.test(v)));
});

test('the files a tarball must carry are derived from what the package declares', () => {
	const packages = packagesFor(CONFIG, LINUX);
	const base = one(packages, 'base package');
	const probe = one(packages, 'probe package', 1);
	assert.deepEqual(expectedFiles(base).sort(), ['bin/agent', 'bin/trace-agent', 'index.js', 'package.json']);
	assert.deepEqual(expectedFiles(probe).sort(), ['bin/probe', 'index.js', 'package.json']);
});

test('Windows binaries carry the suffix, in the package and in the expected files', () => {
	const base = one(packagesFor(CONFIG, target('windows-x86_64')), 'package');
	assert.deepEqual(expectedFiles(base).sort(), ['bin/agent.exe', 'bin/trace-agent.exe', 'index.js', 'package.json']);
});

// An unrecognised label publishes an `os` npm never matches, installing nowhere and reporting nothing.
test('NEGATIVE: a label naming no real host is refused, and the refusal lists the real ones', () => {
	assert.throws(() => target('solaris-arm64'), /unknown target/);
	assert.throws(() => target('linux-ppc64'), /unknown target/);
	assert.throws(() => target('linux'), /unknown target/);
	assert.throws(() => target('bsd-arm64'), /linux-x86_64/);
	// A pair nobody in this repo builds is still a pair npm understands, so the kit does not refuse it.
	assert.equal(target('macos-x86_64').npmOs, 'darwin');
});

test('this host has a target label, or none, and never a guess', () => {
	assert.equal(currentTargetName('darwin', 'arm64'), 'macos-arm64');
	assert.equal(currentTargetName('win32', 'x64'), 'windows-x86_64');
	assert.equal(currentTargetName('linux', 'arm64'), 'linux-arm64');
	assert.equal(currentTargetName('freebsd', 'x64'), null);
	assert.equal(currentTargetName('linux', 'ppc64'), null);
});

// One binary can reach the kernel a different way per platform, so a directory one target needs, another lacks.
test('an extra directory can name the targets that carry it', () => {
	const config = {
		scope: '@x/agent',
		variants: [
			{
				suffix: '-probe',
				optional: true,
				extraDirs: [{ dir: 'share/system-probe', onlyOn: ['linux-x86_64', 'linux-arm64'] }],
			},
		],
		binaries: [{ shipsAs: 'system-probe', variant: '-probe' }],
	};
	assert.deepEqual(one(packagesFor(config, target('linux-x86_64')), 'package').extraDirs, ['share/system-probe']);
	assert.deepEqual(
		one(packagesFor(config, target('macos-arm64')), 'package').extraDirs,
		[],
		'a target that carries no objects must not be asked to stage a directory it has none of'
	);
});

test('a plain string extra directory is carried on every target the variant publishes on', () => {
	const config = {
		scope: '@x/agent',
		variants: [{ suffix: '-probe', optional: true, extraDirs: ['share/anything'] }],
		binaries: [{ shipsAs: 'system-probe', variant: '-probe' }],
	};
	for (const name of ['linux-x86_64', 'macos-arm64', 'windows-x86_64']) {
		assert.deepEqual(one(packagesFor(config, target(name)), 'package').extraDirs, ['share/anything'], name);
	}
});

// A caller's org can refuse an action named by tag, and the refusal fails the caller's run, not this CI.
const USES = /^[ \t]*(?:-[ \t]*)?uses:[ \t]*(\S+)/gm;

/**
 * `./path` is a workflow in this same commit, as pinned as the file quoting it, and a leading `./` is the whole
 * exemption. The scan and the cases below share this function, or a case proves only its own copy.
 *
 * @param {string} ref
 */
const isPinned = (ref) => ref.startsWith('./') || /@[0-9a-f]{40}$|@sha256:[0-9a-f]{64}$/.test(ref);

test('every action in the workflows is pinned to a commit SHA', () => {
	const dir = new URL('../../.github/workflows/', import.meta.url);
	const unpinned = [];
	for (const file of readdirSync(dir)) {
		for (const [, ref = ''] of readFileSync(new URL(file, dir), 'utf-8').matchAll(USES)) {
			if (!isPinned(ref)) unpinned.push(`${file}: ${ref}`);
		}
	}
	assert.deepEqual(unpinned, []);
});

// A slug that starts with a dot is another repository's workflow, and `@main` is a moving ref.
test('NEGATIVE: the local-workflow exemption does not cover a repository slug', () => {
	assert.equal(isPinned('./.github/workflows/test.yml'), true);
	assert.equal(isPinned('.github/workflows/test.yml@main'), false);
	assert.equal(isPinned('dotorg/.github/workflows/shared.yml@main'), false);
	assert.equal(isPinned('actions/checkout@v4'), false);
});

test('NEGATIVE: the scan reads uses: as a key, not the word in a sentence', () => {
	const refs = (/** @type {string} */ text) => [...text.matchAll(USES)].map(([, ref]) => ref);
	assert.deepEqual(refs('      - uses: actions/checkout@abc\n'), ['actions/checkout@abc']);
	assert.deepEqual(refs('    uses: ./.github/workflows/test.yml\n'), ['./.github/workflows/test.yml']);
	assert.deepEqual(refs('      # consumers name it in `uses: owner/repo/.github/workflows/x.yml@v1`\n'), []);
});

// Git for Windows checks out CRLF, and prettier's default endOfLine of `lf` rejects every file it sees there.
test('the checkout is normalized to LF so the Windows leg sees the same bytes', () => {
	const attributes = readFileSync(new URL('../../.gitattributes', import.meta.url), 'utf-8');
	const normalizes = attributes.split('\n').some((line) => /^\*\s+text=auto\s+eol=lf\s*$/.test(line.trim()));
	assert.ok(normalizes, `.gitattributes does not normalize every file to LF:\n${attributes}`);
});
