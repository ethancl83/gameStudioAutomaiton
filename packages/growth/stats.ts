// 성장 실험 판정용 순수 통계 함수. 외부 의존성 없이 결정적으로 계산한다.

export interface Proportion { successes: number; trials: number }
export interface TestResult { effect: number | null; diff: number | null; ciLow: number | null; ciHigh: number | null; pValue: number | null }
export interface WelchResult extends TestResult { df: number | null }
export type Spending = 'obrien_fleming' | 'pocock';

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  const z = x - 1;
  let sum = LANCZOS[0];
  for (let i = 1; i < 9; i++) sum += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** 정규화 상부 불완전 감마 Q(a, x). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const prefix = Math.exp(-x + a * Math.log(x) - lnGamma(a));
  if (x < a + 1) {
    let term = 1 / a, sum = term;
    for (let n = 1; n < 500; n++) { term *= x / (a + n); sum += term; if (Math.abs(term) < Math.abs(sum) * 1e-16) break; }
    return 1 - sum * prefix;
  }
  const tiny = 1e-300;
  let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return prefix * h;
}

/** P(Z > x). 꼬리 확률을 1−Φ로 빼지 않고 직접 계산해 정밀도를 유지한다. */
function normalUpper(x: number): number {
  if (x < 0) return 1 - normalUpper(-x);
  return 0.5 * gammaQ(0.5, x * x / 2);
}

export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  return x < 0 ? normalUpper(-x) : 1 - normalUpper(x);
}

/** Acklam 근사 후 Halley 1회 보정. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  let x: number;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - low) {
    const q = p - 0.5, r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return h;
}

/** 정규화 불완전 베타 I_x(a, b). */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? front * betaContinuedFraction(a, b, x) / a : 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
}

/** P(T > |t|)의 절반 꼬리. */
function studentTail(t: number, df: number): number {
  return 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

export function studentTCdf(t: number, df: number): number {
  if (!(df > 0) || Number.isNaN(t)) return NaN;
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const tail = studentTail(t, df);
  return t >= 0 ? 1 - tail : tail;
}

const NULL_RESULT: TestResult = { effect: null, diff: null, ciLow: null, ciHigh: null, pValue: null };

/**
 * 양측 pooled z 검정. 신뢰구간은 상대 lift pT/pC − 1의 delta method 구간이다:
 * Var(pT/pC) ≈ Var(pT)/pC² + pT²·Var(pC)/pC⁴ (비합동 분산). pC = 0이면 상대 효과와 구간은 null이다.
 */
export function twoProportionTest(control: Proportion, treatment: Proportion, alpha: number): TestResult {
  if (!(control.trials > 0 && treatment.trials > 0) || control.successes < 0 || treatment.successes < 0 ||
      control.successes > control.trials || treatment.successes > treatment.trials) return { ...NULL_RESULT };
  const pC = control.successes / control.trials, pT = treatment.successes / treatment.trials;
  const diff = pT - pC;
  const pooled = (control.successes + treatment.successes) / (control.trials + treatment.trials);
  const pooledSe = Math.sqrt(pooled * (1 - pooled) * (1 / control.trials + 1 / treatment.trials));
  // pooled 비율이 0 또는 1이면 두 arm이 동일하므로 차이에 대한 증거가 없다.
  const pValue = pooledSe === 0 ? 1 : Math.min(1, 2 * normalUpper(Math.abs(diff) / pooledSe));
  if (pC === 0) return { effect: null, diff, ciLow: null, ciHigh: null, pValue };
  const effect = diff / pC;
  const varC = pC * (1 - pC) / control.trials, varT = pT * (1 - pT) / treatment.trials;
  const se = Math.sqrt(varT / (pC * pC) + pT * pT * varC / (pC ** 4));
  const z = normalQuantile(1 - alpha / 2);
  return { effect, diff, ciLow: effect - z * se, ciHigh: effect + z * se, pValue };
}

function meanVariance(values: number[]): { mean: number; variance: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return { mean, variance };
}

/**
 * Welch t 검정. 상대 효과 (meanT−meanC)/|meanC|의 구간은 차이 구간을 |meanC|로 나눈 값이다
 * (meanC를 고정값으로 보는 근사). 두 arm의 분산이 모두 0이면 차이가 정확히 0일 때만 p=1, 아니면 p=0이다.
 */
export function welchTest(control: number[], treatment: number[], alpha: number): WelchResult {
  if (control.length < 2 || treatment.length < 2 || ![...control, ...treatment].every(Number.isFinite)) return { ...NULL_RESULT, df: null };
  const c = meanVariance(control), t = meanVariance(treatment);
  const diff = t.mean - c.mean;
  const vc = c.variance / control.length, vt = t.variance / treatment.length;
  const se = Math.sqrt(vc + vt);
  let pValue: number, df: number, half: number;
  if (se === 0) {
    df = control.length + treatment.length - 2;
    pValue = diff === 0 ? 1 : 0;
    half = 0;
  } else {
    df = (vc + vt) ** 2 / (vc ** 2 / (control.length - 1) + vt ** 2 / (treatment.length - 1));
    pValue = Math.min(1, 2 * studentTail(diff / se, df));
    half = studentQuantile(1 - alpha / 2, df) * se;
  }
  if (c.mean === 0) return { effect: null, diff, ciLow: null, ciHigh: null, pValue, df };
  const scale = Math.abs(c.mean);
  return { effect: diff / scale, diff, ciLow: (diff - half) / scale, ciHigh: (diff + half) / scale, pValue, df };
}

/** 이분법으로 t 분포 분위수를 구한다(p ≥ 0.5 전용). */
function studentQuantile(p: number, df: number): number {
  let low = 0, high = Math.max(10, normalQuantile(p) * 4);
  while (studentTCdf(high, df) < p) high *= 2;
  for (let i = 0; i < 200 && high - low > 1e-12; i++) {
    const mid = (low + high) / 2;
    if (studentTCdf(mid, df) < p) low = mid; else high = mid;
  }
  return (low + high) / 2;
}

/** Holm step-down 보정 p. 입력 순서를 유지한다. */
export function holmAdjust(p: number[]): number[] {
  const m = p.length;
  const order = p.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const adjusted = new Array<number>(m);
  let running = 0;
  order.forEach((item, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * item.value));
    adjusted[item.index] = running;
  });
  return adjusted;
}

/** Benjamini-Hochberg step-up 보정 p(FDR). 입력 순서를 유지한다. */
export function benjaminiHochberg(p: number[]): number[] {
  const m = p.length;
  const order = p.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const adjusted = new Array<number>(m);
  let running = 1;
  for (let rank = m - 1; rank >= 0; rank--) {
    running = Math.min(running, Math.min(1, m * order[rank].value / (rank + 1)));
    adjusted[order[rank].index] = running;
  }
  return adjusted;
}

/** Lan-DeMets alpha-spending 함수 α(t). */
export function spentAlpha(alpha: number, informationFraction: number, spending: Spending): number {
  const t = Math.min(1, Math.max(0, informationFraction));
  if (t === 0) return 0;
  if (spending === 'pocock') return alpha * Math.log(1 + (Math.E - 1) * t);
  return Math.min(alpha, 2 * normalUpper(normalQuantile(1 - alpha / 2) / Math.sqrt(t)));
}

/**
 * k번째 look(1부터)의 명목 유의수준 α(t_k) − α(t_{k−1}), t_k = k/K.
 * 이전 look과의 상관을 무시한 증분(합집합 상한) 경계라 정확한 group-sequential 경계보다 보수적이지만
 * 전체 1종 오류는 α 이하로 유지된다.
 */
export function sequentialNominalAlpha(alpha: number, lookIndex: number, totalLooks: number, spending: Spending): number {
  if (!Number.isInteger(lookIndex) || !Number.isInteger(totalLooks) || lookIndex < 1 || lookIndex > totalLooks) return 0;
  return spentAlpha(alpha, lookIndex / totalLooks, spending) - spentAlpha(alpha, (lookIndex - 1) / totalLooks, spending);
}
