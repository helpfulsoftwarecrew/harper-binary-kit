// Staging, which must not succeed at nothing: no package written, or one staged around a missing binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildTree, packageDir } from '../../src/layout.js';
import { packagesFor } from '../../src/packages.js';
import { accessorName, indexModule, stageAll, stagePackage } from '../../src/stage.js';
import { currentTargetName, target } from '../../src/targets.js';
import { carriesExecutableBit, one, withTempDir } from '../support/sandbox.js';

const CONFIG = {
	scope: '@x/agent',
	variants: [{ suffix: '' }, { suffix: '-probe', optional: true, extraDirs: ['share/probe'] }],
	binaries: [{ shipsAs: 'agent' }, { shipsAs: 'probe', variant: '-probe' }],
	manifest: { license: 'Apache-2.0', author: 'Someone' },
};
const LINUX = target('linux-x86_64');
const WINDOWS = target('windows-x86_64');
// Staging is what a release runner does for its own platform, and a POSIX package staged on Windows is
// refused, so the fixtures stage the host's target the way a release leg does.
const HOST = target(currentTargetName() ?? 'linux-x86_64');
const OTHER = HOST.name === 'macos-arm64' ? LINUX : target('macos-arm64');

function build(
	/** @type {string} */ root,
	on = HOST,
	{ binaries = ['agent', 'probe'], extras = ['share/probe'] } = {}
) {
	const tree = buildTree(root, on.name);
	mkdirSync(tree.bin, { recursive: true });
	for (const name of binaries) writeFileSync(join(tree.bin, `${name}${on.exe}`), `binary ${name}`);
	for (const extra of extras) {
		mkdirSync(join(tree.root, extra), { recursive: true });
		writeFileSync(join(tree.root, extra, 'object.o'), 'objects');
	}
	return tree;
}

test('a staged package carries the binaries, the manifest npm filters on, and the index', () =>
	withTempDir('kit-stage-', async (root) => {
		build(root);
		const base = one(packagesFor(CONFIG, HOST), 'base package');
		const dir = stagePackage({ root, pkg: base, version: '3.1.0', manifest: CONFIG.manifest });

		const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
		assert.equal(manifest.name, `@x/agent-${HOST.name}`);
		assert.equal(manifest.version, '3.1.0');
		// npm's names, not the label's: `macos-arm64` filters on darwin, and the label would match no host.
		assert.deepEqual(manifest.os, [HOST.npmOs]);
		assert.deepEqual(manifest.cpu, [HOST.npmCpu]);
		assert.equal(manifest.license, 'Apache-2.0', 'the consumer’s own manifest fields carry through');
		assert.ok(manifest.files.includes('bin/'));
		assert.ok(existsSync(join(dir, 'bin', `agent${HOST.exe}`)));
		assert.ok(existsSync(join(dir, 'index.js')));
	}));

// npm packs the mode it finds, so a binary staged without this installs unexecutable and the failure is at
// spawn time on the customer's node. NTFS cannot carry the bit, so there the staging has to refuse instead.
test('the executable bit survives staging, and staging refuses where it cannot', () =>
	withTempDir('kit-mode-', async (root) => {
		build(root, LINUX);
		const base = one(packagesFor(CONFIG, LINUX), 'base package');
		const stage = () => stagePackage({ root, pkg: base, version: '1.0.0', manifest: {} });
		if (carriesExecutableBit(root)) {
			assert.equal(statSync(join(stage(), 'bin', 'agent')).mode & 0o111, 0o111);
		} else {
			assert.throws(stage, /did not keep its executable bit/);
		}
	}));

// Windows packages are the case that still has to work on Windows: the .exe carries no bit to lose.
test('a windows package stages wherever it is staged', () =>
	withTempDir('kit-winmode-', async (root) => {
		build(root, WINDOWS);
		const base = one(packagesFor(CONFIG, WINDOWS), 'base package');
		const dir = stagePackage({ root, pkg: base, version: '1.0.0', manifest: {} });
		assert.ok(existsSync(join(dir, 'bin', 'agent.exe')));
	}));

test('a variant that ships extra directories stages them and exports an accessor', () =>
	withTempDir('kit-extras-', async (root) => {
		build(root);
		const probe = one(packagesFor(CONFIG, HOST), 'probe package', 1);
		const dir = stagePackage({ root, pkg: probe, version: '1.0.0', manifest: {} });
		assert.ok(existsSync(join(dir, 'share', 'probe', 'object.o')));
		const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
		assert.ok(manifest.files.includes('share/probe/'), 'staged but not listed in files is staged and not shipped');
		assert.match(readFileSync(join(dir, 'index.js'), 'utf-8'), /getShareProbeDir/);
	}));

test('the accessor name follows one rule, so a consumer can predict it', () => {
	assert.equal(accessorName('share/probe'), 'getShareProbeDir');
	assert.equal(accessorName('share/system-probe'), 'getShareSystemProbeDir');
	assert.equal(accessorName('lib'), 'getLibDir');
});

// A package staged around a missing binary is one npm publishes and nothing can run, and the build that was
// supposed to produce it failed somewhere upstream where nobody looked.
test('NEGATIVE: a binary the build did not produce stops the staging, naming the path', () =>
	withTempDir('kit-missing-', async (root) => {
		build(root, HOST, { binaries: ['agent'] });
		const probe = one(packagesFor(CONFIG, HOST), 'probe package', 1);
		assert.throws(
			() => stagePackage({ root, pkg: probe, version: '1.0.0', manifest: {} }),
			(/** @type {any} */ error) => {
				// The filename, not shipsAs: on Windows it is probe.exe, and the message must name that file.
				assert.ok(error.message.includes(`carries probe${HOST.exe} and there is nothing at`), error.message);
				assert.ok(error.message.includes(`Run the build for ${HOST.name}`), error.message);
				return true;
			}
		);
	}));

test('NEGATIVE: an extra directory the build did not produce stops the staging too', () =>
	withTempDir('kit-noextra-', async (root) => {
		build(root, HOST, { extras: [] });
		const probe = one(packagesFor(CONFIG, HOST), 'probe package', 1);
		assert.throws(
			() => stagePackage({ root, pkg: probe, version: '1.0.0', manifest: {} }),
			(/** @type {any} */ error) => {
				assert.match(error.message, /ships share\/probe and there is nothing at/);
				// The reason it matters: the binary starts and does nothing, which is worse than failing to start.
				assert.match(error.message, /worse than failing to start/);
				return true;
			}
		);
	}));

test('NEGATIVE: an --only that matches nothing is an error, not a quiet success', () =>
	withTempDir('kit-only-', async (root) => {
		build(root);
		assert.throws(
			() => stageAll({ root, config: CONFIG, version: '1.0.0', targets: [LINUX], only: 'probe-macos-arm64' }),
			/no package named "probe-macos-arm64" among the targets given \(linux-x86_64\)/
		);
	}));

test('NEGATIVE: staging with no targets at all is an error', () =>
	withTempDir('kit-none-', async (root) => {
		assert.throws(() => stageAll({ root, config: CONFIG, version: '1.0.0', targets: [] }), /no packages were staged/);
	}));

test('--only stages exactly the one package, from its own target tree', () =>
	withTempDir('kit-one-', async (root) => {
		build(root);
		const staged = stageAll({
			root,
			config: CONFIG,
			version: '1.0.0',
			targets: [HOST, OTHER],
			only: `probe-${HOST.name}`,
		});
		assert.deepEqual(staged, [`@x/agent-probe-${HOST.name}`]);
		assert.ok(existsSync(packageDir(root, `probe-${HOST.name}`)));
		assert.ok(!existsSync(packageDir(root, HOST.name)), 'it staged a package it was not asked for');
	}));

test('the generated module is CommonJS, since a platform package is required by whatever loader a host has', () => {
	const source = indexModule({ agent: 'agent' }, []);
	assert.match(source, /module\.exports = \{/);
	assert.match(source, /require\('path'\)/);
	assert.doesNotMatch(source, /\bexport\b/);
});
