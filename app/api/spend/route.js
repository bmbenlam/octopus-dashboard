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

function sumWindow(rated, startMs, endMs) {
  let kwh = 0;
  let costPence = 0;
  let missingRateKwh = 0;
  for (const c of rated) {
    const t = new Date(c.intervalStart).getTime();
    if (t >= startMs && t < endMs) {
      kwh += c.consumptionKwh;
      if (c.rate != null) costPence += c.consumptionKwh * c.rate;
      else missingRateKwh += c.consumptionKwh;
    }
  }
  return { kwh: round2(kwh), costPence: round2(costPence), missingRateKwh: round2(missingRateKwh) };
}

async function buildFuelSpend(fuel, meterPointId, serial, productCode, tariffCode) {
  if (!meterPointId || !serial || !productCode || !tariffCode) return null;

  const now = new Date();
  const historyFrom = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);
  const rateTo = new Date(now.getTime() + DAY_MS); // catch tomorrow's already-published rate

  const [consumption, rates, standingCharge] = await Promise.all([
    fetchConsumptionForPeriod(fuel, meterPointId, serial, historyFrom.toISOString(), now.toISOString()),
    fetchRatesForPeriod(fuel, productCode, tariffCode, historyFrom.toISOString(), rateTo.toISOString()),
    fetchStandingCharge(fuel, productCode, tariffCode),
  ]);

  const standingRate = standingCharge ? standingCharge.rate : 0;

  if (!consumption.length) {
    return { hasData: false, standingChargePencePerDay: standingRate };
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
      usageCostPence: usage.costPence,
      standingChargePence,
      totalCostPence: round2(usage.costPence + standingChargePence),
      incompleteData: usage.missingRateKwh > 0,
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
    currentRate: currentRate
      ? { rate: currentRate.rate, validFrom: currentRate.validFrom, validTo: currentRate.validTo }
      : null,
    nextRate: nextRate
      ? { rate: nextRate.rate, validFrom: nextRate.validFrom, validTo: nextRate.validTo }
      : null,
    trailing14dAvgRate,
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
