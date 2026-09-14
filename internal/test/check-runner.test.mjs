import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const runner = resolve("internal/cli/check.mjs");
const sourceDirectories = [
  "internal/cli",
  "goalbuddy/scripts",
  "goalbuddy/surfaces/local-goal-board/scripts",
  "goalbuddy/surfaces/local-goal-board/scripts/lib",
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy check spaces & dollars $ "));
  for (const directory of sourceDirectories) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, "a first.mjs"), 'throw new Error("syntax checks must not execute source");\n');
  }
  copyFileSync(runner, join(root, "internal/cli/check.mjs"));
  for (const [directory, label] of [["internal/test", "internal"], ["goalbuddy/surfaces/local-goal-board/test", "board"]]) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, "with spaces & $.test.mjs"), `import { writeFileSync } from "node:fs";\nimport test from "node:test";\ntest("${label} coverage", () => writeFileSync(${JSON.stringify(join(root, label + ".ran"))}, "ran"));\n`);
  }
  return root;
}

function run(root, args = []) {
  const env = { ...process.env };
  // Launch a fresh test runner; Node 24 otherwise inherits the outer test worker context.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [join(root, "internal/cli/check.mjs"), ...args], { cwd: tmpdir(), encoding: "utf8", env });
}

test("check runner handles spaces and shell metacharacters while running both complete test groups", () => {
  const root = fixture();
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Checking syntax in 5 source files/);
    for (const label of ["internal", "board"]) {
      assert.equal(readFileSync(join(root, label + ".ran"), "utf8"), "ran");
      assert.ok(result.stdout.includes(label + " coverage"));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("check runner rejects a later syntax error in every source group before running tests", () => {
  for (const directory of sourceDirectories) {
    const root = fixture();
    try {
      writeFileSync(join(root, directory, "z invalid later.mjs"), "const invalid = ;\n");
      const result = run(root);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /z invalid later\.mjs/);
      assert.match(result.stderr, /SyntaxError/);
      for (const label of ["internal", "board"]) assert.equal(existsSync(join(root, label + ".ran")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("test-only mode preserves both suites and propagates a failing test", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "goalbuddy/scripts/z broken.mjs"), "const broken = ;\n");
    let result = run(root, ["--tests-only"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout, /Checking syntax/);
    for (const label of ["internal", "board"]) rmSync(join(root, label + ".ran"));
    writeFileSync(join(root, "internal/test/z failure.test.mjs"), 'import test from "node:test";\ntest("deliberate failure", () => { throw new Error("failure must reach npm"); });\n');
    result = run(root, ["--tests-only"]);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout + result.stderr, /failure must reach npm/);
    for (const label of ["internal", "board"]) assert.equal(existsSync(join(root, label + ".ran")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing or empty test groups fail instead of silently reducing coverage", () => {
  for (const directory of ["internal/test", "goalbuddy/surfaces/local-goal-board/test"]) {
    const root = fixture();
    try {
      rmSync(join(root, directory), { recursive: true });
      assert.equal(run(root).status, 1);
      mkdirSync(join(root, directory));
      const result = run(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /No \.test\.mjs files found/);
      for (const label of ["internal", "board"]) assert.equal(existsSync(join(root, label + ".ran")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("child exit codes, termination and launch errors cannot become a successful check", () => {
  const root = fixture();
  try {
    const imported = `import { runNode } from ${JSON.stringify(pathToFileURL(join(root, "internal/cli/check.mjs")).href)};\n`;
    const child = (body) => spawnSync(process.execPath, ["--input-type=module", "-e", imported + body + '\nconsole.log("incorrect continuation");'], { encoding: "utf8" });
    const failed = child('runNode(["-e", "process.exit(7)"]);');
    assert.equal(failed.status, 7);
    assert.doesNotMatch(failed.stdout, /incorrect continuation/);
    const terminated = child('runNode(["-e", \'process.kill(process.pid, "SIGTERM")\']);');
    assert.notEqual(terminated.status, 0);
    assert.doesNotMatch(terminated.stdout, /incorrect continuation/);
    const missing = child(`runNode(["--version"], ${JSON.stringify(join(root, "missing directory"))});`);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /ENOENT/);
    assert.doesNotMatch(missing.stdout, /incorrect continuation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
