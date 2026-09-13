import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, openSync, closeSync, ftruncateSync, statSync, utimesSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const dispatcher = resolve(process.env.GOALBUDDY_TEST_SCRIPT_ROOT || "goalbuddy/scripts", "dispatch-task.mjs");

function makeProject({ taskType = "worker" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-dispatch-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "widget.mjs"), "export const widget = 1;\n");
  writeFileSync(join(root, "README.md"), "# fixture\n");
  const goalDir = join(root, "docs", "goals", "one");
  mkdirSync(join(goalDir, "notes"), { recursive: true });
  writeFileSync(join(goalDir, "goal.md"), "# one\n");
  writeFileSync(join(goalDir, "state.yaml"), `version: 2
goal:
  title: "one goal"
  slug: "one"
  kind: specific
  tranche: "test"
  status: active
active_task: T001
tasks:
  - id: T001
    type: ${taskType}
    assignee: ${taskType === "worker" ? "Worker" : taskType === "judge" ? "Judge" : "Scout"}
    status: active
    objective: "Adjust the widget."
    allowed_files:
      - src/widget.mjs
    verify:
      - "true"
    stop_if:
      - "Need files outside allowed_files."
    receipt: null
`);
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "-q"]);
  git(["-c", "user.email=test@example.com", "-c", "user.name=test", "add", "-A"]);
  git(["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "init"]);
  return root;
}

function fakeHarnessBin(root, name, script) {
  const bin = join(root, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return bin;
}

const RECEIPT = JSON.stringify({
  goalbuddy_receipt_v1: {
    result: "done",
    task_id: "T001",
    board_path: "docs/goals/one/state.yaml",
    changed_files: ["src/widget.mjs"],
    commands: [{ cmd: "true", status: "pass" }],
    summary: "widget adjusted",
    harness: "codex",
  },
});

function runDispatch(root, bin, extraArgs = []) {
  return spawnSync(process.execPath, [dispatcher, "docs/goals/one", "--to", "codex", "--timeout", "5", "--json", ...extraArgs], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    timeout: 15000,
  });
}

test("dispatch runs an external worker and reports a clean scope", () => {
  const root = makeProject();
  try {
    const bin = fakeHarnessBin(root, "codex", `if printf '%s\\n' "$@" | grep -q 'Native wait_agent timeouts'; then exit 42; fi\necho "export const widget = 2;" > src/widget.mjs\necho '${RECEIPT}'`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.harness, "codex");
    assert.equal(report.receipt.result, "done");
    assert.equal(report.scope_check.status, "clean");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch flags out-of-scope writes from an external worker", () => {
  const root = makeProject();
  try {
    const bin = fakeHarnessBin(root, "codex", `echo "tampered" >> README.md\necho '${RECEIPT}'`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 1, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.scope_check.status, "violations");
    assert.deepEqual(report.scope_check.violations, ["README.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch flags any write from a read-only role", () => {
  const root = makeProject({ taskType: "scout" });
  try {
    const bin = fakeHarnessBin(root, "codex", `echo "export const widget = 2;" > src/widget.mjs\necho '${RECEIPT}'`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 1, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.scope_check.status, "violations");
    assert.deepEqual(report.scope_check.violations, ["src/widget.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch extracts receipts wrapped in markdown fences", () => {
  const root = makeProject();
  try {
    const bin = fakeHarnessBin(root, "codex", `printf 'Here you go:\\n\\n\`\`\`json\\n%s\\n\`\`\`\\n' '${RECEIPT}'`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).receipt.summary, "widget adjusted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch reports a missing harness CLI cleanly", () => {
  const root = makeProject();
  try {
    const bin = join(root, "sparse-bin");
    mkdirSync(bin, { recursive: true });
    const gitPath = spawnSync("command", ["-v", "git"], { encoding: "utf8", shell: true }).stdout.trim();
    symlinkSync(gitPath, join(bin, "git"));
    const result = spawnSync(process.execPath, [dispatcher, "docs/goals/one", "--to", "codex", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: bin },
    });
    assert.equal(result.status, 1, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.match(report.error, /codex.*not found|not found.*codex/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch rejects unsupported harness targets", () => {
  const root = makeProject();
  try {
    const result = spawnSync(process.execPath, [dispatcher, "docs/goals/one", "--to", "gemini", "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.error, /Unknown or missing dispatch target/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external dispatch timeout is terminal and still reports partial writes", () => {
  const root = makeProject();
  try {
    const bin = fakeHarnessBin(root, "codex", "echo 'partial external write' >> README.md\nwhile :; do :; done");
    const result = spawnSync(process.execPath, [dispatcher, "docs/goals/one", "--to", "codex", "--timeout", "1", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 1, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.match(report.error, /hard execution timeout after 1s/);
    assert.equal(report.timeout_semantics, "hard_execution_deadline");
    assert.equal(report.scope_check.status, "violations");
    assert.deepEqual(report.scope_check.violations, ["README.md"]);
    assert.equal(report.receipt, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("goalbuddy dispatch CLI wrapper forwards to the bundled script", () => {
  const root = makeProject();
  try {
    const bin = fakeHarnessBin(root, "codex", `echo "export const widget = 2;" > src/widget.mjs\necho '${RECEIPT}'`);
    const cli = resolve("internal/cli/goal-maker.mjs");
    const result = spawnSync(process.execPath, [cli, "dispatch", "docs/goals/one", "--to", "codex", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.scope_check.status, "clean");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch rejects receipt-shaped fragments that are not real receipts", () => {
  const root = makeProject();
  try {
    const bin = fakeHarnessBin(root, "codex", `echo '{"goalbuddy_receipt_v1": true}'\necho 'later, the real one:'\necho '${RECEIPT}'`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.receipt.result, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch extracts bare receipts returned without the envelope", () => {
  const root = makeProject();
  try {
    const bare = JSON.stringify({
      result: "done",
      task_id: "T001",
      decision: "approved",
      summary: "bare receipt",
    });
    const bin = fakeHarnessBin(root, "codex", `echo "export const widget = 2;" > src/widget.mjs\nprintf 'Some prose first.\\n\`\`\`json\\n%s\\n\`\`\`\\n' '${bare}'`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.receipt.summary, "bare receipt");
    assert.equal(report.receipt.harness, "codex");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const role of ["scout", "judge"]) {
  test(`reproduced ${role} edit to an already-dirty tracked file is rejected and preserved`, () => {
    const root = makeProject({ taskType: role });
    try {
      writeFileSync(join(root, "README.md"), "existing user work\n");
      const bin = fakeHarnessBin(root, "codex", `echo 'unauthorized append' >> README.md\necho '${RECEIPT}'`);
      const result = runDispatch(root, bin);
      const report = JSON.parse(result.stdout);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(report.ok, false);
      assert.equal(report.scope_check.status, "violations");
      assert.deepEqual(report.scope_check.violations, ["README.md"]);
      assert.equal(readFileSync(join(root, "README.md"), "utf8"), "existing user work\nunauthorized append\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const [name, setup, script, violations] of [
  ["existing untracked edit", (root) => writeFileSync(join(root, "draft.txt"), "user draft\n"), "echo changed >> draft.txt", ["draft.txt"]],
  ["untracked deletion", (root) => writeFileSync(join(root, "draft.txt"), "user draft\n"), "rm draft.txt", ["draft.txt"]],
  ["tracked deletion", () => {}, "rm README.md", ["README.md"]],
  ["dirty file restored to HEAD", (root) => writeFileSync(join(root, "README.md"), "user draft\n"), "git show HEAD:README.md > README.md", ["README.md"]],
  ["tracked rename", () => {}, "mv README.md renamed.md", ["README.md", "renamed.md"]],
  ["staged rename", () => {}, "git mv README.md renamed.md", ["README.md", "renamed.md"]],
  ["mode-only edit", () => {}, "chmod +x README.md", ["README.md"]],
  ["symlink replacement", (root) => symlinkSync("README.md", join(root, "link")), "rm link; ln -s src/widget.mjs link", ["link"]],

  ["index-only staging", (root) => writeFileSync(join(root, "README.md"), "user draft\n"), "git add README.md", ["README.md"]],
  ["PM board controls", () => {}, "echo '# tampered' >> docs/goals/one/state.yaml", ["docs/goals/one/state.yaml"]],
]) {
  test(`dispatch rejects ${name} from a read-only role`, () => {
    const root = makeProject({ taskType: "judge" });
    try {
      setup(root);
      const bin = fakeHarnessBin(root, "codex", `${script}\necho '${RECEIPT}'`);
      const result = runDispatch(root, bin);
      assert.equal(result.status, 1, result.stdout);
      const actual = JSON.parse(result.stdout).scope_check.violations;
      assert.deepEqual(actual, violations);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("allowed dirty Worker writes leave unrelated dirty/untracked work untouched", () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, "README.md"), "user draft\n");
    writeFileSync(join(root, "draft.txt"), "untracked draft\n");
    writeFileSync(join(root, "src/widget.mjs"), "// existing change\n");
    const bin = fakeHarnessBin(root, "codex", `echo 'export const widget = 2;' >> src/widget.mjs\necho '${RECEIPT}'`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).scope_check.changed_files, ["src/widget.mjs"]);
    assert.equal(readFileSync(join(root, "README.md"), "utf8"), "user draft\n");
    assert.equal(readFileSync(join(root, "draft.txt"), "utf8"), "untracked draft\n");
    assert.match(readFileSync(join(root, "src/widget.mjs"), "utf8"), /^\/\/ existing change/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const file of ["state.yaml", "goal.md", "notes/acceptance-contract.json"]) {
  test(`Worker cannot edit PM-owned ${file} even with an explicit allowlist`, () => {
    const root = makeProject();
    try {
      const statePath = join(root, "docs/goals/one/state.yaml");
      writeFileSync(statePath, readFileSync(statePath, "utf8").replace("- src/widget.mjs", "- docs/goals/one/**"));
      const bin = fakeHarnessBin(root, "codex", `echo tampered >> docs/goals/one/${file}\necho '${RECEIPT}'`);
      const result = runDispatch(root, bin);
      assert.equal(result.status, 1, result.stdout);
      assert.deepEqual(JSON.parse(result.stdout).scope_check.violations, [`docs/goals/one/${file}`]);
      assert.match(readFileSync(join(root, "docs/goals/one", file), "utf8"), /tampered/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("non-Git dispatch fails scope inspection without starting the harness", () => {
  const root = makeProject();
  try {
    rmSync(join(root, ".git"), { recursive: true });
    const bin = fakeHarnessBin(root, "codex", `echo launched >> README.md\necho '${RECEIPT}'`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).scope_check.status, "unverifiable");
    assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# fixture\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed Git inspection after dispatch never becomes clean", () => {
  const root = makeProject();
  try {
    const bin = fakeHarnessBin(root, "codex", `echo partial >> README.md\nprintf corrupt > .git/index\necho '${RECEIPT}'`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 1, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.scope_check.status, "unverifiable");
    assert.match(readFileSync(join(root, "README.md"), "utf8"), /partial/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [name, script] of [
  ["Git configuration", "git config example.changed yes"],
]) {
  test(`read-only dispatch detects changes to ${name}`, () => {
    const root = makeProject({ taskType: "scout" });
    try {
      const bin = fakeHarnessBin(root, "codex", `${script}\necho '${RECEIPT}'`);
      const result = runDispatch(root, bin);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(JSON.parse(result.stdout).scope_check.status, "violations");
      assert.ok(JSON.parse(result.stdout).scope_check.violations.some((path) => path.startsWith(".git/")));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("Worker can create an allowed file and its missing parent directories", () => {
  const root = makeProject();
  try {
    const board = join(root, "docs/goals/one/state.yaml");
    writeFileSync(board, readFileSync(board, "utf8").replace("- src/widget.mjs", "- src/new/widget.mjs"));
    const bin = fakeHarnessBin(root, "codex", `mkdir src/new\necho 'export const widget = 2;' > src/new/widget.mjs\necho '${RECEIPT}'`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).scope_check.changed_files, ["src/new", "src/new/widget.mjs"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("read-only no-op preserves dirty tracked and untracked work", () => {
  const root = makeProject({ taskType: "scout" });
  try {
    writeFileSync(join(root, "README.md"), "existing work\n");
    writeFileSync(join(root, "draft.txt"), "existing draft\n");
    const bin = fakeHarnessBin(root, "codex", `echo '${RECEIPT}'`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).scope_check.changed_files, []);
    assert.equal(readFileSync(join(root, "README.md"), "utf8"), "existing work\n");
    assert.equal(readFileSync(join(root, "draft.txt"), "utf8"), "existing draft\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Worker renames must keep both removed and added paths inside allowed_files", () => {
  const root = makeProject();
  try {
    const bin = fakeHarnessBin(root, "codex", `mv src/widget.mjs README.md\necho '${RECEIPT}'`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).scope_check.violations, ["README.md"]);
    assert.deepEqual(JSON.parse(result.stdout).scope_check.changed_files, ["README.md", "src/widget.mjs"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("custom goal directories remain protected outside docs/goals", () => {
  const root = makeProject();
  try {
    const move = spawnSync("mv", ["docs/goals/one", "custom-goal"], { cwd: root, encoding: "utf8" });
    assert.equal(move.status, 0, move.stderr);
    const board = join(root, "custom-goal/state.yaml");
    writeFileSync(board, readFileSync(board, "utf8").replace("- src/widget.mjs", "- custom-goal/**"));
    const bin = fakeHarnessBin(root, "codex", `echo '# tampered' >> custom-goal/state.yaml\necho '${RECEIPT}'`);
    const result = spawnSync(process.execPath, [dispatcher, "custom-goal", "--to", "codex", "--json"], {
      cwd: root, encoding: "utf8", timeout: 15000,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).scope_check.violations, ["custom-goal/state.yaml"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("concurrent board changes during preflight prevent dispatch under stale authority", () => {
  const root = makeProject();
  try {
    const gitPath = spawnSync("command", ["-v", "git"], { encoding: "utf8", shell: true }).stdout.trim();
    const bin = fakeHarnessBin(root, "codex", `echo launched >> README.md\necho '${RECEIPT}'`);
    // Simulate another writer during the first Git inspection, before its snapshot.
    fakeHarnessBin(root, "git", `if [ "$1" = rev-parse ] && [ "$2" = --show-toplevel ]; then echo '# concurrent PM change' >> docs/goals/one/state.yaml; fi\nexec '${gitPath}' "$@"`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).scope_check.status, "unverifiable");
    assert.match(JSON.parse(result.stdout).error, /Board changed/);
    assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# fixture\n");
    assert.match(readFileSync(join(root, "docs/goals/one/state.yaml"), "utf8"), /concurrent PM change/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("separate Git directory pointer files are protected by content/state observation", () => {
  const root = makeProject({ taskType: "scout" });
  const metadata = mkdtempSync(join(tmpdir(), "goalbuddy-git-metadata-"));
  try {
    const moved = spawnSync("git", ["init", "--separate-git-dir", metadata], { cwd: root, encoding: "utf8" });
    assert.equal(moved.status, 0, moved.stderr);
    const bin = fakeHarnessBin(root, "codex", `echo >> .git\necho '${RECEIPT}'`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).scope_check.violations, [".git"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(metadata, { recursive: true, force: true });
  }
});

test("a goal at the repository root still protects its board controls", () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, "state.yaml"), readFileSync(join(root, "docs/goals/one/state.yaml"), "utf8").replace("- src/widget.mjs", "- state.yaml"));
    writeFileSync(join(root, "goal.md"), "# root goal\n");
    const bin = fakeHarnessBin(root, "codex", `echo '# tampered' >> state.yaml\necho '${RECEIPT}'`);
    const result = spawnSync(process.execPath, [dispatcher, ".", "--to", "codex", "--timeout", "5", "--json"], {
      cwd: root, encoding: "utf8", timeout: 15000,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).scope_check.violations, ["state.yaml"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const change of [false, true]) {
  test(`linked worktree ${change ? "forbidden edit is rejected" : "no-op succeeds"}`, () => {
    const main = makeProject({ taskType: "scout" });
    const parent = mkdtempSync(join(tmpdir(), "goalbuddy-linked-"));
    const root = join(parent, "checkout");
    try {
      const linked = spawnSync("git", ["worktree", "add", "-q", "-b", "fixture", root], { cwd: main, encoding: "utf8" });
      assert.equal(linked.status, 0, linked.stderr);
      const bin = fakeHarnessBin(root, "codex", `${change ? "echo changed >> README.md" : "git status --porcelain >/dev/null"}\necho '${RECEIPT}'`);
      const result = runDispatch(root, bin);
      assert.equal(result.status, change ? 1 : 0, result.stdout || result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.scope_check.status, change ? "violations" : "clean");
      assert.deepEqual(report.scope_check.violations, change ? ["README.md"] : []);
    } finally { rmSync(parent, { recursive: true, force: true }); rmSync(main, { recursive: true, force: true }); }
  });
}

for (const target of ["node_modules/.cache/big", ".git/objects/sparse-file"]) {
  test(`ignored/generated sparse storage ${target} does not block source observation`, () => {
    const root = makeProject({ taskType: "scout" });
    try {
      writeFileSync(join(root, ".gitignore"), "node_modules/\n");
      mkdirSync(join(root, target, ".."), { recursive: true });
      const fd = openSync(join(root, target), "w"); ftruncateSync(fd, 513 * 1024 * 1024); closeSync(fd);
      assert.equal(statSync(join(root, target)).blocks, 0);
      const bin = fakeHarnessBin(root, "codex", `echo '${RECEIPT}'`);
      const result = runDispatch(root, bin);
      assert.equal(result.status, 0, result.stdout);
      const observation = JSON.parse(result.stdout).scope_check.observation;
      assert.equal(observation.policy, "source-and-controls-v1");
      assert.ok(observation.git_exclusions.includes("object database"));
      if (target.startsWith("node_modules")) assert.ok(observation.excluded_ignored_paths.includes("node_modules/"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("git status cache refresh is clean while semantic index flags remain observed", () => {
  const root = makeProject({ taskType: "scout" });
  try {
    utimesSync(join(root, "README.md"), new Date(0), new Date(0));
    const semantic = () => spawnSync("git", ["ls-files", "--stage", "-v"], { cwd: root, encoding: "utf8" }).stdout;
    const before = semantic();
    const bin = fakeHarnessBin(root, "codex", `test "$GIT_OPTIONAL_LOCKS" = 0 || exit 42\nGIT_OPTIONAL_LOCKS=1 git status --porcelain >/dev/null\necho '${RECEIPT}'`);
    const status = runDispatch(root, bin);
    assert.equal(status.status, 0, status.stdout);
    assert.equal(semantic(), before);
    fakeHarnessBin(root, "codex", `git update-index --assume-unchanged README.md\necho '${RECEIPT}'`);
    const flags = runDispatch(root, bin);
    assert.equal(flags.status, 1, flags.stdout);
    assert.deepEqual(JSON.parse(flags.stdout).scope_check.violations, ["README.md"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const admitted of [false, true]) {
  test(`ignored source ${admitted ? "explicitly admitted is observed" : "exclusion is visible in the claim"}`, () => {
    const root = makeProject({ taskType: "scout" });
    try {
      writeFileSync(join(root, ".gitignore"), "generated/\n");
      mkdirSync(join(root, "generated")); writeFileSync(join(root, "generated/result.txt"), "before");
      if (admitted) {
        const path = join(root, "docs/goals/one/state.yaml");
        writeFileSync(path, readFileSync(path, "utf8").replace("    receipt: null", "    inputs:\n      - generated/result.txt\n    receipt: null"));
      }
      const bin = fakeHarnessBin(root, "codex", `echo changed >> generated/result.txt\necho '${RECEIPT}'`);
      const result = runDispatch(root, bin), report = JSON.parse(result.stdout);
      assert.equal(result.status, admitted ? 1 : 0, result.stdout);
      assert.ok(report.scope_check.observation.excluded_ignored_paths.includes("generated/"));
      if (admitted) {
        assert.ok(report.scope_check.observation.admitted_ignored_paths.includes("generated/result.txt"));
        assert.deepEqual(report.scope_check.violations, ["generated/result.txt"]);
      } else assert.match(report.scope_check.observation.claim, /observed source\/control paths/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("ignored PM controls cannot disappear from source observation", () => {
  const root = makeProject({ taskType: "scout" });
  try {
    writeFileSync(join(root, ".gitignore"), "docs/goals/**/notes/\n");
    writeFileSync(join(root, "docs/goals/one/notes/proof.json"), "{}");
    const bin = fakeHarnessBin(root, "codex", `echo tampered >> docs/goals/one/notes/proof.json\necho '${RECEIPT}'`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).scope_check.violations, ["docs/goals/one/notes/proof.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit glob grants observe nested ignored source paths", () => {
  const root = makeProject({ taskType: "scout" });
  try {
    writeFileSync(join(root, ".gitignore"), "generated/\n");
    mkdirSync(join(root, "generated/nested/deeper"), { recursive: true });
    writeFileSync(join(root, "generated/nested/deeper/result.txt"), "before");
    const path = join(root, "docs/goals/one/state.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("src/widget.mjs", "generated/**/*.txt"));
    const bin = fakeHarnessBin(root, "codex", `echo changed >> generated/nested/deeper/result.txt\necho '${RECEIPT}'`);
    const result = runDispatch(root, bin), report = JSON.parse(result.stdout);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(report.scope_check.observation.admitted_ignored_paths.includes("generated/nested/deeper/result.txt"));
    assert.deepEqual(report.scope_check.violations, ["generated/nested/deeper/result.txt"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("root-level goal permits explicitly allowed source edits", () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, "state.yaml"), readFileSync(join(root, "docs/goals/one/state.yaml")));
    writeFileSync(join(root, "goal.md"), "# root goal\n");
    const receipt = JSON.parse(RECEIPT); receipt.goalbuddy_receipt_v1.board_path = "state.yaml";
    const bin = fakeHarnessBin(root, "codex", `echo '// allowed' >> src/widget.mjs\necho '${JSON.stringify(receipt)}'`);
    const result = spawnSync(process.execPath, [dispatcher, ".", "--to", "codex", "--timeout", "5", "--json"], { cwd: root, encoding: "utf8", timeout: 15000, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } });
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).scope_check.changed_files, ["src/widget.mjs"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [field, value] of [["task_id", "T777"], ["board_path", "docs/goals/unrelated/state.yaml"], ["harness", "claude-code"]]) {
  test(`dispatch rejects wrong receipt ${field} and retains it for recovery`, () => {
    const root = makeProject();
    try {
      const receipt = JSON.parse(RECEIPT); receipt.goalbuddy_receipt_v1[field] = value;
      const bin = fakeHarnessBin(root, "codex", `echo '${JSON.stringify(receipt)}'`);
      const result = runDispatch(root, bin), report = JSON.parse(result.stdout);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(report.ok, false);
      assert.equal(report.receipt[field], value);
      assert.match(report.error, new RegExp(field));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("duplicate JSON receipt members cannot be hidden by the envelope or bare fallback", () => {
  const root = makeProject();
  try {
    const bin = fakeHarnessBin(root, "codex", `echo '{"goalbuddy_receipt_v1":{"result":"blocked","result":"done","task_id":"T001"}}'`);
    const result = runDispatch(root, bin);
    assert.equal(result.status, 1, result.stdout);
    assert.match(JSON.parse(result.stdout).error, /Duplicate JSON/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
