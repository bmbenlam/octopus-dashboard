"use client";

import { useEffect, useRef, useState } from "react";

const PRICE_POLL_MS = 5 * 60 * 1000; // Tracker rates change at most daily
const USAGE_POLL_MS = 30 * 1000; // Home Mini reports roughly every 10-30s
const SPEND_POLL_MS = 15 * 60 * 1000; // consumption history doesn't need tight polling
const CLOCK_TICK_MS = 1000;

function formatClock(date) {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatTime(iso) {
  if (!iso) return "--:--";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatDay(iso) {
  if (!iso) return "--";
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });
}

function formatPence(rate) {
  if (rate == null) return "--";
  return `${rate.toFixed(1)}p`;
}

function formatMoney(pence) {
  if (pence == null) return "£--";
  return `£${(pence / 100).toFixed(2)}`;
}

function formatPct(pct) {
  if (pct == null) return null;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

function formatDemand(watts) {
  if (watts == null) return "--";
  if (Math.abs(watts) >= 1000) return `${(watts / 1000).toFixed(2)} kW`;
  return `${Math.round(watts)} W`;
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body;
}

function usePoll(url, intervalMs) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const body = await getJson(url);
        if (cancelled) return;
        setData(body);
        setError(null);
        setFetchedAt(new Date());
      } catch (err) {
        if (cancelled) return;
        setError(err.message);
      }
    }

    load();
    timerRef.current = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timerRef.current);
    };
  }, [url, intervalMs]);

  return { data, error, fetchedAt };
}

function buildTips(fuelName, spend) {
  if (!spend || !spend.hasData) return [];
  const tips = [];

  if (spend.currentRate && spend.nextRate) {
    const delta = spend.nextRate.rate - spend.currentRate.rate;
    const pct = spend.currentRate.rate ? (delta / spend.currentRate.rate) * 100 : 0;
    if (Math.abs(pct) >= 3) {
      tips.push(
        `Tomorrow's ${fuelName} rate is ${Math.abs(pct).toFixed(0)}% ${
          delta < 0 ? "cheaper" : "more expensive"
        } than today — ${delta < 0 ? "a good day to shift big usage to tomorrow" : "try to avoid shifting usage to tomorrow"}.`
      );
    }
  } else if (spend.currentRate && !spend.nextRate) {
    tips.push(`Tomorrow's ${fuelName} rate isn't published yet (usually appears in the evening).`);
  }

  if (spend.currentRate && spend.trailing14dAvgRate) {
    const pct = ((spend.currentRate.rate - spend.trailing14dAvgRate) / spend.trailing14dAvgRate) * 100;
    if (Math.abs(pct) >= 5) {
      tips.push(
        `Today's ${fuelName} rate is ${Math.abs(pct).toFixed(0)}% ${
          pct < 0 ? "below" : "above"
        } your 2-week average — ${pct < 0 ? "a relatively cheap day" : "a relatively expensive day"}.`
      );
    }
  }

  if (spend.weekOverWeek && spend.weekOverWeek.deltaPct != null && Math.abs(spend.weekOverWeek.deltaPct) >= 5) {
    tips.push(
      `You spent ${Math.abs(spend.weekOverWeek.deltaPct).toFixed(0)}% ${
        spend.weekOverWeek.deltaPct > 0 ? "more" : "less"
      } on ${fuelName} this week than the week before.`
    );
  }

  return tips;
}

function StatusBadge({ live }) {
  return (
    <span className={`badge ${live ? "live" : "delayed"}`}>
      {live ? "LIVE" : "DELAYED"}
      <style jsx>{`
        .badge {
          font-size: 0.65rem;
          letter-spacing: 0.08em;
          padding: 0.15rem 0.45rem;
          border-radius: 999px;
          font-weight: 700;
        }
        .live {
          background: rgba(74, 222, 128, 0.15);
          color: #4ade80;
        }
        .delayed {
          background: rgba(250, 204, 21, 0.15);
          color: #facc15;
        }
      `}</style>
    </span>
  );
}

function SpendTile({ label, spend }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="money">{spend ? formatMoney(spend.totalCostPence) : "£--"}</div>
      {spend && (
        <div className="formula">
          {spend.kwh.toFixed(1)} kWh × {spend.avgRatePence != null ? spend.avgRatePence.toFixed(1) : "--"}p
        </div>
      )}
      {spend && spend.standingChargePence > 0 && (
        <div className="kwh">+ {formatMoney(spend.standingChargePence)} standing</div>
      )}
      {spend && spend.incompleteData && <div className="flag">partial data</div>}
      {spend && spend.coveragePct != null && spend.coveragePct < 80 && (
        <div className="flag">only {spend.coveragePct.toFixed(0)}% of readings received</div>
      )}
      <style jsx>{`
        .tile {
          background: #1a1e28;
          border-radius: 0.75rem;
          padding: 0.75rem 0.5rem;
          text-align: center;
          flex: 1;
        }
        .label {
          font-size: 0.7rem;
          color: #8890a0;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .money {
          font-size: 1.5rem;
          font-weight: 700;
          margin-top: 0.15rem;
        }
        .formula {
          font-size: 0.75rem;
          color: #8890a0;
        }
        .kwh {
          font-size: 0.7rem;
          color: #6b7280;
        }
        .flag {
          font-size: 0.6rem;
          color: #facc15;
          margin-top: 0.15rem;
        }
      `}</style>
    </div>
  );
}

function Projection({ projection }) {
  if (!projection) return null;
  return (
    <div className="projection">
      <div className="formula">
        {projection.avgDailyKwh.toFixed(1)} kWh/day × {projection.ratePence.toFixed(1)}p ≈{" "}
        {formatMoney(projection.dailyCostPence)}/day
      </div>
      <div className="total">→ ~{formatMoney(projection.projected30dCostPence)} over 30 days</div>
      <div className="basis">at today's rate, based on {projection.basis}</div>
      {projection.lowCoverage && (
        <div className="warn">
          This meter is only sending a fraction of its readings — likely an underestimate.
        </div>
      )}
      <style jsx>{`
        .projection {
          background: rgba(96, 165, 250, 0.08);
          border: 1px solid rgba(96, 165, 250, 0.25);
          border-radius: 0.75rem;
          padding: 0.6rem 0.85rem;
          margin-top: 0.75rem;
        }
        .formula {
          font-size: 0.85rem;
          color: #c3c8d4;
        }
        .total {
          font-size: 1rem;
          font-weight: 700;
          color: #60a5fa;
          margin-top: 0.15rem;
        }
        .basis {
          font-size: 0.7rem;
          color: #6b7280;
          margin-top: 0.1rem;
        }
        .warn {
          font-size: 0.7rem;
          color: #facc15;
          margin-top: 0.25rem;
        }
      `}</style>
    </div>
  );
}

function Outlook({ entries }) {
  if (!entries || !entries.length) return null;
  return (
    <div className="outlook">
      <div className="heading">Next 7 days</div>
      <div className="row">
        {entries.map((e, i) => (
          <div className="day" key={i}>
            <div className="date">{formatDay(e.date)}</div>
            <div className={`rate ${e.source === "estimated" ? "estimated" : ""}`}>
              {formatPence(e.rate)}
            </div>
            {e.source === "estimated" && <div className="tag">est.</div>}
          </div>
        ))}
      </div>
      <style jsx>{`
        .outlook {
          margin-top: 0.75rem;
        }
        .heading {
          font-size: 0.7rem;
          color: #8890a0;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 0.35rem;
        }
        .row {
          display: flex;
          gap: 0.4rem;
        }
        .day {
          flex: 1;
          background: #1a1e28;
          border-radius: 0.5rem;
          padding: 0.4rem 0.2rem;
          text-align: center;
        }
        .date {
          font-size: 0.65rem;
          color: #8890a0;
        }
        .rate {
          font-size: 0.9rem;
          font-weight: 700;
          margin-top: 0.1rem;
        }
        .rate.estimated {
          color: #9ca3af;
        }
        .tag {
          font-size: 0.55rem;
          color: #6b7280;
        }
      `}</style>
    </div>
  );
}

function RateHistoryChart({ entries, currentFrom, nextFrom }) {
  if (!entries || !entries.length) return null;
  const shown = entries.slice(-14);
  const max = Math.max(...shown.map((e) => e.rate));
  const min = Math.min(...shown.map((e) => e.rate));
  const span = max - min || 1;

  return (
    <div className="chart">
      {shown.map((e) => {
        const heightPct = 15 + ((e.rate - min) / span) * 85;
        const isCurrent = e.validFrom === currentFrom;
        const isNext = e.validFrom === nextFrom;
        return (
          <div className="bar-wrap" key={e.validFrom} title={`${formatDay(e.validFrom)}: ${formatPence(e.rate)}`}>
            <div
              className={`bar ${isCurrent ? "current" : ""} ${isNext ? "next" : ""}`}
              style={{ height: `${heightPct}%` }}
            />
          </div>
        );
      })}
      <style jsx>{`
        .chart {
          display: flex;
          align-items: flex-end;
          gap: 3px;
          height: 3rem;
          margin-top: 0.5rem;
        }
        .bar-wrap {
          flex: 1;
          height: 100%;
          display: flex;
          align-items: flex-end;
        }
        .bar {
          width: 100%;
          background: #3a4152;
          border-radius: 2px 2px 0 0;
          min-height: 4px;
        }
        .bar.current {
          background: #60a5fa;
        }
        .bar.next {
          background: #4ade80;
        }
      `}</style>
    </div>
  );
}

function FuelCard({ title, live, priceNow, priceValidTo, usagePrimary, usageLabel, usageSub, spend, tips }) {
  return (
    <section className="card">
      <div className="row">
        <h2>{title}</h2>
        <StatusBadge live={live} />
      </div>

      <div className="liveRow">
        <div>
          <div className="price">{priceNow}</div>
          <div className="sub">p/kWh {priceValidTo ? `· until ${priceValidTo}` : ""}</div>
        </div>
        <div className="usageBlock">
          <div className="usage">{usagePrimary}</div>
          <div className="sub">{usageLabel}</div>
        </div>
      </div>
      {usageSub && <div className="note">{usageSub}</div>}

      {spend && spend.standingChargeSource === "none" && (
        <div className="note">
          No standing charge found for this tariff — totals below may be undercounted. Set{" "}
          {`OCTOPUS_${title.toUpperCase()}_STANDING_CHARGE_PENCE`} to fix.
        </div>
      )}

      {spend && spend.hasData ? (
        <>
          <div className="tiles">
            <SpendTile label="24h" spend={spend.day} />
            <SpendTile label="7 days" spend={spend.week} />
            <SpendTile label="30 days" spend={spend.month} />
          </div>
          {spend.weekOverWeek && spend.weekOverWeek.deltaPct != null && (
            <div className={`trend ${spend.weekOverWeek.deltaPct > 0 ? "up" : "down"}`}>
              {formatPct(spend.weekOverWeek.deltaPct)} vs previous 7 days
            </div>
          )}
          <Projection projection={spend.projection} />
          <Outlook entries={spend.outlook} />
          <RateHistoryChart
            entries={spend.recentDailyRates}
            currentFrom={spend.currentRate && spend.currentRate.validFrom}
            nextFrom={spend.nextRate && spend.nextRate.validFrom}
          />
          {tips && tips.length > 0 && (
            <ul className="tips">
              {tips.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          )}
          <div className="asof">data as of {formatTime(spend.latestDataAt)} {formatDay(spend.latestDataAt)}</div>
        </>
      ) : (
        <div className="note">Spend history not available yet.</div>
      )}

      <style jsx>{`
        .card {
          background: #14171f;
          border-radius: 1.25rem;
          padding: 1.5rem 1.75rem;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }
        .row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 0.5rem;
        }
        h2 {
          font-size: 1.2rem;
          font-weight: 600;
          color: #aeb4c2;
          margin: 0;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .liveRow {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          gap: 1rem;
        }
        .price {
          font-size: clamp(2.2rem, 6vw, 3.4rem);
          font-weight: 700;
          line-height: 1;
        }
        .usageBlock {
          text-align: right;
        }
        .usage {
          font-size: clamp(1.2rem, 3vw, 1.8rem);
          font-weight: 600;
          color: #d6dae3;
        }
        .sub {
          color: #8890a0;
          font-size: 0.95rem;
          margin-top: 0.2rem;
        }
        .note {
          color: #facc15;
          font-size: 0.85rem;
          margin-top: 0.5rem;
        }
        .tiles {
          display: flex;
          gap: 0.6rem;
          margin-top: 1rem;
        }
        .trend {
          margin-top: 0.5rem;
          font-size: 0.85rem;
          font-weight: 600;
        }
        .trend.up {
          color: #f87171;
        }
        .trend.down {
          color: #4ade80;
        }
        .tips {
          margin: 0.6rem 0 0;
          padding-left: 1.1rem;
          color: #c3c8d4;
          font-size: 0.85rem;
          line-height: 1.4;
        }
        .tips li {
          margin-bottom: 0.25rem;
        }
        .asof {
          color: #565c6b;
          font-size: 0.75rem;
          margin-top: 0.5rem;
        }
      `}</style>
    </section>
  );
}

export default function Page() {
  const [now, setNow] = useState(new Date());
  const price = usePoll("/api/price", PRICE_POLL_MS);
  const usage = usePoll("/api/usage", USAGE_POLL_MS);
  const spend = usePoll("/api/spend", SPEND_POLL_MS);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const elecPrice = price.data && price.data.electricity && price.data.electricity.current;
  const gasPrice = price.data && price.data.gas && price.data.gas.current;
  const elecUsage = usage.data && usage.data.electricity;
  const gasUsage = usage.data && usage.data.gas;
  const elecSpend = spend.data && spend.data.electricity;
  const gasSpend = spend.data && spend.data.gas;

  const stale = Boolean(price.error || usage.error || spend.error);

  return (
    <main className="dashboard">
      <header>
        <h1>Home Energy</h1>
        <div className="clock">{formatClock(now)}</div>
      </header>

      <div className="grid">
        <FuelCard
          title="Electricity"
          live={true}
          priceNow={formatPence(elecPrice && elecPrice.rate)}
          priceValidTo={elecPrice && formatTime(elecPrice.validTo)}
          usagePrimary={elecUsage ? formatDemand(elecUsage.demandWatts) : "no reading"}
          usageLabel={elecUsage ? `as of ${formatTime(elecUsage.readAt)}` : "Home Mini not reporting"}
          spend={elecSpend}
          tips={buildTips("electricity", elecSpend)}
        />
        <FuelCard
          title="Gas"
          live={false}
          priceNow={formatPence(gasPrice && gasPrice.rate)}
          priceValidTo={gasPrice && formatTime(gasPrice.validTo)}
          usagePrimary={gasUsage ? `${gasUsage.consumptionKwh} kWh` : "no reading"}
          usageLabel={
            gasUsage
              ? `${formatTime(gasUsage.intervalStart)}–${formatTime(gasUsage.intervalEnd)}`
              : "awaiting smart meter data"
          }
          usageSub="Gas meters report every 30 min with a delay, not truly live"
          spend={gasSpend}
          tips={buildTips("gas", gasSpend)}
        />
      </div>

      <footer>
        {stale ? (
          <span className="warn">Reconnecting… {price.error || usage.error || spend.error}</span>
        ) : (
          <span>
            Prices {price.fetchedAt ? formatClock(price.fetchedAt) : "--"} · Usage{" "}
            {usage.fetchedAt ? formatClock(usage.fetchedAt) : "--"} · Spend{" "}
            {spend.fetchedAt ? formatClock(spend.fetchedAt) : "--"}
          </span>
        )}
      </footer>

      <style jsx>{`
        .dashboard {
          min-height: 100vh;
          width: 100vw;
          padding: 1.5rem;
          display: flex;
          flex-direction: column;
          gap: 1.25rem;
        }
        header {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
        }
        h1 {
          font-size: 1.5rem;
          margin: 0;
          font-weight: 600;
          color: #d6dae3;
        }
        .clock {
          font-size: 1.5rem;
          font-variant-numeric: tabular-nums;
          color: #8890a0;
        }
        .grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1.25rem;
        }
        @media (max-aspect-ratio: 4/3) {
          .grid {
            grid-template-columns: 1fr;
          }
        }
        footer {
          text-align: center;
          color: #565c6b;
          font-size: 0.85rem;
        }
        .warn {
          color: #facc15;
        }
      `}</style>
    </main>
  );
}
