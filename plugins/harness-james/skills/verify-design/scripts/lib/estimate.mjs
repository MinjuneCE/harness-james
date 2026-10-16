// 묶음 토큰 추정과 비용 범위 한 줄. 계수는 framework 8.4의 값이다.
//  판정: 묶음 1k 토큰당 standard 0.092달러, deep 0.104달러, ±25%. 반증 몫을 뺀 값이다(사용자 결정 5-2 (a)).
//  반증: 건수 × 모델별 단가(Opus 0.20달러 = standard 반증, Fable 1.23달러 = deep 반증). 건수 범위는 0건부터 상한(limits.refute)까지.
//  범위 = [판정 × 0.75 + 0, 판정 × 1.25 + 단가 × 상한]
export const COST_PER_1K = { standard: 0.092, deep: 0.104 };
export const COST_SPREAD = 0.25;
export const REFUTE_COST = { opus: 0.2, fable: 1.23 };
// level별 반증 모델(찾은 모델과 다른 모델)
export const REFUTER_OF = { standard: "opus", deep: "fable" };
export const COST_BASIS = "보정 1회 기준";

// 문자 종류별 근사: ASCII 4자당 1토큰, 그 밖(한글 등) 1자당 약 0.9토큰.
export function estimateTokens(text) {
  let ascii = 0, other = 0;
  for (const ch of text) (ch.charCodeAt(0) < 128 ? ascii++ : other++);
  return Math.round(ascii / 4 + other * 0.9);
}

const MODEL_NAME = { opus: "Opus", fable: "Fable" };
// 금액은 숫자 뒤 "달러"로 적는다(framework 8.4). 달러 기호를 쓰지 않는다(스킬 인자 치환 `$N`과도 안 겹친다).

export function estimate(docs, { refuteMax = 8 } = {}) {
  const tokens = docs.reduce((s, d) => s + estimateTokens(d.text), 0);
  const k = tokens / 1000;
  const calc = (lv) => {
    const m = REFUTER_OF[lv];
    const judge = k * COST_PER_1K[lv];
    const refuteMaxUsd = REFUTE_COST[m] * refuteMax;
    const lo = judge * (1 - COST_SPREAD);
    const hi = judge * (1 + COST_SPREAD) + refuteMaxUsd;
    return {
      usd: [Math.round(lo), Math.round(hi)],
      judge_range: [Math.round(lo), Math.round(judge * (1 + COST_SPREAD))],
      judge_usd: Number(judge.toFixed(2)),
      refute: { model: m, per: REFUTE_COST[m], min: 0, max: refuteMax, max_usd: Number(refuteMaxUsd.toFixed(2)) },
    };
  };
  const st = calc("standard");
  const dp = calc("deep");
  // framework 8.4: 판정 범위와 반증 범위를 따로 보이고, 합계는 둘을 더한 범위로 적는다
  const money = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(2));
  const part = (lv, c) => `${lv} ${c.usd[0]}–${c.usd[1]}달러 = 판정 ${c.judge_range[0]}–${c.judge_range[1]}달러(1k 토큰당 ${COST_PER_1K[lv].toFixed(3)} ±${COST_SPREAD * 100}%) + 반증 0–${money(c.refute.max_usd)}달러(${MODEL_NAME[c.refute.model]} 건당 ${c.refute.per.toFixed(2)} × 0–${c.refute.max}건)`;
  return {
    bundle_tokens: tokens,
    standard_usd: st.usd,
    deep_usd: dp.usd,
    judge_usd: { standard: st.judge_usd, deep: dp.judge_usd },
    judge_range_usd: { standard: st.judge_range, deep: dp.judge_range },
    refute_usd: { standard: st.refute, deep: dp.refute },
    basis: COST_BASIS,
    cost_line: `묶음 약 ${Math.round(k)}k 토큰 · ${part("standard", st)} · ${part("deep", dp)} (${COST_BASIS})`,
  };
}

// 사용자 결정 1(2026-10-16): 되돌릴 수 없는 부작용·데이터 이전 trait가 있으면 deep 권장 줄을 보인다. 정보만, level은 바꾸지 않는다.
export const DEEP_ADVICE_TRAITS = ["irreversible-effects", "data-migration"];
export function deepAdvice(traits = []) {
  const hit = DEEP_ADVICE_TRAITS.filter((t) => traits.includes(t));
  return hit.length ? `구현 직전·확정 때는 deep 권장 (traits: ${hit.join(", ")})` : null;
}
