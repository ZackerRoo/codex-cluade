import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseNpmPackFiles, validateReleasePack } from "../src/install/ReleaseCheck.js";

describe("release check", () => {
  it("validates packed files and executable bin entrypoints", () => {
    const result = validateReleasePack({
      packageJson: {
        files: ["dist/src", "README.md"],
        bin: {
          "claude-agent-bridge": "dist/src/cli.js",
          "claude-agent-bridge-mcp": "dist/src/mcpServer.js",
          "claude-agent-bridge-dashboard": "dist/src/dashboardCli.js"
        }
      },
      packedFiles: [
        "package.json",
        "README.md",
        "dist/src/cli.js",
        "dist/src/mcpServer.js",
        "dist/src/dashboardCli.js",
        "dist/src/install/ReleaseCheck.js"
      ],
      binContents: {
        "dist/src/cli.js": "#!/usr/bin/env node\nconsole.log('cli')",
        "dist/src/mcpServer.js": "#!/usr/bin/env node\nconsole.log('mcp')",
        "dist/src/dashboardCli.js": "#!/usr/bin/env node\nconsole.log('dashboard')"
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.checks.every((check: { ok: boolean }) => check.ok), true);
  });

  it("reports missing package files and invalid bin entrypoints", () => {
    const result = validateReleasePack({
      packageJson: {
        files: ["dist/src"],
        bin: {
          "claude-agent-bridge": "dist/src/cli.js",
          "claude-agent-bridge-dashboard": "dist/src/dashboardCli.js"
        }
      },
      packedFiles: ["package.json", "dist/src/cli.js"],
      binContents: {
        "dist/src/cli.js": "console.log('missing shebang')"
      }
    });

    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check: { name: string; ok: boolean }) => check.name === "README.md" && !check.ok));
    assert.ok(result.checks.some((check: { name: string; ok: boolean }) => check.name === "bin:claude-agent-bridge-dashboard" && !check.ok));
    assert.ok(result.checks.some((check: { name: string; ok: boolean }) => check.name === "bin-shebang:claude-agent-bridge" && !check.ok));
  });

  it("parses npm pack dry-run JSON output", () => {
    const files = parseNpmPackFiles(JSON.stringify([
      {
        filename: "codex-claude-agent-bridge-0.1.0.tgz",
        files: [
          { path: "package.json" },
          { path: "README.md" },
          { path: "dist/src/cli.js" }
        ]
      }
    ]));

    assert.deepEqual(files, ["package.json", "README.md", "dist/src/cli.js"]);
  });
});
