// Which runners gate a publish, read from the workflow text, since no YAML parser is a dependency here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = (/** @type {string} */ name) =>
	readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf-8');

/**
 * The block under a top-level job, up to the next job or the end of the file.
 *
 * @param {string} text
 * @param {string} job
 */
const jobBlock = (text, job) => {
	const match = text.match(new RegExp(`^  ${job}:\\n((?:(?:    .*)?\\n)*)`, 'm'));
	assert.ok(match, `no job named ${job}`);
	return match[1] ?? '';
};

/** @param {string} value a single-quoted YAML scalar holding a JSON array */
const runners = (value) => /** @type {string[]} */ (JSON.parse(value));

const publish = workflow('publish.yml');
const tests = workflow('test.yml');

// Hosted macOS runners went unscheduled for hours and cancelled a release, so the publish gate runs without them.
test('publish gates on the test workflow over Linux and Windows, without macOS', () => {
	const call = jobBlock(publish, 'test');
	assert.match(call, /^    uses: \.\/\.github\/workflows\/test\.yml$/m);
	const os = call.match(/^      os: '(.*)'$/m);
	assert.ok(os, `publish.yml's test call passes no os input:\n${call}`);
	const list = runners(os[1] ?? '');
	assert.deepEqual(list, ['ubuntu-latest', 'windows-latest']);
	assert.ok(!list.some((runner) => runner.startsWith('macos')), list.join(', '));
	assert.match(jobBlock(publish, 'publish'), /^    needs: test$/m);
});

// A push, pull_request or dispatch run carries no inputs and takes the fallback; a call without `os` takes the default.
test('test.yml still runs macOS by default and on every push', () => {
	const declared = tests.match(/^      os:\n(?:        .*\n)*?        default: '(.*)'$/m);
	assert.ok(declared, 'test.yml declares no os input with a default');
	const fallback = tests.match(/^        os: \$\{\{ fromJSON\(inputs\.os \|\| '(.*)'\) \}\}$/m);
	assert.ok(fallback, 'the test matrix does not read os from the input with a fallback');
	const all = ['ubuntu-latest', 'macos-latest', 'windows-latest'];
	assert.deepEqual(runners(declared[1] ?? ''), all);
	assert.deepEqual(runners(fallback[1] ?? ''), all);
	assert.match(tests, /^  push:\n    branches: \['\*\*'\]$/m);
	assert.match(tests, /^  pull_request:$/m);
});

test('the publish gate keeps both node versions and the workflow lint', () => {
	assert.match(jobBlock(tests, 'test'), /^        node: \['22', '24'\]$/m);
	assert.match(jobBlock(tests, 'actionlint'), /rhysd\/actionlint/);
	assert.doesNotMatch(jobBlock(tests, 'actionlint'), /^    if:/m);
});
