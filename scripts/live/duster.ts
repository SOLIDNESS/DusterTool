/**
 * Obsluga wdrozenia na mainnecie. Kazde polecenie domyslnie tylko symuluje
 * transakcje; dopiero flaga --send ja wysyla. Uzywane sa wylacznie portfele z keys/.
 *
 *   npx tsx scripts/live/duster.ts status
 *   npx tsx scripts/live/duster.ts audit             kontrola ksiag programu i lista stakujacych (tylko odczyt)
 *   npx tsx scripts/live/duster.ts init              (deployer) konfiguracja programu, delegacja oplat, tabela adresow
 *   npx tsx scripts/live/duster.ts buy 0.05          (tester)   zakup tokena na poolu
 *   npx tsx scripts/live/duster.ts stake 100000      (tester)
 *   npx tsx scripts/live/duster.ts unstake           (tester)   wyplata calosci
 *   npx tsx scripts/live/duster.ts buyback           (crank)
 *   npx tsx scripts/live/duster.ts convert [limit]   (tester)   wymiana martwych tokenow przez program
 *
 * Wdrozenie wybiera zmienna DEPLOYMENT (domyslnie 'test').
 */
import { BN } from "@coral-xyz/anchor";
import { CpAmm, encodeDelegatePermissions, getUnClaimLpFee, PositionDelegatePermission } from "@meteora-ag/cp-amm-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import { planBuyback } from "../../src/core/buyback";
import type { Deployment } from "../../src/core/deployment";
import { lookupAddresses } from "../../src/core/lookup";
import { TOKEN_DECIMALS } from "../../src/core/pool";
import { buildItems, isConvertible, loadPlanContext, planConversion } from "../../src/core/plan";
import { jupiterRouter } from "../../src/core/route";
import { scanWallet } from "../../src/core/scan";
import {
  dusterProgram,
  effectiveAssets,
  initializeIx,
  sharesToAssets,
  unreleasedAt,
  stakeIx,
  UNSTAKE_ALL,
  unstakeIx,
  userStakePda,
} from "../../src/sdk/duster";
import { loadDeployment, readDeploymentFile, writeDeploymentFile } from "../lib/deployment";
import { connection, loadWallet, sleep } from "../lib/env";
import { hasFlag, positional, simulateOrSend } from "../lib/tx";

const SEND = hasFlag("send");
const PRIORITY = Number(process.env.PRIORITY_MICROLAMPORTS ?? 20_000);
// Portfel z mainnetu z wieloma martwymi tokenami: z niego wyznaczamy wspolne adresy pump.fun do tabeli adresow.
const SAMPLE_WALLET = new PublicKey(process.env.ALT_SAMPLE_WALLET ?? "Gygj9QQby4j2jryqyqBHvLP7ctv2SaANgh4sCb69BUpA");
const sol = (l: number | bigint) => (Number(l) / LAMPORTS_PER_SOL).toFixed(6);
const ui = (raw: bigint | BN) => (Number(raw.toString()) / 10 ** TOKEN_DECIMALS).toLocaleString("en-US", { maximumFractionDigits: 2 });
const budget = (units: number) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY }),
];

async function status(conn: Connection, d: Deployment) {
  const program = dusterProgram(conn);
  const cpAmm = new CpAmm(conn);
  console.log(`token ${d.mint.toBase58()}\npool  ${d.pool.toBase58()}\nconfig ${d.refs.config.toBase58()}`);
  const info = await conn.getAccountInfo(d.refs.config);
  if (!info) {
    console.log("program nie jest jeszcze skonfigurowany (uruchom: init)");
    return;
  }
  const c = await program.account.config.fetch(d.refs.config);
  const [poolState, positionState] = await Promise.all([cpAmm.fetchPoolState(d.pool), cpAmm.fetchPositionState(d.position)]);
  const claimable = getUnClaimLpFee(poolState, positionState).feeTokenB;
  const now = Math.floor(Date.now() / 1000);
  console.table({
    "fee od rentu (bps)": c.rentFeeBps,
    "udzial stakujacych (bps)": c.stakerShareBps,
    "interwal buybacku (s)": c.buybackInterval.toNumber(),
    wstrzymany: c.paused,
    "stakowane DUSTER": ui(c.totalAssets),
    "udzialy": c.totalShares.toString(),
    "oplaty do odebrania (SOL)": sol(BigInt(claimable.toString())),
    "czeka na odkup (SOL)": sol(BigInt(c.pendingStakerLamports.toString())),
    "nastepny buyback za (s)": Math.max(0, c.lastBuyback.toNumber() + c.buybackInterval.toNumber() - now),
    wymiany: c.totalConversions.toString(),
    "zamkniete konta": c.totalAccountsClosed.toString(),
    "fee od rentu razem (SOL)": sol(BigInt(c.totalRentFeeLamports.toString())),
    "sprzedane smieci (SOL)": sol(BigInt(c.totalSaleLamports.toString())),
    "DUSTER dla uzytkownikow": ui(c.totalDusterToUsers),
    "buyback razem (SOL)": sol(BigInt(c.totalBuybackLamports.toString())),
    "buyback razem (DUSTER)": ui(c.totalBuybackDuster),
    "treasury z poola (SOL)": sol(BigInt(c.totalTreasuryLamports.toString())),
  });
}

/**
 * Kontrola ksiag programu na zywo (tylko odczyt): czy to, co program ma zapisane, zgadza sie
 * z tym, co faktycznie lezy na jego kontach, i ile przypada kazdemu stakujacemu.
 */
async function audit(conn: Connection, d: Deployment) {
  const program = dusterProgram(conn);
  const big = (v: { toString(): string }) => BigInt(v.toString());
  const tokens = async (account: PublicKey) => BigInt((await conn.getTokenAccountBalance(account).catch(() => null))?.value.amount ?? "0");
  const treasuryWsol = getAssociatedTokenAddressSync(NATIVE_MINT, d.treasury);
  const [c, allStakes, vault, feeWsol, swapWsol, treasuryWsolBalance, treasurySol] = await Promise.all([
    program.account.config.fetch(d.refs.config),
    program.account.userStake.all(),
    tokens(d.refs.stakeVault),
    tokens(d.refs.feeWsol),
    tokens(d.refs.swapWsol),
    tokens(treasuryWsol),
    conn.getBalance(d.treasury),
  ]);
  // Tylko konta stakingu nalezace do naszej konfiguracji.
  const stakes = allStakes.filter((s) => userStakePda(d.refs.config, s.account.owner).equals(s.publicKey));
  const now = Date.now() / 1000;
  const totalShares = big(c.totalShares);
  const totalAssets = big(c.totalAssets);
  const locked = unreleasedAt(c, now);
  const effective = effectiveAssets(c, now);
  const pending = big(c.pendingStakerLamports);
  const claimed = big(c.totalFeesClaimedLamports);
  const toTreasury = big(c.totalTreasuryLamports);
  const spent = big(c.totalBuybackLamports);

  console.log("Stakujacy:");
  let sharesSum = 0n;
  let valueSum = 0n;
  const rows = stakes
    .map((s) => ({ owner: s.account.owner.toBase58(), shares: big(s.account.shares), deposited: big(s.account.deposited) }))
    .sort((x, y) => (y.shares > x.shares ? 1 : -1));
  for (const r of rows) {
    const value = sharesToAssets(c, r.shares, now);
    sharesSum += r.shares;
    valueSum += value;
    const share = totalShares > 0n ? (Number((r.shares * 1_000_000n) / totalShares) / 10_000).toFixed(2) : "0";
    console.log(`  ${r.owner}  ${share}% puli  wplacone ${ui(r.deposited)}  do wyplaty teraz ${ui(value)}  nagrody ${ui(value - r.deposited)}`);
  }
  if (!rows.length) console.log("  (nikt nie stakuje)");

  let failed = 0;
  const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) failed++;
    console.log(`  ${ok ? "OK  " : "BLAD"} ${name}: ${detail}`);
  };
  console.log("\nKontrola:");
  check("udzialy stakujacych sumuja sie do puli", sharesSum === totalShares, `${sharesSum} z ${totalShares}`);
  check("skarbiec stakingu ma co najmniej tyle DUSTER, ile program jest winien", vault >= totalAssets, `w skarbcu ${ui(vault)}, zapisane ${ui(totalAssets)}`);
  check(
    "suma wyplat wszystkich stakujacych miesci sie w puli",
    valueSum <= effective && effective + locked <= totalAssets,
    `do wyplaty ${ui(valueSum)}, uwolnione ${ui(effective)}, jeszcze nieuwolnione ${ui(locked)}`,
  );
  check("SOL czekajacy na odkup lezy na koncie programu", feeWsol >= pending, `na koncie ${sol(feeWsol)}, czeka ${sol(pending)}`);
  check("konto przejsciowe wymiany jest puste", swapWsol === 0n, sol(swapWsol));
  check(
    "oplaty z poola rozliczone co do lamporta",
    claimed === toTreasury + spent + pending,
    `odebrane ${sol(claimed)} = treasury ${sol(toTreasury)} + odkup ${sol(spent)} + czeka ${sol(pending)}`,
  );
  // Kazdy buyback zaokragla czesc stakujacych w dol, wiec moze im brakowac najwyzej 1 lamporta na buyback.
  const stakerSide = spent + pending;
  const rounding = (claimed * BigInt(c.stakerShareBps)) / 10_000n - stakerSide;
  check(
    `podzial zgodny z konfiguracja (${c.stakerShareBps / 100}% dla stakujacych)`,
    rounding >= 0n && rounding <= 10_000n,
    `stakujacy ${sol(stakerSide)}, treasury ${sol(toTreasury)}, zaokraglenia ${rounding} lamportow`,
  );
  console.log(`\nTreasury ${d.treasury.toBase58()}: ${sol(treasurySol)} SOL + ${sol(treasuryWsolBalance)} wSOL`);
  console.log(failed ? `\n${failed} kontroli NIE przeszlo.` : "\nWszystkie kontrole przeszly.");
  if (failed) process.exitCode = 1;
}

async function init(conn: Connection) {
  const deployer = loadWallet("deployer");
  const treasury = loadWallet("treasury").publicKey;
  const file = readDeploymentFile();
  if (!file.mint || !file.pool || !file.position || !file.positionNftAccount) {
    throw new Error("Najpierw utworz token i pool: npx tsx scripts/live/setup-token-pool.ts --send");
  }
  file.treasury = treasury.toBase58();
  writeDeploymentFile(file);
  const d = loadDeployment();
  const program = dusterProgram(conn);
  const cpAmm = new CpAmm(conn);

  // 1. Konfiguracja programu. Treasury musi miec minimalne saldo, inaczej drobne przelewy fee sa odrzucane.
  if (!(await conn.getAccountInfo(d.refs.config))) {
    const ixs: TransactionInstruction[] = [...budget(200_000)];
    const minBalance = await conn.getMinimumBalanceForRentExemption(0);
    const treasuryBalance = await conn.getBalance(treasury);
    if (treasuryBalance < minBalance) {
      ixs.push(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: treasury, lamports: minBalance - treasuryBalance + 100_000 }));
    }
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, getAssociatedTokenAddressSync(NATIVE_MINT, treasury), treasury, NATIVE_MINT),
      await initializeIx(program, deployer.publicKey, d.refs, d.position, {
        treasury,
        rentFeeBps: 500,
        stakerShareBps: 5000,
        buybackIntervalSecs: 3600,
        releaseDurationSecs: 3600,
        maxBuybackLamports: new BN(2 * LAMPORTS_PER_SOL),
        minStake: new BN(1_000 * 10 ** TOKEN_DECIMALS),
      }),
    );
    const r = await simulateOrSend(conn, ixs, [deployer], { send: SEND, label: "konfiguracja programu" });
    if (r.signature && !r.error) file.signatures.initialize = r.signature;
  } else {
    console.log("konfiguracja programu: juz istnieje");
  }

  // 2. Delegacja odbioru oplat z pozycji LP na program. Pozycja zostaje u wlasciciela.
  const position = await cpAmm.fetchPositionState(d.position).catch(() => null);
  if (position && !file.signatures.delegate) {
    const tx = await cpAmm.updateDelegatePermission({
      owner: deployer.publicKey,
      position: d.position,
      positionNftAccount: d.positionNftAccount,
      delegate: d.refs.config,
      permission: encodeDelegatePermissions([PositionDelegatePermission.ClaimPositionFee]),
    });
    const r = await simulateOrSend(conn, [...budget(100_000), ...tx.instructions], [deployer], { send: SEND, label: "delegacja oplat" });
    if (r.signature && !r.error) file.signatures.delegate = r.signature;
  }

  // 3. Tabela adresow.
  if (!file.lookupTable) {
    const unique = await lookupAddresses(d, await scanWallet(conn, SAMPLE_WALLET));
    console.log(`tabela adresow: ${unique.length} adresow`);
    if (SEND) {
      const slot = await conn.getSlot("finalized");
      const [createIx, table] = AddressLookupTableProgram.createLookupTable({ authority: deployer.publicKey, payer: deployer.publicKey, recentSlot: slot });
      const r = await simulateOrSend(conn, [...budget(50_000), createIx], [deployer], { send: true, label: "tabela adresow" });
      if (r.signature && !r.error) {
        file.lookupTable = table.toBase58();
        writeDeploymentFile(file);
        for (let i = 0; i < unique.length; i += 20) {
          await sleep(1000);
          await simulateOrSend(
            conn,
            [
              ...budget(50_000),
              AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: deployer.publicKey, payer: deployer.publicKey, addresses: unique.slice(i, i + 20) }),
            ],
            [deployer],
            { send: true, label: `tabela adresow ${i + 1}-${Math.min(i + 20, unique.length)}` },
          );
        }
      }
    }
  } else {
    console.log(`tabela adresow: ${file.lookupTable}`);
  }
  writeDeploymentFile(file);
}

async function buy(conn: Connection, d: Deployment, amountSol: number) {
  const tester = loadWallet("tester");
  const cpAmm = new CpAmm(conn);
  const tx = await cpAmm.swap({
    payer: tester.publicKey,
    pool: d.pool,
    inputTokenMint: NATIVE_MINT,
    outputTokenMint: d.mint,
    amountIn: new BN(Math.round(amountSol * LAMPORTS_PER_SOL)),
    minimumAmountOut: new BN(0),
    tokenAMint: d.mint,
    tokenBMint: NATIVE_MINT,
    tokenAVault: d.refs.tokenAVault,
    tokenBVault: d.refs.tokenBVault,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    referralTokenAccount: null,
  });
  await simulateOrSend(conn, [...budget(200_000), ...tx.instructions], [tester], { send: SEND, label: `zakup za ${amountSol} SOL` });
}

async function stake(conn: Connection, d: Deployment, amountUi: number) {
  const tester = loadWallet("tester");
  const amount = new BN(Math.round(amountUi * 10 ** TOKEN_DECIMALS));
  const ix = await stakeIx(dusterProgram(conn), tester.publicKey, d.refs, amount);
  await simulateOrSend(conn, [...budget(100_000), ix], [tester], { send: SEND, label: `stake ${amountUi}` });
}

async function unstake(conn: Connection, d: Deployment) {
  const tester = loadWallet("tester");
  const program = dusterProgram(conn);
  const [c, s] = await Promise.all([
    program.account.config.fetch(d.refs.config),
    program.account.userStake.fetchNullable(userStakePda(d.refs.config, tester.publicKey)),
  ]);
  if (!s) return console.log("brak stakingu na portfelu tester");
  console.log(`wartosc stakingu: ${ui(sharesToAssets(c, BigInt(s.shares.toString()), Date.now() / 1000))} (wplacono ${ui(s.deposited)})`);
  const ix = await unstakeIx(program, tester.publicKey, d.refs, UNSTAKE_ALL);
  await simulateOrSend(conn, [...budget(100_000), ix], [tester], { send: SEND, label: "unstake" });
}

async function buyback(conn: Connection, d: Deployment) {
  const crank = loadWallet("crank");
  const plan = await planBuyback(conn, d, crank.publicKey, { computeUnitPriceMicroLamports: PRIORITY });
  console.log(
    `do odebrania ${sol(plan.claimableLamports)} SOL, czeka ${sol(plan.pendingStakerLamports)} SOL, odkup za ${sol(plan.spendLamports)} SOL -> ok. ${ui(plan.expectedDuster)} DUSTER`,
  );
  if (plan.waitSecs > 0) console.log(`uwaga: program pozwoli na buyback za ${plan.waitSecs} s`);
  await simulateOrSend(conn, plan.instructions, [crank], { send: SEND, label: "buyback" });
}

async function convert(conn: Connection, d: Deployment, limit: number) {
  const tester = loadWallet("tester");
  // Tak jak aplikacja: tokeny sparowane z inna waluta niz SOL ida przez agregator Jupiter.
  const router = jupiterRouter(conn);
  const scan = await scanWallet(conn, tester.publicKey, { router });
  const ctx = await loadPlanContext(conn, d, scan, { priorityMicroLamports: PRIORITY }, router);
  if (!ctx.lookupTables.length) console.log("uwaga: brak tabeli adresow, paczki beda mniejsze");

  const items = await buildItems(ctx, scan.accounts.filter((a) => isConvertible(a, d)).slice(0, limit));
  if (!items.length) return console.log("brak kont do wymiany");
  const plan = planConversion(ctx, items);
  console.log(
    `${plan.accounts} kont w ${plan.batches.length} transakcjach: rent ${sol(plan.rentLamports)} SOL (fee ${sol(plan.feeLamports)}), sprzedaz ${sol(plan.saleLamports)} SOL -> ok. ${ui(plan.dusterOut)} DUSTER`,
  );
  for (const [i, b] of plan.batches.entries()) {
    const r = await simulateOrSend(conn, b.instructions, [tester], { send: SEND, lookupTables: b.lookupTables, label: `paczka ${i + 1}/${plan.batches.length}` });
    if (r.error) break;
    await sleep(500);
  }
}

async function main() {
  const [cmd, arg] = positional();
  const conn = connection();
  if (cmd === "init") return init(conn);
  const d = loadDeployment();
  if (cmd === "status" || !cmd) return status(conn, d);
  if (cmd === "audit") return audit(conn, d);
  if (cmd === "buy") return buy(conn, d, Number(arg ?? 0.01));
  if (cmd === "stake") return stake(conn, d, Number(arg ?? 1000));
  if (cmd === "unstake") return unstake(conn, d);
  if (cmd === "buyback") return buyback(conn, d);
  if (cmd === "convert") return convert(conn, d, Number(arg ?? 200));
  throw new Error(`Nieznane polecenie: ${cmd}`);
}

main().catch((e) => {
  console.error((e as Error).stack?.slice(0, 2500) ?? e);
  process.exit(1);
});
