import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const cli = resolve("internal/cli/goal-maker.mjs");
const packageRoot = resolve(".");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

function run(args, env) {
  const result = spawnSync(process.execPath, [cli, ...args, "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: result.stdout ? JSON.parse(result.stdout) : null };
}

function runHuman(args, env) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeExecutable(path, lines) {
  writeFileSync(path, `${lines.join("\n")}\n`);
  chmodSync(path, 0o755);
}

function isolatedPath(root, kind) {
  const bin = join(root, `bin-${kind}`);
  mkdirSync(bin, { recursive: true });
  return bin;
}

function missingCliEnv(root, name) {
  const bin = isolatedPath(root, `missing-${name}`);
  writeExecutable(join(bin, name), ["#!/bin/sh", "exit 127"]);
  return { PATH: `${bin}${delimiter}${process.env.PATH}` };
}

function nativeCodexEnv(root) {
  const bin = isolatedPath(root, "codex");
  const pluginSource = join(packageRoot, "plugins", "goalbuddy");
  writeExecutable(join(bin, "codex"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 'codex-cli test'; exit 0; fi",
    "if [ \"$1\" = \"plugin\" ] && [ \"$2\" = \"marketplace\" ]; then exit 0; fi",
    "if [ \"$1\" = \"plugin\" ] && [ \"$2\" = \"add\" ]; then",
    `  target="$CODEX_HOME/plugins/cache/goalbuddy/goalbuddy/${version}"`,
    "  mkdir -p \"$(dirname \"$target\")\"",
    `  cp -R ${JSON.stringify(`${pluginSource}/.`)} "$target"`,
    "  printf '[plugins.\"goalbuddy@goalbuddy\"]\\nenabled = true\\n' > \"$CODEX_HOME/config.toml\"",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"login\" ]; then echo 'Logged in'; exit 0; fi",
    "if [ \"$1\" = \"features\" ]; then echo 'goals  test  true'; exit 0; fi",
    "exit 2",
  ]);
  return { PATH: `${bin}${delimiter}${process.env.PATH}` };
}

function nativeClaudeEnv(root) {
  const bin = isolatedPath(root, "claude");
  const pluginSource = join(packageRoot, "plugins", "goalbuddy");
  writeExecutable(join(bin, "claude"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 'Claude Code test'; exit 0; fi",
    "if [ \"$1\" = \"plugin\" ] && [ \"$2\" = \"marketplace\" ] && [ \"$3\" = \"remove\" ]; then printf '{}\\n' > \"$CLAUDE_CONFIG_DIR/plugins/known_marketplaces.json\"; exit 0; fi",
    "if [ \"$1\" = \"plugin\" ] && [ \"$2\" = \"marketplace\" ]; then mkdir -p \"$CLAUDE_CONFIG_DIR/plugins\"; exit 0; fi",
    "if [ \"$1\" = \"plugin\" ] && { [ \"$2\" = \"install\" ] || [ \"$2\" = \"update\" ]; }; then",
    `  target="$CLAUDE_CONFIG_DIR/plugins/cache/goalbuddy/goalbuddy/${version}"`,
    "  mkdir -p \"$(dirname \"$target\")\"",
    `  cp -R ${JSON.stringify(`${pluginSource}/.`)} "$target"`,
    `  printf '{"plugins":{"goalbuddy@goalbuddy":[{"scope":"user","installPath":"%s","version":"${version}"}]}}\\n' "$target" > "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json"`,
    "  exit 0",
    "fi",
    `if [ \"$1\" = \"plugin\" ] && [ \"$2\" = \"uninstall\" ]; then rm -rf "$CLAUDE_CONFIG_DIR/plugins/cache/goalbuddy/goalbuddy/${version}"; printf '{\"plugins\":{}}\\n' > \"$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json\"; exit 0; fi`,
    "exit 2",
  ]);
  return { PATH: `${bin}${delimiter}${process.env.PATH}` };
}

function assertResult(result, { action, target, model, ok = true }) {
  assert.equal(result.ok, ok);
  assert.equal(result.action, action);
  assert.equal(result.target, target);
  assert.equal(result.install_model, model);
  assert.equal(result.requested_version, version);
  assert.equal(result.proof.checks.every((check) => check.ok), ok);
  assert.equal(typeof result.fallback.used, "boolean");
  assert.ok(Object.hasOwn(result, "error"));
  assert.ok(Array.isArray(result.warnings));
}

test("Codex native lifecycle proves install, update, doctor, reset, and removed state", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-codex-native-"));
  try {
    const home = join(root, "codex");
    const env = nativeCodexEnv(root);
    for (const action of ["install", "update"]) {
      const response = run([action, "--target", "codex", "--codex-home", home, "--source", packageRoot], env);
      assert.equal(response.status, 0, response.stderr || response.stdout);
      assertResult(response.json.result, { action, target: "codex", model: "codex-cli" });
    }
    const doctor = run(["doctor", "--target", "codex", "--codex-home", home], env);
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    assertResult(doctor.json.result, { action: "doctor", target: "codex", model: "codex-cli" });
    const reset = run(["reset", "--target", "codex", "--codex-home", home], env);
    assert.equal(reset.status, 0, reset.stderr || reset.stdout);
    assertResult(reset.json.result, { action: "reset", target: "codex", model: "none" });
    assert.equal(run(["doctor", "--target", "codex", "--codex-home", home], env).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex missing CLI uses and proves the atomic bundled-copy lifecycle", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-codex-copy-"));
  try {
    const home = join(root, "codex");
    const env = missingCliEnv(root, "codex");
    for (const action of ["install", "update"]) {
      const response = run([action, "--target", "codex", "--codex-home", home], env);
      assert.equal(response.status, 0, response.stderr || response.stdout);
      assertResult(response.json.result, { action, target: "codex", model: "bundled-copy" });
      assert.equal(response.json.result.fallback.used, true);
    }
    assert.equal(run(["doctor", "--target", "codex", "--codex-home", home], env).status, 0);
    assert.equal(run(["reset", "--target", "codex", "--codex-home", home], env).status, 0);
    assert.equal(run(["doctor", "--target", "codex", "--codex-home", home], env).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude native plugin lifecycle is exact and repeatable", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-claude-native-"));
  try {
    const home = join(root, "claude");
    const env = nativeClaudeEnv(root);
    for (const action of ["install", "update"]) {
      const response = run([action, "--target", "claude", "--claude-home", home, "--source", packageRoot], env);
      assert.equal(response.status, 0, response.stderr || response.stdout);
      assertResult(response.json.result, { action, target: "claude", model: "claude-cli" });
    }
    const doctor = run(["doctor", "--target", "claude", "--claude-home", home], env);
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    assertResult(doctor.json.result, { action: "doctor", target: "claude", model: "claude-cli" });
    const reset = run(["reset", "--target", "claude", "--claude-home", home], env);
    assert.equal(reset.status, 0, reset.stderr || reset.stdout);
    assertResult(reset.json.result, { action: "reset", target: "claude", model: "none" });
    assert.equal(run(["doctor", "--target", "claude", "--claude-home", home], env).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude missing CLI retains the loose-file lifecycle and ownership-safe reset", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-claude-loose-"));
  try {
    const home = join(root, "claude");
    const env = missingCliEnv(root, "claude");
    for (const action of ["install", "update"]) {
      const response = run([action, "--target", "claude", "--claude-home", home], env);
      assert.equal(response.status, 0, response.stderr || response.stdout);
      assertResult(response.json.result, { action, target: "claude", model: "loose-files" });
      if (action === "install") assert.equal(response.json.result.fallback.used, true);
    }
    assert.equal(run(["doctor", "--target", "claude", "--claude-home", home], env).status, 0);
    assert.equal(run(["reset", "--target", "claude", "--claude-home", home], env).status, 0);
    assert.equal(run(["doctor", "--target", "claude", "--claude-home", home], env).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-directory Codex and Claude homes fail with the shared result contract", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-invalid-home-"));
  try {
    const file = join(root, "not-a-directory");
    writeFileSync(file, "user data\n");
    const codex = run(["install", "--target", "codex", "--codex-home", file], missingCliEnv(root, "codex"));
    assert.equal(codex.status, 1);
    assertResult(codex.json.result, { action: "install", target: "codex", model: "none", ok: false });
    const claude = run(["install", "--target", "claude", "--claude-home", file], missingCliEnv(root, "claude"));
    assert.equal(claude.status, 1);
    assertResult(claude.json.result, { action: "install", target: "claude", model: "none", ok: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aggregate failed targets never receive human success or next-step copy", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-aggregate-copy-"));
  try {
    const invalidCodex = join(root, "codex-file");
    const invalidClaude = join(root, "claude-file");
    writeFileSync(invalidCodex, "user data\n");
    writeFileSync(invalidClaude, "user data\n");
    for (const action of ["install", "update"]) {
      const args = [action, "--codex-home", invalidCodex, "--claude-home", invalidClaude];
      const human = runHuman(args, {});
      assert.equal(human.status, 1, human.stderr || human.stdout);
      assert.match(human.stdout, /Codex: not completed/);
      assert.match(human.stdout, /Claude Code: not completed/);
      assert.doesNotMatch(human.stdout, /\b(?:enabled|installed|updated|restart)\b/i);
      assert.doesNotMatch(human.stdout, /then (?:use|run):/i);
      assert.doesNotMatch(human.stdout, /^Next:$/m);

      const json = run(args, {});
      assert.equal(json.status, 1, json.stderr || json.stdout);
      assert.equal(json.json.ok, false);
      for (const target of [json.json.codex, json.json.claude]) {
        assert.equal(target.result.ok, false);
        assert.equal(typeof target.result.error.code, "string");
        assert.equal(typeof target.result.error.message, "string");
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude mixed state is rejected without deleting either model", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-claude-conflict-"));
  try {
    const home = join(root, "claude");
    const loose = run(["install", "--target", "claude", "--claude-home", home], missingCliEnv(root, "claude"));
    assert.equal(loose.status, 0, loose.stderr || loose.stdout);
    const plugins = join(home, "plugins");
    mkdirSync(plugins, { recursive: true });
    writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({ plugins: { "goalbuddy@goalbuddy": [{ scope: "user", installPath: join(root, "missing-plugin"), version }] } }));
    const conflict = run(["update", "--target", "claude", "--claude-home", home], nativeClaudeEnv(root));
    assert.equal(conflict.status, 1);
    assert.equal(conflict.json.result.install_model, "conflict");
    assert.equal(conflict.json.result.error.code, "MIXED_INSTALL_STATE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude zero-exit native install without state falls back only after absence proof", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-claude-unproven-"));
  try {
    const bin = isolatedPath(root, "claude-zero");
    writeExecutable(join(bin, "claude"), ["#!/bin/sh", "exit 0"]);
    const home = join(root, "claude");
    const response = run(["install", "--target", "claude", "--claude-home", home], { PATH: `${bin}${delimiter}${process.env.PATH}` });
    assert.equal(response.status, 0, response.stderr || response.stdout);
    assertResult(response.json.result, { action: "install", target: "claude", model: "loose-files" });
    assert.equal(response.json.result.fallback.used, true);
    assert.match(response.json.result.fallback.reason, /not proven/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude loose reset preserves every file when one file is modified", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-claude-preserve-"));
  try {
    const home = join(root, "claude");
    const env = missingCliEnv(root, "claude");
    assert.equal(run(["install", "--target", "claude", "--claude-home", home], env).status, 0);
    const modified = join(home, "agents", "goal-worker.md");
    writeFileSync(modified, "user changes\n");
    const reset = run(["reset", "--target", "claude", "--claude-home", home], env);
    assert.equal(reset.status, 1);
    assert.equal(reset.json.result.error.code, "UNOWNED_FILE");
    assert.equal(readFileSync(modified, "utf8"), "user changes\n");
    assert.match(readFileSync(join(home, "skills", "goal-prep", "SKILL.md"), "utf8"), /name: goal-prep/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
