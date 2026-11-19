import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  classifyVerdict,
  createSecurityShield,
  filterSpamClaimableBalances,
  sanitizeMemoPhishing,
  scanTransactionEnvelopeXdr,
} from "./index.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const SOURCE_KP = Keypair.random();
const DEST_KP = Keypair.random();
const ATTACKER_KP = Keypair.random();
const OFFICIAL_USDC_ISSUER = Keypair.random().publicKey();
const FAKE_USDC_ISSUER = Keypair.random().publicKey();

function buildTestTxXdr(
  configure: (builder: TransactionBuilder) => void,
): string {
  const account = new Account(SOURCE_KP.publicKey(), "100");
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET_PASSPHRASE,
  });
  configure(builder);
  return builder.setTimeout(60).build().toXDR();
}

describe("Scan & Shield deterministic pre-sign rules", () => {
  it("classifies verdicts fail-closed", () => {
    expect(classifyVerdict([])).toBe("benign");
  });

  it("blocks malicious setOptions signer takeover", () => {
    const xdr = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.setOptions({
          signer: {
            ed25519PublicKey: ATTACKER_KP.publicKey(),
            weight: 10,
          },
        }),
      );
    });

    const { report } = scanTransactionEnvelopeXdr(xdr, {
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    expect(report.verdict).toBe("malicious");
    expect(
      report.findings.some(
        (f) => f.code === "MALICIOUS_SET_OPTIONS_SIGNER" && f.blocksSigning,
      ),
    ).toBe(true);
  });

  it("blocks dangerous accountMerge full-balance drain", () => {
    const xdr = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.accountMerge({
          destination: ATTACKER_KP.publicKey(),
        }),
      );
    });

    const { report } = scanTransactionEnvelopeXdr(xdr, {
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    expect(report.verdict).toBe("malicious");
    expect(
      report.findings.some(
        (f) => f.code === "DANGEROUS_ACCOUNT_MERGE" && f.blocksSigning,
      ),
    ).toBe(true);
  });

  it("blocks fake USDC issuer and allows verified SEP-42 USDC issuer", () => {
    const fakeUsdcXdr = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.payment({
          destination: DEST_KP.publicKey(),
          asset: new Asset("USDC", FAKE_USDC_ISSUER),
          amount: "50",
        }),
      );
    });

    const verifiedAssets = [{ code: "USDC", issuer: OFFICIAL_USDC_ISSUER }];
    const blocked = scanTransactionEnvelopeXdr(fakeUsdcXdr, {
      networkPassphrase: TESTNET_PASSPHRASE,
      verifiedAssets,
    });
    expect(blocked.report.verdict).toBe("malicious");
    expect(
      blocked.report.findings.some((f) => f.code === "SPOOFED_PROTECTED_ASSET"),
    ).toBe(true);

    const realUsdcXdr = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.payment({
          destination: DEST_KP.publicKey(),
          asset: new Asset("USDC", OFFICIAL_USDC_ISSUER),
          amount: "50",
        }),
      );
    });
    const allowed = scanTransactionEnvelopeXdr(realUsdcXdr, {
      networkPassphrase: TESTNET_PASSPHRASE,
      verifiedAssets,
    });
    expect(allowed.report.verdict).toBe("benign");
  });

  it("blocks missing SEP-29 exchange memo and allows when memo is present", () => {
    const noMemoXdr = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.payment({
          destination: DEST_KP.publicKey(),
          asset: Asset.native(),
          amount: "25",
        }),
      );
    });

    const memoRequiredDestinations = new Set([DEST_KP.publicKey()]);
    const blocked = scanTransactionEnvelopeXdr(noMemoXdr, {
      networkPassphrase: TESTNET_PASSPHRASE,
      memoRequiredDestinations,
    });
    expect(blocked.report.verdict).toBe("malicious");
    expect(blocked.report.requiresMemoCheck).toBe(true);
    expect(
      blocked.report.findings.some((f) => f.code === "MISSING_SEP29_EXCHANGE_MEMO"),
    ).toBe(true);

    const withMemoXdr = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.payment({
          destination: DEST_KP.publicKey(),
          asset: Asset.native(),
          amount: "25",
        }),
      );
      b.addMemo(Memo.text("10928374"));
    });
    const allowed = scanTransactionEnvelopeXdr(withMemoXdr, {
      networkPassphrase: TESTNET_PASSPHRASE,
      memoRequiredDestinations,
    });
    expect(allowed.report.verdict).toBe("benign");
  });

  it("filters spam claimable balances and strips phishing links from memos", () => {
    const filtered = filterSpamClaimableBalances(
      [
        { id: "1", assetCode: "XLM", amount: "0.0001" }, // dust spam
        {
          id: "2",
          assetCode: "XLM",
          amount: "5.0",
          memoText: "Claim airdrop at https://free-xlm.xyz",
        }, // phishing memo
        {
          id: "3",
          assetCode: "USDC",
          assetIssuer: FAKE_USDC_ISSUER,
          amount: "100",
        }, // fake USDC
        {
          id: "4",
          assetCode: "USDC",
          assetIssuer: OFFICIAL_USDC_ISSUER,
          amount: "25",
        }, // legitimate
      ],
      {
        verifiedAssets: [{ code: "USDC", issuer: OFFICIAL_USDC_ISSUER }],
      },
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe("4");
    expect(sanitizeMemoPhishing("Visit www.scam-stellar.com now")).toContain(
      "[redacted-link]",
    );
  });

  it("runs scanner port via createSecurityShield", async () => {
    const shield = createSecurityShield({
      networkPassphrase: TESTNET_PASSPHRASE,
      rpcUrls: ["https://rpc-testnet.example.org"],
      horizonUrls: ["https://horizon-testnet.example.org"],
      sep42AssetListUrls: [],
      directoryLookup: async (addr) =>
        addr === ATTACKER_KP.publicKey()
          ? { address: addr, name: "Known Drainer", tags: ["malicious"] }
          : null,
    });

    const scanner = shield.createScanner();
    const addrReport = await scanner.scanAddress(ATTACKER_KP.publicKey() as never);
    expect(addrReport.verdict).toBe("malicious");
  });
});
