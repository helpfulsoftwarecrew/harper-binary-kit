// The CLI as a release invokes it: a real repo on disk, the real argv, and the file read back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withTempDir } from '../support/sandbox.js';

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

const CONFIG = `export default {
	scope: '@x/agent',
	targets: ['linux-x86_64', 'macos-arm64'],
	variants: [{ suffix: '' }],
	binaries: [{ shipsAs: 'agent' }],
};
`;

/** A consumer repo the CLI can be pointed at, with `version` and whatever optionalDependencies are given. */
function repo(
	/** @type {string} */ dir,
	/** @type {string} */ version,
	/** @type {Record<string, string>} */ optionalDependencies
) {
	writeFileSync(join(dir, 'binary-kit.config.js'), CONFIG);
	writeFileSync(
		join(dir, 'package.json'),
		`${JSON.stringify({ name: '@x/agent', version, optionalDependencies }, null, '\t')}\n`
	);
}

const run = (/** @type {string} */ dir, /** @type {string[]} */ argv) =>
	execFileSync(process.execPath, [CLI, ...argv], { cwd: dir, encoding: 'utf-8' });

const manifest = (/** @type {string} */ dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));

test('deps --write puts the release version on every optional dependency', () =>
	withTempDir('kit-cli-deps-', async (dir) => {
		repo(dir, '2.0.3', { '@x/agent-linux-x86_64': '1.0.1' });
		run(dir, ['deps', '--write']);
		assert.deepEqual(manifest(dir).optionalDependencies, {
			'@x/agent-linux-x86_64': '2.0.3',
			'@x/agent-macos-arm64': '2.0.3',
		});
	}));

// `npm version` runs this as a lifecycle script, so it rewrites the pins and nothing else.
test('deps --write leaves the rest of the manifest alone', () =>
	withTempDir('kit-cli-keep-', async (dir) => {
		repo(dir, '2.0.3', { '@x/agent-linux-x86_64': '1.0.1' });
		run(dir, ['deps', '--write']);
		const written = manifest(dir);
		assert.equal(written.name, '@x/agent');
		assert.equal(written.version, '2.0.3');
		assert.match(readFileSync(join(dir, 'package.json'), 'utf-8'), /^\t"name"/m, 'it reindented the manifest');
	}));

test('NEGATIVE: deps without --write prints and changes nothing', () =>
	withTempDir('kit-cli-dry-', async (dir) => {
		repo(dir, '2.0.3', { '@x/agent-linux-x86_64': '1.0.1' });
		const before = readFileSync(join(dir, 'package.json'), 'utf-8');
		const printed = run(dir, ['deps']);
		assert.match(printed, /2\.0\.3/, 'it should still print the block');
		assert.equal(readFileSync(join(dir, 'package.json'), 'utf-8'), before);
	}));

// Refused from the version alone, before a staged package or the registry is looked at.
test('NEGATIVE: publish refuses a prerelease and exits non-zero', () =>
	withTempDir('kit-cli-pre-', async (dir) => {
		repo(dir, '2.0.0-beta.1', {});
		assert.throws(
			() => execFileSync(process.execPath, [CLI, 'publish'], { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }),
			(/** @type {any} */ error) => error.status === 1 && /2\.0\.0-beta\.1 is a prerelease/.test(error.stderr)
		);
	}));

// The tag is chosen at publish time, so no command writes a dist-tag afterwards.
test('NEGATIVE: there is no latest command', () =>
	withTempDir('kit-cli-latest-', async (dir) => {
		repo(dir, '2.0.3', {});
		assert.throws(
			() => execFileSync(process.execPath, [CLI, 'latest'], { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }),
			(/** @type {any} */ error) => error.status === 2 && !/latest/.test(error.stderr.split('<')[1] ?? '')
		);
	}));

test('every path the manifest promises to ship exists', () => {
	const root = new URL('../../', import.meta.url);
	const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf-8'));
	const missing = manifest.files.filter((/** @type {string} */ entry) => !existsSync(new URL(entry, root)));
	assert.deepEqual(missing, [], 'files[] names paths that are not in the repository');
});

// npm sets the bit at install time, and an install that skips that step leaves a mode-644 bin unrunnable.
test('every bin entry is executable in git, not only after npm repairs it', () => {
	const root = fileURLToPath(new URL('../../', import.meta.url));
	const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
	const notExecutable = Object.values(manifest.bin ?? {})
		.map((rel) => String(rel).replace(/^\.\//, ''))
		.filter((file) => {
			const mode = execFileSync('git', ['ls-files', '-s', file], { cwd: root, encoding: 'utf-8' }).split(/\s+/)[0];
			return mode !== '100755';
		});
	assert.deepEqual(notExecutable, [], 'bin entries git records without the executable bit');
});
