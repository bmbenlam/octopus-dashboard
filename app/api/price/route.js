import { fetchAccountDetails, fetchRate } from "../../../lib/octopus";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const account = await fetchAccountDetails();

    const [electricity, gas] = await Promise.all([
      account.electricity
        ? fetchRate("electricity", account.electricity.productCode, account.electricity.tariffCode)
        : null,
      account.gas ? fetchRate("gas", account.gas.productCode, account.gas.tariffCode) : null,
    ]);

    return Response.json({
      electricity,
      gas,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json(
      { error: err.message || "Failed to fetch prices" },
      { status: 502 }
    );
  }
}
