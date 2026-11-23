import type { ClassicAddress, MuxedAddress } from "@astrowallet/domain";
import {
  Account,
  Asset,
  Memo,
  MuxedAccount,
  Operation,
  StrKey,
  TransactionBuilder,
  type Keypair,
  type xdr,
} from "@stellar/stellar-sdk";

const MAX_U64 = 18446744073709551615n;

export type TypedMemoInput =
  | { kind: "none" }
  | { kind: "text"; value: string }
  | { kind: "id"; value: string }
  | { kind: "hash"; valueHex: string }
  | { kind: "return"; valueHex: string };

export interface ClassicAssetInput {
  assetCode: string;
  assetIssuer?: ClassicAddress | undefined;
}

/**
 * Resolves a Stellar SDK Asset instance from a code + optional Classic issuer.
 */
export function resolveStellarAsset(input: ClassicAssetInput): Asset {
  const code = input.assetCode.trim();
  if (code.toUpperCase() === "XLM" && !input.assetIssuer) {
    return Asset.native();
  }
  if (!input.assetIssuer || !StrKey.isValidEd25519PublicKey(input.assetIssuer)) {
    throw new Error(`Valid Classic issuer G... address is required for asset ${code}`);
  }
  return new Asset(code, input.assetIssuer);
}

/**
 * Encodes a Classic G... public key and unsigned 64-bit muxed ID into a CAP-27/SEP-23 M... address.
 */
export function encodeMuxedAddress(
  baseAddress: ClassicAddress,
  muxedId: string | bigint,
): MuxedAddress {
  if (!StrKey.isValidEd25519PublicKey(baseAddress)) {
    throw new Error("Invalid Classic G... base address");
  }

  let parsedId: bigint;
  if (typeof muxedId === "bigint") {
    parsedId = muxedId;
  } else {
    const cleaned = muxedId.trim();
    if (!/^\d+$/.test(cleaned)) {
      throw new Error("Muxed ID must be an unsigned 64-bit integer");
    }
    parsedId = BigInt(cleaned);
  }

  if (parsedId < 0n || parsedId > MAX_U64) {
    throw new Error("Muxed ID must be between 0 and 18446744073709551615");
  }

  const baseAccount = new Account(baseAddress, "0");
  const muxed = new MuxedAccount(baseAccount, parsedId.toString());
  return muxed.accountId() as MuxedAddress;
}

/**
 * Decodes an M... muxed address into its underlying G... base address and u64 ID.
 */
export function decodeMuxedAddress(muxedAddress: MuxedAddress): {
  baseAddress: ClassicAddress;
  muxedId: string;
} {
  const cleaned = muxedAddress.trim();
  if (!StrKey.isValidMed25519PublicKey(cleaned)) {
    throw new Error("Invalid M... muxed Stellar address");
  }
  const muxed = MuxedAccount.fromAddress(cleaned, "0");
  return {
    baseAddress: muxed.baseAccount().accountId() as ClassicAddress,
    muxedId: muxed.id(),
  };
}

/**
 * Builds and validates a typed Stellar transaction memo (`none`, `text`, `id`, `hash`, or `return`).
 */
export function buildStellarMemo(input: TypedMemoInput): Memo {
  switch (input.kind) {
    case "none":
      return Memo.none();
    case "text": {
      const byteLength = new TextEncoder().encode(input.value).length;
      if (byteLength > 28) {
        throw new Error(`Memo text exceeds 28-byte limit (got ${byteLength} bytes)`);
      }
      return Memo.text(input.value);
    }
    case "id": {
      const cleaned = input.value.trim();
      if (!/^\d+$/.test(cleaned)) {
        throw new Error("Memo ID must be an unsigned 64-bit decimal integer");
      }
      const idVal = BigInt(cleaned);
      if (idVal < 0n || idVal > MAX_U64) {
        throw new Error("Memo ID exceeds uint64 range");
      }
      return Memo.id(idVal.toString());
    }
    case "hash": {
      const cleaned = input.valueHex.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(cleaned)) {
        throw new Error("Memo hash must be a 64-character hex string (32 bytes)");
      }
      return Memo.hash(cleaned);
    }
    case "return": {
      const cleaned = input.valueHex.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(cleaned)) {
        throw new Error("Memo return hash must be a 64-character hex string (32 bytes)");
      }
      return Memo.return(cleaned);
    }
  }
}

/**
 * Builds a `changeTrust` operation (pass `limit: "0"` to remove an unused zero-balance trustline).
 */
export function buildChangeTrustOperation(input: {
  assetCode: string;
  assetIssuer: ClassicAddress;
  limit?: string | undefined;
}): xdr.Operation {
  const asset = resolveStellarAsset({
    assetCode: input.assetCode,
    assetIssuer: input.assetIssuer,
  });
  return Operation.changeTrust({
    asset,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
}

/**
 * Builds `@lumenwipe/sdk`-compatible `changeTrust(limit="0")` operations to reclaim 0.5 XLM per zero-balance trustline.
 */
export function buildLumenWipeReclaimOperations(
  trustlines: readonly { assetCode: string; assetIssuer: ClassicAddress }[],
): xdr.Operation[] {
  if (trustlines.length === 0) {
    throw new Error("No zero-balance trustlines provided to reclaim");
  }
  return trustlines.map((tl) =>
    buildChangeTrustOperation({
      assetCode: tl.assetCode,
      assetIssuer: tl.assetIssuer,
      limit: "0",
    }),
  );
}

/**
 * Builds a `claimClaimableBalance` operation for a 72-hex-char Claimable Balance ID.
 */
export function buildClaimClaimableBalanceOperation(balanceId: string): xdr.Operation {
  const cleaned = balanceId.trim();
  if (!/^[0-9a-fA-F]{72}$/.test(cleaned)) {
    throw new Error("Claimable balance ID must be a 72-character hex string");
  }
  return Operation.claimClaimableBalance({ balanceId: cleaned });
}

/**
 * Builds a Classic SDEX `manageSellOffer` operation (set `amount: "0"` and `offerId` to cancel an offer).
 */
export function buildManageSellOfferOperation(input: {
  selling: ClassicAssetInput;
  buying: ClassicAssetInput;
  amount: string;
  price: string;
  offerId?: string | undefined;
}): xdr.Operation {
  const sellingAsset = resolveStellarAsset(input.selling);
  const buyingAsset = resolveStellarAsset(input.buying);
  return Operation.manageSellOffer({
    selling: sellingAsset,
    buying: buyingAsset,
    amount: input.amount,
    price: input.price,
    offerId: input.offerId ?? "0",
  });
}

/**
 * Validates and signs a Stellar SEP-10 web authentication challenge transaction
 * (`sequence === "0"`, non-FeeBump, strictly `manageData` operations only).
 */
export function signSep10ChallengeTransaction(
  challengeXdr: string,
  keypair: Keypair,
  networkPassphrase: string,
): string {
  const tx = TransactionBuilder.fromXDR(challengeXdr, networkPassphrase);
  if ("innerTransaction" in tx) {
    throw new Error("SEP-10 challenge cannot be a FeeBumpTransaction");
  }
  if (tx.sequence !== "0") {
    throw new Error("SEP-10 safety check failed: challenge sequence must be 0");
  }
  if (
    tx.operations.length === 0 ||
    tx.operations.some((op: { type: string }) => op.type !== "manageData")
  ) {
    throw new Error("SEP-10 safety check failed: challenge may only contain manageData ops");
  }
  tx.sign(keypair);
  return tx.toXDR();
}
