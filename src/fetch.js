// @ts-check
// A prebuilt upstream release into the build trees: download each target's asset, check it against the sha256
// committed in the repo (and a sigstore bundle when one is configured), and only then write the members it
// names. A run writes nothing until every chosen target has passed every check, and every failure is a throw.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { promisify } from 'node:util';

import { archiveKind, readArchive, safeMemberPath } from './archive.js';
import { buildTree } from './layout.js';
import { binaryFilename } from './targets.js';

/** @typedef {import('./targets.js').Target} Target */

/**
 * @typedef {object} ReleaseAsset
 * @property {string} name The asset's exact file name in the release. Never derived: upstreams misname assets.
 * @property {Record<string, string>} binaries `shipsAs` to the member that is that binary.
 * @property {Record<string, string>} [files] Member to a path under `build/<target>`. A member ending in `/`
 *   carries everything under it.
 */

/**
 * @typedef {object} SigstoreConfig
 * @property {string} bundle The bundle's asset name, with `{asset}` standing for the asset it signs.
 * @property {string} issuer The OIDC issuer the signing certificate must name.
 * @property {string} [identity] The certificate identity, exactly.
 * @property {string} [identityRegexp] Or a pattern for it, matched against the whole identity; one of the two
 *   is required.
 */

/**
 * @typedef {object} ReleaseConfig
 * @property {string} repo `owner/name` on GitHub.
 * @property {string} tag The release tag, as the download URL spells it.
 * @property {Record<string, ReleaseAsset>} assets One per target label.
 * @property {string} [pins] The committed sha256 file, relative to the repo root. `release.sha256` by default.
 * @property {string} [checksums] The release's own checksums asset, or a per-asset name with `{asset}` in it.
 * @property {SigstoreConfig} [sigstore]
 */

/** @typedef {(url: string) => Promise<Uint8Array>} Download */

/**
 * What checks a sigstore bundle. Injected so the refusal path is testable without cosign.
 *
 * @typedef {(input: { blob: Uint8Array, bundle: Uint8Array, sigstore: SigstoreConfig, assetName: string }) =>
 *   Promise<void>} BundleCheck
 */

export const DEFAULT_PINS = 'release.sha256';
const GITHUB = 'https://github.com';
const SHA256 = /^[0-9a-f]{64}$/;

/** The `release` block of a config, checked for shape before any byte is fetched. @param {any} config @returns {ReleaseConfig} */
export function releaseConfig(config) {
	const release = config?.release;
	if (!release || typeof release !== 'object') throw new Error('binary-kit.config.js declares no `release` block');
	if (typeof release.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(release.repo))
		throw new Error('release.repo must be "owner/name"');
	if (typeof release.tag !== 'string' || release.tag === '') throw new Error('release.tag must name a tag');
	if (!release.assets || typeof release.assets !== 'object')
		throw new Error('release.assets must map targets to assets');
	for (const [label, asset] of Object.entries(release.assets)) {
		if (!config.targets?.includes(label))
			throw new Error(`release.assets names ${label}, which is not a declared target`);
		if (typeof asset?.name !== 'string' || asset.name === '' || asset.name.includes('/'))
			throw new Error(`release.assets.${label}.name must be the asset's file name`);
		archiveKind(asset.name);
		if (!asset.binaries || Object.keys(asset.binaries).length === 0)
			throw new Error(`release.assets.${label} names no binaries, so fetching it would ship nothing`);
		for (const shipsAs of Object.keys(asset.binaries))
			if (!config.binaries?.some((/** @type {{ shipsAs: string }} */ b) => b.shipsAs === shipsAs))
				throw new Error(`release.assets.${label} ships ${shipsAs}, which binaries does not declare`);
		for (const [member, dest] of Object.entries(asset.files ?? {})) {
			let inside = typeof dest === 'string' && dest !== '';
			try {
				if (inside) inside = safeMemberPath(dest) !== '';
			} catch {
				inside = false;
			}
			if (!inside) throw new Error(`release.assets.${label}.files sends ${member} to ${dest}, outside build/${label}`);
		}
	}
	const sigstore = release.sigstore;
	if (sigstore) {
		if (typeof sigstore.bundle !== 'string' || !sigstore.bundle.includes('{asset}'))
			throw new Error('release.sigstore.bundle must name the bundle asset with {asset} in it');
		if (typeof sigstore.issuer !== 'string' || sigstore.issuer.trim() === '')
			throw new Error('release.sigstore.issuer must name the OIDC issuer');
		// Given means present at all: an empty identity beside a pattern is a mistake to refuse, not a gap the
		// pattern quietly fills.
		const given = ['identity', 'identityRegexp'].filter((key) => sigstore[key] !== undefined);
		if (given.length !== 1) throw new Error('release.sigstore needs exactly one of identity and identityRegexp');
		const key = /** @type {'identity' | 'identityRegexp'} */ (given[0]);
		if (typeof sigstore[key] !== 'string' || sigstore[key].trim() === '')
			throw new Error(`release.sigstore.${key} must be a non-empty string`);
		if (key === 'identityRegexp') {
			// It must stand as a pattern on its own before cosignArgs wraps it: `x)|(.*` would otherwise close the
			// anchoring group early and match any identity.
			try {
				new RegExp(sigstore.identityRegexp);
			} catch (error) {
				throw new Error(`release.sigstore.identityRegexp is not a pattern on its own: ${error}`);
			}
		}
	}
	return release;
}

/** Where an asset of the release downloads from. @param {ReleaseConfig} release @param {string} name */
export const assetUrl = (release, name, baseUrl = GITHUB) =>
	`${baseUrl}/${release.repo}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(name)}`;

/** @type {Download} */
export async function downloadBytes(url) {
	const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60_000) });
	if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`);
	return new Uint8Array(await response.arrayBuffer());
}

/** @param {Uint8Array} bytes */
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * `sha256sum` output, `<hex>  <name>` or `<hex> *<name>`, as a map. A bare digest with no name comes back
 * under the empty name, which is how per-asset `.sha256` files are published.
 *
 * @param {string} text @returns {Map<string, string>}
 */
export function parseChecksums(text) {
	/** @type {Map<string, string>} */
	const sums = new Map();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) continue;
		const match = /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/.exec(trimmed);
		if (!match) throw new Error(`unreadable checksum line: ${JSON.stringify(trimmed.slice(0, 120))}`);
		sums.set((match[2] ?? '').trim(), (match[1] ?? '').toLowerCase());
	}
	return sums;
}

/** The pin file's first line, which binds its digests to one release. @param {ReleaseConfig} release */
const pinHeader = (release) => `# harper-binary-kit pins ${release.repo} ${release.tag}`;

/**
 * The committed digests, refused when they were written for another repo or tag: asset names often stay the
 * same across releases, and a stale pin should say so rather than fail as a mismatch.
 *
 * @param {string} root @param {ReleaseConfig} release @returns {Map<string, string>}
 */
export function readPins(root, release) {
	const path = resolvePath(root, release.pins ?? DEFAULT_PINS);
	let text;
	try {
		text = readFileSync(path, 'utf-8');
	} catch {
		throw new Error(`no pin file at ${path}; run \`harper-binary-kit pin\` and commit what it writes`);
	}
	const first = text.split(/\r?\n/, 1)[0];
	if (first !== pinHeader(release))
		throw new Error(`${path} pins another release (${first}); run \`harper-binary-kit pin\` for ${release.tag}`);
	return parseChecksums(text);
}

/**
 * The `cosign verify-blob` arguments for one bundle. cosign matches `--certificate-identity-regexp` unanchored,
 * so the pattern is wrapped to match the whole identity: `^https://` alone would accept any https signer.
 *
 * @param {SigstoreConfig} sigstore @param {string} bundlePath @param {string} blobPath @returns {string[]}
 */
export function cosignArgs(sigstore, bundlePath, blobPath) {
	const identity =
		sigstore.identity !== undefined
			? ['--certificate-identity', sigstore.identity]
			: ['--certificate-identity-regexp', `^(?:${sigstore.identityRegexp})$`];
	return ['verify-blob', '--bundle', bundlePath, ...identity, '--certificate-oidc-issuer', sigstore.issuer, blobPath];
}

/**
 * Check a bundle with `cosign verify-blob`. A missing cosign is a refusal, never a skip: the config said this
 * release is signed, and a fetch that quietly stopped checking would read the same as one that checked.
 *
 * @param {string} [cosign] @returns {BundleCheck}
 */
export function cosignCheck(cosign = 'cosign') {
	const run = promisify(execFile);
	return async ({ blob, bundle, sigstore, assetName }) => {
		const dir = mkdtempSync(join(tmpdir(), 'kit-sigstore-'));
		try {
			const blobPath = join(dir, 'blob');
			const bundlePath = join(dir, 'bundle.json');
			writeFileSync(blobPath, blob);
			writeFileSync(bundlePath, bundle);
			await run(cosign, cosignArgs(sigstore, bundlePath, blobPath)).catch((/** @type {any} */ error) => {
				const why =
					error?.code === 'ENOENT' ? `${cosign} is not on PATH` : String(error?.stderr || error?.message).trim();
				throw new Error(`the sigstore bundle for ${assetName} did not verify: ${why}`);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

/**
 * Every write a target's asset calls for, as destination path to bytes and mode, or a throw naming the first
 * member that is missing, not a file, or would land outside the target's build tree.
 *
 * @param {Uint8Array} bytes @param {ReleaseAsset} asset @param {Target} on @param {string} root
 * @returns {{ to: string, data: Uint8Array, mode: number }[]}
 */
export function planWrites(bytes, asset, on, root) {
	const tree = buildTree(root, on.name);
	const entries = readArchive(bytes, archiveKind(asset.name));
	const byName = new Map(entries.map((entry) => [entry.name, entry]));
	const inside = (/** @type {string} */ path) => {
		const rel = relative(tree.root, path);
		if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
			throw new Error(`${path} is outside ${tree.root}`);
		return path;
	};
	const file = (/** @type {string} */ member) => {
		const entry = byName.get(safeMemberPath(member));
		if (!entry) throw new Error(`${asset.name} has no member ${member}`);
		if (entry.kind !== 'file') throw new Error(`${asset.name} member ${member} is a ${entry.kind}, not a file`);
		return entry;
	};

	/** @type {{ to: string, data: Uint8Array, mode: number }[]} */
	const writes = [];
	for (const [shipsAs, member] of Object.entries(asset.binaries)) {
		const to = inside(resolvePath(tree.bin, binaryFilename(shipsAs, on)));
		writes.push({ to, data: file(member).read(), mode: 0o755 });
	}
	for (const [member, dest] of Object.entries(asset.files ?? {})) {
		const base = resolvePath(tree.root, safeMemberPath(dest));
		if (!member.endsWith('/')) {
			const entry = file(member);
			writes.push({ to: inside(base), data: entry.read(), mode: entry.mode & 0o111 ? 0o755 : 0o644 });
			continue;
		}
		const prefix = `${safeMemberPath(member)}/`;
		const under = entries.filter((entry) => entry.kind === 'file' && entry.name.startsWith(prefix));
		if (under.length === 0) throw new Error(`${asset.name} has no files under ${member}`);
		for (const entry of under)
			writes.push({
				to: inside(resolvePath(base, entry.name.slice(prefix.length))),
				data: entry.read(),
				mode: entry.mode & 0o111 ? 0o755 : 0o644,
			});
	}
	return writes;
}

/**
 * @typedef {object} FetchOptions
 * @property {string} root The consumer repo.
 * @property {any} config Its `binary-kit.config.js` default export.
 * @property {readonly Target[]} targets
 * @property {string} [only] One target label instead of all of them.
 * @property {Download} [download]
 * @property {BundleCheck} [verifyBundle]
 * @property {string} [baseUrl] Where releases download from, `https://github.com` unless a test says otherwise.
 * @property {(line: string) => void} [say]
 */

/**
 * Fetch, check and extract each chosen target's asset into its build tree, returning every path written. Every
 * pin is checked before the first download and every asset verified and planned before the first write.
 *
 * @param {FetchOptions} options @returns {Promise<string[]>}
 */
export async function fetchRelease({
	root,
	config,
	targets,
	only,
	download = downloadBytes,
	verifyBundle = cosignCheck(),
	baseUrl = GITHUB,
	say = () => {},
}) {
	const release = releaseConfig(config);
	const pins = readPins(root, release);
	const chosen = only ? targets.filter((t) => t.name === only) : targets;
	if (chosen.length === 0) throw new Error(`--only ${only} matches no declared target`);

	const declared = chosen.map((on) => {
		const asset = release.assets[on.name];
		if (!asset) throw new Error(`release.assets declares no asset for ${on.name}`);
		const pinned = pins.get(asset.name);
		if (!pinned || !SHA256.test(pinned))
			throw new Error(`${release.pins ?? DEFAULT_PINS} pins no sha256 for ${asset.name}`);
		return { on, asset, pinned };
	});

	/** @type {{ to: string, data: Uint8Array, mode: number }[]} */
	const writes = [];
	for (const { on, asset, pinned } of declared) {
		const bytes = await download(assetUrl(release, asset.name, baseUrl));
		const actual = sha256(bytes);
		if (actual !== pinned)
			throw new Error(`${asset.name} has sha256 ${actual}, and the pin says ${pinned}; refusing it`);
		say(`verified: ${asset.name} sha256 ${actual}`);
		if (release.sigstore) {
			const bundleName = release.sigstore.bundle.replaceAll('{asset}', asset.name);
			const bundle = await download(assetUrl(release, bundleName, baseUrl));
			await verifyBundle({ blob: bytes, bundle, sigstore: release.sigstore, assetName: asset.name });
			say(`verified: ${asset.name} sigstore bundle ${bundleName}`);
		}
		writes.push(...planWrites(bytes, asset, on, root));
	}

	/** @type {string[]} */
	const written = [];
	for (const { to, data, mode } of writes) {
		mkdirSync(dirname(to), { recursive: true });
		writeFileSync(to, data, { mode });
		written.push(to);
		say(`extracted ${to}`);
	}
	return written;
}

/**
 * @typedef {object} PinOptions
 * @property {string} root
 * @property {any} config
 * @property {Download} [download]
 * @property {string} [baseUrl]
 */

/**
 * Write the pin file from the digests the release publishes, for every declared asset. Returns the path and
 * what it holds. The digests are the release's word at that moment, so the pin's diff is what gets reviewed.
 *
 * @param {PinOptions} options @returns {Promise<{ path: string, text: string }>}
 */
export async function pinRelease({ root, config, download = downloadBytes, baseUrl = GITHUB }) {
	const release = releaseConfig(config);
	const checksums = release.checksums;
	if (!checksums) throw new Error('release.checksums names no published checksums to pin from');
	const names = Object.values(release.assets).map((asset) => asset.name);
	const text = async (/** @type {string} */ name) =>
		new TextDecoder().decode(await download(assetUrl(release, name, baseUrl)));

	/** @type {Map<string, string>} */
	const pinned = new Map();
	if (checksums.includes('{asset}')) {
		for (const name of names) {
			const sums = parseChecksums(await text(checksums.replaceAll('{asset}', name)));
			const digest = sums.get(name) ?? (sums.size === 1 ? sums.get('') : undefined);
			if (!digest) throw new Error(`${checksums.replaceAll('{asset}', name)} holds no digest for ${name}`);
			pinned.set(name, digest);
		}
	} else {
		const sums = parseChecksums(await text(checksums));
		for (const name of names) {
			const digest = sums.get(name);
			if (!digest) throw new Error(`${checksums} holds no digest for ${name}`);
			pinned.set(name, digest);
		}
	}

	const path = resolvePath(root, release.pins ?? DEFAULT_PINS);
	const body = [
		pinHeader(release),
		...[...pinned].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([n, d]) => `${d}  ${n}`),
	];
	const written = `${body.join('\n')}\n`;
	writeFileSync(path, written);
	return { path, text: written };
}
