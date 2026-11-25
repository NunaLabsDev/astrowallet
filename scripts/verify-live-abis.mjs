import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  rpc,
  scValToNative,
} from "../packages/defi/node_modules/@stellar/stellar-sdk/lib/esm/index.js";
import {
  buildCctpApproveXdr,
  evmAddressToBytes32,
  fetchSep40OraclePrices,
  quoteLayerZeroOftBridge,
} from "../packages/defi/dist/index.js";
import {
  buildCreateClaimOperation,
  buildSep50TransferXdr,
  fetchSep50Holdings,
} from "../packages/stellar-core/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseWranglerVars(tomlPath) {
  const text = readFileSync(tomlPath, "utf8");
  const sections = { vars: {}, mainnet: {} };
  let active = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[vars]" || line === "[env.testnet.vars]") {
      active = "vars";
      continue;
    }
    if (line === "[env.mainnet.vars]") {
      active = "mainnet";
      continue;
    }
    if (line.startsWith("[")) {
      active = null;
      continue;
    }
    if (!active) continue;
    const match = /^([A-Z0-9_]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (match) {
      sections[active][match[1]] = match[2];
    }
  }
  return sections;
}

async function simulateContractRead(rpcUrl, passphrase, contractId, method, args = []) {
  const server = new rpc.Server(rpcUrl);
  const readonlyId = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const tx = new TransactionBuilder(
    {
      accountId: () => readonlyId,
      sequenceNumber: () => "0",
      incrementSequenceNumber: () => {},
    },
    { fee: BASE_FEE, networkPassphrase: passphrase },
  )
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(25)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed for ${contractId}.${method}: ${sim.error}`);
  }
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

async function getWasmExports(rpcUrl, contractId) {
  const server = new rpc.Server(rpcUrl);
  const wasmBytes = await server.getContractWasmByContractId(contractId);
  const mod = await WebAssembly.compile(wasmBytes);
  return WebAssembly.Module.exports(mod)
    .filter((entry) => entry.kind === "function")
    .map((entry) => entry.name);
}

const wrangler = parseWranglerVars(resolve(ROOT, "apps/server/wrangler.toml"));
const testnetRpcs = (wrangler.vars.STELLAR_RPC_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const mainnetRpcs = (wrangler.mainnet.STELLAR_RPC_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const redstoneId =
  process.env.REDSTONE_ORACLE_CONTRACT_ID ?? wrangler.mainnet.REDSTONE_ORACLE_CONTRACT_ID;
const claimEscrowTestnetId =
  process.env.CLAIM_ESCROW_CONTRACT_ID ?? wrangler.vars.CLAIM_ESCROW_CONTRACT_ID;
const allowedContracts = (wrangler.vars.RELAY_ALLOWED_CONTRACTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const sorobitsTestnetId =
  process.env.SOROBITS_CONTRACT_ID ?? allowedContracts[3];
const lzOftMainnetId =
  process.env.LZ_OFT_CONTRACT_ID ?? "CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6";
const cctpTmmMainnetId =
  process.env.CCTP_TMM_CONTRACT_ID ?? "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL";

assert.ok(testnetRpcs.length > 0, "Missing STELLAR_RPC_URLS in wrangler.toml [vars]");
assert.ok(mainnetRpcs.length > 0, "Missing STELLAR_RPC_URLS in wrangler.toml [env.mainnet.vars]");
assert.ok(redstoneId, "Missing REDSTONE_ORACLE_CONTRACT_ID");
assert.ok(claimEscrowTestnetId, "Missing CLAIM_ESCROW_CONTRACT_ID");
assert.ok(sorobitsTestnetId, "Missing Sorobits contract ID in RELAY_ALLOWED_CONTRACTS");

const summary = {};

// 1. SEP-40 RedStone Mainnet (real contract without pre-supplied contractId)
const sep40 = await fetchSep40OraclePrices({
  oracleContractId: redstoneId,
  rpcUrls: mainnetRpcs,
  networkPassphrase: Networks.PUBLIC,
  assets: [
    { key: "XLM", symbol: "XLM" },
    { key: "USDC", symbol: "USDC" },
    { key: "USDT", symbol: "USDT" },
    { key: "EURC", symbol: "EURC" },
    { key: "PYUSD", symbol: "PYUSD" },
    { key: "USDY", symbol: "USDY" },
    { key: "earnUSDC_PPS", symbol: "earnUSDC_PPS" },
  ],
  maxStalenessSec: 86_400,
});
for (const key of ["XLM", "USDC", "USDT", "EURC", "PYUSD", "USDY", "earnUSDC_PPS"]) {
  const quote = sep40.prices[key];
  assert.ok(quote, `Expected SEP-40 live price for ${key}`);
  assert.ok(quote.priceUsd > 0, `Expected positive SEP-40 price for ${key}`);
}
assert.equal(sep40.prices.XLM.sourceKind, "stellar");
assert.equal(sep40.prices.earnUSDC_PPS.sourceKind, "other");
assert.ok(sep40.prices.USDC.priceUsd > 0.95 && sep40.prices.USDC.priceUsd < 1.05);
assert.ok(sep40.prices.USDT.priceUsd > 0.95 && sep40.prices.USDT.priceUsd < 1.05);
assert.ok(sep40.prices.PYUSD.priceUsd > 0.95 && sep40.prices.PYUSD.priceUsd < 1.05);
assert.ok(sep40.prices.earnUSDC_PPS.priceUsd > 1.0);
summary.sep40Mainnet = {
  contractId: redstoneId,
  decimals: sep40.decimals,
  latestLedger: sep40.latestLedger,
  pricesUsd: Object.fromEntries(
    Object.entries(sep40.prices).map(([k, v]) => [k, { priceUsd: v.priceUsd, sourceKind: v.sourceKind, ageSec: v.ageSec }]),
  ),
};

// 2. LayerZero V2 OFT Mainnet (USDT0 quotes on Ethereum 30101 & Arbitrum 30110)
const toEvm32 = evmAddressToBytes32("0x1111111111111111111111111111111111111111");
const usdt0Sender = "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q";
const oftEthDust = await quoteLayerZeroOftBridge({
  oftContractId: lzOftMainnetId,
  from: usdt0Sender,
  dstEid: 30101,
  toBytes32: toEvm32,
  amountLdStroops7: 100_000_007n,
  slippageBps: 50,
  rpcUrls: mainnetRpcs,
  networkPassphrase: Networks.PUBLIC,
});
assert.equal(oftEthDust.amountSentLdStroops7, 100_000_000n);
assert.equal(oftEthDust.amountReceivedLdStroops7, 100_000_000n);
assert.ok(oftEthDust.nativeFeeStroops > 0n);

const oftArb = await quoteLayerZeroOftBridge({
  oftContractId: lzOftMainnetId,
  from: usdt0Sender,
  dstEid: 30110,
  toBytes32: toEvm32,
  amountLdStroops7: 100_000_000n,
  slippageBps: 50,
  rpcUrls: mainnetRpcs,
  networkPassphrase: Networks.PUBLIC,
});
assert.equal(oftArb.amountReceivedLdStroops7, 100_000_000n);
assert.ok(oftArb.nativeFeeStroops > 0n);
summary.layerZeroOftMainnet = {
  oftContractId: lzOftMainnetId,
  ethDustQuote: {
    dstEid: 30101,
    amountSentLd: oftEthDust.amountSentLdStroops7.toString(),
    amountReceivedLd: oftEthDust.amountReceivedLdStroops7.toString(),
    nativeFeeStroops: oftEthDust.nativeFeeStroops.toString(),
  },
  arbitrumQuote: {
    dstEid: 30110,
    amountReceivedLd: oftArb.amountReceivedLdStroops7.toString(),
    nativeFeeStroops: oftArb.nativeFeeStroops.toString(),
  },
};

// 3. Circle CCTP V2 Mainnet approve read-only simulation
const usdcMainnetIssuer = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const usdcMainnetSac = new Asset("USDC", usdcMainnetIssuer).contractId(Networks.PUBLIC);
const cctpApprove = await buildCctpApproveXdr({
  from: usdcMainnetIssuer,
  usdcSacContractId: usdcMainnetSac,
  tokenMessengerMinterContractId: cctpTmmMainnetId,
  amountStroops7: 50_000_000n,
  rpcUrls: mainnetRpcs,
  networkPassphrase: Networks.PUBLIC,
});
assert.equal(cctpApprove.alreadyApproved, false);
assert.ok(cctpApprove.unsignedXdr && cctpApprove.unsignedXdr.length > 100);
assert.ok(Number(cctpApprove.minResourceFee ?? "0") > 0);
summary.cctpMainnetApprove = {
  tmmContractId: cctpTmmMainnetId,
  usdcSacContractId: usdcMainnetSac,
  minResourceFee: cctpApprove.minResourceFee,
  xdrLength: cctpApprove.unsignedXdr.length,
};

// 4. Sorobits SEP-50 Testnet holdings & soulbound detection
const soulboundOwner = "GB6CISIU2PAG7MVCR4HKA27VY5OBBJ4P2L5IDEOH7UL34TU66OOFCNZA";
const multiOwner = "GDQJTJJ2ZABBNEAJ2CF6EQB6ATR2P2J3336TWQG57SE3QMKB3DRKAP2J";
const [snap0, snap1] = await Promise.all([
  fetchSep50Holdings({
    contractId: sorobitsTestnetId,
    ownerAddress: soulboundOwner,
    rpcUrls: testnetRpcs,
    networkPassphrase: Networks.TESTNET,
  }),
  fetchSep50Holdings({
    contractId: sorobitsTestnetId,
    ownerAddress: multiOwner,
    rpcUrls: testnetRpcs,
    networkPassphrase: Networks.TESTNET,
  }),
]);
assert.equal(snap0.collectionName, "Sorobits");
assert.equal(snap0.items[0]?.tokenId, 0);
assert.equal(snap0.items[0]?.soulbound, true);
assert.ok(snap0.items[0]?.image?.startsWith("data:image/svg+xml;utf8,<svg"));

const tok1 = snap1.items.find((i) => i.tokenId === 1);
const tok6 = snap1.items.find((i) => i.tokenId === 6);
assert.equal(tok1?.soulbound, true);
assert.equal(tok6?.soulbound, false);

const xfer6 = await buildSep50TransferXdr({
  contractId: sorobitsTestnetId,
  from: multiOwner,
  to: soulboundOwner,
  tokenId: 6,
  rpcUrls: testnetRpcs,
  networkPassphrase: Networks.TESTNET,
});
assert.ok(Number(xfer6.minResourceFee) > 0);
await assert.rejects(
  buildSep50TransferXdr({
    contractId: sorobitsTestnetId,
    from: soulboundOwner,
    to: multiOwner,
    tokenId: 0,
    rpcUrls: testnetRpcs,
    networkPassphrase: Networks.TESTNET,
  }),
  /soulbound on-chain/i,
);
summary.sorobitsSep50Testnet = {
  contractId: sorobitsTestnetId,
  collectionName: snap0.collectionName,
  collectionSymbol: snap0.collectionSymbol,
  token0Soulbound: snap0.items[0]?.soulbound,
  token1Soulbound: tok1?.soulbound,
  token6Soulbound: tok6?.soulbound,
  token6TransferSimFee: xfer6.minResourceFee,
};

// 5. Claim-Escrow Testnet ABI & 7-arg create_claim simulation
const escrowExports = await getWasmExports(testnetRpcs[0], claimEscrowTestnetId);
for (const fn of [
  "init",
  "set_deposits_paused",
  "is_deposits_paused",
  "get_escrowed_balance",
  "rescue_excess",
  "create_claim",
  "claim",
  "refund_expired",
  "refund_expired_to",
  "cancel_claim",
  "cancel_claim_to",
  "extend_claim_ttl",
  "get_claim",
]) {
  assert.ok(escrowExports.includes(fn), `Missing exported function ${fn} on ${claimEscrowTestnetId}`);
}
const xlmTestSac = Asset.native().contractId(Networks.TESTNET);
const isDepositsPaused = await simulateContractRead(
  testnetRpcs[0],
  Networks.TESTNET,
  claimEscrowTestnetId,
  "is_deposits_paused",
);
const escrowedXlmBalance = await simulateContractRead(
  testnetRpcs[0],
  Networks.TESTNET,
  claimEscrowTestnetId,
  "get_escrowed_balance",
  [new Contract(xlmTestSac).address().toScVal()],
);
assert.equal(isDepositsPaused, false);
assert.equal(escrowedXlmBalance, 0n);

const testRpc = new rpc.Server(testnetRpcs[0]);
const senderAcc = await testRpc.getAccount(soulboundOwner);
const createOp = buildCreateClaimOperation({
  escrowContractId: claimEscrowTestnetId,
  claimIdHex: "22".repeat(32),
  senderAddress: soulboundOwner,
  tokenContractId: xlmTestSac,
  amountStroops: 1_000n,
  claimPubkeyHex: Buffer.from(Keypair.random().rawPublicKey()).toString("hex"),
  expiresAtUnix: Math.floor(Date.now() / 1000) + 3600,
  cancellable: true,
});
const createTx = new TransactionBuilder(senderAcc, {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(createOp)
  .setTimeout(30)
  .build();
const createSim = await testRpc.simulateTransaction(createTx);
assert.equal(
  rpc.Api.isSimulationError(createSim),
  false,
  `claim-escrow create_claim simulation failed: ${rpc.Api.isSimulationError(createSim) ? createSim.error : ""}`,
);
summary.claimEscrowTestnet = {
  contractId: claimEscrowTestnetId,
  exportedFunctions: escrowExports,
  isDepositsPaused,
  escrowedXlmBalance: escrowedXlmBalance.toString(),
  createClaim7ArgSimMinResourceFee: createSim.minResourceFee,
};

console.log(JSON.stringify({ ok: true, verifiedAt: new Date().toISOString(), summary }, null, 2));
