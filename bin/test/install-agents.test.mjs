import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const installer = join(dirname(fileURLToPath(import.meta.url)), "..", "install-agents");
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

describe("install-agents local context", () => {
  it("writes the context into each AGENTS.md, private, with nothing to import", () => {
    const context = join(tmp, "context.md");
    writeFileSync(context, "# ctx\n\n- First name: Ada");
    const { dest, status, stderr } = install("present", { QITT_CONTEXT: context });
    assert.equal(status, 0, stderr);
    for (const agent of ["qitt", "worker"]) {
      const file = join(dest, agent, "AGENTS.md");
      const charter = readFileSync(file, "utf8");
      assert.ok(charter.endsWith("## Local context\n\n# ctx\n\n- First name: Ada\n"), charter.slice(-80));
      assert.doesNotMatch(charter, /qitt:context|^@/m);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(join(dest, agent)).sort(), [".claude", "AGENTS.md"]);
    }
  });

  it("warns and leaves the section empty when the context is missing", () => {
    const { dest, status, stderr } = install("missing");
    assert.equal(status, 0, stderr);
    assert.match(stderr, /warning: .*context\.md is missing/);
    for (const agent of ["qitt", "worker"]) {
      const charter = readFileSync(join(dest, agent, "AGENTS.md"), "utf8");
      assert.ok(charter.endsWith("## Local context\n\n"), charter.slice(-80));
      assert.doesNotMatch(charter, /qitt:context|^@/m);
    }
  });

  it("removes the CLAUDE.md and context copy an earlier version installed", () => {
    const dest = join(tmp, "upgrade");
    for (const agent of ["qitt", "worker"]) {
      mkdirSync(join(dest, agent), { recursive: true });
      writeFileSync(join(dest, agent, "CLAUDE.md"), "old charter\n");
      writeFileSync(join(dest, agent, "context.local.md"), "old context\n");
    }
    const { status, stderr } = install("upgrade");
    assert.equal(status, 0, stderr);
    for (const agent of ["qitt", "worker"]) {
      assert.deepEqual(readdirSync(join(dest, agent)).sort(), [".claude", "AGENTS.md"]);
    }
  });

  it("stops, leaving the installed charter alone, when the context cannot be read", () => {
    const context = join(tmp, "locked.md");
    writeFileSync(context, "- First name: Ada\n");
    const first = install("locked", { QITT_CONTEXT: context });
    assert.equal(first.status, 0, first.stderr);
    const before = readFileSync(join(first.dest, "qitt", "AGENTS.md"), "utf8");
    chmodSync(context, 0o000);
    const { dest, status, stderr } = install("locked", { QITT_CONTEXT: context });
    chmodSync(context, 0o600);
    assert.equal(status, 1);
    assert.match(stderr, /locked\.md cannot be read/);
    assert.equal(readFileSync(join(dest, "qitt", "AGENTS.md"), "utf8"), before);
  });

  it("fails when QITT_CONTEXT names a missing file", () => {
    const { status, stderr } = install("bad", { QITT_CONTEXT: join(tmp, "nope.md") });
    assert.equal(status, 1);
    assert.match(stderr, /QITT_CONTEXT=.* is not a file/);
  });
});

describe("install-agents sources", () => {
  const charter = (dest, agent) => readFileSync(join(dest, agent, "AGENTS.md"), "utf8");
  const settings = (dest, agent) => JSON.parse(readFileSync(join(dest, agent, ".claude", "settings.json"), "utf8"));
  const deny = (dest, agent) => settings(dest, agent).permissions.deny;
  const slackDeny = (server) => [`mcp__${server}__slack_send_message`, `mcp__${server}__slack_schedule_message`];

  it("installs slack and jira by default: their sections in each charter, their deny entries", () => {
    const { dest, status, stderr } = install("default");
    assert.equal(status, 0, stderr);
    for (const agent of ["qitt", "worker"]) {
      const text = charter(dest, agent);
      assert.doesNotMatch(text, /qitt:sources/);
      assert.match(text, /^## Sources$[\s\S]*^### Slack$[\s\S]*^### JIRA$[\s\S]*^## Local context$/m);
      assert.deepEqual(deny(dest, agent), slackDeny("slack-cli"));
    }
    assert.equal(settings(dest, "qitt").autoCompactWindow, 150000);
  });

  it("installs only the sources QITT_SOURCES names, and renames the Slack MCP server", () => {
    const jira = install("jira-only", { QITT_SOURCES: "jira" });
    assert.equal(jira.status, 0, jira.stderr);
    assert.doesNotMatch(charter(jira.dest, "qitt"), /^### Slack$/m);
    assert.deepEqual(deny(jira.dest, "worker"), []);
    const renamed = install("renamed", { QITT_SOURCES: "slack,slack", QITT_SLACK_MCP_SERVER: "my-slack" });
    assert.equal(renamed.status, 0, renamed.stderr);
    assert.equal(charter(renamed.dest, "qitt").match(/^### Slack$/gm).length, 1);
    assert.deepEqual(deny(renamed.dest, "qitt"), slackDeny("my-slack"));
  });

  it("reads sources.txt and installs a source of my own from ~/.config/qitt/sources/", () => {
    const config = join(tmp, "own-home", ".config", "qitt");
    const source = join(config, "sources", "teams");
    mkdirSync(join(source, "skills", "teams"), { recursive: true });
    writeFileSync(join(config, "sources.txt"), "# mine\njira\nteams  # chat\n");
    writeFileSync(join(source, "qitt.md"), "### Teams\n\nTeams rules.\n");
    writeFileSync(join(source, "deny.txt"), "# never send\nmcp__teams__send_message\n");
    writeFileSync(join(source, "skills", "teams", "SKILL.md"), "teams skill\n");
    const { dest, status, stderr } = install("own");
    assert.equal(status, 0, stderr);
    assert.match(charter(dest, "qitt"), /^### JIRA$[\s\S]*^### Teams\n\nTeams rules\.\n\n## Local context$/m);
    assert.doesNotMatch(charter(dest, "qitt"), /^### Slack$/m);
    // No worker.md in the source: the worker charter gets nothing from it, the deny list still applies.
    assert.doesNotMatch(charter(dest, "worker"), /Teams/);
    assert.deepEqual(deny(dest, "worker"), ["mcp__teams__send_message"]);
    for (const skill of ["teams", "google-docs"]) {
      assert.ok(existsSync(join(dest, "qitt", ".claude", "skills", skill, "SKILL.md")), skill);
    }
  });

  it("fails before writing anything when a source's skill has the name of another skill", () => {
    const source = join(tmp, "clash-home", ".config", "qitt", "sources", "teams");
    mkdirSync(join(source, "skills", "google-docs"), { recursive: true });
    writeFileSync(join(source, "qitt.md"), "### Teams\n");
    writeFileSync(join(source, "skills", "google-docs", "SKILL.md"), "mine\n");
    const { dest, status, stderr } = install("clash", { QITT_SOURCES: "teams" });
    assert.equal(status, 1);
    assert.match(stderr, /skill 'google-docs' is in both .*\/skills and .*\/sources\/teams\/skills/);
    assert.equal(existsSync(dest), false);
  });

  it("writes that no source is installed when the list is empty", () => {
    const { dest, status, stderr } = install("none", { QITT_SOURCES: "" });
    assert.equal(status, 0, stderr);
    assert.match(charter(dest, "qitt"), /^No source is installed\.$/m);
    assert.deepEqual(deny(dest, "qitt"), []);
  });

  it("fails on a bad name, a source it cannot find, and a source without qitt.md", () => {
    assert.match(install("bad-name", { QITT_SOURCES: "../etc" }).stderr, /source name '\.\.\/etc' must be/);
    const unknown = install("unknown", { QITT_SOURCES: "teams" });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /source 'teams' is in neither/);
    mkdirSync(join(tmp, "empty-home", ".config", "qitt", "sources", "teams"), { recursive: true });
    const empty = install("empty", { QITT_SOURCES: "teams" });
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /source 'teams' has no qitt\.md/);
  });
});
