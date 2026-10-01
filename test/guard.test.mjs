/**
 * Exercises the plugin without Cordis: the pure policy first, then the real
 * `apply(ctx, config)` surface driven by a fake tool registry.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	apply,
	classifyWriteTarget,
	isInside,
	resolveConfig,
	scriptFileName,
	timestampPrefix
} from '../src/index.js';

const PROJECT = 'C:\\Workspace\\some-project';
const MANAGED = join(import.meta.dirname, '..', '.test-managed');

test('a scratch script inside a project is refused', () => {
	const verdict = classifyWriteTarget(join(PROJECT, 'tmp_fix.py'), { managedDir: MANAGED });
	assert.equal(verdict.allowed, false);
	assert.match(verdict.reason, /temp_script_save/);
	assert.match(verdict.reason, /\.test-managed/);
});

test('names that merely resemble a scratch token are left alone', () => {
	for (const name of ['attempt.py', 'template.py', 'attempter.py', 'contemporary.ts', 'latest.sh']) {
		const verdict = classifyWriteTarget(join(PROJECT, name), { managedDir: MANAGED });
		assert.equal(verdict.allowed, true, `${name} should be allowed`);
	}
});

test('the scratch token must be a whole segment', () => {
	for (const name of ['tmp_x.py', 'x-temp.py', 'scratch.y.sh', 'one-off.ps1', 'my_scratch.ts']) {
		const verdict = classifyWriteTarget(join(PROJECT, name), { managedDir: MANAGED });
		assert.equal(verdict.allowed, false, `${name} should be refused`);
	}
});

test('non-script targets and exempt directories are left alone', () => {
	const cases = [
		join(PROJECT, 'tmp_notes.md'),
		join(PROJECT, 'node_modules', 'pkg', 'tmp_a.js'),
		join(PROJECT, '.git', 'hooks', 'tmp_hook.sh'),
		join(PROJECT, 'dist', 'temp_bundle.js'),
		join(tmpdir(), 'tmp_os_level.py'),
		join(MANAGED, '20261001-120000_ok.py')
	];
	for (const path of cases) {
		assert.equal(classifyWriteTarget(path, { managedDir: MANAGED }).allowed, true, `${path} should be allowed`);
	}
});

test('a relative scratch path is refused too, and cwd does not rescue it', () => {
	const verdict = classifyWriteTarget('tmp_probe.js', { managedDir: MANAGED });
	assert.equal(verdict.allowed, false);
});

test('mode off keeps the tools but stops policy', () => {
	const cfg = resolveConfig({ managedDir: MANAGED, mode: 'off' });
	assert.equal(cfg.mode, 'off');
});

test('timestamped names follow YYYYMMDD-HHMMSS_slug.ext', () => {
	const at = new Date(2026, 9, 1, 16, 45, 7);
	assert.equal(timestampPrefix(at), '20261001-164507');
	assert.equal(scriptFileName({ name: 'fix_metadata', extension: 'py' }, at), '20261001-164507_fix_metadata.py');
	assert.equal(scriptFileName({ name: 'parse.py', extension: 'sh' }, at), '20261001-164507_parse.py');
	// A name is a name, not a path: only the basename survives, and characters
	// Windows refuses in a file name are folded to underscores.
	assert.equal(scriptFileName({ name: 'sub/dir/parse.py' }, at), '20261001-164507_parse.py');
	assert.equal(scriptFileName({ name: 'a?b*c.ps1' }, at), '20261001-164507_a_b_c.ps1');
	assert.throws(() => scriptFileName({ name: '   ' }, at));
});

test('isInside is case-insensitive on Windows', () => {
	if (process.platform !== 'win32') return;
	assert.equal(isInside('C:\\Workspace\\Demo\\x.py', 'c:\\workspace\\demo'), true);
	assert.equal(isInside('C:\\Workspace\\Demolish\\x.py', 'C:\\Workspace\\Demo'), false);
});

test('the Cordis surface registers four tools and one guard', async () => {
	const registered = new Map();
	const guards = [];
	const ctx = {
		logger: { info: () => {} },
		tools: {
			register: (definition) => {
				registered.set(definition.name, definition);
				return () => registered.delete(definition.name);
			},
			guard: (guard) => {
				guards.push(guard);
				return () => guards.splice(guards.indexOf(guard), 1);
			}
		}
	};

	const managed = await mkdtemp(join(tmpdir(), 'tsg-managed-'));
	const tools = await mkdtemp(join(tmpdir(), 'tsg-tools-'));
	apply(ctx, { managedDir: managed, toolsDir: tools, olderThanDays: 7, mode: 'deny' });

	assert.deepEqual([...registered.keys()].sort(), [
		'temp_script_list',
		'temp_script_promote',
		'temp_script_purge',
		'temp_script_save'
	]);
	assert.equal(guards.length, 1);

	// Save writes a timestamped script into the managed directory.
	const saved = await registered.get('temp_script_save').execute({ name: 'probe', extension: 'py', content: 'print(1)\n' });
	assert.equal(saved.managedDir, managed);
	assert.equal(saved.bytes, 9);
	assert.match(saved.name, /^\d{8}-\d{6}_probe\.py$/);
	assert.ok(existsSync(saved.path));

	// Saving the same second twice must not overwrite.
	const again = await registered.get('temp_script_save').execute({ name: 'probe', extension: 'py', content: 'print(2)\n' });
	assert.notEqual(again.path, saved.path);

	// The guard refuses a project scratch script and allows the managed one.
	const guard = guards[0];
	assert.match(
		String(guard({ name: 'write', arguments: { file_path: join(PROJECT, 'tmp_x.py') } })),
		/Refused/
	);
	assert.equal(guard({ name: 'write', arguments: { file_path: join(managed, 'tmp_ok.py') } }), undefined);
	assert.equal(guard({ name: 'read', arguments: { file_path: join(PROJECT, 'tmp_x.py') } }), undefined);
	assert.equal(guard({ name: 'write', arguments: null }), undefined, 'a malformed call must not throw');

	// Listing sees both files; purging with a 0-day age is a dry run by default.
	const listing = await registered.get('temp_script_list').execute({});
	assert.equal(listing.count, 2);
	assert.equal(listing.expiredCount, 0, 'a script written just now is not past the 7-day age');

	const dry = await registered.get('temp_script_purge').execute({ olderThanDays: 0 });
	assert.equal(dry.dryRun, true);
	assert.equal(dry.removed.length, 2);
	assert.equal((await readdir(managed)).length, 2, 'a dry run must not delete');

	const real = await registered.get('temp_script_purge').execute({ olderThanDays: 0, dryRun: false });
	assert.equal(real.dryRun, false);
	assert.equal((await readdir(managed)).length, 0);

	// Promote moves one script out of the managed directory and drops the
	// timestamp; anything outside the managed directory is refused.
	const keep = await registered.get('temp_script_save').execute({ name: 'keeper.vbs', content: 'x\n' });
	await assert.rejects(
		() => registered.get('temp_script_promote').execute({ path: join(PROJECT, 'x.py') }),
		/only moves files inside/
	);
	const promoted = await registered.get('temp_script_promote').execute({ path: keep.path });
	assert.equal(promoted.to, join(tools, 'keeper.vbs'));
	assert.ok(existsSync(promoted.to));
	assert.equal(existsSync(keep.path), false);
	assert.equal((await readdir(managed)).length, 0);

	await rm(managed, { recursive: true, force: true });
	await rm(tools, { recursive: true, force: true });
});

test('the rendered text a model sees carries the essentials', async () => {
	let definition;
	const ctx = {
		logger: { info: () => {} },
		tools: {
			register: (value) => {
				if (value.name === 'temp_script_save') definition = value;
				return () => {};
			},
			guard: () => () => {}
		}
	};
	const managed = await mkdtemp(join(tmpdir(), 'tsg-render-'));
	apply(ctx, { managedDir: managed });
	await definition.execute({ name: 'demo', extension: 'py', content: 'print(1)\n' });
	const [block] = definition.output.render({}, { name: 'demo.py', bytes: 9, path: join(managed, 'demo.py') });
	assert.equal(block.type, 'text');
	assert.match(block.text, /demo\.py/);
	assert.match(block.text, /9 B/);
	await rm(managed, { recursive: true, force: true });
});

test('the default managed directory is under the home directory', () => {
	assert.equal(resolveConfig({}).managedDir, join(homedir(), 'tools', 'temp-scripts'));
});

test('a listing of a missing directory is empty, not an error', async () => {
	let definition;
	const ctx = {
		logger: { info: () => {} },
		tools: {
			register: (value) => {
				if (value.name === 'temp_script_list') definition = value;
				return () => {};
			},
			guard: () => () => {}
		}
	};
	apply(ctx, { managedDir: join(tmpdir(), 'tsg-does-not-exist-' + Date.now()) });
	const listing = await definition.execute({});
	assert.equal(listing.count, 0);
	assert.deepEqual(listing.scripts, []);
});

test('a write target that is not a string is never a policy failure', async () => {
	await writeFile(join(tmpdir(), 'tsg-probe.txt'), 'ok');
	assert.equal(classifyWriteTarget(undefined, {}).allowed, true);
	assert.equal(classifyWriteTarget('', {}).allowed, true);
});
