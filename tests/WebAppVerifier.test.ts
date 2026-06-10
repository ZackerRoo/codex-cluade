import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { verifyWebApp } from "../src/verification/WebAppVerifier.js";

describe("WebAppVerifier", () => {
  it("fails when a scripted web app leaves required containers empty after boot", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-web-verify-empty-"));
    await writeFile(join(workspace, "index.html"), [
      "<!doctype html>",
      "<html><body>",
      "<div id=\"map\"></div>",
      "<div id=\"action-grid\"></div>",
      "<script src=\"app.js\" defer></script>",
      "</body></html>"
    ].join("\n"), "utf8");
    await writeFile(join(workspace, "app.js"), "function render() { document.getElementById('map').appendChild(document.createElement('div')); }\n", "utf8");

    const result = await verifyWebApp({
      workspace,
      expectations: [
        { selector: "#map > *", minCount: 1 },
        { selector: "#action-grid button", minCount: 1 }
      ]
    });

    assert.equal(result.ok, false);
    assert.match(result.failures.join("\n"), /#map > \*/);
    assert.match(result.failures.join("\n"), /#action-grid button/);
  });

  it("passes when DOMContentLoaded boot renders required game UI", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-web-verify-pass-"));
    await writeFile(join(workspace, "index.html"), [
      "<!doctype html>",
      "<html><body>",
      "<div id=\"map\"></div>",
      "<div id=\"action-grid\"></div>",
      "<script src=\"app.js\" defer></script>",
      "</body></html>"
    ].join("\n"), "utf8");
    await writeFile(join(workspace, "app.js"), [
      "document.addEventListener('DOMContentLoaded', () => {",
      "  document.getElementById('map').appendChild(document.createElement('div'));",
      "  const button = document.createElement('button');",
      "  button.textContent = 'Explore';",
      "  document.getElementById('action-grid').appendChild(button);",
      "});"
    ].join("\n"), "utf8");

    const result = await verifyWebApp({
      workspace,
      expectations: [
        { selector: "#map > *", minCount: 1 },
        { selector: "#action-grid button", minCount: 1 }
      ]
    });

    assert.equal(result.ok, true);
  });
});
