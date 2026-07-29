import {
  fetchAccountDetails,
  fetchConsumptionForPeriod,
  fetchRatesForPeriod,
  fetchStandingCharge,
} from "../../../lib/octopus";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 32;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Both arrays are sorted ascending by time; walk them together so each
// consumption interval picks up whichever rate covered it.
function attachRates(consumption, rates) {
  let ri = 0;
  return consumption.map((c) => {
    const t = new Date(c.intervalStart).getTime();
    while (
      ri < rates.length - 1 &&
      (rates[ri].validTo ? new Date(rates[ri].validTo).getTime() : Infinity) <= t
    ) {
      ri++;
    }
    const r = rates[ri];
    const covers =
      r &&
      new Date(r.validFrom).getTime() <= t &&
      t < (r.validTo ? new Date(r.validTo).getTime() : Infinity);
    return { ...c, rate: covers ? r.rate : null };
  });
}

const HALF_HOUR_MS = 30 * 60 * 1000;

function sumWindow(rated, startMs, endMs) {
  let kwh = 0;
  let costPence = 0;
  let missingRateKwh = 0;
  let intervalCount = 0;
  for (const c of rated) {
    const t = new Date(c.intervalStart).getTime();
    if (t >= startMs && t < endMs) {
      kwh += c.consumptionKwh;
      intervalCount++;
      if (c.rate != null) costPence += c.consumptionKwh * c.rate;
      else missingRateKwh += c.consumptionKwh;
    }
  }
  // Some meters (gas especially, if its DCC/WAN link is weak) only report a
  // fraction of their expected half-hourly readings — silently summing what
  // exists would understate usage without any sign anything was missing.
  const expectedIntervals = Math.round((endMs - startMs) / HALF_HOUR_MS);
  const coveragePct = expectedIntervals > 0 ? round2(Math.min(100, (intervalCount / expectedIntervals) * 100)) : null;
  return {
    kwh: round2(kwh),
    costPence: round2(costPence),
    missingRateKwh: round2(missingRateKwh),
    coveragePct,
  };
}

async function buildFuelSpend(fuel, meterPointId, serial, productCode, tariffCode) {
  if (!meterPointId || !serial || !productCode || !tariffCode) return null;

  const now = new Date();
  const historyFrom = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);
  const rateTo = new Date(now.getTime() + 8 * DAY_MS); // catch any already-published future rates

  const [consumption, rates, standingCharge] = await Promise.all([
    fetchConsumptionForPeriod(fuel, meterPointId, serial, historyFrom.toISOString(), now.toISOString()),
    fetchRatesForPeriod(fuel, productCode, tariffCode, historyFrom.toISOString(), rateTo.toISOString()),
    fetchStandingCharge(fuel, productCode, tariffCode),
  ]);

  // Octopus's standard-standing-charges resource 404s for some tariffs
  // rather than returning a value (seen in practice, not just theory) —
  // rather than silently treating that as "£0/day", let an env var fill the
  // gap so spend totals stay accurate: OCTOPUS_ELECTRICITY_STANDING_CHARGE_PENCE
  // / OCTOPUS_GAS_STANDING_CHARGE_PENCE.
  const overrideEnvVar = `OCTOPUS_${fuel.toUpperCase()}_STANDING_CHARGE_PENCE`;
  const overrideValue = process.env[overrideEnvVar];
  let standingRate = 0;
  let standingChargeSource = "none";
  if (standingCharge) {
    standingRate = standingCharge.rate;
    standingChargeSource = "api";
  } else if (overrideValue != null && overrideValue !== "" && !Number.isNaN(Number(overrideValue))) {
    standingRate = Number(overrideValue);
    standingChargeSource = "override";
  }

  if (!consumption.length) {
    return { hasData: false, standingChargePencePerDay: standingRate, standingChargeSource };
  }

  const rated = attachRates(consumption, rates);
  // Anchor "last 24h/7d/30d" to the newest reading we actually have, since
  // smart meter data lags real time by anywhere from a couple of hours to a day.
  const latestDataAt = consumption[consumption.length - 1].intervalEnd;
  const anchor = new Date(latestDataAt).getTime();

  function windowSummary(days) {
    const startMs = anchor - days * DAY_MS;
    const usage = sumWindow(rated, startMs, anchor);
    const standingChargePence = round2(standingRate * days);
    return {
      kwh: usage.kwh,
      // Blended p/kWh actually paid across this window (varies day to day on
      // a daily-rate tariff), so the UI can show "kWh x rate = cost" plainly.
      avgRatePence: usage.kwh > 0 ? round2(usage.costPence / usage.kwh) : null,
      usageCostPence: usage.costPence,
      standingChargePence,
      totalCostPence: round2(usage.costPence + standingChargePence),
      incompleteData: usage.missingRateKwh > 0,
      // % of expected half-hourly readings actually present. Well under 100%
      // means the kWh/£ figures above are a floor, not the real total.
      coveragePct: usage.coveragePct,
    };
  }

  const day = windowSummary(1);
  const week = windowSummary(7);
  const month = windowSummary(30);

  const priorWeekUsage = sumWindow(rated, anchor - 14 * DAY_MS, anchor - 7 * DAY_MS);
  const priorWeekTotalPence = round2(priorWeekUsage.costPence + round2(standingRate * 7));

  const nowMs = now.getTime();
  const sortedRates = rates; // already ascending
  const currentIdx = sortedRates.findIndex((r) => {
    const from = new Date(r.validFrom).getTime();
    const to = r.validTo ? new Date(r.validTo).getTime() : Infinity;
    return from <= nowMs && nowMs < to;
  });
  const currentRate = currentIdx >= 0 ? sortedRates[currentIdx] : null;
  // "Next" rate change after the current one — for a daily tariff like Tracker
  // this is effectively tomorrow's rate, once Octopus has published it.
  const nextRate = currentIdx >= 0 && sortedRates[currentIdx + 1] ? sortedRates[currentIdx + 1] : null;

  const trailing14d = sortedRates.filter((r) => {
    const from = new Date(r.validFrom).getTime();
    return from <= nowMs && from > nowMs - 14 * DAY_MS;
  });
  const trailing14dAvgRate = trailing14d.length
    ? round2(trailing14d.reduce((s, r) => s + r.rate, 0) / trailing14d.length)
    : null;

  // Next 7 days, day by day: use Octopus's own published rates where they
  // exist (a daily tariff like Tracker usually only has tomorrow, sometimes
  // nothing yet), and fall back to the trailing 14-day average — clearly
  // labelled "estimated" — for any day Octopus hasn't priced yet.
  const upcomingPublished = currentRate
    ? sortedRates.slice(currentIdx + 1).filter((r) => new Date(r.validFrom).getTime() > nowMs)
    : sortedRates.filter((r) => new Date(r.validFrom).getTime() > nowMs);

  let cursor = currentRate && currentRate.validTo ? new Date(currentRate.validTo) : new Date(nowMs + DAY_MS);
  let upcomingIdx = 0;
  const outlook = [];
  for (let i = 0; i < 7; i++) {
    const candidate = upcomingPublished[upcomingIdx];
    const candidateStartMs = candidate ? new Date(candidate.validFrom).getTime() : null;
    if (candidate && Math.abs(candidateStartMs - cursor.getTime()) < 6 * 60 * 60 * 1000) {
      outlook.push({ date: candidate.validFrom, rate: candidate.rate, source: "published" });
      cursor = candidate.validTo ? new Date(candidate.validTo) : new Date(cursor.getTime() + DAY_MS);
      upcomingIdx++;
    } else {
      outlook.push({ date: cursor.toISOString(), rate: trailing14dAvgRate, source: "estimated" });
      cursor = new Date(cursor.getTime() + DAY_MS);
    }
  }

  // Forward-looking estimate: your recent daily usage pattern, priced at
  // today's known rate (Tracker only publishes one day ahead, so holding the
  // rate flat is the honest assumption for a 30-day-out estimate). Prefer
  // the 30-day window over 7 days if the meter's reporting is patchy enough
  // that a week alone would be a noisy/misleading sample.
  const useMonthForProjection = (week.coveragePct || 0) < 50 && (month.coveragePct || 0) > (week.coveragePct || 0);
  const avgDailyKwh = round2(useMonthForProjection ? month.kwh / 30 : week.kwh / 7);
  const projectionRate = currentRate ? currentRate.rate : trailing14dAvgRate;
  const lowCoverage = (useMonthForProjection ? month.coveragePct : week.coveragePct) < 60;
  const projection =
    projectionRate != null
      ? (() => {
          const dailyCostPence = round2(avgDailyKwh * projectionRate + standingRate);
          return {
            avgDailyKwh,
            ratePence: projectionRate,
            dailyCostPence,
            projected30dCostPence: round2(dailyCostPence * 30),
            basis: `last ${useMonthForProjection ? 30 : 7} days average usage at today's rate`,
            lowCoverage,
          };
        })()
      : null;

  return {
    hasData: true,
    latestDataAt,
    day,
    week,
    month,
    weekOverWeek: {
      previousTotalCostPence: priorWeekTotalPence,
      deltaPence: round2(week.totalCostPence - priorWeekTotalPence),
      deltaPct:
        priorWeekTotalPence > 0
          ? round2(((week.totalCostPence - priorWeekTotalPence) / priorWeekTotalPence) * 100)
          : null,
    },
    standingChargePencePerDay: standingRate,
    standingChargeSource,
    currentRate: currentRate
      ? { rate: currentRate.rate, validFrom: currentRate.validFrom, validTo: currentRate.validTo }
      : null,
    nextRate: nextRate
      ? { rate: nextRate.rate, validFrom: nextRate.validFrom, validTo: nextRate.validTo }
      : null,
    trailing14dAvgRate,
    projection,
    outlook,
    recentDailyRates: sortedRates.filter((r) => new Date(r.validFrom).getTime() > nowMs - 14 * DAY_MS),
  };
}

export async function GET() {
  try {
    const account = await fetchAccountDetails();

    const [electricity, gas] = await Promise.all([
      account.electricity
        ? buildFuelSpend(
            "electricity",
            account.electricity.mpan,
            account.electricity.serialNumber,
            account.electricity.productCode,
            account.electricity.tariffCode
          )
        : null,
      account.gas
        ? buildFuelSpend(
            "gas",
            account.gas.mprn,
            account.gas.serialNumber,
            account.gas.productCode,
            account.gas.tariffCode
          )
        : null,
    ]);

    return Response.json({ electricity, gas, updatedAt: new Date().toISOString() });
  } catch (err) {
    return Response.json({ error: err.message || "Failed to fetch spend data" }, { status: 502 });
  }
}
