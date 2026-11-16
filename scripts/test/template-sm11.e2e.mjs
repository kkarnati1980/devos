// S3-c5 (DEVOS-94, docs/modules/S3.md): SM-11 applied alone gives an app whose real-browser main-journey test
// passes in Chromium at both widths and stores a screenshot per width and the e2e report. Runs in the
// dashboard-e2e workflow, the one job that has Chromium; it borrows the dashboard's pinned playwright package.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../template/apply.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devos-sm11-")); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("SM-11-L1: the generated app's main journey passes in Chromium at 1440×900 and 390×844, with screenshots and report", () => {
  const out = path.join(tmp, "app");
  const r = apply({ out, select: ["SM-11"], sha: "a".repeat(40) });
  assert.equal(r.code, 0, r.error);
  // The generated app resolves "playwright" from its own node_modules; link the dashboard's pinned copy there.
  const pkg = createRequire(path.join(ROOT, "apps/dashboard/package.json")).resolve("playwright/package.json");
  fs.mkdirSync(path.join(out, "node_modules"), { recursive: true });
  fs.symlinkSync(fs.realpathSync(path.dirname(pkg)), path.join(out, "node_modules/playwright"), "dir");
  const report = path.join(tmp, "e2e-report");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
  const run = spawnSync(process.execPath, ["--test", "test/e2e/main-journey.e2e.mjs"], { cwd: out, encoding: "utf8", timeout: 120_000, env: { ...env, E2E_REPORT_DIR: report } });
  assert.equal(run.status, 0, `${run.stdout.slice(-3000)}${run.stderr.slice(-1500)}`);
  const rep = JSON.parse(fs.readFileSync(path.join(report, "main-journey-report.json"), "utf8"));
  assert.equal(rep.check, "SM-11-L1");
  assert.equal(rep.ok, true);
  assert.deepEqual(rep.results.map((x) => [x.viewport, x.width, x.height, x.ok]), [["desktop", 1440, 900, true], ["phone", 390, 844, true]]);
  for (const f of ["main-journey-desktop.png", "main-journey-phone.png"]) {
    const png = fs.readFileSync(path.join(report, f));
    assert.ok(png.length > 1000 && png.subarray(1, 4).toString() === "PNG", `${f} is a real PNG`);
  }
});
