import {
  fetchAccountDetails,
  fetchElectricityTelemetry,
  fetchLatestConsumption,
} from "../../../lib/octopus";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const account = await fetchAccountDetails();

    const [electricity, gas] = await Promise.all([
      account.electricity && account.electricity.deviceId
        ? fetchElectricityTelemetry(account.electricity.deviceId)
        : null,
      account.gas
        ? fetchLatestConsumption("gas", account.gas.mprn, account.gas.serialNumber)
        : null,
    ]);

    return Response.json({
      electricity: electricity ? { ...electricity, live: true } : null,
      gas: gas ? { ...gas, live: false } : null,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json(
      { error: err.message || "Failed to fetch usage" },
      { status: 502 }
    );
  }
}
