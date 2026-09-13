import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { toYamlLines } from "../../goalbuddy/scripts/apply-receipt.mjs";
import { sha256 } from "../../goalbuddy/scripts/file-snapshot.mjs";

const script = resolve(process.env.GOALBUDDY_TEST_SCRIPT_ROOT || "goalbuddy/scripts", "check-can-stop.mjs");
const recorder = resolve("goalbuddy/scripts/record-acceptance.mjs");

function makeGoal(state) {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-can-stop-"));
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "goal.md"), "# Test goal\n");
  writeFileSync(join(root, "state.yaml"), state.trimStart());
  return root;
}

function run(root) {
  const result = spawnSync(process.execPath, [script, root, "--json"], { encoding: "utf8" });
  return { status: result.status, report: JSON.parse(result.stdout || result.stderr) };
}

const activeState = `
version: 2
goal:
  title: "Keep going"
  slug: "keep-going"
  kind: specific
  tranche: "Continue safe work"
  status: active
  oracle:
    signal: "The requested outcome works."
    final_proof: "A final audit verifies the outcome."
  intake:
    completion_proof: "The final audit passes."
rules:
  continuous_until_full_outcome: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: T001
tasks:
  - id: T001
    type: pm
    assignee: PM
    status: active
    objective: "Continue the next safe work package."
    receipt: null
checks:
  dirty_fingerprint: clean
  last_verification:
    result: unknown
    task: null
    commands: []
`;

test("rejects host turn exit while an active task remains", () => {
  const root = makeGoal(activeState);
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.equal(result.report.can_stop, false);
    assert.equal(result.report.reason, "runnable_work_remains");
    assert.equal(result.report.active_task, "T001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const doneState = `
version: 2
goal:
  title: "Finished"
  slug: "finished"
  kind: specific
  tranche: "Verify completion"
  status: done
  oracle:
    signal: "The requested outcome works."
    final_proof: "T999 verifies the complete outcome."
  intake:
    completion_proof: "T999 passes."
rules:
  continuous_until_full_outcome: true
  no_completion_on_weak_proof: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: null
tasks:
  - id: T999
    type: judge
    assignee: Judge
    status: done
    objective: "Audit the full outcome."
    receipt:
      result: done
      decision: complete
      full_outcome_complete: true
      summary: "The original outcome is verified."
checks:
  dirty_fingerprint: clean
  last_verification:
    result: pass
    task: T999
    commands: []
`;

test("legacy terminal completion without acceptance proof is rejected without rewriting history", () => {
  const root = makeGoal(doneState);
  try {
    const original = readFileSync(join(root, "state.yaml"), "utf8");
    const result = run(root);
    assert.equal(result.status, 1);
    assert.equal(result.report.can_stop, false);
    assert.equal(result.report.reason, "acceptance_not_proven");
    assert.equal(readFileSync(join(root, "state.yaml"), "utf8"), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("allows the exact validated terminal approval wait", () => {
  const root = makeGoal(`
version: 2
goal:
  title: "Approval gate"
  slug: "approval-gate"
  kind: specific
  tranche: "Wait for exact approval"
  status: blocked
rules:
  continuous_until_full_outcome: true
  missing_input_or_credentials_do_not_stop_goal: true
agents:
  scout: installed
  worker: installed
  judge: installed
active_task: null
tasks:
  - id: T001
    type: worker
    assignee: Worker
    status: blocked
    objective: "Apply the approved production change."
    allowed_files:
      - src/**
    verify:
      - npm test
    stop_if:
      - "Exact approval is missing."
    receipt:
      result: blocked
      waiting_for_user_approval: true
      required_reply: "approve production"
      blocked_reason: "Production change requires exact approval."
      summary: "Asked once and stopped."
checks:
  dirty_fingerprint: clean
  last_verification:
    result: unknown
    task: T001
    commands: []
`);
  try {
    const result = run(root);
    assert.equal(result.status, 0);
    assert.equal(result.report.can_stop, true);
    assert.equal(result.report.reason, "validated_terminal_block");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function acceptanceProject({ failing = false, inputs = [], timeout = 5 } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "goalbuddy-acceptance-"));
  const goal = join(repo, "docs/goals/one");
  mkdirSync(join(goal, "notes"), { recursive: true });
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/result.txt"), failing ? "broken\n" : "working\n");
  writeFileSync(join(repo, "acceptance.mjs"), 'import { readFileSync } from "node:fs"; process.exit(readFileSync("src/result.txt", "utf8") === "working\\n" ? 0 : 1);\n');
  writeFileSync(join(goal, "goal.md"), "# Deliver a working result\n");
  const project = { repo, goal, command: [process.execPath, "acceptance.mjs"], config: { command: [process.execPath, "acceptance.mjs"], artifacts: ["src"], inputs, timeout_seconds: timeout } };
  stateFor(project);
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "init"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return project;
}

function stateFor(project, evidence, receiptChanges = {}, verification = "pass") {
  const active = !evidence;
  const receipt = active ? "    receipt: null\n" : "    receipt:\n" + toYamlLines({ result: "done", decision: "complete", full_outcome_complete: true, summary: "Final audit consumed the observed acceptance.", ...evidence, ...receiptChanges }, 6).join("\n") + "\n";
  let state = doneState.replace(/    receipt:\n[\s\S]*?checks:\n/, `${toYamlLines({ acceptance: project.config }, 4).join("\n")}\n${receipt}checks:\n`);
  if (active) state = state.replace("  status: done", "  status: active").replace("    status: done", "    status: active").replace("active_task: null", "active_task: T999").replace("    result: pass", "    result: unknown");
  else state = state.replace("    result: pass", `    result: ${verification}`);
  writeFileSync(join(project.goal, "state.yaml"), state);
}

function record(project, env = {}) {
  const result = spawnSync(process.execPath, [recorder, project.goal, "--", ...project.command], { cwd: project.repo, encoding: "utf8", timeout: project.outerTimeout || 15000, env: { ...process.env, ...env } });
  assert.equal(result.error, undefined, result.error?.message);
  return { status: result.status, report: JSON.parse(result.stdout || result.stderr) };
}
function finalize(project, observed, changes = {}, verification = "pass") { stateFor(project, observed.report.audit_evidence, changes, verification); }
function edit(path, from, to) { writeFileSync(path, readFileSync(path, "utf8").replace(from, to)); }
function changeProof(project, observed, mutate) {
  const proof = JSON.parse(readFileSync(observed.report.proof_path));
  mutate(proof);
  const bytes = JSON.stringify(proof);
  writeFileSync(observed.report.proof_path, bytes);
  // Even a final audit that hashes the malformed evidence must not legitimize it.
  observed.report.audit_evidence.acceptance_sha256 = sha256(bytes);
  finalize(project, observed);
}

// Original failure assertion retained: a failed independent check and terminal claim
// cannot authorize completion, regardless of the newer recorder's setup protocol.
test("reproduced failed verification and independent acceptance cannot complete a terminal board", () => {
  const project = acceptanceProject({ failing: true });
  try {
    writeFileSync(join(project.goal, "state.yaml"), doneState.replace("result: pass", "result: fail"));
    assert.equal(spawnSync(process.execPath, ["acceptance.mjs"], { cwd: project.repo }).status, 1);
    const before = readFileSync(join(project.goal, "state.yaml"));
    const result = run(project.goal);
    assert.equal(result.status, 1, JSON.stringify(result.report));
    assert.equal(result.report.can_stop, false);
    assert.match(result.report.errors.join(" "), /non-passing/);
    assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), before);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("one observed verification is consumed by final audit without a second execution", () => {
  const project = acceptanceProject();
  try {
    writeFileSync(join(project.repo, "acceptance.mjs"), 'import { appendFileSync } from "node:fs"; appendFileSync("invocations", "run\\n");\n');
    const before = readFileSync(join(project.goal, "state.yaml"));
    const observed = record(project);
    assert.equal(observed.status, 0, JSON.stringify(observed.report));
    assert.equal(observed.report.cleanup.status, "not_required");
    assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), before);
    assert.equal(run(project.goal).report.reason, "runnable_work_remains");
    finalize(project, observed);
    const result = run(project.goal);
    assert.equal(result.status, 0, JSON.stringify(result.report));
    assert.equal(result.report.reason, "full_outcome_complete");
    assert.equal(result.report.board_revision, sha256(readFileSync(join(project.goal, "state.yaml"))));
    assert.equal(readFileSync(join(project.repo, "invocations"), "utf8"), "run\n");
    assert.equal(record(project).status, 1, "A finalized historical audit cannot run implicitly again.");
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("failed acceptance stays failed despite final audit completion claims", () => {
  const project = acceptanceProject({ failing: true });
  try {
    const observed = record(project);
    assert.equal(observed.status, 1);
    assert.equal(JSON.parse(readFileSync(observed.report.proof_path)).exit_status, 1);
    assert.equal(observed.report.cleanup.status, "not_required");
    finalize(project, observed);
    assert.equal(run(project.goal).report.can_stop, false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("recovery records a new attempt and preserves the failed historical evidence", () => {
  const project = acceptanceProject({ failing: true });
  try {
    const failed = record(project), bytes = readFileSync(failed.report.proof_path);
    writeFileSync(join(project.repo, "src/result.txt"), "working\n");
    const passed = record(project);
    assert.equal(passed.status, 0);
    assert.notEqual(passed.report.proof_path, failed.report.proof_path);
    finalize(project, passed);
    assert.equal(run(project.goal).report.can_stop, true);
    assert.deepEqual(readFileSync(failed.report.proof_path), bytes);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

for (const [name, mutate] of [
  ["artifact contents", ({ repo }) => writeFileSync(join(repo, "src/result.txt"), "broken\n")],
  ["artifact directory additions", ({ repo }) => writeFileSync(join(repo, "src/extra.txt"), "new\n")],
  ["deleted artifact", ({ repo }) => rmSync(join(repo, "src/result.txt"))],
  ["charter", ({ goal }) => writeFileSync(join(goal, "goal.md"), "# A different outcome\n")],
  ["board outcome", ({ goal }) => edit(join(goal, "state.yaml"), 'title: "Finished"', 'title: "Different"')],
  ["acceptance settings", ({ goal }) => edit(join(goal, "state.yaml"), "timeout_seconds: 5", "timeout_seconds: 6")],
  ["omitted local validator", ({ repo }) => writeFileSync(join(repo, "acceptance.mjs"), "process.exit(1);\n")],
]) {
  test(`completion rejects stale proof after ${name} changes`, () => {
    const project = acceptanceProject();
    try {
      const observed = record(project);
      assert.equal(observed.status, 0, JSON.stringify(observed.report));
      finalize(project, observed); mutate(project);
      const result = run(project.goal);
      assert.equal(result.status, 1, JSON.stringify(result.report));
      assert.match(result.report.errors.join(" "), /stale|must exist/);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

test("declared configuration inputs are bound even when omitted from artifacts", () => {
  const project = acceptanceProject({ inputs: ["config.txt"] });
  try {
    writeFileSync(join(project.repo, "config.txt"), "good");
    writeFileSync(join(project.repo, "acceptance.mjs"), 'import { readFileSync } from "node:fs"; process.exit(readFileSync("config.txt", "utf8") === "good" ? 0 : 1);');
    const observed = record(project);
    assert.equal(observed.status, 0);
    finalize(project, observed);
    writeFileSync(join(project.repo, "config.txt"), "bad");
    assert.equal(spawnSync(process.execPath, project.command.slice(1), { cwd: project.repo }).status, 1);
    assert.equal(run(project.goal).report.can_stop, false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("package launchers bind local script entry points and package configuration", () => {
  const project = acceptanceProject();
  try {
    project.command = project.config.command = ["npm", "run", "accept"];
    writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts: { accept: `"${process.execPath}" acceptance.mjs` } }));
    stateFor(project);
    const observed = record(project);
    assert.equal(observed.status, 0, JSON.stringify(observed.report));
    finalize(project, observed);
    assert.equal(run(project.goal).report.can_stop, true);
    edit(join(project.repo, "acceptance.mjs"), "process.exit(", "process.exit(1 || ");
    assert.equal(run(project.goal).report.can_stop, false);
    writeFileSync(join(project.repo, "acceptance.mjs"), "process.exit(0);");
    stateFor(project);
    const next = record(project);
    assert.equal(next.status, 0);
    finalize(project, next);
    writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts: { accept: `"${process.execPath}" -e "process.exit(1)"` } }));
    assert.equal(run(project.goal).report.can_stop, false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

const literalEntryCases = [
  { name: "direct literal file", file: "acceptance.mjs", direct: ["acceptance.mjs"] },
  { name: "direct extensionless file", file: "acceptance", direct: ["acceptance"] },
  { name: "direct filename with spaces", file: "acceptance check.mjs", direct: ["acceptance check.mjs"] },
  { name: "package literal file", file: "acceptance.mjs", script: "node acceptance.mjs" },
  { name: "package extensionless file", file: "acceptance", script: "node acceptance" },
  { name: "concrete subdirectory file", file: "checks/run.mjs", script: "node checks/run.mjs" },
  { name: "ASCII tab separator", file: "acceptance.mjs", script: "node\tacceptance.mjs" },
  { name: "quoted local filename", file: "acceptance check.mjs", script: 'node "acceptance check.mjs"' },
  { name: "single-quoted local filename", file: "acceptance check.mjs", script: "node 'acceptance check.mjs'" },
  { name: "escaped local filename", file: "acceptance check.mjs", script: "node acceptance\\ check.mjs" },
  { name: "quoted local executable", file: "acceptance check.sh", script: '"./acceptance check.sh"', executable: true },
  { name: "direct local executable", file: "acceptance check.sh", direct: ["./acceptance check.sh"], executable: true },
  { name: "explicit-input concrete-file control", file: "acceptance.mjs", script: "node acceptance.mjs", explicit: true },
  { name: "unquoted NBSP without decoy", file: "acceptance\u00a0check.mjs", script: "node acceptance\u00a0check.mjs" },
  { name: "explicit-input NBSP control", file: "acceptance\u00a0check.mjs", script: "node acceptance\u00a0check.mjs", explicit: true, decoy: true },
  { name: "quoted tab filename", file: "acceptance\tcheck.mjs", script: 'node "acceptance\tcheck.mjs"' },
  ...[
    ["NBSP", "\u00a0"], ["narrow NBSP", "\u202f"], ["em space", "\u2003"],
    ["Unicode line separator", "\u2028"], ["BOM", "\ufeff"],
  ].flatMap(([name, space]) => [
    { name: `unquoted ${name}`, file: `acceptance${space}check.mjs`, script: `node acceptance${space}check.mjs`, decoy: true },
    { name: `quoted ${name} control`, file: `acceptance${space}check.mjs`, script: `node "acceptance${space}check.mjs"`, decoy: true },
  ]),
];
for (const entry of literalEntryCases) {
  test(`R3 local entry freshness: ${entry.name}`, () => {
    const project = acceptanceProject({ inputs: ["config.txt", ...(entry.explicit ? [entry.file] : [])] });
    try {
      mkdirSync(join(project.repo, "checks"), { recursive: true });
      writeFileSync(join(project.repo, "config.txt"), "good");
      writeFileSync(join(project.repo, entry.file), entry.executable ? "#!/bin/sh\nexit 0\n" : "process.exit(0);\n");
      if (entry.decoy) writeFileSync(join(project.repo, "acceptance"), "process.exit(0);\n");
      if (entry.executable) chmodSync(join(project.repo, entry.file), 0o755);
      const pkg = entry.script ? { scripts: { accept: entry.script } } : {};
      writeFileSync(join(project.repo, "package.json"), JSON.stringify(pkg));
      project.command = project.config.command = entry.direct ? (entry.executable ? entry.direct : [process.execPath, ...entry.direct]) : ["npm", "run", "--silent", "accept"];
      stateFor(project);
      const observed = record(project); assert.equal(observed.status, 0, JSON.stringify(observed.report));
      finalize(project, observed);
      assert.equal(run(project.goal).report.can_stop, true);
      const board = readFileSync(join(project.goal, "state.yaml")), proof = readFileSync(observed.report.proof_path);
      writeFileSync(join(project.repo, entry.file), entry.executable ? "#!/bin/sh\nexit 1\n" : "process.exit(1);\n");
      const actual = spawnSync(project.command[0], project.command.slice(1), { cwd: project.repo, encoding: "utf8", timeout: 5000 });
      assert.equal(actual.status, 1, actual.stdout || actual.stderr);
      assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), board);
      assert.deepEqual(readFileSync(observed.report.proof_path), proof);
      assert.equal(run(project.goal).report.can_stop, false, "A validator-only change must invalidate the earlier passing proof.");
      const inputs = JSON.parse(proof).binding.inputs;
      assert.ok(inputs.includes(entry.file), "The concrete validator is bound.");
      assert.ok(JSON.parse(proof).binding.local_entry_points.includes(entry.file));
      if (entry.decoy) assert.ok(!inputs.includes("acceptance"), "Unicode whitespace must not select a different file.");
      assert.ok(!inputs.includes(".") && !inputs.includes("checks"), "Bind the exact file without hashing its directory.");
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

// Directory launch support was deliberately removed: metadata and admitted
// inputs cannot make Node's directory/extension fallback a concrete file argv.
for (const entry of [
  { name: "package main with admitted validator", directory: ".", operand: ".", main: "acceptance.mjs", explicit: true },
  { name: "package main with spaces", directory: ".", operand: ".", main: "acceptance check.mjs" },
  { name: "direct package main", directory: ".", operand: ".", main: "acceptance.mjs", direct: true },
  { name: "root index", directory: ".", operand: "." },
  { name: "direct root index slash", directory: ".", operand: "./", direct: true },
  { name: "root main slash", directory: ".", operand: "./", main: "acceptance.mjs" },
  { name: "subdirectory main shadow", directory: "checks", operand: "checks", main: "run.mjs", shadow: true },
  { name: "subdirectory index shadow", directory: "checks", operand: "checks", shadow: true },
  { name: "direct subdirectory shadow", directory: "checks", operand: "checks", main: "run.mjs", shadow: true, direct: true },
  { name: "subdirectory slash shadow with admitted files", directory: "checks", operand: "checks/", main: "run.mjs", shadow: true, explicit: true },
  { name: "subdirectory main without shadow", directory: "checks", operand: "checks", main: "run.mjs", explicit: true },
  { name: "subdirectory index without shadow", directory: "checks", operand: "checks" },
  { name: "direct subdirectory index slash", directory: "checks", operand: "checks/", direct: true },
  { name: "quoted subdirectory", directory: "check dir", operand: '"check dir/"', main: "run.mjs" },
]) {
  test(`R4 directory rejects before execution and concrete-file recovery stays fresh: ${entry.name}`, () => {
    const file = entry.directory === "." ? entry.main || "index.js" : `${entry.directory}/${entry.main || "index.js"}`;
    const project = acceptanceProject({ inputs: ["config.txt", ...(entry.explicit ? [file, ...(entry.shadow ? ["checks.js"] : [])] : [])] });
    try {
      mkdirSync(join(project.repo, entry.directory), { recursive: true });
      writeFileSync(join(project.repo, "config.txt"), "good");
      const markerCode = 'import("node:fs").then(fs => fs.appendFileSync("invocations", "run\\n"));\n';
      writeFileSync(join(project.repo, file), markerCode);
      if (entry.shadow) writeFileSync(join(project.repo, "checks.js"), markerCode);
      const pkg = { scripts: { accept: `node ${entry.operand}` } };
      if (entry.directory === "." && entry.main) pkg.main = entry.main;
      writeFileSync(join(project.repo, "package.json"), JSON.stringify(pkg));
      if (entry.directory !== "." && entry.main) writeFileSync(join(project.repo, entry.directory, "package.json"), JSON.stringify({ main: entry.main }));
      project.command = project.config.command = entry.direct ? [process.execPath, entry.operand] : ["npm", "run", "--silent", "accept"];
      stateFor(project);
      const activeBoard = readFileSync(join(project.goal, "state.yaml"));
      const rejected = record(project);
      assert.equal(rejected.status, 1, JSON.stringify(rejected.report));
      assert.equal(rejected.report.proof_path, undefined);
      assert.match(rejected.report.error, /exact local file.*direct local validator.*concrete filename.*acceptance.inputs/i);
      assert.equal(existsSync(join(project.repo, "invocations")), false, "The directory command must never execute.");
      assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), activeBoard);

      project.command = project.config.command = [process.execPath, file];
      stateFor(project);
      const observed = record(project); assert.equal(observed.status, 0, JSON.stringify(observed.report));
      assert.equal(run(project.goal).report.can_stop, false, "The final audit must consume the one observed verification.");
      finalize(project, observed);
      assert.equal(run(project.goal).report.can_stop, true);
      assert.equal(readFileSync(join(project.repo, "invocations"), "utf8"), "run\n");
      const board = readFileSync(join(project.goal, "state.yaml")), proof = readFileSync(observed.report.proof_path);
      assert.ok(JSON.parse(proof).binding.local_entry_points.includes(file));
      assert.ok(!JSON.parse(proof).binding.inputs.includes(entry.directory));
      writeFileSync(join(project.repo, file), "process.exit(1);\n");
      const actual = spawnSync(project.command[0], project.command.slice(1), { cwd: project.repo, encoding: "utf8", timeout: 5000 });
      assert.equal(actual.status, 1, actual.stdout || actual.stderr);
      assert.equal(run(project.goal).report.can_stop, false);
      assert.deepEqual(readFileSync(join(project.goal, "state.yaml")), board);
      assert.deepEqual(readFileSync(observed.report.proof_path), proof);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

for (const entry of [
  { name: "unresolved declared main despite index fallback", script: "node .", main: "missing.mjs" },
  { name: "directory-valued main", script: "node .", main: "checks" },
  { name: "implicit extension resolution", script: "node acceptance", extra: "acceptance.js" },
  { name: "file with trailing slash", script: "node acceptance.mjs/" },
  { name: "unresolved directory", script: "node missing" },
  { name: "unbalanced quote", script: "node 'acceptance.mjs" },
  { name: "newline", script: "node acceptance.mjs\nnode acceptance.mjs" },
  { name: "quoted newline", script: 'node "acceptance\ncheck.mjs"' },
  { name: "quoted carriage return", script: 'node "acceptance\rcheck.mjs"' },
  { name: "command composition", script: "node acceptance.mjs && node acceptance.mjs" },
  { name: "shell expansion", script: 'node "$VALIDATOR"' },
  { name: "shell glob", script: "node acceptance*.mjs" },
  { name: "shell assignment", script: "VALIDATOR=acceptance.mjs node acceptance.mjs" },
  { name: "nested package launcher", script: "npm run alternate" },
  { name: "shell wrapper", script: 'sh -c "node acceptance.mjs"' },
  { name: "direct opaque wrapper", direct: ["env", "node", "."], main: "acceptance.mjs" },
  { name: "unresolved Node option", script: "node --require ./preload.cjs ." },
]) {
  test(`unresolved local entry rejects before execution: ${entry.name}`, () => {
    const project = acceptanceProject();
    try {
      const markerCode = 'import("node:fs").then(fs => fs.writeFileSync("executed", "bad"));';
      for (const name of ["acceptance.mjs", "index.js", "preload.cjs", ...(entry.extra ? [entry.extra] : [])]) writeFileSync(join(project.repo, name), markerCode);
      mkdirSync(join(project.repo, "checks")); writeFileSync(join(project.repo, "checks/index.js"), markerCode);
      writeFileSync(join(project.repo, "package.json"), JSON.stringify({ ...(entry.main ? { main: entry.main } : {}), scripts: { accept: entry.script } }));
      project.command = project.config.command = entry.direct || ["npm", "run", "--silent", "accept"]; stateFor(project);
      const observed = record(project, { VALIDATOR: "acceptance.mjs" });
      assert.equal(observed.status, 1, JSON.stringify(observed.report));
      assert.equal(observed.report.proof_path, undefined, "Reject before any execution attempt.");
      assert.equal(existsSync(join(project.repo, "executed")), false);
      assert.match(observed.report.error, /direct local validator/i);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

for (const argv of [
  ["run", "--silent", "accept"],
  ["--silent", "run", "accept"],
  ["-s", "run", "accept"],
  ["run", "accept", "--silent"],
  ["run", "--loglevel", "silent", "accept"],
  ["--loglevel=silent", "run-script", "accept"],
  ["run", "--", "accept"],
  ["run", "accept", "--", "--prefix", "elsewhere", "--silent"],
]) {
  test(`R2 npm validator remains bound: ${argv.join(" ")}`, () => {
    const project = acceptanceProject();
    try {
      project.command = project.config.command = ["npm", ...argv];
      writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts: { accept: `"${process.execPath}" acceptance.mjs` } }));
      stateFor(project);
      const observed = record(project);
      assert.equal(observed.status, 0, JSON.stringify(observed.report));
      finalize(project, observed);
      assert.equal(run(project.goal).report.can_stop, true);
      writeFileSync(join(project.repo, "acceptance.mjs"), "process.exit(1);");
      const actual = spawnSync("npm", argv, { cwd: project.repo, encoding: "utf8", timeout: 5000 });
      assert.equal(actual.status, 1, actual.stdout || actual.stderr);
      assert.equal(run(project.goal).report.can_stop, false, "The exact declared command now fails; its earlier proof is stale.");
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

test("R2 sequence continuation cannot hide a failed verification status", () => {
  const project = acceptanceProject();
  try {
    const observed = record(project); assert.equal(observed.status, 0);
    finalize(project, observed);
    edit(join(project.goal, "state.yaml"), "    commands: []", '    commands:\n      - status: fail\n          status: pass\n          cmd: "node acceptance.mjs"');
    const result = run(project.goal);
    assert.equal(result.report.can_stop, false, JSON.stringify(result.report));
    assert.match(result.report.errors.join(" "), /Duplicate YAML key/);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

for (const argv of [
  ["--prefix", "nested", "run", "accept"],
  ["run", "accept", "--prefix=nested"],
  ["run", "--workspace", "nested", "accept"],
  ["run", "--unknown", "accept"],
  ["run", "--loglevel", "accept"],
  ["--", "run", "accept"],
  ["exec", "node", "acceptance.mjs"],
]) {
  test(`ambiguous package launcher rejects without execution: ${argv.join(" ")}`, () => {
    const project = acceptanceProject();
    try {
      project.command = project.config.command = ["npm", ...argv];
      writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts: { accept: `"${process.execPath}" acceptance.mjs` } }));
      writeFileSync(join(project.repo, "acceptance.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("executed", "bad");');
      stateFor(project);
      const observed = record(project);
      assert.equal(observed.status, 1, JSON.stringify(observed.report));
      assert.match(observed.report.error, /[Pp]ackage/);
      assert.equal(existsSync(join(project.repo, "executed")), false);
      assert.equal(observed.report.proof_path, undefined, "Rejected before launching a command.");
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

test("package lifecycle alias and pre/post entry points are bound", () => {
  const project = acceptanceProject();
  try {
    project.command = project.config.command = ["npm", "--silent", "test"];
    const scripts = { test: `"${process.execPath}" acceptance.mjs`, pretest: `"${process.execPath}" before.mjs`, posttest: `"${process.execPath}" after.mjs` };
    writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts }));
    writeFileSync(join(project.repo, "before.mjs"), "process.exit(0);");
    writeFileSync(join(project.repo, "after.mjs"), "process.exit(0);");
    stateFor(project);
    const observed = record(project); assert.equal(observed.status, 0, JSON.stringify(observed.report));
    const entries = JSON.parse(readFileSync(observed.report.proof_path)).binding.local_entry_points;
    assert.ok(entries.includes("before.mjs") && entries.includes("after.mjs"));
    finalize(project, observed); assert.equal(run(project.goal).report.can_stop, true);
    for (const path of ["before.mjs", "after.mjs"]) {
      writeFileSync(join(project.repo, path), "process.exit(1);");
      assert.equal(run(project.goal).report.can_stop, false);
      writeFileSync(join(project.repo, path), "process.exit(0);");
    }
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("implicit or absent package scripts require an explicit local validator", () => {
  const project = acceptanceProject();
  try {
    project.command = project.config.command = ["npm", "start"];
    writeFileSync(join(project.repo, "package.json"), "{}");
    writeFileSync(join(project.repo, "server.js"), 'require("fs").writeFileSync("executed", "bad");');
    stateFor(project);
    const observed = record(project);
    assert.equal(observed.status, 1);
    assert.match(observed.report.error, /explicitly declared/);
    assert.equal(existsSync(join(project.repo, "executed")), false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

for (const target of ["proof", "artifact"]) {
  test(`missing or symlinked ${target} cannot certify completion`, () => {
    const project = acceptanceProject();
    try {
      const observed = record(project);
      assert.equal(observed.status, 0);
      finalize(project, observed);
      const path = target === "proof" ? observed.report.proof_path : join(project.repo, "src/result.txt");
      const backup = join(project.repo, "preserved-evidence");
      const bytes = readFileSync(path);
      writeFileSync(backup, bytes); rmSync(path);
      assert.equal(run(project.goal).report.can_stop, false);
      symlinkSync(backup, path);
      assert.equal(run(project.goal).report.can_stop, false);
      assert.deepEqual(readFileSync(backup), bytes);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

test("stop checker never executes board commands and recorder requires explicit matching argv", () => {
  const project = acceptanceProject();
  try {
    project.config.command = [process.execPath, "-e", 'require("fs").writeFileSync("executed", "bad")'];
    stateFor(project);
    assert.equal(run(project.goal).report.can_stop, false);
    assert.equal(record(project).status, 1);
    assert.throws(() => readFileSync(join(project.repo, "executed")), /ENOENT/);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

for (const target of ["src/result.txt", "docs/goals/one/state.yaml"]) {
  test(`recorder rejects verification that mutates ${target}`, () => {
    const project = acceptanceProject();
    try {
      writeFileSync(join(project.repo, "acceptance.mjs"), `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(target)}, "\\n# changed\\n");`);
      const observed = record(project);
      assert.equal(observed.status, 1);
      assert.equal(JSON.parse(readFileSync(observed.report.proof_path)).result, "fail");
      assert.match(readFileSync(join(project.repo, target), "utf8"), /changed/);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

for (const field of ["missing_evidence", "remaining_blockers", "contradictions", "blocked_tasks"]) {
  test(`completion cannot override audit ${field}`, () => {
    const project = acceptanceProject();
    try { const observed = record(project); finalize(project, observed, { [field]: ["unresolved"] }); assert.equal(run(project.goal).report.can_stop, false); }
    finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

for (const [name, mutate] of [
  ["missing stdout", proof => { delete proof.stdout; }],
  ["missing stderr", proof => { delete proof.stderr; }],
  ["malformed output", proof => { proof.stdout.bytes = "unknown"; }],
  ["contradictory exit", proof => { proof.exit_status = 1; }],
  ["contradictory cleanup", proof => { proof.cleanup = { status: "unproven" }; }],
  ["future timestamp", proof => { proof.finished_at = new Date(Date.now() + 3600000).toISOString(); }],
  ["wrong command", proof => { proof.command = ["true"]; }],
  ["historical v1 proof", proof => { proof.version = 1; }],
]) {
  test(`completion rejects ${name} even if the audit hashes it`, () => {
    const project = acceptanceProject();
    try { const observed = record(project); changeProof(project, observed, mutate); assert.equal(run(project.goal).report.can_stop, false); }
    finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

test("earlier passing version-2 evidence without additive cleanup facts remains supported", () => {
  const project = acceptanceProject();
  try {
    const observed = record(project);
    assert.equal(observed.status, 0);
    changeProof(project, observed, proof => { delete proof.cleanup; });
    assert.equal(run(project.goal).report.can_stop, true);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

for (const key of ["result", "result ", "result\t"]) {
  test(`normalized duplicate YAML ${JSON.stringify(key)} is rejected`, () => {
    const project = acceptanceProject();
    try {
      edit(join(project.goal, "state.yaml"), "    result: unknown", `    ${key}: fail\n    result: unknown`);
      assert.equal(record(project).status, 1);
      assert.equal(run(project.goal).report.can_stop, false);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

test("duplicate JSON proof members are rejected after escape normalization", () => {
  const project = acceptanceProject();
  try {
    const observed = record(project);
    const bytes = readFileSync(observed.report.proof_path, "utf8").replace('"result": "pass"', '"\\u0072esult": "fail", "result": "pass"');
    writeFileSync(observed.report.proof_path, bytes);
    observed.report.audit_evidence.acceptance_sha256 = sha256(bytes);
    finalize(project, observed);
    assert.match(run(project.goal).report.errors.join(" "), /Duplicate JSON/);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("explicit freshness expiry is enforced without a universal one-day cap", () => {
  const project = acceptanceProject();
  try {
    project.config.max_age_seconds = 10 * 86400; stateFor(project);
    const observed = record(project);
    assert.equal(observed.status, 0);
    changeProof(project, observed, proof => { proof.started_at = "2020-01-01T00:00:00.000Z"; proof.finished_at = "2020-01-01T00:00:01.000Z"; });
    assert.match(run(project.goal).report.errors.join(" "), /stale/);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("configured timeout is observed and large ordinary logs do not fail successful checks", () => {
  const project = acceptanceProject({ timeout: 130 });
  try {
    writeFileSync(join(project.repo, "acceptance.mjs"), 'process.stdout.write("a".repeat(5 * 1024 * 1024)); process.stderr.write("b".repeat(5 * 1024 * 1024));');
    const observed = record(project);
    assert.equal(observed.status, 0, JSON.stringify(observed.report));
    const proof = JSON.parse(readFileSync(observed.report.proof_path));
    assert.equal(proof.timeout_seconds, 130);
    assert.equal(proof.stdout.bytes, 5 * 1024 * 1024);
    assert.equal(proof.stderr.truncated, true);
    assert.ok(readFileSync(observed.report.proof_path).length < 200000);
    finalize(project, observed);
    assert.equal(run(project.goal).report.can_stop, true);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("timeout failure preserves observed signal and cannot complete", () => {
  const project = acceptanceProject({ timeout: 0.05 });
  try {
    writeFileSync(join(project.repo, "acceptance.mjs"), 'setTimeout(() => {}, 2000);');
    const observed = record(project);
    assert.equal(observed.status, 1);
    const proof = JSON.parse(readFileSync(observed.report.proof_path));
    assert.equal(proof.timed_out, true);
    assert.match(proof.signal, /SIGTERM|SIGKILL/);
    finalize(project, observed);
    assert.equal(run(project.goal).report.can_stop, false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("timeout also terminates a package launcher's validator process group", { skip: process.platform === "win32" }, () => {
  const project = acceptanceProject({ timeout: 1 });
  try {
    project.command = project.config.command = ["npm", "run", "accept"];
    writeFileSync(join(project.repo, "package.json"), JSON.stringify({ scripts: { accept: `"${process.execPath}" acceptance.mjs` } }));
    writeFileSync(join(project.repo, "acceptance.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("started", "yes"); process.on("SIGTERM", () => {}); setTimeout(() => {}, 10000);');
    stateFor(project);
    const start = Date.now(), observed = record(project);
    assert.equal(observed.status, 1);
    assert.equal(readFileSync(join(project.repo, "started"), "utf8"), "yes");
    assert.ok(Date.now() - start < 6000, "Timeout must not await the launcher's surviving child.");
    assert.equal(JSON.parse(readFileSync(observed.report.proof_path)).timed_out, true);
    finalize(project, observed);
    assert.equal(run(project.goal).report.can_stop, false);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

for (const stdio of ["ignore", "inherit"]) {
  test(`R2 timeout cleans same-group ${stdio} descendants before returning`, { skip: process.platform === "win32" }, async () => {
    const project = acceptanceProject({ timeout: 0.4, inputs: ["child.mjs"] });
    try {
      writeFileSync(join(project.repo, "child.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("child.pid", String(process.pid)); process.on("SIGTERM", () => {}); setTimeout(() => writeFileSync("alive-after-grace", "yes"), 2200); setTimeout(() => process.exit(0), 5000);');
      writeFileSync(join(project.repo, "acceptance.mjs"), `import { spawn } from "node:child_process"; spawn(process.execPath, ["child.mjs"], { stdio: "${stdio}" }); setTimeout(() => {}, 10000);`);
      const started = Date.now(), observed = record(project), elapsed = Date.now() - started;
      assert.equal(observed.status, 1);
      assert.ok(existsSync(join(project.repo, "child.pid")), "The descendant actually started.");
      await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, started + 2800 - Date.now())));
      assert.equal(existsSync(join(project.repo, "alive-after-grace")), false, "The child survived timeout escalation.");
      assert.ok(elapsed >= 1400 && elapsed < 5000, `Cleanup must outlive direct-child close but remain bounded: ${elapsed}ms`);
      const proof = JSON.parse(readFileSync(observed.report.proof_path));
      assert.equal(proof.timed_out, true);
      assert.equal(proof.cleanup.status, "complete");
      finalize(project, observed);
      assert.equal(run(project.goal).report.can_stop, false);
    } finally {
      // Only the PID written by this fixture is eligible for fallback cleanup.
      const pidPath = join(project.repo, "child.pid");
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, "utf8"));
        if (Number.isSafeInteger(pid) && pid > 1) try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      rmSync(project.repo, { recursive: true, force: true });
    }
  });
}

test("failed cleanup inspection remains explicitly unproven and bounded", () => {
  const project = acceptanceProject({ timeout: 0.05, inputs: ["probe-denied.mjs"] });
  try {
    const preload = join(project.repo, "probe-denied.mjs");
    writeFileSync(preload, 'const kill = process.kill; process.kill = (pid, signal) => { if (signal === 0) { const error = new Error("fixture probe denied"); error.code = "EPERM"; throw error; } return kill.call(process, pid, signal); };');
    writeFileSync(join(project.repo, "acceptance.mjs"), 'setTimeout(() => {}, 10000);');
    const start = Date.now(), observed = record(project, { NODE_OPTIONS: `--import=${preload}` });
    assert.equal(observed.status, 1);
    assert.ok(Date.now() - start < 5000);
    assert.equal(observed.report.cleanup.status, "unproven");
    assert.match(observed.report.error, /Cleanup unproven: fixture probe denied/);
    assert.equal(JSON.parse(readFileSync(observed.report.proof_path)).timed_out, true);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

test("explicit non-Git artifact workspaces can earn current acceptance", () => {
  const project = acceptanceProject();
  try {
    rmSync(join(project.repo, ".git"), { recursive: true });
    project.config.workspace = "../../.."; stateFor(project);
    const observed = record(project);
    assert.equal(observed.status, 0, JSON.stringify(observed.report));
    finalize(project, observed);
    assert.equal(run(project.goal).report.can_stop, true);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});

for (const phase of ["record", "stop"]) {
  test(`concurrent board mutation during ${phase} context read never reports success`, () => {
    const project = acceptanceProject();
    try {
      if (phase === "stop") { const observed = record(project); assert.equal(observed.status, 0); finalize(project, observed); }
      const bin = join(project.repo, "fake-bin"); mkdirSync(bin);
      const realGit = spawnSync("command", ["-v", "git"], { encoding: "utf8", shell: true }).stdout.trim();
      const replacement = join(project.repo, "active.yaml"); writeFileSync(replacement, activeState);
      writeFileSync(join(bin, "git"), `#!/bin/sh\ncp '${replacement}' '${join(project.goal, "state.yaml")}'\nexec '${realGit}' "$@"\n`); chmodSync(join(bin, "git"), 0o755);
      const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
      const result = phase === "record" ? record(project, env) : (() => { const run = spawnSync(process.execPath, [script, project.goal, "--json"], { cwd: project.repo, encoding: "utf8", env }); return { status: run.status, report: JSON.parse(run.stdout) }; })();
      assert.equal(result.status, 1, JSON.stringify(result.report));
      assert.notEqual(result.report.can_stop, true);
      assert.match(readFileSync(join(project.goal, "state.yaml"), "utf8"), /title: "Keep going"/);
    } finally { rmSync(project.repo, { recursive: true, force: true }); }
  });
}

test("authorized long verification can finish beyond the old 120-second ceiling", { skip: process.env.GOALBUDDY_LONG_CHECK !== "1" }, () => {
  const project = acceptanceProject({ timeout: 130 }); project.outerTimeout = 135000;
  try {
    writeFileSync(join(project.repo, "acceptance.mjs"), "setTimeout(() => process.exit(0), 121000);\n");
    const observed = record(project);
    assert.equal(observed.status, 0, JSON.stringify(observed.report));
    finalize(project, observed);
    assert.equal(run(project.goal).report.can_stop, true);
  } finally { rmSync(project.repo, { recursive: true, force: true }); }
});
