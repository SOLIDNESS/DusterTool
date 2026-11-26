/**
 * Przygotowanie buybacku: ile SOL czeka w pozycji LP, ile z tego pojdzie na
 * odkup i jaka minimalna ilosc DUSTER wpisac do transakcji.
 */
import { CpAmm, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { buybackIx, dusterProgram, type ConfigAccount } from "../sdk/duster";
import type { Deployment } from "./deployment";
import { TOKEN_DECIMALS } from "./pool";
import { dusterQuoter } from "./program-convert";

export interface BuybackPlan {
  config: ConfigAccount;
  /** Sekundy do chwili, w ktorej program pozwoli na buyback (0 = mozna teraz). */
  waitSecs: number;
  claimableLamports: bigint;
  pendingStakerLamports: bigint;
  /** SOL, ktore ten buyback wyda na DUSTER. */
  spendLamports: bigint;
  expectedDuster: bigint;
  minDusterOut: bigint;
  instructions: TransactionInstruction[];
}

export async function planBuyback(
  conn: Connection,
  d: Deployment,
  cranker: PublicKey,
  opts: { slippageBps?: number; computeUnitPriceMicroLamports?: number } = {},
): Promise<BuybackPlan> {
  const program = dusterProgram(conn);
  const cpAmm = new CpAmm(conn);
  const [config, poolState, positionState, slot] = await Promise.all([
    program.account.config.fetch(d.refs.config),
    cpAmm.fetchPoolState(d.pool),
    cpAmm.fetchPositionState(d.position),
    conn.getSlot(),
  ]);
  // Dla najswiezszego slotu RPC bywa jeszcze bez czasu bloku; wtedy wystarcza zegar lokalny.
  const blockTime = (await conn.getBlockTime(slot).catch(() => null)) ?? Math.floor(Date.now() / 1000);

  const claimable = BigInt(getUnClaimLpFee(poolState, positionState).feeTokenB.toString());
  const pendingBefore = BigInt(config.pendingStakerLamports.toString());
  const pending = pendingBefore + (claimable * BigInt(config.stakerShareBps)) / 10_000n;
  const max = BigInt(config.maxBuybackLamports.toString());
  const hasStakers = BigInt(config.totalShares.toString()) > 0n;
  const spend = hasStakers ? (pending < max ? pending : max) : 0n;

  const expected = spend >= 1_000n ? dusterQuoter(cpAmm, poolState, TOKEN_DECIMALS, blockTime, slot).out(spend) : 0n;
  const minOut = (expected * BigInt(10_000 - (opts.slippageBps ?? 300))) / 10_000n;

  const due = config.lastBuyback.toNumber() + config.buybackInterval.toNumber();
  const treasuryWsol = getAssociatedTokenAddressSync(NATIVE_MINT, d.treasury, true);
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.computeUnitPriceMicroLamports ?? 0 }),
    createAssociatedTokenAccountIdempotentInstruction(cranker, treasuryWsol, d.treasury, NATIVE_MINT),
    await buybackIx(program, cranker, d.refs, d.treasury, d.position, d.positionNftAccount, new BN(minOut.toString())),
  ];
  return {
    config,
    waitSecs: Math.max(0, due - blockTime),
    claimableLamports: claimable,
    pendingStakerLamports: pendingBefore,
    spendLamports: spend,
    expectedDuster: expected,
    minDusterOut: minOut,
    instructions,
  };
}
