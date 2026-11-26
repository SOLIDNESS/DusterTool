/**
 * Test calosci programu na lokalnym walidatorze z kopia programu Meteora z mainnetu.
 *
 * Uruchomienie: npm run localnet (w jednym terminalu), potem npm run e2e.
 * Skrypt uzywa wylacznie jednorazowych kluczy generowanych w pamieci i odmawia
 * pracy z jakimkolwiek RPC innym niz lokalny.
 */
import { BN } from "@coral-xyz/anchor";
import {
  CpAmm,
  derivePositionNftAccount,
  encodeDelegatePermissions,
  PositionDelegatePermission,
} from "@meteora-ag/cp-amm-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import assert from "node:assert/strict";
import { singleSidedPoolParams, TOKEN_DECIMALS, TOTAL_SUPPLY_RAW } from "../../src/core/pool";
import {
  beginConvertIx,
  buybackIx,
  configPda,
  dusterProgram,
  finishConvertIx,
  initializeIx,
  poolRefs,
  sessionPda,
  sharesToAssets,
  stakeIx,
  UNSTAKE_ALL,
  unstakeIx,
  updateConfigIx,
  userStakePda,
} from "../../src/sdk/duster";

const RPC = "http://127.0.0.1:8899";
const DUSTER = 10n ** BigInt(TOKEN_DECIMALS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const conn = new Connection(RPC, "confirmed");
const program = dusterProgram(conn);

async function send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  const sig = await conn.sendTransaction(tx, { skipPreflight: true });
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) {
    const info = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const logs = (info?.meta?.logMessages ?? []).join("\n");
    throw new Error(`Transakcja odrzucona: ${JSON.stringify(res.value.err)}\n${logs}`);
  }
  return sig;
}

async function expectFail(name: string, fn: () => Promise<unknown>, pattern: RegExp) {
  try {
    await fn();
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, pattern, `${name}: inny blad niz oczekiwany:\n${msg.slice(0, 1500)}`);
    console.log(`  ok  ${name} (odrzucone zgodnie z oczekiwaniem)`);
    return;
  }
  assert.fail(`${name}: transakcja powinna zostac odrzucona`);
}

const ok = (name: string) => console.log(`  ok  ${name}`);
const tokenBalance = async (account: PublicKey) => (await getAccount(conn, account)).amount;
const cuUsed = async (sig: string) =>
  (await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }))?.meta?.computeUnitsConsumed;

async function airdrop(to: PublicKey, sol: number) {
  const sig = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  const bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}

async function main() {
  const genesis = await conn.getGenesisHash();
  assert.notEqual(genesis, "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "to jest mainnet, przerywam");

  const admin = Keypair.generate();
  const treasury = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const cranker = Keypair.generate();
  const buyer = Keypair.generate();
  for (const [kp, sol] of [
    [admin, 10],
    [treasury, 1],
    [alice, 20],
    [bob, 20],
    [cranker, 1],
    [buyer, 5],
  ] as const) {
    await airdrop(kp.publicKey, sol);
  }

  // --- token i pool jednostronny, parametry jak na mainnecie ---
  const mint = Keypair.generate();
  const adminAta = getAssociatedTokenAddressSync(mint.publicKey, admin.publicKey);
  await send(
    [
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: mint.publicKey,
        space: MINT_SIZE,
        lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mint.publicKey, TOKEN_DECIMALS, admin.publicKey, null),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminAta, admin.publicKey, mint.publicKey),
      createMintToInstruction(mint.publicKey, adminAta, admin.publicKey, BigInt(TOTAL_SUPPLY_RAW.toString())),
    ],
    [admin, mint],
  );

  const cpAmm = new CpAmm(conn);
  const pp = singleSidedPoolParams(cpAmm);
  const positionNft = Keypair.generate();
  const created = await cpAmm.createCustomPool({
    payer: admin.publicKey,
    creator: admin.publicKey,
    positionNft: positionNft.publicKey,
    tokenAMint: mint.publicKey,
    tokenBMint: NATIVE_MINT,
    tokenAAmount: pp.tokenAAmount,
    tokenBAmount: pp.tokenBAmount,
    sqrtMinPrice: pp.sqrtMinPrice,
    sqrtMaxPrice: pp.sqrtMaxPrice,
    liquidityDelta: pp.liquidityDelta,
    initSqrtPrice: pp.initSqrtPrice,
    poolFees: pp.poolFees,
    hasAlphaVault: false,
    activationType: pp.activationType,
    collectFeeMode: pp.collectFeeMode,
    activationPoint: null,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    isLockLiquidity: true,
  });
  await send(created.tx.instructions, [admin, positionNft]);
  const pool = created.pool;
  const position = created.position;
  const positionNftAccount = derivePositionNftAccount(positionNft.publicKey);
  ok("token i pool jednostronny z zablokowana plynnoscia");

  const refs = poolRefs(mint.publicKey, pool);
  const config = configPda(mint.publicKey);
  const fetchConfig = () => program.account.config.fetch(config);
  const MIN_STAKE = 1_000n * DUSTER;

  // --- initialize ---
  await expectFail(
    "initialize z poolem innego tokena",
    async () =>
      send(
        [
          await initializeIx(program, admin.publicKey, { ...refs, pool: positionNftAccount }, position, {
            treasury: treasury.publicKey,
            rentFeeBps: 500,
            stakerShareBps: 5000,
            buybackIntervalSecs: 60,
            releaseDurationSecs: 60,
            maxBuybackLamports: new BN(10 * LAMPORTS_PER_SOL),
            minStake: new BN(MIN_STAKE.toString()),
          }),
        ],
        [admin],
      ),
    /InvalidPool|0x1772/,
  );
  await send(
    [
      await initializeIx(program, admin.publicKey, refs, position, {
        treasury: treasury.publicKey,
        rentFeeBps: 500,
        stakerShareBps: 5000,
        buybackIntervalSecs: 60,
        releaseDurationSecs: 60,
        maxBuybackLamports: new BN(10 * LAMPORTS_PER_SOL),
        minStake: new BN(MIN_STAKE.toString()),
      }),
    ],
    [admin],
  );
  let cfg = await fetchConfig();
  assert.equal(cfg.pool.toBase58(), pool.toBase58());
  assert.equal(cfg.rentFeeBps, 500);
  ok("initialize");

  await expectFail(
    "update_config przez obcy portfel",
    async () => send([await updateConfigIx(program, alice.publicKey, config, { rentFeeBps: 0 })], [alice]),
    /ConstraintHasOne|0x7d1/,
  );
  await expectFail(
    "update_config z fee ponad limit",
    async () => send([await updateConfigIx(program, admin.publicKey, config, { rentFeeBps: 1001 })], [admin]),
    /InvalidParameter|0x1771/,
  );

  // --- delegacja odbioru oplat na program (pozycja zostaje u wlasciciela) ---
  const delegateTx = await cpAmm.updateDelegatePermission({
    owner: admin.publicKey,
    position,
    positionNftAccount,
    delegate: config,
    permission: encodeDelegatePermissions([PositionDelegatePermission.ClaimPositionFee]),
  });
  await send(delegateTx.instructions, [admin]);
  ok("delegacja odbioru oplat z pozycji LP na program");

  // --- zakupy na poolu generuja oplaty ---
  const buy = async (who: Keypair, sol: number) => {
    const tx = await cpAmm.swap({
      payer: who.publicKey,
      pool,
      inputTokenMint: NATIVE_MINT,
      outputTokenMint: mint.publicKey,
      amountIn: new BN(sol * LAMPORTS_PER_SOL),
      minimumAmountOut: new BN(0),
      tokenAMint: mint.publicKey,
      tokenBMint: NATIVE_MINT,
      tokenAVault: refs.tokenAVault,
      tokenBVault: refs.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
    });
    await send(tx.instructions, [who]);
  };
  await buy(alice, 2);
  await buy(bob, 1);
  const aliceAta = getAssociatedTokenAddressSync(mint.publicKey, alice.publicKey);
  const bobAta = getAssociatedTokenAddressSync(mint.publicKey, bob.publicKey);
  const aliceBought = await tokenBalance(aliceAta);
  console.log(`      alice kupila ${(Number(aliceBought) / 1e6).toFixed(0)} DUSTER za 2 SOL`);
  ok("zakupy na poolu");

  // --- buyback bez stakujacych: polowa do treasury, polowa czeka ---
  const treasuryWsol = getAssociatedTokenAddressSync(NATIVE_MINT, treasury.publicKey);
  const mkBuyback = async () => [
    createAssociatedTokenAccountIdempotentInstruction(cranker.publicKey, treasuryWsol, treasury.publicKey, NATIVE_MINT),
    await buybackIx(program, cranker.publicKey, refs, treasury.publicKey, position, positionNftAccount, new BN(0)),
  ];
  let sig = await send(await mkBuyback(), [cranker]);
  cfg = await fetchConfig();
  const claimed1 = BigInt(cfg.totalFeesClaimedLamports.toString());
  // 3 SOL obrotu * 2% = 0,06 SOL, z czego 20% zabiera Meteora (z dokladnoscia do zaokraglen).
  assert.ok(claimed1 <= 48_000_000n && claimed1 > 47_999_990n, `odebrane oplaty: ${claimed1}`);
  const stakerPart1 = claimed1 / 2n;
  assert.equal(await tokenBalance(treasuryWsol), claimed1 - stakerPart1);
  assert.equal(BigInt(cfg.pendingStakerLamports.toString()), stakerPart1);
  assert.equal(BigInt(cfg.totalBuybackDuster.toString()), 0n);
  assert.equal(await tokenBalance(refs.stakeVault), 0n);
  console.log(`      buyback: ${await cuUsed(sig)} CU`);
  ok("buyback bez stakujacych: 50% do treasury, 50% czeka na stakujacych");

  await expectFail("drugi buyback przed uplywem interwalu", async () => send(await mkBuyback(), [cranker]), /BuybackTooEarly|0x1777/);

  // --- staking ---
  await expectFail(
    "stake ponizej minimum",
    async () => send([await stakeIx(program, alice.publicKey, refs, new BN((MIN_STAKE - 1n).toString()))], [alice]),
    /BelowMinimum|0x1778/,
  );
  const aliceStake = 10_000_000n * DUSTER;
  await send([await stakeIx(program, alice.publicKey, refs, new BN(aliceStake.toString()))], [alice]);
  cfg = await fetchConfig();
  assert.equal(BigInt(cfg.totalShares.toString()), aliceStake);
  assert.equal(BigInt(cfg.totalAssets.toString()), aliceStake);
  assert.equal(await tokenBalance(refs.stakeVault), aliceStake);
  ok("stake: pierwsza wplata 1:1");

  // --- buyback ze stakujacym ---
  console.log("      czekam 62 s na kolejny buyback...");
  await sleep(62_000);
  await buy(bob, 1);
  sig = await send(await mkBuyback(), [cranker]);
  cfg = await fetchConfig();
  const bought = BigInt(cfg.totalBuybackDuster.toString());
  // Oczekujace ok. 0,024 + polowa z ok. 0,016 nowych oplat = ok. 0,032 SOL na odkup.
  const claimed2 = BigInt(cfg.totalFeesClaimedLamports.toString()) - claimed1;
  assert.ok(claimed2 <= 16_000_000n && claimed2 > 15_999_990n, `odebrane oplaty: ${claimed2}`);
  const spent = stakerPart1 + claimed2 / 2n;
  assert.equal(BigInt(cfg.totalBuybackLamports.toString()), spent);
  assert.equal(BigInt(cfg.pendingStakerLamports.toString()), 0n);
  assert.ok(bought > 0n);
  assert.equal(BigInt(cfg.unreleased.toString()), bought);
  assert.equal(BigInt(cfg.totalAssets.toString()), aliceStake + bought);
  assert.equal(await tokenBalance(refs.stakeVault), aliceStake + bought);
  assert.equal(await tokenBalance(treasuryWsol), claimed1 + claimed2 - spent);
  console.log(`      odkupiono ${(Number(bought) / 1e6).toFixed(2)} DUSTER za ${(Number(spent) / 1e9).toFixed(4)} SOL (${await cuUsed(sig)} CU)`);
  ok("buyback: odbior oplat, podzial 50/50, odkup do skarbca stakingu");

  // --- nagroda uwalnia sie stopniowo; wejscie tuz po buybacku nie przejmuje jej ---
  const bobStake = 10_000_000n * DUSTER;
  await send([await stakeIx(program, bob.publicKey, refs, new BN(bobStake.toString()))], [bob]);
  cfg = await fetchConfig();
  const bobShares = BigInt((await program.account.userStake.fetch(userStakePda(config, bob.publicKey))).shares.toString());
  assert.ok(bobShares <= bobStake && bobShares > (bobStake * 99n) / 100n, `udzialy boba: ${bobShares}`);
  const bobBefore = await tokenBalance(bobAta);
  await send([await unstakeIx(program, bob.publicKey, refs, UNSTAKE_ALL)], [bob]);
  const bobGain = (await tokenBalance(bobAta)) - bobBefore - bobStake;
  // Bob byl w puli najwyzej kilka sekund z polowa udzialow: dostaje co najwyzej ulamek nagrody
  // (albo nic i traci jednostke na zaokragleniu, jesli wyszedl w tej samej sekundzie).
  assert.ok(bobGain >= -1n && bobGain < bought / 5n, `zysk boba ${bobGain} z nagrody ${bought}`);
  assert.equal(await conn.getAccountInfo(userStakePda(config, bob.publicKey)), null);
  console.log(`      bob wszedl i wyszedl po kilku sekundach: zysk ${(Number(bobGain) / 1e6).toFixed(2)} z ${(Number(bought) / 1e6).toFixed(2)} DUSTER nagrody`);
  ok("wejscie i wyjscie tuz po buybacku daje tylko uwolniona czesc; puste konto stakingu zamkniete");

  await expectFail(
    "unstake zostawiajacy pyl",
    async () => send([await unstakeIx(program, alice.publicKey, refs, new BN((aliceStake - 1n).toString()))], [alice]),
    /RemainderBelowMinimum|0x177a/,
  );

  // --- pauza blokuje wplaty, ale nie wyplaty ---
  await send([await updateConfigIx(program, admin.publicKey, config, { paused: true })], [admin]);
  await expectFail(
    "stake przy pauzie",
    async () => send([await stakeIx(program, bob.publicKey, refs, new BN(MIN_STAKE.toString()))], [bob]),
    /Paused|0x1770/,
  );
  const halfShares = aliceStake / 2n;
  const aliceBefore = await tokenBalance(aliceAta);
  await send([await unstakeIx(program, alice.publicKey, refs, new BN(halfShares.toString()))], [alice]);
  assert.ok((await tokenBalance(aliceAta)) - aliceBefore >= halfShares);
  await send([await updateConfigIx(program, admin.publicKey, config, { paused: false })], [admin]);
  ok("pauza: stake zablokowany, unstake dziala");

  // --- po uplywie okresu uwalniania stakujacy ma cala nagrode ---
  console.log("      czekam 62 s na pelne uwolnienie nagrody...");
  await sleep(62_000);
  cfg = await fetchConfig();
  const now = Math.floor(Date.now() / 1000);
  const aliceShares = BigInt((await program.account.userStake.fetch(userStakePda(config, alice.publicKey))).shares.toString());
  const predicted = sharesToAssets(cfg, aliceShares, now);
  const before = await tokenBalance(aliceAta);
  await send([await unstakeIx(program, alice.publicKey, refs, UNSTAKE_ALL)], [alice]);
  const got = (await tokenBalance(aliceAta)) - before;
  assert.equal(got, predicted, "wyplata rozni sie od wyliczenia po stronie klienta");
  assert.ok(got > aliceShares, "wyplata powinna byc wieksza od wplaty");
  cfg = await fetchConfig();
  assert.equal(BigInt(cfg.totalShares.toString()), 0n);
  assert.equal(await tokenBalance(refs.stakeVault), BigInt(cfg.totalAssets.toString()));
  console.log(`      alice: ${(Number(aliceShares) / 1e6).toFixed(0)} udzialow -> ${(Number(got) / 1e6).toFixed(2)} DUSTER`);
  ok("unstake calosci z nagroda; ksiegowanie zgodne ze skarbcem");

  // --- wymiana: begin -> zamkniecie kont + przychod -> finish ---
  const carol = Keypair.generate();
  await airdrop(carol.publicKey, 0.05);
  const junkMints = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const junkAtas: PublicKey[] = [];
  for (const m of junkMints) {
    const ata = getAssociatedTokenAddressSync(m.publicKey, carol.publicKey);
    junkAtas.push(ata);
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: admin.publicKey,
          newAccountPubkey: m.publicKey,
          space: MINT_SIZE,
          lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(m.publicKey, 6, admin.publicKey, null),
        createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata, carol.publicKey, m.publicKey),
      ],
      [admin, m],
    );
  }
  const rentPerAccount = (await conn.getAccountInfo(junkAtas[0]))!.lamports;
  const rentTotal = rentPerAccount * junkAtas.length;
  const sale = 50_000_000; // 0,05 SOL "przychodu ze sprzedazy"
  const carolWsol = getAssociatedTokenAddressSync(NATIVE_MINT, carol.publicKey);
  const carolDuster = getAssociatedTokenAddressSync(mint.publicKey, carol.publicKey);

  await expectFail(
    "begin_convert bez finish_convert",
    async () => send([await beginConvertIx(program, carol.publicKey, config, junkAtas)], [carol]),
    /MissingFinish|0x1773/,
  );
  await expectFail(
    "begin_convert z cudzym kontem tokenow",
    async () =>
      send(
        [
          await beginConvertIx(program, carol.publicKey, config, [aliceAta]),
          await finishConvertIx(program, carol.publicKey, refs, treasury.publicKey, new BN(0)),
        ],
        [carol],
      ),
    /InvalidTokenAccount|0x1774/,
  );

  // Kurs z poola przed wymiana, do sprawdzenia zabezpieczenia przed poslizgiem.
  const poolState = await cpAmm.fetchPoolState(pool);
  const slot = await conn.getSlot();
  const quote = cpAmm.getQuote({
    inAmount: new BN(sale),
    inputTokenMint: NATIVE_MINT,
    slippage: 1,
    poolState,
    currentTime: (await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000),
    currentSlot: slot,
    tokenADecimal: TOKEN_DECIMALS,
    tokenBDecimal: 9,
  });
  const expectedOut = BigInt(quote.swapOutAmount.toString());
  const rate = (expectedOut * 1_000_000_000n) / BigInt(sale);

  // Uzytkownik nie ma ani konta wSOL, ani konta DUSTER: pierwsze nie jest potrzebne, drugie zaklada program.
  const convertIxs = async (minRate: bigint, withSwap = true) => [
    await beginConvertIx(program, carol.publicKey, config, junkAtas),
    ...junkAtas.map((a) => createCloseAccountInstruction(a, carol.publicKey, carol.publicKey)),
    SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: carol.publicKey, lamports: sale }),
    await finishConvertIx(program, carol.publicKey, refs, treasury.publicKey, new BN(minRate.toString()), withSwap),
  ];

  await expectFail(
    "finish_convert z kursem minimalnym ponad rynek",
    async () => send(await convertIxs((rate * 110n) / 100n), [carol, buyer]),
    /SlippageExceeded|0x1776|ExceededSlippage|custom program error/,
  );

  await expectFail(
    "finish_convert z przychodem, ale bez konta DUSTER",
    async () => send(await convertIxs(0n, false), [carol, buyer]),
    /MissingSwapAccounts|0x177d/,
  );
  await expectFail(
    "finish_convert z cudzym kontem DUSTER jako odbiorca",
    async () => {
      const ixs = await convertIxs(0n);
      const finish = ixs[ixs.length - 1];
      const slot = finish.keys.findIndex((k) => k.pubkey.equals(carolDuster));
      finish.keys[slot] = { ...finish.keys[slot], pubkey: aliceAta };
      return send(ixs, [carol, buyer]);
    },
    /InvalidTokenAccount|0x1774/,
  );

  const carolBefore = await conn.getBalance(carol.publicKey);
  const treasuryBefore = await conn.getBalance(treasury.publicKey);
  cfg = await fetchConfig();
  const conversionsBefore = cfg.totalConversions.toNumber();
  sig = await send(await convertIxs((rate * 99n) / 100n), [carol, buyer]);
  const carolAfter = await conn.getBalance(carol.publicKey);
  const treasuryAfter = await conn.getBalance(treasury.publicKey);
  const fee = Math.floor((rentTotal * 500) / 10_000);
  const dusterRent = (await conn.getAccountInfo(carolDuster))!.lamports;
  const txFee = (await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }))!.meta!.fee;

  assert.equal(treasuryAfter - treasuryBefore, fee, "fee od rentu w treasury");
  assert.equal(await tokenBalance(carolDuster), expectedOut, "DUSTER dla uzytkownika rowny wycenie poola");
  // Uzytkownik: + rent - fee - depozyt nowego konta DUSTER - oplata sieciowa; caly przychod poszedl w DUSTER.
  assert.equal(carolAfter - carolBefore, rentTotal - fee - dusterRent - txFee, "saldo SOL uzytkownika");
  assert.equal(await conn.getAccountInfo(sessionPda(config, carol.publicKey)), null, "konto sesji zamkniete");
  assert.equal(await conn.getAccountInfo(carolWsol), null, "uzytkownik nie potrzebuje konta wSOL");
  assert.equal(await tokenBalance(refs.swapWsol), 0n, "konto wSOL programu puste po wymianie");
  for (const a of junkAtas) assert.equal(await conn.getAccountInfo(a), null);
  cfg = await fetchConfig();
  assert.equal(cfg.totalConversions.toNumber(), conversionsBefore + 1);
  assert.equal(cfg.totalAccountsClosed.toNumber(), 3);
  assert.equal(cfg.totalRentLamports.toNumber(), rentTotal);
  assert.equal(cfg.totalRentFeeLamports.toNumber(), fee);
  assert.equal(cfg.totalSaleLamports.toNumber(), sale);
  assert.equal(BigInt(cfg.totalDusterToUsers.toString()), expectedOut);
  console.log(
    `      wymiana: rent ${rentTotal} lamportow, fee ${fee}, sprzedaz ${sale} -> ${(Number(expectedOut) / 1e6).toFixed(2)} DUSTER (${await cuUsed(sig)} CU)`,
  );
  ok("wymiana: fee 5% od rentu, caly przychod zamieniony na DUSTER, konta posprzatane");

  // --- druga wymiana tego samego portfela: konto DUSTER juz istnieje ---
  const m2 = Keypair.generate();
  const carolJunk2 = getAssociatedTokenAddressSync(m2.publicKey, carol.publicKey);
  await send(
    [
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: m2.publicKey,
        space: MINT_SIZE,
        lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(m2.publicKey, 6, admin.publicKey, null),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, carolJunk2, carol.publicKey, m2.publicKey),
    ],
    [admin, m2],
  );
  const dusterBefore2 = await tokenBalance(carolDuster);
  const carolBefore2 = await conn.getBalance(carol.publicKey);
  sig = await send(
    [
      await beginConvertIx(program, carol.publicKey, config, [carolJunk2]),
      createCloseAccountInstruction(carolJunk2, carol.publicKey, carol.publicKey),
      SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: carol.publicKey, lamports: 20_000_000 }),
      await finishConvertIx(program, carol.publicKey, refs, treasury.publicKey, new BN(0)),
    ],
    [carol, buyer],
  );
  const txFee2 = (await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }))!.meta!.fee;
  assert.ok((await tokenBalance(carolDuster)) > dusterBefore2, "DUSTER dopisany do istniejacego konta");
  assert.equal(
    (await conn.getBalance(carol.publicKey)) - carolBefore2,
    rentPerAccount - Math.floor((rentPerAccount * 500) / 10_000) - txFee2,
    "druga wymiana: tylko rent minus fee",
  );
  assert.equal(await tokenBalance(refs.swapWsol), 0n);
  console.log(`      druga wymiana: ${await cuUsed(sig)} CU`);
  ok("druga wymiana: konto DUSTER juz istnieje, nic nie jest zakladane");

  // --- wymiana samych pustych kont: bez swapu ---
  const dave = Keypair.generate();
  await airdrop(dave.publicKey, 0.02);
  const m = Keypair.generate();
  const daveJunk = getAssociatedTokenAddressSync(m.publicKey, dave.publicKey);
  const daveDuster = getAssociatedTokenAddressSync(mint.publicKey, dave.publicKey);
  await send(
    [
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: m.publicKey,
        space: MINT_SIZE,
        lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(m.publicKey, 6, admin.publicKey, null),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, daveJunk, dave.publicKey, m.publicKey),
    ],
    [admin, m],
  );
  const daveBefore = await conn.getBalance(dave.publicKey);
  sig = await send(
    [
      await beginConvertIx(program, dave.publicKey, config, [daveJunk]),
      createCloseAccountInstruction(daveJunk, dave.publicKey, dave.publicKey),
      await finishConvertIx(program, dave.publicKey, refs, treasury.publicKey, new BN(0), false),
    ],
    [dave],
  );
  const daveFee = Math.floor((rentPerAccount * 500) / 10_000);
  const daveTxFee = (await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }))!.meta!.fee;
  assert.equal((await conn.getBalance(dave.publicKey)) - daveBefore, rentPerAccount - daveFee - daveTxFee);
  assert.equal(await conn.getAccountInfo(daveDuster), null, "bez przychodu konto DUSTER nie jest zakladane");
  ok("wymiana samych pustych kont: tylko fee od rentu, bez swapu");

  console.log("\nWszystkie testy przeszly.");
}

main().catch((e) => {
  console.error("\nBLAD:", (e as Error).message?.slice(0, 4000) ?? e);
  process.exit(1);
});
