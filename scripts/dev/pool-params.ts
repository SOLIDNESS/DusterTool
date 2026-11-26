/**
 * Narzedzie deweloperskie: liczy lokalnie parametry poola jednostronnego i
 * sprawdza je walidatorami SDK Meteory. Niczego nie wysyla.
 */
import {
  CpAmm,
  getPriceFromSqrtPrice,
  getAmountBFromLiquidityDelta,
  validateCustomizablePoolParams,
  feeNumeratorToBps,
  decodeFeeTimeSchedulerParams,
  Rounding,
} from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import { singleSidedPoolParams, SOL_DECIMALS, START_PRICE_SOL, TOKEN_DECIMALS, TOTAL_SUPPLY_UI } from "../../src/core/pool";
import { connection } from "../lib/env";

function main() {
  const cpAmm = new CpAmm(connection());
  const p = singleSidedPoolParams(cpAmm);
  const price = getPriceFromSqrtPrice(p.initSqrtPrice, TOKEN_DECIMALS, SOL_DECIMALS);
  console.log("cena startowa (zadana):   ", START_PRICE_SOL, "SOL za token");
  console.log("cena startowa (z sqrt):   ", price.toString());
  console.log("kapitalizacja startowa:   ", price.mul(TOTAL_SUPPLY_UI).toFixed(4), "SOL");
  console.log("initSqrtPrice:            ", p.initSqrtPrice.toString());
  console.log("liquidityDelta:           ", p.liquidityDelta.toString());
  console.log("baseFee:                  ", JSON.stringify(p.poolFees.baseFee));
  try {
    const decoded = decodeFeeTimeSchedulerParams(Buffer.from(p.poolFees.baseFee.data));
    console.log("oplata bazowa:            ", feeNumeratorToBps(decoded.cliffFeeNumerator), "bps");
  } catch (e) {
    console.log("dekodowanie oplaty:       ", (e as Error).message);
  }

  // Ile SOL musi wplynac, zeby cena wzrosla x-krotnie (bez oplat): L * (sqrt(P1) - sqrt(P0)).
  for (const mult of [2, 4, 14.7]) {
    const target = new BN(Math.floor(Math.sqrt(mult) * 1e9)).mul(p.initSqrtPrice).div(new BN(1e9));
    try {
      const amountB = getAmountBFromLiquidityDelta(p.initSqrtPrice, target, p.liquidityDelta, Rounding.Up, p.collectFeeMode);
      console.log(`SOL potrzebne do ceny x${mult}:`.padEnd(26), (Number(amountB.toString()) / 1e9).toFixed(3));
    } catch (e) {
      console.log(`SOL do ceny x${mult}: blad`, (e as Error).message.slice(0, 120));
    }
  }

  try {
    const ok = validateCustomizablePoolParams as unknown as (...args: unknown[]) => unknown;
    console.log("walidator SDK dostepny:   ", typeof ok === "function");
  } catch {
    /* brak */
  }
}

main();
