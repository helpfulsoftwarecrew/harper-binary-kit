// @ts-check
// Where the binary is: each installed platform package asked by filename, and the answer checked by filename,
// since one published before a second binary existed answers every request with the first.

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { buildTree } from './layout.js';
import { currentTargetName, target } from './targets.js';

/**
 * @typedef {object} PackageVariant
 * @property {string} suffix Appended to the base package name before the platform label. Empty for the base.
 * @property {boolean} [optional] True for a package that is not a dependency and is installed by name.
 * @property {string} [carries] Why an optional package exists, for the error that says to install it.
 */

/**
 * What asking one platform package for one binary produced.
 *
 * @param {string} packageName @param {string} shipsAs @param {string} file
 * @param {(name: string) => Promise<any>} load
 */
async function ask(packageName, shipsAs, file, load) {
	let pkg;
	try {
		pkg = await load(packageName);
	} catch {
		return { installed: false };
	}
	const getBinaryPath = pkg.getBinaryPath ?? pkg.default?.getBinaryPath;
	let resolved;
	try {
		resolved = getBinaryPath?.(shipsAs);
	} catch {
		// A throw is the base package's ordinary answer for a binary only an add-on ships: installed, without this one.
		return { installed: true };
	}
	if (resolved && basename(resolved) === file && existsSync(resolved)) return { installed: true, path: resolved };
	// Set only on a name mismatch, so the error can tell a wrong binary apart from a missing package.
	return { installed: true, staleMatch: resolved };
}

/**
 * Why nothing resolved, in the three states that want different things from the reader: an opt-in package
 * to install, an installed one too old to upgrade, or a base package whose absence is a broken install.
 *
 * @param {Array<Record<string, any>>} asked @param {string} file @param {string} local @param {string} buildCommand
 */
export function resolutionFailure(asked, file, local, buildCommand) {
	const stale = asked.find((a) => a.staleMatch);
	if (stale)
		return (
			`${stale.name} is installed but predates ${file} support (it resolved ${stale.staleMatch} ` +
			`instead) and no local build exists at ${local}. Update ${stale.name} to a version that ships ` +
			`${file}, or build locally with ${buildCommand}.`
		);

	const missingOptional = asked.find((a) => a.optional && !a.installed);
	const carrier = asked.find((a) => a.optional !== true);
	if (missingOptional && carrier?.installed)
		return (
			`${missingOptional.name} is not installed${missingOptional.carries ? `. ${missingOptional.carries}` : ''}. ` +
			`Install it to get ${file}: npm install ${missingOptional.name}`
		);

	return `none of ${asked.map((a) => a.name).join(', ')} nor a local build at ${local} resolved ${file}`;
}

/**
 * A resolver bound to one package's platform packages.
 *
 * @param {object} options
 * @param {string} options.packageName The base package as a constant, since a deployed component's name can be anything.
 * @param {string} options.packageRoot Where a dev checkout's build output sits.
 * @param {readonly PackageVariant[]} options.variants Asked in order, each for every binary, so none is routed by name.
 * @param {string} [options.buildCommand] What a dev runs to produce the local build, for the error.
 * @param {(name: string) => Promise<any>} [options.load] `(name) => import(name)` written in the consumer's module.
 */
export function createBinaryResolver({
	packageName,
	packageRoot,
	variants,
	buildCommand = 'npm run build',
	load = (name) => import(name),
}) {
	/** This host's target, or a throw naming the platform no package was published for. */
	const here = () => {
		const name = currentTargetName();
		if (!name) throw new Error(`unsupported platform: ${process.platform}-${process.arch}`);
		return target(name);
	};

	/** One variant's package name for this host. */
	const packageFor = (/** @type {PackageVariant} */ variant) => `${packageName}${variant.suffix}-${here().name}`;

	return {
		/** The label this host's packages are published under. */
		platformName: () => here().name,

		/**
		 * Whatever one variant's package says about its own layout, or null when it is not installed. Asked rather
		 * than computed, because a path built here goes stale the moment that package's layout changes.
		 *
		 * @param {PackageVariant} variant @param {string} accessor Name of the function the package exports.
		 * @returns {Promise<string | null>}
		 */
		async resolveDir(variant, accessor) {
			try {
				const pkg = await load(packageFor(variant));
				const dir = (pkg[accessor] ?? pkg.default?.[accessor])?.();
				return dir && existsSync(dir) ? dir : null;
			} catch {
				return null;
			}
		},

		/**
		 * The platform packages' accessors first (the npm install path), then a dev checkout's build output.
		 *
		 * @param {{ shipsAs: string, title?: string }} wanted
		 * @returns {Promise<string>}
		 */
		async resolveBinary(wanted) {
			const on = here();
			const file = `${wanted.shipsAs}${on.exe}`;

			const asked = [];
			for (const variant of variants) {
				const name = packageFor(variant);
				const answer = await ask(name, wanted.shipsAs, file, load);
				if (answer.path) return answer.path;
				asked.push({ name, ...variant, ...answer });
			}

			const local = join(buildTree(packageRoot, on.name).bin, file);
			if (existsSync(local)) return local;

			throw new Error(
				`no ${wanted.title ?? wanted.shipsAs} binary: ${resolutionFailure(asked, file, local, buildCommand)}`
			);
		},
	};
}
