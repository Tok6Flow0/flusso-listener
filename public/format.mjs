// Generated from Flusso src/lib/numberFormat.ts; presentation only. See NOTICE.
/**
 * Canonical number presentation for Flusso.
 *
 * One place decides how many decimals a figure gets, and the answer depends on
 * what the figure *means* — never on which screen it happens to appear on.
 *
 *   price          2 / 4 / 6 dp by magnitude   a $67k mark does not need four
 *                                              decimals; a $0.42 token does
 *   rate           4 dp                        funding, borrow, and fee rates
 *                                              are small and every digit moves
 *                                              money
 *   percent        2 dp                        returns, drawdowns, win rates
 *   money          2 dp                        cash amounts, always
 *   quantity       up to 8 dp, trailing zeros trimmed
 *   basis points   1 dp
 *   ratio          2 dp                        Sharpe, leverage, factors
 *   count          0 dp
 *
 * Presentation only. Nothing here recomputes a financial value — callers pass
 * in numbers the platform already produced, and a missing value stays missing.
 */
/** What the product shows when a value is genuinely absent. Never "0". */
export const EMPTY = "—";
/**
 * ────────────────────────────────────────────────────────────────────────────
 * Reconciliation: figures a reader can add up MUST add up.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Rounding each figure on its own is what breaks this. Ten funding amounts
 * whose exact sum is $1.4349 render as 0.54 0.48 0.26 0.07 0.05 0.03 0.01 —
 * which a reader adds to $1.44 — while the total, rounded from full precision,
 * renders $1.43. Both are "correct" in isolation and the panel is still wrong,
 * because a user checking our arithmetic finds it broken. That is a trust
 * failure, not a cosmetic one.
 *
 * `reconcileForDisplay` fixes it by allocating the rounding residual across the
 * parts (largest-remainder), so:
 *
 *     sum(reconcileForDisplay(parts)) === roundMoney(sum(parts))    exactly
 *
 * The total keeps its true value — it is still the correctly rounded exact sum —
 * and the parts are nudged by at most one cent each to meet it. That is the only
 * arrangement where both the total and the addition are right.
 *
 * ⚠ DO NOT format parts individually and separately format their total. If you
 * are rendering a set of figures alongside their sum, run the set through
 * `reconcileForDisplay` first and derive the total from the returned parts.
 * `src/lib/cellPositions.ts` shows the intended shape. Tests in
 * `numberFormat.test.ts` fail on any change that reintroduces per-figure
 * rounding, and they are there deliberately — do not relax them to make an
 * edit pass.
 */
/**
 * Round half away from zero at `decimals`, tolerant of binary artefacts.
 *
 * Plain `Math.round` rounds −0.005 to −0.00 (it rounds toward +∞), which makes
 * a loss and a gain of the same size disagree. Money rounds away from zero in
 * both directions. The epsilon nudge keeps 54.50000000000001 and
 * 54.499999999999996 — the same cent to a human — from landing on different
 * cents.
 */
export function roundMoney(value, decimals = DECIMALS.money) {
    if (!Number.isFinite(value))
        return Number.NaN;
    const scale = 10 ** decimals;
    return quantisedUnits(value, scale) / scale;
}
function quantisedUnits(value, scale) {
    const scaled = value * scale;
    const magnitude = Math.abs(scaled);
    // Scale the tolerance with the value so it stays meaningful for large sums
    // and never swamps a genuinely tiny one.
    const rounded = Math.round(magnitude + Math.max(magnitude, 1) * Number.EPSILON * 4);
    return scaled < 0 ? -rounded : rounded;
}
/**
 * Quantise related figures so the parts sum exactly to the rounded total.
 *
 * Non-finite entries pass through untouched and take no part in the allocation,
 * so one unavailable row cannot corrupt every other figure on the panel.
 *
 * @param values parts that are displayed together with their sum
 * @returns the same parts, each within one unit-in-the-last-place of its input
 */
export function reconcileForDisplay(values, decimals = DECIMALS.money) {
    return reconcileForDisplayToTotal(values, undefined, decimals);
}
/**
 * Quantise related figures to an already-established display total.
 *
 * This is for one canonical total alongside a separately bucketed set of
 * parts (for example, completed hourly cells beside the settled day total).
 * Callers must first establish that both reads reconcile at source precision;
 * this helper only allocates the display-rounding residual.
 */
export function reconcileForDisplayToTotal(values, total, decimals = DECIMALS.money) {
    const scale = 10 ** decimals;
    const scaled = values.map((value) => (Number.isFinite(value) ? value * scale : Number.NaN));
    const live = [];
    for (let i = 0; i < scaled.length; i += 1)
        if (Number.isFinite(scaled[i]))
            live.push(i);
    // Keep the allocation in integer display units. Applying a residual measured
    // in dollars as whole dollars can move a part by 100 cents.
    const base = values.map((value) => (Number.isFinite(value) ? quantisedUnits(value, scale) : Number.NaN));
    const exactSum = live.reduce((sum, i) => sum + values[i], 0);
    const targetValue = total === undefined || !Number.isFinite(total) ? exactSum : total;
    const target = quantisedUnits(targetValue, scale);
    let residual = target - live.reduce((sum, i) => sum + base[i], 0);
    if (residual !== 0 && live.length > 0) {
        // Hand each spare unit to whichever part was rounded furthest in the
        // opposite direction, so every adjustment reduces total error rather than
        // parking it all on one unlucky row. Ties break on magnitude then index, so
        // the same inputs always produce the same output.
        const step = residual > 0 ? 1 : -1;
        const order = [...live].sort((left, right) => {
            const leftError = scaled[left] - base[left];
            const rightError = scaled[right] - base[right];
            if (leftError !== rightError)
                return step > 0 ? rightError - leftError : leftError - rightError;
            const leftSize = Math.abs(scaled[left]);
            const rightSize = Math.abs(scaled[right]);
            if (leftSize !== rightSize)
                return rightSize - leftSize;
            return left - right;
        });
        for (let taken = 0; taken < Math.abs(residual); taken += 1) {
            base[order[taken % order.length]] += step;
        }
        residual = 0;
    }
    return base.map((value) => (Number.isFinite(value) ? value / scale : Number.NaN));
}
/**
 * The total to display beside a reconciled set. Equal to the sum of the parts
 * `reconcileForDisplay` returns, and to the correctly rounded exact sum.
 */
export function reconciledTotal(values, decimals = DECIMALS.money) {
    const live = values.filter((value) => Number.isFinite(value));
    if (live.length === 0)
        return Number.NaN;
    return roundMoney(live.reduce((sum, value) => sum + value, 0), decimals);
}
export const DECIMALS = {
    rate: 4,
    percent: 2,
    money: 2,
    creditEstimate: 1,
    bps: 1,
    ratio: 2,
    count: 0,
    quantityMax: 8,
};
const decimalFormatter = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: DECIMALS.quantityMax,
});
const fixedFormatterCache = new Map();
function finite(value) {
    if (value === null || value === undefined || value === "")
        return null;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}
function fixed(n, digits) {
    let formatter = fixedFormatterCache.get(digits);
    if (!formatter) {
        formatter = new Intl.NumberFormat("en-US", {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
        });
        fixedFormatterCache.set(digits, formatter);
    }
    return formatter.format(n);
}
/** Minus sign is U+2212, which aligns with digits; the hyphen does not. */
function signOf(n, showSign) {
    if (n < 0)
        return "−";
    return showSign && n > 0 ? "+" : "";
}
/**
 * Decimals for an instrument price. Trading wants precision where precision
 * exists, so sub-dollar instruments keep six places and the ordinary range
 * keeps four — but a five-figure mark gets two, because trailing zeros there
 * are noise, not information.
 */
export function priceDecimals(value) {
    const abs = Math.abs(value);
    if (abs >= 1000)
        return 2;
    if (abs >= 1)
        return 4;
    return 6;
}
export function formatPrice(value) {
    const n = finite(value);
    return n === null ? EMPTY : fixed(n, priceDecimals(n));
}
/** A rate already expressed as a percent (0.0125 -> pass 1.25). */
export function formatRate(value, { showSign = false } = {}) {
    const n = finite(value);
    if (n === null)
        return EMPTY;
    return `${signOf(n, showSign)}${fixed(Math.abs(n), DECIMALS.rate)}%`;
}
/** A percentage already expressed as a percent (12.5 -> "12.50%"). */
export function formatPercent(value, { showSign = false } = {}) {
    const n = finite(value);
    if (n === null)
        return EMPTY;
    return `${signOf(n, showSign)}${fixed(Math.abs(n), DECIMALS.percent)}%`;
}
/**
 * Percent for prose and pricing copy — "20%", "2.5%". Trailing zeros are
 * trimmed here and only here: a sentence and a headline price are not a
 * column of figures, so padding them adds noise instead of precision.
 */
export function formatPercentLabel(value, { showSign = false } = {}) {
    const n = finite(value);
    if (n === null)
        return EMPTY;
    const body = Math.abs(n).toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: DECIMALS.percent,
    });
    return `${signOf(n, showSign)}${body}%`;
}
/** A fraction (0.125 -> "12.50%"). */
export function formatFraction(value, { showSign = false } = {}) {
    const n = finite(value);
    return n === null ? EMPTY : formatPercent(n * 100, { showSign });
}
/** A rate held as a fraction (0.0001 -> "0.0100%"). */
export function formatRateFraction(value, { showSign = false } = {}) {
    const n = finite(value);
    return n === null ? EMPTY : formatRate(n * 100, { showSign });
}
export function formatMoney(value, { currency = "", showSign = false } = {}) {
    const n = finite(value);
    if (n === null)
        return EMPTY;
    const body = fixed(Math.abs(n), DECIMALS.money);
    return `${signOf(n, showSign)}${currency ? `${currency} ` : ""}${body}`;
}
/**
 * Abbreviated money for axis ticks and dense tiles. Two significant decimals
 * at every tier so the abbreviations do not disagree with each other.
 */
export function formatCompactMoney(value) {
    const n = finite(value);
    if (n === null)
        return EMPTY;
    const abs = Math.abs(n);
    const sign = n < 0 ? "−" : "";
    if (abs >= 1e9)
        return `${sign}$${fixed(abs / 1e9, 2)}B`;
    if (abs >= 1e6)
        return `${sign}$${fixed(abs / 1e6, 2)}M`;
    if (abs >= 1e3)
        return `${sign}$${fixed(abs / 1e3, 2)}k`;
    return `${sign}$${fixed(abs, DECIMALS.money)}`;
}
/**
 * Abbreviated public counts for dense identity cards. Keep three significant
 * figures, matching the precision YouTube publishes for subscriber totals.
 */
export function formatCompactCount(value) {
    const n = finite(value);
    if (n === null)
        return EMPTY;
    const abs = Math.abs(n);
    const sign = n < 0 ? "−" : "";
    const compact = (scale, suffix) => {
        const scaled = abs / scale;
        const maximumFractionDigits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
        return `${sign}${new Intl.NumberFormat("en-US", {
            minimumFractionDigits: 0,
            maximumFractionDigits,
        }).format(scaled)}${suffix}`;
    };
    if (abs >= 999_500_000)
        return compact(1_000_000_000, "B");
    if (abs >= 999_500)
        return compact(1_000_000, "M");
    if (abs >= 1_000)
        return compact(1_000, "k");
    return `${sign}${fixed(abs, DECIMALS.count)}`;
}
/** Display precision for modelled Flow Credit usage; never changes the billed amount. */
export function formatCreditEstimate(value) {
    const n = finite(value);
    return n === null ? EMPTY : `${signOf(n, false)}${fixed(Math.abs(n), DECIMALS.creditEstimate)}`;
}
/** Position and order sizes: keep what the venue gave us, drop dead zeros. */
export function formatQuantity(value) {
    const n = finite(value);
    if (n === null)
        return EMPTY;
    return decimalFormatter.format(n);
}
/** Generic non-financial decimal, for venue-native prices and quantities. */
export function formatDecimal(value) {
    const n = finite(value);
    return n === null ? EMPTY : decimalFormatter.format(n);
}
export function formatBps(value) {
    const n = finite(value);
    return n === null ? EMPTY : `${fixed(n, DECIMALS.bps)} bps`;
}
export function formatRatio(value) {
    const n = finite(value);
    return n === null ? EMPTY : fixed(n, DECIMALS.ratio);
}
export function formatCount(value) {
    const n = finite(value);
    return n === null ? EMPTY : fixed(n, DECIMALS.count);
}
/** Flow Credits are whole units, formatted without loading the Library catalogue. */
export function formatFlowCredits(amount) {
    const whole = Math.round(Number(amount) || 0);
    return `${whole.toLocaleString("en-US", { maximumFractionDigits: 0 })} FC`;
}
