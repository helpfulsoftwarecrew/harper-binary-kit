// @ts-check
// How the binaries split across npm packages. The base variant is an optionalDependency so npm installs one
// host's and skips the rest; an add-on variant is not, so nobody pays for binaries they never run.

import { binaryFilename } from './targets.js';

/**
 * @typedef {object} Binary
 * @property {string} shipsAs The filename before the platform's suffix, and the name `getBinaryPath` is asked for.
 * @property {string} [variant] Which variant carries it. Defaults to the base variant.
 * @property {readonly string[]} [onlyOn] Target names that carry it; absent means every target.
 * @property {string} [symbol] A string the packed file must contain, read from the tarball by the publish gate.
 * @property {(contents: Buffer, binary: Binary) => string | undefined} [check] A reason to refuse the bytes, or nothing.
 */

/**
 * @typedef {object} Variant
 * @property {string} suffix Appended to the scope before the target label. Empty for the base variant.
 * @property {boolean} [optional] True for a variant installed by name rather than by dependency resolution.
 * @property {string} [carries] Why it is separate, for the error a consumer reads when it is not installed.
 * @property {readonly (string | ExtraDir)[]} [extraDirs] Directories beside `bin/`, relative to the build tree.
 */

/**
 * A directory only some targets carry: one binary can reach the kernel a different way per platform, and a
 * variant-wide directory would refuse to stage a target that ships no objects.
 *
 * @typedef {object} ExtraDir
 * @property {string} dir
 * @property {readonly string[]} onlyOn Target names that carry it.
 */

/**
 * @typedef {object} PlatformPackage
 * @property {string} name The npm name.
 * @property {string} dirName Directory under `npm/`. The npm name's last segment, so the two cannot drift.
 * @property {import('./targets.js').Target} target
 * @property {Variant} variant
 * @property {Binary[]} binaries
 * @property {boolean} optionalDependency
 * @property {readonly string[]} extraDirs Resolved for this target, so no later step decides it again.
 */

/** Whether a binary ships for a target at all. @param {Binary} binary @param {import('./targets.js').Target} on */
export const shipsOn = (binary, on) => !binary.onlyOn || binary.onlyOn.includes(on.name);

/** The extra directories one variant carries on one target. @param {Variant} variant @param {import('./targets.js').Target} on @returns {string[]} */
export const extraDirsFor = (variant, on) =>
	(variant.extraDirs ?? [])
		.map((entry) => (typeof entry === 'string' ? { dir: entry, onlyOn: undefined } : entry))
		.filter((entry) => !entry.onlyOn || entry.onlyOn.includes(on.name))
		.map((entry) => entry.dir);

/** The binaries one variant carries on one target. @param {readonly Binary[]} binaries @param {Variant} variant @param {import('./targets.js').Target} on */
export const binariesFor = (binaries, variant, on) =>
	binaries.filter((binary) => (binary.variant ?? '') === variant.suffix && shipsOn(binary, on));

/**
 * Every package one target publishes. A variant with nothing to carry on this target publishes nothing, so a
 * host without an add-on's binary does not get an empty package promising one.
 *
 * @param {object} config
 * @param {string} config.scope The base package name; every platform package is this plus a suffix.
 * @param {readonly Variant[]} config.variants
 * @param {readonly Binary[]} config.binaries
 * @param {import('./targets.js').Target} on
 * @returns {PlatformPackage[]}
 */
export function packagesFor({ scope, variants, binaries }, on) {
	const packages = [];
	for (const variant of variants) {
		const carried = binariesFor(binaries, variant, on);
		if (carried.length === 0) continue;
		const dirName = `${variant.suffix ? `${variant.suffix.replace(/^-/, '')}-` : ''}${on.name}`;
		packages.push({
			name: `${scope}${variant.suffix}-${on.name}`,
			dirName,
			target: on,
			variant,
			binaries: carried,
			optionalDependency: variant.optional !== true,
			extraDirs: extraDirsFor(variant, on),
		});
	}
	return packages;
}

/** Every package across every target: what the publish job walks, and what the gate checks. @param {any} config @param {readonly import('./targets.js').Target[]} targets */
export const allPackages = (config, targets) => targets.flatMap((on) => packagesFor(config, on));

/** What a package's optionalDependencies should say, at this version. @param {any} config @param {readonly import('./targets.js').Target[]} targets @param {string} version */
export function optionalDependencies(config, targets, version) {
	/** @type {Record<string, string>} */
	const pinned = {};
	for (const pkg of allPackages(config, targets)) {
		// An add-on listed here would install on every matching host, the cost the split exists to refuse.
		if (pkg.optionalDependency) pinned[pkg.name] = version;
	}
	return pinned;
}

/** The files one package's tarball must carry, for the gate to compare against. @param {PlatformPackage} pkg */
export const expectedFiles = (pkg) => [
	...pkg.binaries.map((binary) => `bin/${binaryFilename(binary.shipsAs, pkg.target)}`),
	'index.js',
	'package.json',
];
