// Server-only client for the Octopus Energy REST + Kraken GraphQL APIs.
// Never import this from client components — it reads OCTOPUS_API_KEY.

const REST_BASE = "https://api.octopus.energy/v1";
const GRAPHQL_URL = "https://api.octopus.energy/v1/graphql/";

// Module-scoped caches. These only help within a warm serverless instance —
// that's fine, they just cut down on repeat auth/lookup calls, not required for correctness.
const cache = {
  token: null,
  tokenExpiry: 0,
  account: null,
  accountExpiry: 0,
};

function getEnv() {
  const apiKey = process.env.OCTOPUS_API_KEY;
  const accountNumber = process.env.OCTOPUS_ACCOUNT_NUMBER;
  if (!apiKey || !accountNumber) {
    throw new Error(
      "Missing OCTOPUS_API_KEY / OCTOPUS_ACCOUNT_NUMBER environment variables"
    );
  }
  return { apiKey, accountNumber };
}

function basicAuthHeader(apiKey) {
  return "Basic " + Buffer.from(`${apiKey}:`).toString("base64");
}

async function parseJsonResponse(res, label) {
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned a non-JSON response (${res.status}): ${raw.slice(0, 200)}`);
  }
}

// Follows Octopus's `next` pagination links, collecting every page's `results`.
async function fetchAllPages(initialUrl, { headers, treat404AsEmpty } = {}) {
  const results = [];
  let url = initialUrl;
  let guard = 0;
  while (url && guard < 50) {
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) {
      if (treat404AsEmpty && res.status === 404) return results;
      throw new Error(`Octopus request failed (${res.status}): ${url}`);
    }
    const body = await parseJsonResponse(res, "Octopus paginated request");
    results.push(...(body.results || []));
    url = body.next || null;
    guard++;
  }
  return results;
}

function pickCurrentFromSeries(series, nowMs) {
  if (!series || !series.length) return null;
  const current = series.find((s) => {
    const from = new Date(s.validFrom).getTime();
    const to = s.validTo ? new Date(s.validTo).getTime() : Infinity;
    return from <= nowMs && nowMs < to;
  });
  if (current) return current;
  return [...series].sort((a, b) => new Date(b.validFrom) - new Date(a.validFrom))[0] || null;
}

async function graphqlRequest(query, variables, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `JWT ${token}`;

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  const raw = await res.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(
      `Octopus GraphQL request failed (${res.status}): ${raw.slice(0, 200)}`
    );
  }
  if (body.errors && body.errors.length) {
    throw new Error(`Octopus GraphQL error: ${body.errors[0].message}`);
  }
  return body.data;
}

async function obtainKrakenToken() {
  if (cache.token && cache.tokenExpiry > Date.now()) {
    return cache.token;
  }

  const { apiKey } = getEnv();
  const query = `
    mutation ObtainKrakenToken($apiKey: String!) {
      obtainKrakenToken(input: { APIKey: $apiKey }) {
        token
      }
    }
  `;
  const data = await graphqlRequest(query, { apiKey }, null);
  const token = data && data.obtainKrakenToken && data.obtainKrakenToken.token;
  if (!token) throw new Error("Octopus: failed to obtain Kraken token (check API key)");

  cache.token = token;
  cache.tokenExpiry = Date.now() + 55 * 60 * 1000; // tokens last ~60min, refresh a bit early
  return token;
}

function pickCurrentAgreement(agreements, now) {
  if (!agreements || !agreements.length) return null;
  const active = agreements.find((a) => {
    const from = new Date(a.validFrom).getTime();
    const to = a.validTo ? new Date(a.validTo).getTime() : Infinity;
    return from <= now && now < to;
  });
  if (active) return active;
  // Fall back to the most recently started agreement if none matches exactly.
  return [...agreements].sort(
    (a, b) => new Date(b.validFrom) - new Date(a.validFrom)
  )[0];
}

async function fetchAccountDetails() {
  if (cache.account && cache.accountExpiry > Date.now()) {
    return cache.account;
  }

  const { accountNumber } = getEnv();
  const token = await obtainKrakenToken();

  const query = `
    query GetAccount($accountNumber: String!) {
      account(accountNumber: $accountNumber) {
        electricityAgreements(active: true) {
          meterPoint {
            mpan
            meters(includeInactive: false) {
              serialNumber
              smartImportElectricityMeter {
                deviceId
              }
            }
            agreements(includeInactive: true) {
              validFrom
              validTo
              tariff {
                ... on TariffType {
                  productCode
                  tariffCode
                }
              }
            }
          }
        }
        gasAgreements(active: true) {
          meterPoint {
            mprn
            meters(includeInactive: false) {
              serialNumber
            }
            agreements(includeInactive: true) {
              validFrom
              validTo
              tariff {
                ... on TariffType {
                  productCode
                  tariffCode
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphqlRequest(query, { accountNumber }, token);
  const account = data && data.account;
  if (!account) throw new Error("Octopus: account not found (check account number)");

  const now = Date.now();

  const elecAgreement = account.electricityAgreements && account.electricityAgreements[0];
  const elecMeterPoint = elecAgreement && elecAgreement.meterPoint;
  const elecMeter = elecMeterPoint && elecMeterPoint.meters && elecMeterPoint.meters[0];
  const elecTariff = elecMeterPoint
    ? pickCurrentAgreement(elecMeterPoint.agreements, now)
    : null;

  const gasAgreement = account.gasAgreements && account.gasAgreements[0];
  const gasMeterPoint = gasAgreement && gasAgreement.meterPoint;
  const gasMeter = gasMeterPoint && gasMeterPoint.meters && gasMeterPoint.meters[0];
  const gasTariff = gasMeterPoint
    ? pickCurrentAgreement(gasMeterPoint.agreements, now)
    : null;

  const result = {
    electricity: elecMeterPoint
      ? {
          mpan: elecMeterPoint.mpan,
          serialNumber: elecMeter && elecMeter.serialNumber,
          deviceId:
            elecMeter &&
            elecMeter.smartImportElectricityMeter &&
            elecMeter.smartImportElectricityMeter.deviceId,
          productCode: elecTariff && elecTariff.tariff && elecTariff.tariff.productCode,
          tariffCode: elecTariff && elecTariff.tariff && elecTariff.tariff.tariffCode,
        }
      : null,
    gas: gasMeterPoint
      ? {
          mprn: gasMeterPoint.mprn,
          serialNumber: gasMeter && gasMeter.serialNumber,
          productCode: gasTariff && gasTariff.tariff && gasTariff.tariff.productCode,
          tariffCode: gasTariff && gasTariff.tariff && gasTariff.tariff.tariffCode,
        }
      : null,
  };

  cache.account = result;
  cache.accountExpiry = Date.now() + 60 * 60 * 1000; // tariffs/meters rarely change; re-check hourly
  return result;
}

async function fetchRatesForPeriod(fuel, productCode, tariffCode, periodFrom, periodTo) {
  if (!productCode || !tariffCode) return [];

  const segment = fuel === "gas" ? "gas-tariffs" : "electricity-tariffs";
  const url =
    `${REST_BASE}/products/${encodeURIComponent(productCode)}/${segment}/${encodeURIComponent(tariffCode)}/standard-unit-rates/` +
    `?period_from=${periodFrom}&period_to=${periodTo}&page_size=1500`;

  const results = await fetchAllPages(url, { treat404AsEmpty: true });
  return results
    .map((r) => ({ rate: r.value_inc_vat, validFrom: r.valid_from, validTo: r.valid_to }))
    .sort((a, b) => new Date(a.validFrom) - new Date(b.validFrom));
}

async function fetchRate(fuel, productCode, tariffCode) {
  if (!productCode || !tariffCode) return null;

  const now = new Date();
  const periodFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const periodTo = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const series = await fetchRatesForPeriod(fuel, productCode, tariffCode, periodFrom, periodTo);
  return { current: pickCurrentFromSeries(series, now.getTime()), series };
}

async function fetchStandingCharge(fuel, productCode, tariffCode) {
  if (!productCode || !tariffCode) return null;

  const segment = fuel === "gas" ? "gas-tariffs" : "electricity-tariffs";
  const now = new Date();
  const periodFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const periodTo = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const url =
    `${REST_BASE}/products/${encodeURIComponent(productCode)}/${segment}/${encodeURIComponent(tariffCode)}/standard-standing-charges/` +
    `?period_from=${periodFrom}&period_to=${periodTo}&page_size=100`;

  const results = await fetchAllPages(url, { treat404AsEmpty: true });
  const series = results
    .map((r) => ({ rate: r.value_inc_vat, validFrom: r.valid_from, validTo: r.valid_to }))
    .sort((a, b) => new Date(a.validFrom) - new Date(b.validFrom));

  return pickCurrentFromSeries(series, now.getTime());
}

async function fetchConsumptionForPeriod(fuel, meterPointId, serial, periodFrom, periodTo) {
  if (!meterPointId || !serial) return [];

  const { apiKey } = getEnv();
  const segment = fuel === "gas" ? "gas-meter-points" : "electricity-meter-points";
  const url =
    `${REST_BASE}/${segment}/${encodeURIComponent(meterPointId)}/meters/${encodeURIComponent(serial)}/consumption/` +
    `?period_from=${periodFrom}&period_to=${periodTo}&order_by=period&page_size=1500`;

  const results = await fetchAllPages(url, {
    headers: { Authorization: basicAuthHeader(apiKey) },
    treat404AsEmpty: true,
  });

  return results
    .map((r) => ({
      consumptionKwh: r.consumption,
      intervalStart: r.interval_start,
      intervalEnd: r.interval_end,
    }))
    .sort((a, b) => new Date(a.intervalStart) - new Date(b.intervalStart));
}

async function fetchLatestConsumption(fuel, meterPointId, serial) {
  if (!meterPointId || !serial) return null;

  const { apiKey } = getEnv();
  const segment = fuel === "gas" ? "gas-meter-points" : "electricity-meter-points";
  const url =
    `${REST_BASE}/${segment}/${encodeURIComponent(meterPointId)}/meters/${encodeURIComponent(serial)}/consumption/` +
    `?order_by=-period&page_size=1`;

  const res = await fetch(url, {
    headers: { Authorization: basicAuthHeader(apiKey) },
    cache: "no-store",
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Octopus consumption request failed (${res.status}) for ${fuel}`);
  }
  const body = await parseJsonResponse(res, `Octopus consumption (${fuel})`);
  const latest = body.results && body.results[0];
  if (!latest) return null;

  return {
    consumptionKwh: latest.consumption,
    intervalStart: latest.interval_start,
    intervalEnd: latest.interval_end,
  };
}

async function fetchElectricityTelemetry(deviceId) {
  if (!deviceId) return null;

  const token = await obtainKrakenToken();
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  const end = now.toISOString();

  const query = `
    query GetTelemetry($deviceId: String!, $start: DateTime!, $end: DateTime!) {
      smartMeterTelemetry(deviceId: $deviceId, grouping: HALF_HOURLY, start: $start, end: $end) {
        readAt
        consumptionDelta
        demand
      }
    }
  `;
  const data = await graphqlRequest(query, { deviceId, start, end }, token);
  const readings = (data && data.smartMeterTelemetry) || [];
  if (!readings.length) return null;

  const latest = readings.reduce((a, b) =>
    new Date(a.readAt) > new Date(b.readAt) ? a : b
  );

  return {
    demandWatts: latest.demand != null ? Number(latest.demand) : null,
    consumptionDeltaWh:
      latest.consumptionDelta != null ? Number(latest.consumptionDelta) : null,
    readAt: latest.readAt,
  };
}

export {
  fetchAccountDetails,
  fetchRate,
  fetchRatesForPeriod,
  fetchStandingCharge,
  fetchLatestConsumption,
  fetchConsumptionForPeriod,
  fetchElectricityTelemetry,
};
