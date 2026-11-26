import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  MuxedAccount,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  classifyVerdict,
  clearSep42AssetCache,
  createSecurityShield,
  decodeAuthEntryXdr,
  evaluateSorobanInvocation,
  fetchSep42VerifiedAssets,
  filterSpamClaimableBalances,
  decodeTransactionEnvelope,
  sanitizeMemoPhishing,
  scanTransactionEnvelopeXdr,
  simulateSorobanTransaction,
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

  it("blocks M... muxed destinations wrapping a malicious G... address", async () => {
    const muxedAttacker = new MuxedAccount(
      new Account(ATTACKER_KP.publicKey(), "1"),
      "4242",
    ).accountId();

    const xdrStr = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.payment({
          destination: muxedAttacker,
          asset: Asset.native(),
          amount: "10",
        }),
      );
    });

    const shield = createSecurityShield({
      networkPassphrase: TESTNET_PASSPHRASE,
      rpcUrls: [],
      horizonUrls: [],
      sep42AssetListUrls: [],
      directoryLookup: async (addr) =>
        addr === ATTACKER_KP.publicKey()
          ? { address: addr, name: "Drainer", tags: ["malicious"] }
          : null,
    });

    const report = await shield.createScanner().scanTransactionXdr(xdrStr);
    expect(report.verdict).toBe("malicious");
    expect(
      report.findings.some((f) => f.code === "DIRECTORY_MALICIOUS_DESTINATION"),
    ).toBe(true);
  });

  it("inspects nested Soroban subInvocations in directoryLookup and runs Soroban simulation", async () => {
    const outerContract = StrKey.encodeContract(new Uint8Array(32).fill(1));
    const innerMaliciousContract = StrKey.encodeContract(new Uint8Array(32).fill(2));

    const nestedAuth = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(outerContract).toScAddress(),
            functionName: "router_swap",
            args: [],
          }),
        ),
        subInvocations: [
          new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              new xdr.InvokeContractArgs({
                contractAddress: new Address(innerMaliciousContract).toScAddress(),
                functionName: "transfer",
                args: [],
              }),
            ),
            subInvocations: [],
          }),
        ],
      }),
    });

    const sorobanTx = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: new Address(outerContract).toScAddress(),
              functionName: "router_swap",
              args: [],
            }),
          ),
          auth: [nestedAuth],
        }),
      );
    });

    let rpcSimulated = false;
    const shield = createSecurityShield({
      networkPassphrase: TESTNET_PASSPHRASE,
      rpcUrls: ["https://rpc-mock.example.org"],
      horizonUrls: [],
      sep42AssetListUrls: [],
      directoryLookup: async (addr) =>
        addr === innerMaliciousContract
          ? { address: addr, name: "Evil Subcontract", tags: ["malicious"] }
          : null,
      fetchFn: async () => {
        rpcSimulated = true;
        return new Response(
          JSON.stringify({
            result: {
              minResourceFee: "55000",
              events: [],
            },
          }),
          { status: 200 },
        );
      },
    });

    const report = await shield.createScanner().scanTransactionXdr(sorobanTx);
    expect(rpcSimulated).toBe(true);
    expect(report.verdict).toBe("malicious");
    expect(
      report.findings.some((f) => f.code === "DIRECTORY_MALICIOUS_CONTRACT"),
    ).toBe(true);
    expect(BigInt(report.estimatedFeeStroops)).toBeGreaterThanOrEqual(55000n);
  });

  it("loads SEP-42 asset lists to verify real USDC without false positives, and warns when no registry is loaded", async () => {
    clearSep42AssetCache();
    const realUsdcXdr = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.payment({
          destination: DEST_KP.publicKey(),
          asset: new Asset("USDC", OFFICIAL_USDC_ISSUER),
          amount: "25",
        }),
      );
    });

    // Without SEP-42 configured -> non-blocking warning (not false-positive malicious)
    const noReg = scanTransactionEnvelopeXdr(realUsdcXdr, {
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    expect(noReg.report.verdict).toBe("warning");
    expect(
      noReg.report.findings.some(
        (f) => f.code === "UNVERIFIED_PROTECTED_ASSET_NO_REGISTRY" && !f.blocksSigning,
      ),
    ).toBe(true);

    // With SEP-42 list fetched -> real USDC is benign, fake USDC is malicious
    const assets = await fetchSep42VerifiedAssets(
      ["https://assets.example.org/sep42.json"],
      {
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              assets: [{ code: "USDC", issuer: OFFICIAL_USDC_ISSUER }],
            }),
            { status: 200 },
          ),
      },
    );
    expect(assets).toEqual([{ code: "USDC", issuer: OFFICIAL_USDC_ISSUER }]);

    const shield = createSecurityShield({
      networkPassphrase: TESTNET_PASSPHRASE,
      rpcUrls: [],
      horizonUrls: [],
      sep42AssetListUrls: ["https://assets.example.org/sep42.json"],
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            assets: [{ code: "USDC", issuer: OFFICIAL_USDC_ISSUER }],
          }),
          { status: 200 },
        ),
    });

    const realReport = await shield.createScanner().scanTransactionXdr(realUsdcXdr);
    expect(realReport.verdict).toBe("benign");

    const fakeUsdcXdr = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.payment({
          destination: DEST_KP.publicKey(),
          asset: new Asset("USDC", FAKE_USDC_ISSUER),
          amount: "25",
        }),
      );
    });
    const fakeReport = await shield.createScanner().scanTransactionXdr(fakeUsdcXdr);
    expect(fakeReport.verdict).toBe("malicious");
    expect(
      fakeReport.findings.some((f) => f.code === "SPOOFED_PROTECTED_ASSET"),
    ).toBe(true);
  });

  it("decodes both HashIdPreimage Soroban auth variants and SorobanAuthorizationEntry XDR", () => {
    const contractId = StrKey.encodeContract(new Uint8Array(32).fill(9));
    const networkId = new Uint8Array(32).fill(0xab);
    const rootInvocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contractId).toScAddress(),
          functionName: "upgrade",
          args: [],
        }),
      ),
      subInvocations: [],
    });

    const legacyPreimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId,
        nonce: 42n,
        signatureExpirationLedger: 950_000,
        invocation: rootInvocation,
      }),
    );
    const legacyDecoded = decodeAuthEntryXdr(legacyPreimage.toXDR("base64"));
    expect(legacyDecoded.kind).toBe("hash_id_preimage");
    expect(legacyDecoded.networkIdHex).toBe("ab".repeat(32));
    expect(legacyDecoded.nonce).toBe("42");
    expect(legacyDecoded.signatureExpirationLedger).toBe(950_000);
    expect(legacyDecoded.invocation.contractId).toBe(contractId);
    expect(legacyDecoded.invocation.functionName).toBe("upgrade");

    const withAddrPreimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
      new xdr.HashIdPreimageSorobanAuthorizationWithAddress({
        networkId,
        nonce: 77n,
        signatureExpirationLedger: 960_000,
        address: new Address(SOURCE_KP.publicKey()).toScAddress(),
        invocation: rootInvocation,
      }),
    );
    const withAddrDecoded = decodeAuthEntryXdr(withAddrPreimage.toXDR("base64"));
    expect(withAddrDecoded.kind).toBe("hash_id_preimage");
    expect(withAddrDecoded.address).toBe(SOURCE_KP.publicKey());
    expect(withAddrDecoded.invocation.functionName).toBe("upgrade");

    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation,
    });
    const entryDecoded = decodeAuthEntryXdr(authEntry.toXDR("base64"));
    expect(entryDecoded.kind).toBe("soroban_authorization_entry");
    expect(entryDecoded.credentialsType).toBe("sorobanCredentialsSourceAccount");
    expect(entryDecoded.invocation.functionName).toBe("upgrade");

    expect(() => decodeAuthEntryXdr("not-valid-base64-xdr")).toThrow(/Invalid/i);
  });

  it("evaluates Soroban invocations, setOptions lockouts, and Classic clawback/flags rules", () => {
    const upgradeFindings = evaluateSorobanInvocation({
      contractId: StrKey.encodeContract(new Uint8Array(32).fill(5)),
      functionName: "upgrade",
      args: [],
      subInvocations: [],
    });
    expect(classifyVerdict(upgradeFindings)).toBe("malicious");
    expect(upgradeFindings.some((f) => f.code === "MALICIOUS_SOROBAN_FUNCTION" && f.blocksSigning)).toBe(true);

    const addSignerFindings = evaluateSorobanInvocation({
      functionName: "add_signer",
      args: [],
      subInvocations: [],
    });
    expect(classifyVerdict(addSignerFindings)).toBe("malicious");

    const burnFindings = evaluateSorobanInvocation({
      functionName: "burn",
      args: ["100"],
      subInvocations: [],
    });
    expect(classifyVerdict(burnFindings)).toBe("malicious");

    const transferFindings = evaluateSorobanInvocation({
      functionName: "transfer",
      args: ["100"],
      subInvocations: [],
    });
    expect(classifyVerdict(transferFindings)).toBe("warning");
    expect(transferFindings.some((f) => f.code === "SOROBAN_TOKEN_TRANSFER")).toBe(true);

    const lockoutTx = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.setOptions({
          masterWeight: 1,
          lowThreshold: 5,
          medThreshold: 5,
          highThreshold: 5,
        }),
      );
    });
    const lockoutReport = scanTransactionEnvelopeXdr(lockoutTx, {
      networkPassphrase: TESTNET_PASSPHRASE,
    }).report;
    expect(lockoutReport.verdict).toBe("malicious");
    expect(
      lockoutReport.findings.some((f) => f.code === "MALICIOUS_SET_OPTIONS_THRESHOLD_LOCKOUT"),
    ).toBe(true);

    const clawbackTx = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.clawback({
          asset: new Asset("USDC", OFFICIAL_USDC_ISSUER),
          from: DEST_KP.publicKey(),
          amount: "5",
        }),
      );
    });
    const clawbackReport = scanTransactionEnvelopeXdr(clawbackTx, {
      networkPassphrase: TESTNET_PASSPHRASE,
      verifiedAssets: [{ code: "USDC", issuer: OFFICIAL_USDC_ISSUER }],
    }).report;
    expect(clawbackReport.verdict).toBe("malicious");
    expect(clawbackReport.findings.some((f) => f.code === "MALICIOUS_CLAWBACK")).toBe(true);

    const flagsTx = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.setTrustLineFlags({
          trustor: DEST_KP.publicKey(),
          asset: new Asset("USDC", OFFICIAL_USDC_ISSUER),
          flags: { authorized: false },
        }),
      );
    });
    const flagsReport = scanTransactionEnvelopeXdr(flagsTx, {
      networkPassphrase: TESTNET_PASSPHRASE,
      verifiedAssets: [{ code: "USDC", issuer: OFFICIAL_USDC_ISSUER }],
    }).report;
    expect(flagsReport.verdict).toBe("warning");
    expect(flagsReport.findings.some((f) => f.code === "TRUSTLINE_FLAGS_CHANGE")).toBe(true);
  });

  it("extracts accurate assetCode and assetIssuer from XDR LedgerEntry stateChanges", async () => {
    const beforeAcc = new xdr.LedgerEntry({
      lastModifiedLedgerSeq: 1,
      data: xdr.LedgerEntryData.account(
        new xdr.AccountEntry({
          accountId: xdr.PublicKey.publicKeyTypeEd25519(SOURCE_KP.rawPublicKey()),
          balance: 100_000_000n,
          seqNum: 1n,
          numSubEntries: 0,
          inflationDest: null,
          flags: 0,
          homeDomain: "",
          thresholds: new Uint8Array(4),
          signers: [],
          ext: xdr.AccountEntryExt.v0(),
        }),
      ),
      ext: xdr.LedgerEntryExt.v0(),
    }).toXDR("base64");

    const afterAcc = new xdr.LedgerEntry({
      lastModifiedLedgerSeq: 2,
      data: xdr.LedgerEntryData.account(
        new xdr.AccountEntry({
          accountId: xdr.PublicKey.publicKeyTypeEd25519(SOURCE_KP.rawPublicKey()),
          balance: 85_000_000n,
          seqNum: 2n,
          numSubEntries: 0,
          inflationDest: null,
          flags: 0,
          homeDomain: "",
          thresholds: new Uint8Array(4),
          signers: [],
          ext: xdr.AccountEntryExt.v0(),
        }),
      ),
      ext: xdr.LedgerEntryExt.v0(),
    }).toXDR("base64");

    const issuerKp = Keypair.fromPublicKey(OFFICIAL_USDC_ISSUER);
    const usdcAsset = xdr.TrustLineAsset.assetTypeCreditAlphanum4(
      new xdr.AlphaNum4({
        assetCode: "USDC",
        issuer: xdr.PublicKey.publicKeyTypeEd25519(issuerKp.rawPublicKey()),
      }),
    );

    const beforeTl = new xdr.LedgerEntry({
      lastModifiedLedgerSeq: 1,
      data: xdr.LedgerEntryData.trustline(
        new xdr.TrustLineEntry({
          accountId: xdr.PublicKey.publicKeyTypeEd25519(SOURCE_KP.rawPublicKey()),
          asset: usdcAsset,
          balance: 10_000_000n,
          limit: 1_000_000_000n,
          flags: 1,
          ext: xdr.TrustLineEntryExt.v0(),
        }),
      ),
      ext: xdr.LedgerEntryExt.v0(),
    }).toXDR("base64");

    const afterTl = new xdr.LedgerEntry({
      lastModifiedLedgerSeq: 2,
      data: xdr.LedgerEntryData.trustline(
        new xdr.TrustLineEntry({
          accountId: xdr.PublicKey.publicKeyTypeEd25519(SOURCE_KP.rawPublicKey()),
          asset: usdcAsset,
          balance: 35_000_000n,
          limit: 1_000_000_000n,
          flags: 1,
          ext: xdr.TrustLineEntryExt.v0(),
        }),
      ),
      ext: xdr.LedgerEntryExt.v0(),
    }).toXDR("base64");

    const sim = await simulateSorobanTransaction(
      ["https://rpc-test.example"],
      "AAAA",
      async () =>
        new Response(
          JSON.stringify({
            result: {
              minResourceFee: "12345",
              stateChanges: [
                { before: beforeAcc, after: afterAcc },
                { before: beforeTl, after: afterTl },
                {
                  before: { address: SOURCE_KP.publicKey(), balance: "10000000" },
                  after: { address: SOURCE_KP.publicKey(), balance: "20000000" },
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );

    expect(sim.ok).toBe(true);
    expect(sim.balanceDiffs).toEqual([
      {
        address: SOURCE_KP.publicKey(),
        assetCode: "XLM",
        assetIssuer: undefined,
        delta: "-1.5000000",
      },
      {
        address: SOURCE_KP.publicKey(),
        assetCode: "USDC",
        assetIssuer: OFFICIAL_USDC_ISSUER,
        delta: "+2.5000000",
      },
      {
        address: SOURCE_KP.publicKey(),
        assetCode: "UNKNOWN",
        assetIssuer: undefined,
        delta: "+1.0000000",
      },
    ]);
  });

  it("preserves optional SEP-42 metadata (name, domain, icon, decimals, contract) when fetching asset lists", async () => {
    clearSep42AssetCache();
    const issuerA = Keypair.random().publicKey();
    const contractA = StrKey.encodeContract(new Uint8Array(32).fill(7));

    const assets = await fetchSep42VerifiedAssets(
      ["https://sep42-list-a.example/assets.json", "https://sep42-list-b.example/assets.json"],
      {
        fetchFn: async (input) => {
          const url = String(input);
          if (url.includes("list-a")) {
            return new Response(
              JSON.stringify({
                assets: [
                  {
                    code: "USDC",
                    issuer: issuerA,
                    name: "USD Coin",
                    domain: "centre.io",
                    icon: "https://assets.example/usdc.png",
                    decimals: 7,
                    contract: contractA,
                  },
                ],
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              assets: [
                {
                  code: "USDC",
                  issuer: issuerA,
                  org: "Circle Internet Financial",
                  icon: "http://insecure.example/ignore.png",
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
    );

    expect(assets).toHaveLength(1);
    expect(assets[0]).toEqual({
      code: "USDC",
      issuer: issuerA,
      name: "USD Coin",
      domain: "centre.io",
      icon: "https://assets.example/usdc.png",
      decimals: 7,
      contract: contractA,
    });
    clearSep42AssetCache();
  });

  it("blocks mismatched sourceAddress and fails closed on Mainnet Soroban simulation error", async () => {
    const shield = createSecurityShield({
      networkPassphrase: "Public Global Stellar Network ; September 2015",
      rpcUrls: ["https://rpc-mainnet.example"],
      horizonUrls: [],
      verifiedAssets: [],
      sep42AssetListUrls: [],
      fetchFn: async () =>
        new Response(JSON.stringify({ error: { message: "rpc unavailable" } }), { status: 503 }),
    });
    const scanner = shield.createScanner();

    const mismatchedXdr = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.payment({
          destination: DEST_KP.publicKey(),
          asset: Asset.native(),
          amount: "5",
        }),
      );
    });

    const mismatchReport = await scanner.scanTransactionXdr(
      mismatchedXdr,
      ATTACKER_KP.publicKey(),
    );
    expect(mismatchReport.verdict).toBe("malicious");
    expect(mismatchReport.findings.some((f) => f.code === "SOURCE_ACCOUNT_MISMATCH")).toBe(true);

    const contractId = StrKey.encodeContract(new Uint8Array(32).fill(9));
    const sorobanXdr = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: "swap",
          args: [],
        }),
      );
    });
    const simFailReport = await scanner.scanTransactionXdr(
      sorobanXdr,
      SOURCE_KP.publicKey(),
    );
    expect(simFailReport.verdict).toBe("malicious");
    expect(
      simFailReport.findings.some(
        (f) => f.code === "SOROBAN_SIMULATION_FAILED" && f.blocksSigning === true,
      ),
    ).toBe(true);
  });

  it("extracts sendAmount on pathPaymentStrictSend and isolates LayerZero OFTs to Mainnet", () => {
    const strictSendXdr = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: "42.5000000",
          destination: DEST_KP.publicKey(),
          destAsset: new Asset("USDC", OFFICIAL_USDC_ISSUER),
          destMin: "10.0000000",
          path: [],
        }),
      );
    });
    const decoded = decodeTransactionEnvelope(strictSendXdr, TESTNET_PASSPHRASE);
    expect(decoded.operations[0]?.type).toBe("pathPaymentStrictSend");
    expect(decoded.operations[0]?.amount).toBe("42.5000000");

    const MAINNET_USDE_ISSUER = "GDJ5BNU5NN6NQ54D7OX6NQTUYNBZ42CAT33QGM5BIQ2QIYADAC5ICH47";
    const usdeXdr = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.payment({
          destination: DEST_KP.publicKey(),
          asset: new Asset("USDE", MAINNET_USDE_ISSUER),
          amount: "5",
        }),
      );
    });
    const testnetScan = scanTransactionEnvelopeXdr(usdeXdr, {
      networkPassphrase: TESTNET_PASSPHRASE,
      verifiedAssets: [{ code: "USDC", issuer: OFFICIAL_USDC_ISSUER }],
    });
    expect(
      testnetScan.report.findings.some((f) => f.code === "SPOOFED_PROTECTED_ASSET"),
    ).toBe(true);

    const mainnetTx = new TransactionBuilder(new Account(SOURCE_KP.publicKey(), "100"), {
      fee: BASE_FEE,
      networkPassphrase: "Public Global Stellar Network ; September 2015",
    })
      .addOperation(
        Operation.payment({
          destination: DEST_KP.publicKey(),
          asset: new Asset("USDE", MAINNET_USDE_ISSUER),
          amount: "5",
        }),
      )
      .setTimeout(60)
      .build()
      .toXDR();
    const mainnetScan = scanTransactionEnvelopeXdr(mainnetTx, {
      networkPassphrase: "Public Global Stellar Network ; September 2015",
      verifiedAssets: [{ code: "USDC", issuer: OFFICIAL_USDC_ISSUER }],
    });
    expect(
      mainnetScan.report.findings.some((f) => f.code === "SPOOFED_PROTECTED_ASSET"),
    ).toBe(false);
  });

  it("flags beginSponsoringFutureReserves as a reserve commitment warning and blocks malicious sponsored targets", () => {
    const sponsorTx = buildTestTxXdr((b) => {
      b.addOperation(
        Operation.beginSponsoringFutureReserves({
          sponsoredId: DEST_KP.publicKey(),
        }),
      );
      b.addOperation(
        Operation.endSponsoringFutureReserves({
          source: DEST_KP.publicKey(),
        }),
      );
    });

    const cleanScan = scanTransactionEnvelopeXdr(sponsorTx, {
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    expect(cleanScan.report.verdict).toBe("warning");
    expect(
      cleanScan.report.findings.some((f) => f.code === "SPONSORED_RESERVE_COMMITMENT"),
    ).toBe(true);

    const maliciousScan = scanTransactionEnvelopeXdr(sponsorTx, {
      networkPassphrase: TESTNET_PASSPHRASE,
      directoryEntries: new Map([
        [
          DEST_KP.publicKey(),
          { address: DEST_KP.publicKey(), name: "Scam Account", tags: ["malicious"] },
        ],
      ]),
    });
    expect(maliciousScan.report.verdict).toBe("malicious");
    expect(
      maliciousScan.report.findings.some(
        (f) => f.code === "DIRECTORY_MALICIOUS_SPONSORED_ACCOUNT" && f.blocksSigning,
      ),
    ).toBe(true);
  });

  it("extracts sorobanResourceFeeStroops even when innerTx.fee is tampered and decodes host function args", async () => {
    const { Contract, SorobanDataBuilder, nativeToScVal } = await import("@stellar/stellar-sdk");
    const contractId = StrKey.encodeContract(new Uint8Array(32).fill(7));
    const claimIdBytes = new Uint8Array(32).fill(0xab);
    const contract = new Contract(contractId);
    const sorobanData = new SorobanDataBuilder().setResourceFee("5000000").build();

    const built = new TransactionBuilder(new Account(SOURCE_KP.publicKey(), "100"), {
      fee: "100",
      networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(
        contract.call("refund_expired", nativeToScVal(claimIdBytes, { type: "bytes" })),
      )
      .setSorobanData(sorobanData)
      .setTimeout(60)
      .build();

    // Tamper v1.tx.fee down to 100 while sorobanData.resourceFee remains 5_000_000
    const envXdr = built.toEnvelope();
    envXdr.v1.tx.fee = 100;
    const decoded = decodeTransactionEnvelope(envXdr.toXDR("base64"), TESTNET_PASSPHRASE);
    expect(decoded.feeStroops).toBe("100");
    expect(decoded.sorobanResourceFeeStroops).toBe("5000000");

    const hostFn = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contractId).toScAddress(),
        functionName: "refund_expired",
        args: [nativeToScVal(claimIdBytes, { type: "bytes" })],
      }),
    );
    const { decodeHostFunctionXdr } = await import("./decoder.js");
    const decodedFn = decodeHostFunctionXdr(hostFn.toXDR("base64"));
    expect(decodedFn.contractId).toBe(contractId);
    expect(decodedFn.functionName).toBe("refund_expired");
    expect(decodedFn.args).toEqual(["ab".repeat(32)]);
  });
});
