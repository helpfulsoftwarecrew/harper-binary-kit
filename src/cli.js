#!/usr/bin/env node
// @ts-check
// One command per release step, each reading the same config and target list. A step that rediscovers the
// package set by globbing turns a target that failed to build into a package nobody notices is missing.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';

import { checkFloors } from './floor.js';
import { buildTree } from './layout.js';
import { allPackages, optionalDependencies } from './packages.js';
import { prereleaseRefusal, publishAll } from './publish.js';
import { confirmPublished, readBackLine } from './published.js';
import { stageAll } from './stage.js';
import { binaryFilename, targets } from './targets.js';
import { verifyAll } from './verify.js';

/** @param {string} message */
const fail = (message) => {
	process.stderr.write(`harper-binary-kit: ${message}\n`);
	process.exit(1);
};

const say = (/** @type {string} */ message) => process.stdout.write(`${message}\n`);

/** The indent a manifest already uses, so rewriting it does not reformat every line. @param {string} source */
const indentOf = (source) => (/^\t/m.test(source) ? '\t' : (source.match(/^ +/m)?.[0].length ?? 2));

/**
 * The consumer's config and the version it is releasing. Both are read from the repo rather than passed, so a
 * workflow cannot hand one step a different answer from another.
 *
 * @param {string} root
 */
async function load(root) {
	const configPath = resolvePath(root, 'binary-kit.config.js');
	let config;
	try {
		config = (await import(pathToFileURL(configPath).href)).default;
	} catch (error) {
		fail(`could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const version = JSON.parse(readFileSync(resolvePath(root, 'package.json'), 'utf-8')).version;
	return { config, version, targetList: targets(config.targets) };
}

/** @type {Record<string, (root: string, argv: string[]) => Promise<void>>} */
const COMMANDS = {
	/** Stage every platform package from the build trees. `--only <dirName>` stages one. */
	async stage(/** @type {string} */ root, /** @type {string[]} */ argv) {
		const { config, version, targetList } = await load(root);
		const onlyAt = argv.indexOf('--only');
		const only = onlyAt === -1 ? undefined : argv[onlyAt + 1];
		// The whole target list even for --only, since a package stages from its own target's tree, not the host's.
		const staged = stageAll({ root, config, version, targets: targetList, ...(only ? { only } : {}) });
		for (const name of staged) say(`staged ${name}@${version}`);
	},

	/** Refuse a release whose tarballs are wrong. Reads what npm would pack, never the working tree. */
	async verify(/** @type {string} */ root) {
		const { config, version, targetList } = await load(root);
		const reasons = verifyAll({ root, packages: allPackages(config, targetList), version });
		for (const reason of reasons) say(reason);
		if (reasons.length > 0) fail(`${reasons.length} reason(s) not to publish this release`);
		say(`every package packs at ${version} with the binaries it declares`);
	},

	/** Every binary of one target against the image floor that target declares. */
	async floor(/** @type {string} */ root, /** @type {string[]} */ argv) {
		const { config, targetList } = await load(root);
		const name = argv[0] ?? fail('floor needs a target name');
		const on = targetList.find((candidate) => candidate.name === name) ?? fail(`${name} is not a declared target`);
		const declared = config.floors?.[on.name];
		if (!declared) {
			say(`${on.name} declares no floor; nothing to check`);
			return;
		}
		const files = allPackages(config, [on]).flatMap((pkg) =>
			pkg.binaries.map((binary) => `${buildTree(root, on.name).bin}/${binaryFilename(binary.shipsAs, on)}`)
		);
		const { ok, lines } = checkFloors({ files, floor: declared });
		for (const line of lines) say(line);
		if (!ok) fail(`binaries for ${on.name} need more than the target image provides`);
	},

	/** What optionalDependencies should say at this version, as JSON on stdout. */
	// `--write` is for a consumer's `version` lifecycle script, so the pins move with `npm version`.
	async deps(/** @type {string} */ root, /** @type {string[]} */ argv) {
		const { config, version, targetList } = await load(root);
		const deps = optionalDependencies(config, targetList, version);
		say(JSON.stringify(deps, null, '\t'));
		if (!argv.includes('--write')) return;
		const path = resolvePath(root, 'package.json');
		const source = readFileSync(path, 'utf-8');
		const manifest = JSON.parse(source);
		manifest.optionalDependencies = deps;
		writeFileSync(path, `${JSON.stringify(manifest, null, indentOf(source))}\n`);
		say(`wrote optionalDependencies to ${path}`);
	},

	/** Every package name in the release, one per line, for a workflow that needs the list. */
	async names(/** @type {string} */ root) {
		const { config, targetList } = await load(root);
		say(config.scope);
		for (const pkg of allPackages(config, targetList)) say(pkg.name);
	},

	/**
	 * Publish every package under the tag its own `latest` calls for, attempting all of them, then read the
	 * registry back. A prerelease is refused before anything reaches the registry.
	 */
	async publish(/** @type {string} */ root) {
		const { config, version, targetList } = await load(root);
		const refusal = prereleaseRefusal(version);
		if (refusal) fail(refusal);
		const packages = allPackages(config, targetList);
		const { failed, lines } = await publishAll({ root, packages, rootName: config.scope, version });
		for (const line of lines) say(line);

		// Before the read-back, which would only wait out its whole budget to find a failed package absent.
		if (failed.length > 0) fail(`${failed.length} package(s) did not publish: ${failed.map((f) => f.name).join(', ')}`);

		// Read back to report, not to gate: a package the registry has not served yet looks like one it never took.
		const names = [config.scope, ...packages.map((pkg) => pkg.name)];
		const { missing, lines: readBack } = await confirmPublished({ names, version });
		for (const line of readBack) say(line);
		say(readBackLine(missing, version));
	},
};

const [command, ...argv] = process.argv.slice(2);
const run = COMMANDS[/** @type {keyof typeof COMMANDS} */ (command)];
if (!run) {
	process.stderr.write(`usage: harper-binary-kit <${Object.keys(COMMANDS).join('|')}> [args]\n`);
	process.exit(2);
}
run(process.cwd(), argv).catch((/** @type {unknown} */ error) => {
	fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
