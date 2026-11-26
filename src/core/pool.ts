/**
 * Parametry poola DUSTER/SOL na Meteora DAMM v2.
 *
 * Pool jednostronny: wplacamy wylacznie tokeny, a cena startowa jest
 * jednoczesnie cena minimalna. Oplata 2% jest stala i zbierana tylko w SOL.
 */
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  CpAmm,
  getBaseFeeParams,
  getSqrtPriceFromPrice,
  MAX_SQRT_PRICE,
  type PoolFeesParams,
} from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";

export const TOKEN_DECIMALS = 6;
export const SOL_DECIMALS = 9;
/** Podaz jak na pump.fun: 1 mld tokenow z 6 miejscami po przecinku. */
export const TOTAL_SUPPLY_UI = 1_000_000_000;
export const TOTAL_SUPPLY_RAW = new BN(TOTAL_SUPPLY_UI).mul(new BN(10).pow(new BN(TOKEN_DECIMALS)));

/**
 * Cena startowa pump.fun: 30 SOL wirtualnej rezerwy na 1,073 mld tokenow,
 * czyli ok. 0,000000027959 SOL za token (kapitalizacja ok. 27,96 SOL).
 */
export const START_PRICE_SOL = (30 / 1_073_000_000).toFixed(18);

export const POOL_FEE_BPS = 200;

export function poolFees(): PoolFeesParams {
  // Harmonogram z ta sama oplata na poczatku i na koncu daje stale 2%.
  const baseFee = getBaseFeeParams({
    baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
    feeTimeSchedulerParam: {
      startingFeeBps: POOL_FEE_BPS,
      endingFeeBps: POOL_FEE_BPS,
      numberOfPeriod: 0,
      totalDuration: 0,
    },
  });
  return { baseFee, compoundingFeeBps: 0, padding: 0, dynamicFee: null };
}

export interface SingleSidedPoolParams {
  tokenAAmount: BN;
  tokenBAmount: BN;
  initSqrtPrice: BN;
  sqrtMinPrice: BN;
  sqrtMaxPrice: BN;
  liquidityDelta: BN;
  poolFees: PoolFeesParams;
  collectFeeMode: CollectFeeMode;
  activationType: ActivationType;
}

export function singleSidedPoolParams(cpAmm: CpAmm, tokenAAmount: BN = TOTAL_SUPPLY_RAW): SingleSidedPoolParams {
  const initSqrtPrice = getSqrtPriceFromPrice(START_PRICE_SOL, TOKEN_DECIMALS, SOL_DECIMALS);
  const liquidityDelta = cpAmm.preparePoolCreationSingleSide({
    tokenAAmount,
    minSqrtPrice: initSqrtPrice,
    maxSqrtPrice: MAX_SQRT_PRICE,
    initSqrtPrice,
    collectFeeMode: CollectFeeMode.OnlyB,
  });
  return {
    tokenAAmount,
    tokenBAmount: new BN(0),
    initSqrtPrice,
    sqrtMinPrice: initSqrtPrice,
    sqrtMaxPrice: MAX_SQRT_PRICE,
    liquidityDelta,
    poolFees: poolFees(),
    collectFeeMode: CollectFeeMode.OnlyB,
    activationType: ActivationType.Timestamp,
  };
}
