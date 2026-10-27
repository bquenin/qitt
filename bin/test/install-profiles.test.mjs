import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const installer = join(dirname(fileURLToPath(import.meta.url)), "..", "install-profiles");
const tmp = mkdtempSync(join(tmpdir(), "qitt-install-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

// HOME points into the temp dir too, so the default context path can never be the real one.
function install(name, env = {}) {
  const dest = join(tmp, name);
  const res = spawnSync("bash", [installer], {
    env: { PATH: process.env.PATH, HOME: join(tmp, `${name}-home`), QITT_PROJECTS_DIR: dest, ...env },
    encoding: "utf8",
  });
  return { dest, ...res };
}

describe("install-profiles local context", () => {
  it("copies the context into each profile and keeps the import", () => {
    const context = join(tmp, "context.md");
    writeFileSync(context, "# ctx\n\n- First name: Ada\n");
    const { dest, status, stderr } = install("present", { QITT_CONTEXT: context });
    assert.equal(status, 0, stderr);
    for (const profile of ["qitt", "worker"]) {
      const copy = join(dest, profile, "context.local.md");
      assert.equal(readFileSync(copy, "utf8"), "# ctx\n\n- First name: Ada\n");
      assert.equal(statSync(copy).mode & 0o777, 0o600);
      assert.match(readFileSync(join(dest, profile, "CLAUDE.md"), "utf8"), /^@context\.local\.md$/m);
    }
  });

  it("warns, drops the import, and removes a stale copy when the context is missing", () => {
    const context = join(tmp, "later.md");
    writeFileSync(context, "old\n");
    assert.equal(install("missing", { QITT_CONTEXT: context }).status, 0);
    rmSync(context);
    const { dest, status, stderr } = install("missing");
    assert.equal(status, 0, stderr);
    assert.match(stderr, /warning: .*context\.md is missing/);
    for (const profile of ["qitt", "worker"]) {
      assert.equal(existsSync(join(dest, profile, "context.local.md")), false);
      const charter = readFileSync(join(dest, profile, "CLAUDE.md"), "utf8");
      assert.doesNotMatch(charter, /^@/m);
      assert.match(charter, /^## Local context$/m);
    }
  });

  it("fails when QITT_CONTEXT names a missing file", () => {
    const { status, stderr } = install("bad", { QITT_CONTEXT: join(tmp, "nope.md") });
    assert.equal(status, 1);
    assert.match(stderr, /QITT_CONTEXT=.* is not a file/);
  });
});
