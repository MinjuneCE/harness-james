// lib/config.mjs: defaults, the project file .loop/collab/config.json, the workspace root, and the shipped example.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, loadConfig, merge, resolveRoot, roleNames, offRoles, roleName, configNotice } from "../lib/config.mjs";

const SKILL = fileURLToPath(new URL("..", import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "collab-config-"));
function project(config) {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".loop/collab"), { recursive: true });
  if (config !== undefined) fs.writeFileSync(path.join(root, ".loop/collab/config.json"), typeof config === "string" ? config : JSON.stringify(config));
  return root;
}

test("defaults: five generic roles all on, their lineages, no aliases for old names", () => {
  const c = loadConfig({ root: project(undefined), env: {} });
  assert.deepEqual(roleNames(c), ["impl", "qa", "scenarios", "infra", "pm"]);
  assert.deepEqual(offRoles(c), []);
  assert.deepEqual(c.lineages, { impl: "impl", qa: "qa", scn: "scenarios", infra: "infra", pm: "pm" });
  assert.deepEqual(c.oldLineages, {});
  assert.deepEqual(c.roleAliases, {});
  assert.equal(c.exists, false);
  assert.equal(c.error, undefined);
  assert.equal(configNotice(c), null);
  assert.equal(c.gaps.tickets, ".loop/tickets");
  assert.deepEqual(Object.entries(c.gaps.rules).filter(([, on]) => on).map(([k]) => k), ["G1", "G2", "G3", "G4", "G5", "G6"]);
  // owner aliases come from the roles and lineages (and their upper case), nothing else
  assert.equal(c.ownerAliases.scn, "scenarios");
  assert.equal(c.ownerAliases.QA, "qa");
  assert.equal(Object.values(c.ownerAliases).every((r) => roleNames(c).includes(r)), true);
  // loadConfig never hands out the shared default objects
  c.roles.impl = false;
  assert.equal(DEFAULTS.roles.impl, true);
});

test("a project file adds and switches roles, lineages, aliases and gap knobs on top of the defaults", () => {
  const c = loadConfig({ root: project({ _설명: "x", roles: { pm: false, design: true, _note: "x" }, lineages: { dsg: "design" }, roleAliases: { tester: "qa" }, oldLineages: { tst: "qa" }, ownerAliases: { 디자인: "design" }, gaps: { staleHours: 48, rules: { G7: true, _x: 1 }, tickets: false, g8Owners: ["qa"] } }), env: {} });
  assert.equal(c.exists, true);
  assert.deepEqual(roleNames(c), ["impl", "qa", "scenarios", "infra", "pm", "design"]);
  assert.deepEqual(offRoles(c), ["pm"]);
  assert.equal(c.lineages.dsg, "design");
  assert.equal(c.lineages.scn, "scenarios");
  assert.equal(roleName(c, "tester"), "qa");
  assert.equal(roleName(c, "nobody"), "nobody");
  assert.equal(c.ownerAliases.tester, "qa");
  assert.equal(c.ownerAliases.tst, "qa");
  assert.equal(c.ownerAliases.DSG, "design");
  assert.equal(c.ownerAliases["디자인"], "design");
  assert.equal(c.gaps.staleHours, 48);
  assert.equal(c.gaps.rules.G7, true);
  assert.equal(c.gaps.rules.G1, true);
  assert.equal(c.gaps.tickets, false);
  assert.deepEqual(c.gaps.g8Owners, ["qa"]);
  assert.equal(c.ignored, undefined);
});

test("wrong types and reserved names are skipped and listed, never read as a switch", () => {
  const c = merge({ roles: { pm: "off", user: false, "Bad Role": true, ok: 1 }, lineages: { web: "nobody", "TooLongLineageName": "impl" }, roleAliases: { impl: "qa", tester: "nobody" }, gaps: { staleHours: -1, rules: { G0: true, G2: "no" }, tickets: 3, g8Owners: "qa" }, ownerAliases: [] });
  assert.equal(c.roles.pm, true);
  assert.equal(Object.hasOwn(c.roles, "user"), false);
  assert.deepEqual(c.ignored.sort(), [
    "gaps.g8Owners", "gaps.rules.G0", "gaps.rules.G2", "gaps.staleHours", "gaps.tickets",
    "lineages.TooLongLineageName", "lineages.web", "ownerAliases",
    "roleAliases.impl", "roleAliases.tester", "roles.Bad Role", "roles.ok", "roles.pm", "roles.user",
  ].sort());
  assert.deepEqual(merge({ roles: [] }).ignored, ["roles"]);
});

test("a broken file means defaults plus an error; a missing file is just defaults", () => {
  for (const raw of ["{nope", "[]", "3", "null"]) {
    const c = loadConfig({ root: project(raw), env: {} });
    assert.ok(c.error, raw);
    assert.equal(c.exists, false);
    assert.deepEqual(offRoles(c), []);
    assert.equal(configNotice(c).using, "defaults");
  }
  assert.equal(loadConfig({ root: tmp(), env: {} }).error, undefined);
  assert.equal(loadConfig({ env: {} }).file, null);
});

test("COLLAB_CONFIG points at another file for the CLI, gaps and the hook alike", () => {
  const elsewhere = project({ roles: { infra: false } });
  const c = loadConfig({ root: project(undefined), env: { COLLAB_CONFIG: path.join(elsewhere, ".loop/collab/config.json") } });
  assert.deepEqual(offRoles(c), ["infra"]);
});

test("resolveRoot: explicit root, COLLAB_ROOT, PANE_LEAD_ROOT, CLAUDE_PROJECT_DIR, then the nearest .loop/collab above cwd, then cwd", () => {
  const ws = project(undefined);
  const nested = path.join(ws, "a/b/c");
  fs.mkdirSync(nested, { recursive: true });
  const bare = tmp();
  assert.equal(resolveRoot({ env: {}, cwd: nested }), ws);
  assert.equal(resolveRoot({ env: {}, cwd: bare }), bare);
  assert.equal(resolveRoot({ env: { CLAUDE_PROJECT_DIR: bare }, cwd: nested }), bare);
  assert.equal(resolveRoot({ env: { CLAUDE_PROJECT_DIR: bare, PANE_LEAD_ROOT: ws }, cwd: bare }), ws);
  assert.equal(resolveRoot({ env: { PANE_LEAD_ROOT: ws, COLLAB_ROOT: bare }, cwd: nested }), bare);
  assert.equal(resolveRoot({ root: ws, env: { COLLAB_ROOT: bare }, cwd: bare }), ws);
});

test("the shipped example loads cleanly and shows a switched-off role and an added role", () => {
  const c = loadConfig({ file: path.join(SKILL, "examples/config.example.json"), env: {} });
  assert.equal(c.error, undefined);
  assert.equal(c.ignored, undefined);
  assert.deepEqual(offRoles(c), ["pm"]);
  assert.equal(c.lineages.dsg, "design");
});
