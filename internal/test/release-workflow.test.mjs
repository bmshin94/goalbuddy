import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const workflow = readFileSync(".github/workflows/npm-publish.yml", "utf8");

test("npm publishing is release-only and bound to the package version", () => {
  assert.match(workflow, /release:\s*\n\s+types: \[published\]/);
  assert.doesNotMatch(workflow, /workflow_dispatch:/);
  assert.match(workflow, /RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.match(workflow, /expected_tag="v\$package_version"/);
  assert.match(workflow, /if \[ "\$RELEASE_TAG" != "\$expected_tag" \]/);
});

test("npm publishing uses OIDC and a trusted-publishing-capable npm", () => {
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /node-version: "24"/);
  assert.match(workflow, /npm install --global npm@11\.18\.0/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
});

test("npm publishing checks packaged content against the exact release tag", () => {
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /check-package-identity\.mjs --package \. --git-ref "\$RELEASE_TAG"/);
  assert.match(workflow, /check-package-identity\.mjs --package "goalbuddy@\$package_version" --git-ref "\$RELEASE_TAG"/);
  assert.match(workflow, /for attempt in 1 2 3 4 5/);
});
