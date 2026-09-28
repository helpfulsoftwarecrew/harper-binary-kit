// The two halves of `getBinaryPath` against each other: every case stages a real package and resolves a
// binary back out of it, because separately the writer and the caller agree only with themselves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { buildTree, packageDir } from '../../src/layout.js';
import { packagesFor } from '../../src/packages.js';
import { createBinaryResolver } from '../../src/resolve.js';
import { stagePackage } from '../../src/stage.js';
import { currentTargetName, target } from '../../src/targets.js';
import { one, withTempDir } from '../support/sandbox.js';

const HERE = target(currentTargetName() ?? 'linux-x86_64');

const CONFIG = {
	scope: '@test/widget',
	variants: [
		{ suffix: '' },
		{ suffix: '-probe', optional: true, carries: 'It carries the probe and its objects.', extraDirs: ['share/probe'] },
	],
	binaries: [{ shipsAs: 'widget' }, { shipsAs: 'widget-helper' }, { shipsAs: 'probe', variant: '-probe' }],
};

/** A build tree with every declared binary in it, as a build would leave one. */
function fakeBuild(/** @type {string} */ root, /** @type {string[]} */ extraDirs = []) {
	const tree = buildTree(root, HERE.name);
	mkdirSync(tree.bin, { recursive: true });
	for (const binary of CONFIG.binaries) {
		writeFileSync(join(tree.bin, `${binary.shipsAs}${HERE.exe}`), `#!/bin/sh\necho ${binary.shipsAs}\n`);
	}
	for (const dir of extraDirs) {
		mkdirSync(join(tree.root, dir), { recursive: true });
		writeFileSync(join(tree.root, dir, 'object.o'), 'objects');
	}
	return tree;
}

/**
 * A resolver whose `load` returns the staged package. `packageRoot` has no build tree, because a fallback
 * that succeeds hides every failure the packages themselves would report.
 */
function resolverOver(
	/** @type {string} */ root,
	/** @type {Map<string, string>} */ staged,
	packageRoot = join(root, 'no-build-here')
) {
	const require = createRequire(import.meta.url);
	return createBinaryResolver({
		packageName: CONFIG.scope,
		packageRoot,
		variants: CONFIG.variants,
		load: async (name) => {
			const dir = staged.get(name);
			if (!dir) throw new Error(`Cannot find module '${name}'`);
			return require(join(dir, 'index.js'));
		},
	});
}

/** Stage every package this target publishes and hand back a name→directory map. */
function stageEverything(/** @type {string} */ root, version = '1.0.0') {
	/** @type {Map<string, string>} */
	const staged = new Map();
	for (const pkg of packagesFor(CONFIG, HERE)) {
		stagePackage({ root, pkg, version, manifest: {} });
		staged.set(pkg.name, packageDir(root, pkg.dirName));
	}
	return staged;
}

test('a binary staged into a package is the one the resolver hands back', () =>
	withTempDir('kit-contract-', async (root) => {
		fakeBuild(root, ['share/probe']);
		const staged = stageEverything(root);
		const resolve = resolverOver(root, staged);
		// realpath, since macOS hands mkdtemp a /var path that resolves to /private/var.
		const staging = realpathSync(join(root, 'npm'));

		for (const binary of CONFIG.binaries) {
			const path = await resolve.resolveBinary({ shipsAs: binary.shipsAs });
			assert.match(path, new RegExp(`${binary.shipsAs}${HERE.exe.replace('.', '\\.')}$`));
			assert.ok(
				realpathSync(path).startsWith(staging),
				`resolved outside the staged packages, so a local build answered instead: ${path}`
			);
		}
	}));

// A key mismatch is a package that installs and answers "Unknown binary" for everything in it.
test('NEGATIVE: the key the resolver asks for is the key the staging wrote', () =>
	withTempDir('kit-keys-', async (root) => {
		fakeBuild(root, ['share/probe']);
		const staged = stageEverything(root);
		const require = createRequire(import.meta.url);
		const base = require(join(String(staged.get(`@test/widget-${HERE.name}`)), 'index.js'));
		assert.deepEqual(Object.keys(base.getBinaryPath ? { 'widget': 1, 'widget-helper': 1 } : {}).sort(), [
			'widget',
			'widget-helper',
		]);
		// Asked by the name it ships under, which is what the descriptor carries and what the resolver passes.
		for (const shipsAs of ['widget', 'widget-helper']) {
			assert.ok(base.getBinaryPath(shipsAs).endsWith(`${shipsAs}${HERE.exe}`));
		}
		assert.throws(() => base.getBinaryPath('not-a-binary'), /Unknown binary: not-a-binary/);
		// The refusal names what the package does have, or a caller has to go read the tarball to find out.
		assert.throws(() => base.getBinaryPath('not-a-binary'), /widget, widget-helper/);
	}));

// A package published before a second binary existed answers every name with the first, which exists on disk.
test('NEGATIVE: a package answering with the wrong binary is refused, not resolved', () =>
	withTempDir('kit-stale-', async (root) => {
		fakeBuild(root, ['share/probe']);
		const staged = stageEverything(root);
		const require = createRequire(import.meta.url);
		const resolve = createBinaryResolver({
			packageName: CONFIG.scope,
			packageRoot: join(root, 'no-build-here'),
			variants: CONFIG.variants,
			// An older publish of the base package: it answers every name with the one binary it knows.
			load: async (name) => {
				const dir = staged.get(name);
				if (!dir) throw new Error(`Cannot find module '${name}'`);
				const real = require(join(dir, 'index.js'));
				return { getBinaryPath: () => real.getBinaryPath('widget') };
			},
		});
		await assert.rejects(
			() => resolve.resolveBinary({ shipsAs: 'widget-helper', title: 'the helper' }),
			(/** @type {any} */ error) => {
				assert.match(error.message, /predates widget-helper/);
				assert.match(error.message, /widget/);
				return true;
			}
		);
	}));

test('an extra directory is staged and the package says where it landed', () =>
	withTempDir('kit-extra-', async (root) => {
		fakeBuild(root, ['share/probe']);
		const staged = stageEverything(root);
		const resolve = resolverOver(root, staged);
		const dir = await resolve.resolveDir(one(CONFIG.variants, 'variant', 1), 'getShareProbeDir');
		assert.ok(dir, 'the probe package reported no directory for the objects it ships');
		assert.ok(dir.endsWith(join('share', 'probe')));
	}));

// An add-on nobody installed is an operator's choice, not a broken install, and the message must say so.
test('NEGATIVE: an uninstalled add-on reads as opt-in, and names the install', () =>
	withTempDir('kit-optin-', async (root) => {
		fakeBuild(root, ['share/probe']);
		const staged = stageEverything(root);
		staged.delete(`@test/widget-probe-${HERE.name}`);
		const resolve = resolverOver(root, staged);
		await assert.rejects(
			() => resolve.resolveBinary({ shipsAs: 'probe' }),
			(/** @type {any} */ error) => {
				assert.match(error.message, /is not installed/);
				assert.match(error.message, /It carries the probe and its objects\./);
				assert.match(error.message, new RegExp(`npm install @test/widget-probe-${HERE.name}`));
				return true;
			}
		);
	}));

// The dev path: nothing installed at all, and a build tree beside the checkout.
test('a dev checkout with no packages installed resolves its own build output', () =>
	withTempDir('kit-dev-', async (root) => {
		const tree = fakeBuild(root);
		// The checkout itself as packageRoot is the dev case: nothing installed, and the build tree answers.
		const resolve = resolverOver(root, new Map(), root);
		const path = await resolve.resolveBinary({ shipsAs: 'widget' });
		assert.equal(path, join(tree.bin, `widget${HERE.exe}`));
	}));
