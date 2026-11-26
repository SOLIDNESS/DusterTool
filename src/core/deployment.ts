/**
 * Opis wdrozenia: publiczne adresy tokena, poola i kont programu.
 * Pliki leza w deployments/<nazwa>.json i nie zawieraja zadnych kluczy prywatnych.
 */
import { PublicKey } from "@solana/web3.js";
import { poolRefs, type PoolRefs } from "../sdk/duster";

export interface DeploymentFile {
  mint?: string;
  pool?: string;
  position?: string;
  positionNftMint?: string;
  positionNftAccount?: string;
  treasury?: string;
  lookupTable?: string;
  signatures: Record<string, string>;
}

export interface Deployment {
  mint: PublicKey;
  pool: PublicKey;
  position: PublicKey;
  positionNftAccount: PublicKey;
  treasury: PublicKey;
  lookupTable: PublicKey | null;
  refs: PoolRefs;
}

export function parseDeployment(d: DeploymentFile): Deployment {
  const need = (key: keyof DeploymentFile): PublicKey => {
    const v = d[key];
    if (typeof v !== "string") throw new Error(`W pliku wdrozenia brakuje pola '${key}'`);
    return new PublicKey(v);
  };
  const mint = need("mint");
  const pool = need("pool");
  return {
    mint,
    pool,
    position: need("position"),
    positionNftAccount: need("positionNftAccount"),
    treasury: need("treasury"),
    lookupTable: d.lookupTable ? new PublicKey(d.lookupTable) : null,
    refs: poolRefs(mint, pool),
  };
}
