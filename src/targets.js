// @ts-check
// The three vocabularies a host goes by: node's platform/arch, npm's os/cpu, and the published label. They
// disagree on every axis, and a package labelled one way while npm filters another installs nowhere.

/**
 * @typedef {object} Target
 * @property {string} os The label half naming the system, as the packages are published.
 * @property {string} arch The label half naming the architecture.
 * @property {string} name `<os>-<arch>`: the package-name segment and the build directory.
 * @property {string} exe Executable suffix, empty everywhere but Windows.
 * @property {string} npmOs npm's `os` field, matched against process.platform.
 * @property {string} npmCpu npm's `cpu` field, matched against process.arch.
 */

/** How node names a system, against the label the packages use. */
const OS_LABELS = { linux: 'linux', darwin: 'macos', win32: 'windows' };
/** How node names an architecture, against the label the packages use. */
const ARCH_LABELS = { x64: 'x86_64', arm64: 'arm64' };

/** The reverse of OS_LABELS: what npm has to be told, given the label. */
const NPM_OS = Object.fromEntries(Object.entries(OS_LABELS).map(([npm, label]) => [label, npm]));
const NPM_CPU = Object.fromEntries(Object.entries(ARCH_LABELS).map(([npm, label]) => [label, npm]));

/** Windows is the only one, and a binary staged without it is a file npm ships and nothing can run. */
const EXE = { windows: '.exe' };

/**
 * One target from its label. Throws rather than guessing: a label nothing recognises would otherwise publish
 * a package with an `os` field npm never matches, which installs on no host and reports no error.
 *
 * @param {string} name `<os>-<arch>`, e.g. `linux-x86_64`.
 * @returns {Target}
 */
export function target(name) {
	const [os, arch] = name.split('-');
	// Looked up before the check, so the throw narrows both lookups and nothing needs a cast.
	const npmOs = os ? NPM_OS[os] : undefined;
	const npmCpu = arch ? NPM_CPU[arch] : undefined;
	if (!os || !arch || !npmOs || !npmCpu) {
		throw new Error(
			`unknown target "${name}". Known: ${Object.keys(NPM_OS)
				.flatMap((o) => Object.keys(NPM_CPU).map((a) => `${o}-${a}`))
				.join(', ')}`
		);
	}
	return { os, arch, name, exe: EXE[/** @type {keyof typeof EXE} */ (os)] ?? '', npmOs, npmCpu };
}

/** @param {readonly string[]} names @returns {Target[]} */
export const targets = (names) => names.map(target);

/**
 * The label for the host this runs on, or null. Not a throw: a machine the packages are not published for
 * still stages and tests other targets, and only resolving a binary for THIS host needs an answer.
 *
 * @param {NodeJS.Platform} [platform] @param {string} [arch]
 * @returns {string | null}
 */
export function currentTargetName(platform = process.platform, arch = process.arch) {
	const os = OS_LABELS[/** @type {keyof typeof OS_LABELS} */ (platform)];
	const cpu = ARCH_LABELS[/** @type {keyof typeof ARCH_LABELS} */ (arch)];
	return os && cpu ? `${os}-${cpu}` : null;
}

/** The binary's filename on a target: the name it ships under plus that platform's suffix. @param {string} shipsAs @param {Target} on */
export const binaryFilename = (shipsAs, on) => `${shipsAs}${on.exe}`;
