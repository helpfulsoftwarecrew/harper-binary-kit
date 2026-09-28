// @ts-check
// Where things are, stated once. Four processes on separate runners meet at these paths and none can see
// the others, so one that recomputes them is a convention with two owners.

import { join } from 'node:path';

/**
 * @typedef {object} BuildTree
 * @property {string} root `build/<target>`, which is what a build produces and staging reads.
 * @property {string} bin The binaries themselves.
 * @property {string} share Anything shipped beside them: objects, policies, data files.
 */

/** One target's build tree under `root`. @param {string} root @param {string} targetName @returns {BuildTree} */
export function buildTree(root, targetName) {
	const base = join(root, 'build', targetName);
	return { root: base, bin: join(base, 'bin'), share: join(base, 'share') };
}

/** Where one platform package is staged and packed from. @param {string} root @param {string} dirName */
export const packageDir = (root, dirName) => join(root, 'npm', dirName);

/** Where every staged package sits, for a caller walking them. @param {string} root */
export const stagingRoot = (root) => join(root, 'npm');
