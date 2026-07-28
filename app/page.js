"use client";

import { useEffect, useRef, useState } from "react";

const PRICE_POLL_MS = 5 * 60 * 1000; // Tracker rates change at most daily
const USAGE_POLL_MS = 30 * 1000; // Home Mini reports roughly every 10-30s
const CLOCK_TICK_MS = 1000;

function formatClock(date) {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatTime(iso) {
  if (!iso) return "--:--";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatPence(rate) {
  if (rate == null) return "--";
  return `${rate.toFixed(1)}p`;
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

function StatusBadge({ live }) {
  return (
    <span className={`badge ${live ? "live" : "delayed"}`}>
      {live ? "LIVE" : "DELAYED"}
      <style jsx>{`
        .badge {
          font-size: 0.7rem;
          letter-spacing: 0.08em;
          padding: 0.2rem 0.5rem;
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

function FuelCard({ title, priceNow, priceValidTo, usagePrimary, usageLabel, usageSub, live, note }) {
  return (
    <section className="card">
      <div className="row">
        <h2>{title}</h2>
        <StatusBadge live={live} />
      </div>

      <div className="price">{priceNow}</div>
      <div className="sub">p/kWh {priceValidTo ? `· until ${priceValidTo}` : ""}</div>

      <div className="usage">{usagePrimary}</div>
      <div className="sub">{usageLabel}</div>
      {usageSub && <div className="sub faint">{usageSub}</div>}
      {note && <div className="note">{note}</div>}

      <style jsx>{`
        .card {
          background: #14171f;
          border-radius: 1.25rem;
          padding: 2rem 2.5rem;
          display: flex;
          flex-direction: column;
          justify-content: center;
          min-height: 0;
        }
        .row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 0.5rem;
        }
        h2 {
          font-size: 1.4rem;
          font-weight: 600;
          color: #aeb4c2;
          margin: 0;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .price {
          font-size: clamp(3rem, 9vw, 6rem);
          font-weight: 700;
          line-height: 1;
        }
        .usage {
          font-size: clamp(1.6rem, 4vw, 2.5rem);
          font-weight: 600;
          margin-top: 1.25rem;
          color: #d6dae3;
        }
        .sub {
          color: #8890a0;
          font-size: 1.1rem;
          margin-top: 0.25rem;
        }
        .faint {
          opacity: 0.7;
          font-size: 0.95rem;
        }
        .note {
          color: #facc15;
          font-size: 0.95rem;
          margin-top: 0.75rem;
        }
      `}</style>
    </section>
  );
}

export default function Page() {
  const [now, setNow] = useState(new Date());
  const price = usePoll("/api/price", PRICE_POLL_MS);
  const usage = usePoll("/api/usage", USAGE_POLL_MS);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const elecPrice = price.data && price.data.electricity && price.data.electricity.current;
  const gasPrice = price.data && price.data.gas && price.data.gas.current;
  const elecUsage = usage.data && usage.data.electricity;
  const gasUsage = usage.data && usage.data.gas;

  const stale = Boolean(price.error || usage.error);

  return (
    <main className="dashboard">
      <header>
        <h1>Home Energy</h1>
        <div className="clock">{formatClock(now)}</div>
      </header>

      <div className="grid">
        <FuelCard
          title="Electricity"
          priceNow={formatPence(elecPrice && elecPrice.rate)}
          priceValidTo={elecPrice && formatTime(elecPrice.validTo)}
          usagePrimary={elecUsage ? formatDemand(elecUsage.demandWatts) : "no reading"}
          usageLabel={elecUsage ? `as of ${formatTime(elecUsage.readAt)}` : "Home Mini not reporting"}
          live={true}
        />
        <FuelCard
          title="Gas"
          priceNow={formatPence(gasPrice && gasPrice.rate)}
          priceValidTo={gasPrice && formatTime(gasPrice.validTo)}
          usagePrimary={gasUsage ? `${gasUsage.consumptionKwh} kWh` : "no reading"}
          usageLabel={
            gasUsage
              ? `${formatTime(gasUsage.intervalStart)}–${formatTime(gasUsage.intervalEnd)}`
              : "awaiting smart meter data"
          }
          usageSub="Gas meters report every 30 min with a delay, not truly live"
          live={false}
        />
      </div>

      <footer>
        {stale ? (
          <span className="warn">
            Reconnecting… {price.error || usage.error}
          </span>
        ) : (
          <span>
            Prices updated {price.fetchedAt ? formatClock(price.fetchedAt) : "--"} · Usage updated{" "}
            {usage.fetchedAt ? formatClock(usage.fetchedAt) : "--"}
          </span>
        )}
      </footer>

      <style jsx>{`
        .dashboard {
          height: 100vh;
          width: 100vw;
          padding: 2rem;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }
        header {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
        }
        h1 {
          font-size: 1.6rem;
          margin: 0;
          font-weight: 600;
          color: #d6dae3;
        }
        .clock {
          font-size: 1.6rem;
          font-variant-numeric: tabular-nums;
          color: #8890a0;
        }
        .grid {
          flex: 1;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1.5rem;
          min-height: 0;
        }
        @media (max-aspect-ratio: 4/3) {
          .grid {
            grid-template-columns: 1fr;
          }
        }
        footer {
          text-align: center;
          color: #565c6b;
          font-size: 0.95rem;
        }
        .warn {
          color: #facc15;
        }
      `}</style>
    </main>
  );
}
