// 중요도·문턱을 쉬운 말로 푸는 계산이 score.mjs 산식(중요도 × 변경 규모 + 지적 20, 시즌 문턱 × 0.8, 중요도 85 이상 동결)과 맞는지
import { test } from "node:test";
import assert from "node:assert/strict";
import { criticalityWord, reviewRule, ruleCell, ruleText } from "../lib/rule.mjs";
import { SCORING } from "./helpers.mjs";

const rule = (c, t, o) => reviewRule(SCORING, c, t, o);

test("평시: 몇 줄부터 걸리는지", () => {
  assert.equal(rule(95, 50).from, 1, "95 × 0.6 = 57 ≥ 50");
  assert.equal(rule(85, 50).from, 1, "85 × 0.6 = 51 ≥ 50");
  assert.equal(rule(85, 60).from, 11, "51 < 60, 85 × 0.8 = 68 ≥ 60");
  assert.equal(rule(75, 60).from, 11, "75 × 0.8 = 60 ≥ 60");
  assert.equal(rule(70, 60).from, 51, "56 < 60, 70 ≥ 60");
  assert.equal(rule(60, 60).from, 51);
  assert.equal(rule(50, 60).from, null, "50 × 1.0 = 50 < 60");
});

test("중간 이상 지적(+20)이 같이 있을 때", () => {
  assert.equal(rule(85, 60).with_finding_from, 1, "51 + 20 ≥ 60");
  assert.equal(rule(60, 60).with_finding_from, 11, "36 + 20 < 60, 48 + 20 ≥ 60");
  assert.equal(rule(50, 60).with_finding_from, 11, "30 + 20 < 60, 40 + 20 ≥ 60");
  assert.equal(rule(30, 60).with_finding_from, null, "30 + 20 < 60");
});

test("피크 시즌: 문턱 × 0.8, 중요도 85 이상은 동결", () => {
  assert.deepEqual(rule(85, 60, { season: true }), { from: 1, with_finding_from: 1, threshold: 48, freeze: true });
  assert.equal(rule(84, 60, { season: true }).freeze, false);
  assert.equal(rule(70, 60, { season: true }).from, 11, "56 ≥ 48");
  assert.equal(rule(50, 60, { season: true }).from, 51, "50 ≥ 48");
});

test("문장", () => {
  assert.equal(ruleText(rule(95, 50)), "한 줄만 바뀌어도 사람이 봐요");
  assert.equal(ruleText(rule(75, 60)), "11줄 이상 바뀌면 사람이 봐요");
  assert.match(ruleText(rule(50, 60)), /줄 수만으로는 안 걸려요. 11줄 이상 바뀌고 중간 이상 지적/);
  assert.equal(ruleText(rule(30, 60)), "이 문턱으로는 안 걸려요");
  assert.equal(ruleCell(SCORING, 85, 60), "11줄 이상 바뀌면 사람이 봐요 (중간 이상 지적이 있으면 한 줄만 바뀌어도) · 피크 시즌: 한 줄만 바뀌어도 사람이 봐요(시즌 변경 동결)");
  assert.equal(ruleCell(SCORING, 75, 60), "11줄 이상 바뀌면 사람이 봐요 (중간 이상 지적이 있으면 한 줄만 바뀌어도)", "시즌에도 같은 문장이면 한 번만");
  assert.deepEqual([95, 85, 75, 60].map(criticalityWord), ["가장 높음", "높음", "보통", "낮음"]);
});
