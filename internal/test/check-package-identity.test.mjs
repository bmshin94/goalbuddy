import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const script = resolve("internal/cli/check-package-identity.mjs");

test("package identity compares extracted file lists and SHA-256 hashes", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-identity-test-"));
  try {
    writePackage(root, "tag content\n");
    git(root, "init");
    git(root, "add", "package.json", "payload.txt");
    git(root, "-c", "user.name=GoalBuddy Tests", "-c", "user.email=tests@example.invalid", "commit", "-m", "fixture");
    git(root, "tag", "v1.0.0");

    const registry = join(root, "registry");
    mkdirSync(registry);
    writePackage(registry, "tag content\n");
    const matching = check(root, registry);
    assert.equal(matching.status, 0, matching.stderr || matching.stdout);
    assert.equal(JSON.parse(matching.stdout).ok, true);

    writeFileSync(join(registry, "payload.txt"), "different registry content\n");
    const mismatching = check(root, registry);
    assert.equal(mismatching.status, 1, mismatching.stderr || mismatching.stdout);
    const report = JSON.parse(mismatching.stdout);
    assert.equal(report.ok, false);
    assert.deepEqual(report.only_in_package, []);
    assert.deepEqual(report.only_in_tag, []);
    assert.equal(report.changed[0].path, "payload.txt");
    assert.match(report.changed[0].package_sha256, /^[a-f0-9]{64}$/);
    assert.match(report.changed[0].tag_sha256, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tarball manifest records every packaged file hash", () => {
  const root = mkdtempSync(join(tmpdir(), "goalbuddy-manifest-test-"));
  try {
    writePackage(root, "candidate\n");
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: root, encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = join(root, JSON.parse(packed.stdout)[0].filename);
    const manifest = join(root, "manifest.json");
    const result = spawnSync(process.execPath, [script, "--tarball", tarball, "--manifest", manifest], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const written = JSON.parse(readFileSync(manifest, "utf8"));
    assert.equal(written.algorithm, "sha256");
    assert.deepEqual(written.files.map((file) => file.path), ["package.json", "payload.txt"]);
    assert.ok(written.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function check(cwd, packageDir) {
  return spawnSync(process.execPath, [script, "--package", packageDir, "--git-ref", "v1.0.0"], { cwd, encoding: "utf8" });
}

function writePackage(root, payload) {
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "identity-fixture", version: "1.0.0", files: ["payload.txt"] }, null, 2)}\n`);
  writeFileSync(join(root, "payload.txt"), payload);
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
