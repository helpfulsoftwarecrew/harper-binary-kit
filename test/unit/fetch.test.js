// The release fetch against a loopback server holding real archives: what lands in the build tree when every
// check passes, and that nothing lands when any one of them fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
	cosignArgs,
	cosignCheck,
	fetchRelease,
	parseChecksums,
	pinRelease,
	readPins,
	releaseConfig,
	sha256,
} from '../../src/fetch.js';
import { buildTree } from '../../src/layout.js';
import { stageAll } from '../../src/stage.js';
import { targets } from '../../src/targets.js';
import { tarGz, withReleaseServer, zip } from '../support/archives.js';
import { carriesExecutableBit, withTempDir } from '../support/sandbox.js';

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
const TAG = 'v0.162.0';
const REPO = 'example/collector-releases';
const at = (/** @type {string} */ name) => `/${REPO}/releases/download/${TAG}/${name}`;

const LINUX_TGZ = 'collector_0.162.0_linux_amd64.tar.gz';
const WINDOWS_ZIP = 'collector-windows-amd64.exe.zip';

const linuxArchive = tarGz([
	{ name: 'otelcol', data: '#!/bin/sh\necho linux\n', mode: 0o755 },
	{ name: 'LICENSE', data: 'Apache-2.0' },
	{ name: 'licenses/', kind: 'dir', mode: 0o755 },
	{ name: 'licenses/a.txt', data: 'a' },
	{ name: 'licenses/sub/b.txt', data: 'b' },
]);
const windowsArchive = zip([{ name: 'collector-windows-amd64.exe', data: 'MZ windows', mode: 0o755 }]);

/** A consumer config, typed loosely so a test can break it. @param {Partial<Record<string, any>>} [release] @returns {any} */
const configWith = (release = {}) => ({
	scope: '@x/collector',
	targets: ['linux-x86_64', 'windows-x86_64'],
	variants: [{ suffix: '' }],
	binaries: [{ shipsAs: 'otelcol' }],
	release: {
		repo: REPO,
		tag: TAG,
		checksums: 'checksums.txt',
		assets: {
			'linux-x86_64': {
				name: LINUX_TGZ,
				binaries: { otelcol: 'otelcol' },
				files: { 'LICENSE': 'share/LICENSE', 'licenses/': 'share/licenses' },
			},
			'windows-x86_64': { name: WINDOWS_ZIP, binaries: { otelcol: 'collector-windows-amd64.exe' } },
		},
		...release,
	},
});

const checksums = `${sha256(linuxArchive)}  ${LINUX_TGZ}\n${sha256(windowsArchive)} *${WINDOWS_ZIP}\n`;
const SERVED = {
	[at(LINUX_TGZ)]: linuxArchive,
	[at(WINDOWS_ZIP)]: windowsArchive,
	[at('checksums.txt')]: checksums,
};

/** Write the pin file a reviewed `pin` run would have committed. @param {string} root @param {string} [body] */
const commitPins = (root, body = checksums) =>
	writeFileSync(join(root, 'release.sha256'), `# harper-binary-kit pins ${REPO} ${TAG}\n${body}`);

const neverCalled = async () => {
	throw new Error('no sigstore check was configured, so none should run');
};

test('a tar.gz and a zip land in their build trees, binaries executable and named for the target', () =>
	withTempDir('kit-fetch-ok-', (root) =>
		withReleaseServer(SERVED, async (baseUrl) => {
			commitPins(root);
			const config = configWith();
			const written = await fetchRelease({
				root,
				config,
				targets: targets(config.targets),
				baseUrl,
				verifyBundle: neverCalled,
			});
			const linux = buildTree(root, 'linux-x86_64');
			const windows = buildTree(root, 'windows-x86_64');
			assert.deepEqual(
				written.sort(),
				[
					join(linux.bin, 'otelcol'),
					join(linux.root, 'share/LICENSE'),
					join(linux.root, 'share/licenses/a.txt'),
					join(linux.root, 'share/licenses/sub/b.txt'),
					join(windows.bin, 'otelcol.exe'),
				].sort()
			);
			assert.equal(readFileSync(join(linux.bin, 'otelcol'), 'utf-8'), '#!/bin/sh\necho linux\n');
			assert.equal(readFileSync(join(windows.bin, 'otelcol.exe'), 'utf-8'), 'MZ windows');
			assert.equal(readFileSync(join(linux.root, 'share/licenses/sub/b.txt'), 'utf-8'), 'b');
			if (carriesExecutableBit(root)) assert.equal(statSync(join(linux.bin, 'otelcol')).mode & 0o111, 0o111);
		})
	));

// Staging is what consumes a fetch, so the two run against each other. Windows, since staging a POSIX target
// on NTFS is refused for the executable bit it cannot keep.
test('what fetch writes stages as a platform package', () =>
	withTempDir('kit-fetch-stage-', (root) =>
		withReleaseServer(SERVED, async (baseUrl) => {
			commitPins(root);
			const config = configWith();
			const list = targets(config.targets);
			await fetchRelease({ root, config, targets: list, only: 'windows-x86_64', baseUrl, verifyBundle: neverCalled });
			const staged = stageAll({ root, config, version: '1.0.0', targets: list, only: 'windows-x86_64' });
			assert.deepEqual(staged, ['@x/collector-windows-x86_64']);
			assert.ok(existsSync(join(root, 'npm', 'windows-x86_64', 'bin', 'otelcol.exe')));
		})
	));

test('NEGATIVE: an asset whose sha256 differs from the pin is refused and nothing is written', () =>
	withTempDir('kit-fetch-sha-', (root) =>
		withReleaseServer(
			{ ...SERVED, [at(LINUX_TGZ)]: tarGz([{ name: 'otelcol', data: 'swapped', mode: 0o755 }]) },
			async (baseUrl) => {
				commitPins(root);
				const config = configWith();
				await assert.rejects(
					fetchRelease({ root, config, targets: targets(config.targets), baseUrl, verifyBundle: neverCalled }),
					new RegExp(`${LINUX_TGZ} has sha256 [0-9a-f]{64}, and the pin says ${sha256(linuxArchive)}; refusing it`)
				);
				assert.equal(existsSync(join(root, 'build')), false, 'a refused asset wrote into the build tree');
			}
		)
	));

test('NEGATIVE: an asset the release does not hold fails on the 404', () =>
	withTempDir('kit-fetch-404-', (root) =>
		withReleaseServer({ [at(LINUX_TGZ)]: linuxArchive }, async (baseUrl) => {
			commitPins(root);
			const config = configWith();
			await assert.rejects(
				fetchRelease({
					root,
					config,
					targets: targets(config.targets),
					only: 'windows-x86_64',
					baseUrl,
					verifyBundle: neverCalled,
				}),
				/answered 404/
			);
			assert.equal(existsSync(join(root, 'build')), false);
		})
	));

test('NEGATIVE: a target with no declared asset, or an asset with no pin, is refused before any download', () =>
	withTempDir('kit-fetch-undeclared-', (root) =>
		withReleaseServer(SERVED, async (baseUrl, asked) => {
			const config = configWith();
			delete config.release.assets['windows-x86_64'];
			commitPins(root);
			await assert.rejects(
				fetchRelease({ root, config, targets: targets(config.targets), only: 'windows-x86_64', baseUrl }),
				/declares no asset for windows-x86_64/
			);
			commitPins(root, `${sha256(windowsArchive)}  ${WINDOWS_ZIP}\n`);
			await assert.rejects(
				fetchRelease({ root, config, targets: targets(config.targets), only: 'linux-x86_64', baseUrl }),
				new RegExp(`pins no sha256 for ${LINUX_TGZ}`)
			);
			assert.deepEqual(asked, []);
		})
	));

// The last target fails, so a per-target check would already have written linux. Each case runs in a fresh
// root; `requests` says whether the failure must come before any download.
test('NEGATIVE: a full fetch whose last target fails writes nothing for any target', async () => {
	const swapped = zip([{ name: 'collector-windows-amd64.exe', data: 'MZ swapped', mode: 0o755 }]);
	const linked = zip([{ name: 'collector-windows-amd64.exe', kind: 'symlink', linkTo: '/bin/sh' }]);
	const bundles = {
		[at(`${LINUX_TGZ}.sigstore.json`)]: '{"for":"linux"}',
		[at(`${WINDOWS_ZIP}.sigstore.json`)]: '{"for":"windows"}',
	};
	const sigstore = { bundle: '{asset}.sigstore.json', issuer: 'https://issuer.example', identity: 'x' };
	/** @type {{ name: string, served: Record<string, string | Uint8Array>, pins?: string, config: any, requests: boolean, error: RegExp, verifyBundle?: import('../../src/fetch.js').BundleCheck }[]} */
	const cases = [
		{
			name: 'sha mismatch',
			served: { ...SERVED, [at(WINDOWS_ZIP)]: swapped },
			config: configWith(),
			requests: true,
			error: new RegExp(`${WINDOWS_ZIP} has sha256 ${sha256(swapped)}, and the pin says`),
		},
		{
			name: 'missing pin',
			served: SERVED,
			pins: `${sha256(linuxArchive)}  ${LINUX_TGZ}\n`,
			config: configWith(),
			requests: false,
			error: new RegExp(`pins no sha256 for ${WINDOWS_ZIP}`),
		},
		{
			name: 'undeclared asset',
			served: SERVED,
			config: (() => {
				const config = configWith();
				delete config.release.assets['windows-x86_64'];
				return config;
			})(),
			requests: false,
			error: /declares no asset for windows-x86_64/,
		},
		{
			name: 'bad bundle',
			served: { ...SERVED, ...bundles },
			config: configWith({ sigstore }),
			requests: true,
			error: /the sigstore bundle for collector-windows-amd64\.exe\.zip did not verify/,
			verifyBundle: async ({ assetName }) => {
				if (assetName === WINDOWS_ZIP) throw new Error(`the sigstore bundle for ${assetName} did not verify`);
			},
		},
		{
			name: 'member is a link',
			served: { ...SERVED, [at(WINDOWS_ZIP)]: linked },
			pins: `${sha256(linuxArchive)}  ${LINUX_TGZ}\n${sha256(linked)}  ${WINDOWS_ZIP}\n`,
			config: configWith(),
			requests: true,
			error: /member collector-windows-amd64\.exe is a link, not a file/,
		},
	];
	for (const c of cases)
		await withTempDir('kit-fetch-last-', (root) =>
			withReleaseServer(c.served, async (baseUrl, asked) => {
				commitPins(root, c.pins);
				await assert.rejects(
					fetchRelease({
						root,
						config: c.config,
						targets: targets(['linux-x86_64', 'windows-x86_64']),
						baseUrl,
						verifyBundle: c.verifyBundle ?? neverCalled,
					}),
					c.error,
					c.name
				);
				assert.equal(existsSync(join(root, 'build')), false, `${c.name}: an earlier target was written`);
				assert.deepEqual(readdirSync(root), ['release.sha256'], c.name);
				if (c.requests) assert.ok(asked.includes(at(LINUX_TGZ)), `${c.name}: linux was never downloaded`);
				else assert.deepEqual(asked, [], `${c.name}: a request went out before the refusal`);
			})
		);
});

test('NEGATIVE: a pin file written for another tag is refused as stale, not as a mismatch', () =>
	withTempDir('kit-fetch-stale-', async (root) => {
		writeFileSync(join(root, 'release.sha256'), `# harper-binary-kit pins ${REPO} v0.161.0\n${checksums}`);
		assert.throws(() => readPins(root, releaseConfig(configWith())), /pins another release/);
	}));

test('NEGATIVE: an archive with a traversal member is refused even though its sha256 is pinned', () =>
	withTempDir('kit-fetch-traversal-', (root) => {
		const hostile = tarGz([
			{ name: 'otelcol', data: 'binary', mode: 0o755 },
			{ name: '../../escaped', data: 'payload' },
		]);
		return withReleaseServer({ [at(LINUX_TGZ)]: hostile }, async (baseUrl) => {
			commitPins(root, `${sha256(hostile)}  ${LINUX_TGZ}\n`);
			const config = configWith();
			await assert.rejects(
				fetchRelease({
					root,
					config,
					targets: targets(config.targets),
					only: 'linux-x86_64',
					baseUrl,
					verifyBundle: neverCalled,
				}),
				/climbs out of the extraction directory/
			);
			assert.equal(existsSync(join(root, 'build')), false);
			assert.deepEqual(readdirSync(root), ['release.sha256']);
		});
	}));

test('NEGATIVE: a member named as a binary that is a symlink, or absent, is refused', () =>
	withTempDir('kit-fetch-link-', (root) => {
		const linked = tarGz([{ name: 'otelcol', kind: 'symlink', linkTo: '/bin/sh' }]);
		return withReleaseServer({ [at(LINUX_TGZ)]: linked }, async (baseUrl) => {
			commitPins(root, `${sha256(linked)}  ${LINUX_TGZ}\n`);
			const config = configWith();
			const args = {
				root,
				config,
				targets: targets(config.targets),
				only: 'linux-x86_64',
				baseUrl,
				verifyBundle: neverCalled,
			};
			await assert.rejects(fetchRelease(args), /member otelcol is a link, not a file/);
			config.release.assets['linux-x86_64'].binaries = { otelcol: 'bin/otelcol' };
			await assert.rejects(fetchRelease(args), /has no member bin\/otelcol/);
			assert.equal(existsSync(join(root, 'build')), false);
		});
	}));

test('NEGATIVE: a files destination outside the build tree is refused before any download', () =>
	withTempDir('kit-fetch-dest-', (root) =>
		withReleaseServer(SERVED, async (baseUrl, asked) => {
			commitPins(root);
			for (const dest of ['../../LICENSE', '/etc/LICENSE', '.']) {
				const config = configWith();
				config.release.assets['linux-x86_64'].files = { LICENSE: dest };
				await assert.rejects(
					fetchRelease({ root, config, targets: targets(config.targets), only: 'linux-x86_64', baseUrl }),
					/sends LICENSE to .*, outside build\/linux-x86_64/
				);
			}
			assert.deepEqual(asked, []);
			assert.equal(existsSync(join(root, 'build')), false);
		})
	));

test('a configured sigstore bundle is fetched and checked before anything is written', () =>
	withTempDir('kit-fetch-sigstore-', (root) =>
		withReleaseServer({ ...SERVED, [at(`${LINUX_TGZ}.sigstore.json`)]: '{"bundle":true}' }, async (baseUrl) => {
			commitPins(root);
			const sigstore = {
				bundle: '{asset}.sigstore.json',
				issuer: 'https://issuer.example',
				identityRegexp: '^https://',
			};
			const config = configWith({ sigstore });
			/** @type {any[]} */
			const seen = [];
			const args = { root, config, targets: targets(config.targets), only: 'linux-x86_64', baseUrl };
			await fetchRelease({ ...args, verifyBundle: async (input) => void seen.push(input) });
			assert.equal(seen.length, 1);
			assert.equal(sha256(seen[0].blob), sha256(linuxArchive));
			assert.equal(new TextDecoder().decode(seen[0].bundle), '{"bundle":true}');
			assert.deepEqual(seen[0].sigstore, sigstore);

			const failing = async () => {
				throw new Error('the sigstore bundle did not verify: wrong identity');
			};
			await withTempDir('kit-fetch-sigstore-bad-', async (other) => {
				commitPins(other);
				await assert.rejects(fetchRelease({ ...args, root: other, verifyBundle: failing }), /wrong identity/);
				assert.equal(existsSync(join(other, 'build')), false);
			});
		})
	));

test('NEGATIVE: a configured sigstore check with no cosign to run refuses rather than skipping', async () => {
	const check = cosignCheck(join(process.cwd(), 'no-such-cosign'));
	await assert.rejects(
		check({
			blob: new Uint8Array([1]),
			bundle: new Uint8Array([2]),
			sigstore: { bundle: '{asset}.sigstore.json', issuer: 'https://issuer.example', identity: 'x' },
			assetName: 'a.tar.gz',
		}),
		/the sigstore bundle for a\.tar\.gz did not verify: .*no-such-cosign is not on PATH/
	);
});

test('pin writes the release header and every declared asset from a combined checksums file', () =>
	withTempDir('kit-pin-combined-', (root) =>
		withReleaseServer(SERVED, async (baseUrl) => {
			const { text } = await pinRelease({ root, config: configWith(), baseUrl });
			assert.equal(
				text,
				`# harper-binary-kit pins ${REPO} ${TAG}\n${sha256(windowsArchive)}  ${WINDOWS_ZIP}\n${sha256(linuxArchive)}  ${LINUX_TGZ}\n`
			);
			assert.deepEqual(readPins(root, releaseConfig(configWith())).get(LINUX_TGZ), sha256(linuxArchive));
		})
	));

test('pin reads per-asset digest files, bare hex included', () =>
	withTempDir('kit-pin-each-', (root) =>
		withReleaseServer(
			{
				[at(`${LINUX_TGZ}.sha256`)]: sha256(linuxArchive),
				[at(`${WINDOWS_ZIP}.sha256`)]: `${sha256(windowsArchive)}  ${WINDOWS_ZIP}\n`,
			},
			async (baseUrl) => {
				await pinRelease({ root, config: configWith({ checksums: '{asset}.sha256' }), baseUrl });
				const pins = readPins(root, releaseConfig(configWith()));
				assert.equal(pins.get(LINUX_TGZ), sha256(linuxArchive));
				assert.equal(pins.get(WINDOWS_ZIP), sha256(windowsArchive));
			}
		)
	));

test('NEGATIVE: pin refuses a checksums file that leaves an asset out, and writes no pin file', () =>
	withTempDir('kit-pin-missing-', (root) =>
		withReleaseServer({ [at('checksums.txt')]: `${sha256(linuxArchive)}  ${LINUX_TGZ}\n` }, async (baseUrl) => {
			await assert.rejects(
				pinRelease({ root, config: configWith(), baseUrl }),
				new RegExp(`no digest for ${WINDOWS_ZIP}`)
			);
			assert.equal(existsSync(join(root, 'release.sha256')), false);
		})
	));

test('parseChecksums reads sha256sum text and refuses a line it cannot read', () => {
	assert.deepEqual(
		[...parseChecksums(`${'a'.repeat(64)}  x.zip\n${'B'.repeat(64)} *y.tar.gz\n`)],
		[
			['x.zip', 'a'.repeat(64)],
			['y.tar.gz', 'b'.repeat(64)],
		]
	);
	assert.throws(() => parseChecksums('md5 x.zip'), /unreadable checksum line/);
});

test('NEGATIVE: releaseConfig refuses an asset for an undeclared target or binary, and a half sigstore block', () => {
	const config = configWith();
	assert.throws(
		() =>
			releaseConfig({
				...config,
				release: { ...config.release, assets: { 'macos-arm64': config.release.assets['linux-x86_64'] } },
			}),
		/macos-arm64, which is not a declared target/
	);
	assert.throws(
		() => releaseConfig({ ...config, binaries: [{ shipsAs: 'other' }] }),
		/ships otelcol, which binaries does not declare/
	);
	assert.throws(
		() =>
			releaseConfig(configWith({ sigstore: { bundle: '{asset}.sigstore.json', issuer: 'https://issuer.example' } })),
		/exactly one of identity and identityRegexp/
	);
	assert.throws(
		() => releaseConfig(configWith({ sigstore: { bundle: '{asset}.sigstore.json', issuer: '', identity: 'x' } })),
		/issuer must name the OIDC issuer/
	);
	assert.throws(() => releaseConfig({ ...config, release: undefined }), /declares no `release` block/);
});

test('cosign gets an exact identity as given and an identity pattern anchored at both ends', () => {
	const base = { bundle: '{asset}.sigstore.json', issuer: 'https://issuer.example' };
	assert.deepEqual(cosignArgs({ ...base, identity: 'https://a/wf.yaml@refs/tags/v1' }, 'b.json', 'blob'), [
		'verify-blob',
		'--bundle',
		'b.json',
		'--certificate-identity',
		'https://a/wf.yaml@refs/tags/v1',
		'--certificate-oidc-issuer',
		'https://issuer.example',
		'blob',
	]);
	const args = cosignArgs({ ...base, identityRegexp: 'https://a/.*|https://b/x' }, 'b.json', 'blob');
	const pattern = args[args.indexOf('--certificate-identity-regexp') + 1] ?? '';
	assert.equal(pattern, '^(?:https://a/.*|https://b/x)$');
	// JavaScript and Go's RE2 agree on this subset, so this is what cosign will match.
	const re = new RegExp(pattern);
	assert.ok(re.test('https://a/wf.yaml'));
	assert.ok(re.test('https://b/x'));
	assert.equal(re.test('https://evil.example/?https://a/'), false);
	assert.equal(re.test('https://b/x-and-more'), false);
});

test('the CLI fetches with `fetch --only` and pins with `pin`', () =>
	withTempDir('kit-fetch-cli-', (root) =>
		withReleaseServer(SERVED, async (baseUrl) => {
			writeFileSync(
				join(root, 'binary-kit.config.js'),
				`export default ${JSON.stringify(configWith(), null, '\t')};\n`
			);
			writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@x/collector', version: '1.0.0' }));
			const run = (/** @type {string[]} */ argv) =>
				promisify(execFile)(process.execPath, [CLI, ...argv], {
					cwd: root,
					encoding: 'utf-8',
					env: { ...process.env, HARPER_BINARY_KIT_RELEASE_BASE: baseUrl },
				});
			const pinned = await run(['pin']);
			assert.match(pinned.stdout, /wrote .*release\.sha256/);
			const fetched = await run(['fetch', '--only', 'linux-x86_64']);
			assert.match(fetched.stdout, /verified: collector_0\.162\.0_linux_amd64\.tar\.gz sha256 [0-9a-f]{64}/);
			assert.match(fetched.stdout, new RegExp(`fetched 4 file\\(s\\) from ${REPO} ${TAG}`));
			assert.ok(existsSync(join(buildTree(root, 'linux-x86_64').bin, 'otelcol')));

			commitPins(root, `${'0'.repeat(64)}  ${LINUX_TGZ}\n`);
			await assert.rejects(run(['fetch', '--only', 'linux-x86_64']), (/** @type {any} */ error) => {
				assert.equal(error.code, 1);
				assert.match(error.stderr, /and the pin says 0{64}; refusing it/);
				return true;
			});
		})
	));
