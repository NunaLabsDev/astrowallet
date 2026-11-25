import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  NEAR_STELLAR_USDC_ASSET_ID,
  NEAR_STELLAR_XLM_ASSET_ID,
  buildCctpApproveXdr,
  buildCctpDepositForBurnXdr,
  buildCctpForwarderHookData,
  buildCctpMintAndForwardXdr,
  buildLayerZeroOftSendXdr,
  computeLayerZeroOftSharedAmount,
  contractStrkeyToBytes32Hex,
  convertEvmUsdc6ToStellarStroops7,
  convertStellarUsdcToEvmAtomic6,
  createNearIntentsQuoteAdapter,
  deriveAssetContractId,
  encodeLayerZeroRecipientBytes32,
  evmAddressToBytes32,
  quoteLayerZeroOftBridge,
  stroops7ToDecimal,
  type LayerZeroOftQuoteResult,
  type NearIntentsQuoteResult,
} from "@astrowallet/defi";
import {
  ContractAddressSchema,
  normalizeDecimalAmountInput,
  type ClassicAddress,
} from "@astrowallet/domain";
import { useWallet } from "../state/wallet-context.js";
import { copyTextToClipboard, openExternalUrl } from "../telegram/webapp.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import { ClearSignSummaryCard } from "./ClearSignSummaryCard.js";

type RampTab = "cash" | "any_chain" | "pro_bridge";

const NEAR_ORIGIN_ASSETS = [
  { id: "nep141:btc.omft.near", label: "Bitcoin (BTC)", decimals: 8, chain: "Bitcoin" },
  { id: "nep141:eth.omft.near", label: "Ethereum (ETH)", decimals: 18, chain: "Ethereum" },
  { id: "nep141:sol.omft.near", label: "Solana (SOL)", decimals: 9, chain: "Solana" },
  { id: "nep141:ton.omft.near", label: "TON (TON)", decimals: 9, chain: "TON" },
  {
    id: NEAR_STELLAR_USDC_ASSET_ID,
    label: "Stellar USDC (Origin → Cross-Chain)",
    decimals: 7,
    chain: "Stellar",
  },
] as const;

function decimalToAtomicString(decimalInput: string, decimals: number): string {
  const clean = normalizeDecimalAmountInput(decimalInput, decimals);
  if (!clean) {
    throw new Error(`Enter a valid positive decimal amount (up to ${decimals} decimals)`);
  }
  const [wholePart = "0", fracPart = ""] = clean.split(".");
  const paddedFrac = fracPart.padEnd(decimals, "0");
  const combined = `${wholePart}${paddedFrac}`.replace(/^0+/, "");
  if (!combined) {
    throw new Error("Amount must be greater than 0");
  }
  return combined;
}

async function readJsonSafe<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      res.ok ? "Anchor returned non-JSON response" : `Anchor HTTP ${res.status}`,
    );
  }
}

const NEAR_DEST_STELLAR_ASSETS = [
  { id: NEAR_STELLAR_USDC_ASSET_ID, label: "Stellar USDC", chain: "Stellar" },
  { id: NEAR_STELLAR_XLM_ASSET_ID, label: "Stellar XLM", chain: "Stellar" },
] as const;

const NEAR_DEST_CROSSCHAIN_ASSETS = [
  { id: "nep141:btc.omft.near", label: "Bitcoin (BTC)", chain: "Bitcoin" },
  { id: "nep141:eth.omft.near", label: "Ethereum (ETH)", chain: "Ethereum" },
  { id: "nep141:sol.omft.near", label: "Solana (SOL)", chain: "Solana" },
  { id: "nep141:ton.omft.near", label: "TON (TON)", chain: "TON" },
] as const;

const CCTP_DOMAINS = [
  { domain: 0, label: "Ethereum (Domain 0)" },
  { domain: 6, label: "Base (Domain 6)" },
  { domain: 3, label: "Arbitrum (Domain 3)" },
  { domain: 2, label: "Optimism (Domain 2)" },
  { domain: 7, label: "Polygon (Domain 7)" },
  { domain: 1, label: "Avalanche (Domain 1)" },
] as const;

const LAYERZERO_EIDS = [
  { eid: 30101, label: "Ethereum (EID 30101)" },
  { eid: 30109, label: "Polygon (EID 30109)" },
  { eid: 30110, label: "Arbitrum (EID 30110)" },
  { eid: 30111, label: "Optimism (EID 30111)" },
  { eid: 30184, label: "Base (EID 30184)" },
  { eid: 40161, label: "Sepolia Testnet (EID 40161)" },
] as const;

/**
 * Unified Cash & Cross-Chain Hub inside Telegram Mini App:
 * 1) MoneyGram Ramps (SEP-24 Cash-Out / Cash-In)
 * 2) NEAR Intents 1-Click Cross-Chain Deposit (with strict MEMO guard)
 * 3) Pro Bridge Execution (Circle CCTP V2 Burn/Forward + LayerZero V2 OFT Quote/Send)
 */
export function RampSheet() {
  const {
    config,
    activeAccount,
    accountState,
    verifiedAssets,
    tonAccount,
    ensureTonAccount,
    signSep10ChallengeXdr,
    signAndSubmitRawXdrWithShield,
    showToast,
  } = useWallet();

  const [activeTab, setActiveTab] = useState<RampTab>("cash");

  // MoneyGram SEP-24 state
  const [cashDirection, setCashDirection] = useState<"offramp" | "onramp">("offramp");
  const [cashAmount, setCashAmount] = useState("50.00");
  const [anchorDomain, setAnchorDomain] = useState(
    () => config.moneygramAnchorDomain ?? "",
  );
  const [cashBusy, setCashBusy] = useState(false);
  const [cashSessionUrl, setCashSessionUrl] = useState<string | null>(null);
  const [cashError, setCashError] = useState<string | null>(null);

  // NEAR Intents 1-Click state
  const [originAsset, setOriginAsset] = useState<string>(NEAR_ORIGIN_ASSETS[0].id);
  const [destAsset, setDestAsset] = useState<string>(NEAR_DEST_STELLAR_ASSETS[0].id);
  const [nearAmountDecimal, setNearAmountDecimal] = useState("0.01");
  const [nearRefundAddress, setNearRefundAddress] = useState("");
  const [nearDestAddress, setNearDestAddress] = useState("");
  const [nearBusy, setNearBusy] = useState(false);
  const [nearQuote, setNearQuote] = useState<NearIntentsQuoteResult | null>(null);
  const [nearLockedQuote, setNearLockedQuote] = useState<NearIntentsQuoteResult | null>(null);
  const [nearError, setNearError] = useState<string | null>(null);
  const [copiedAddr, setCopiedAddr] = useState(false);

  const isStellarOrigin = originAsset === NEAR_STELLAR_USDC_ASSET_ID;
  const destOptions = isStellarOrigin
    ? NEAR_DEST_CROSSCHAIN_ASSETS
    : NEAR_DEST_STELLAR_ASSETS;

  useEffect(() => {
    setNearQuote(null);
    setNearLockedQuote(null);
    setNearError(null);
    if (isStellarOrigin) {
      if (!NEAR_DEST_CROSSCHAIN_ASSETS.some((d) => d.id === destAsset)) {
        setDestAsset(NEAR_DEST_CROSSCHAIN_ASSETS[0].id);
      }
      setNearRefundAddress(activeAccount?.address ?? "");
    } else {
      if (!NEAR_DEST_STELLAR_ASSETS.some((d) => d.id === destAsset)) {
        setDestAsset(NEAR_DEST_STELLAR_ASSETS[0].id);
      }
      setNearDestAddress(activeAccount?.address ?? "");
      if (originAsset === "nep141:ton.omft.near" && tonAccount?.friendlyAddress) {
        setNearRefundAddress(tonAccount.friendlyAddress);
      } else if (nearRefundAddress === activeAccount?.address) {
        setNearRefundAddress("");
      }
    }
  }, [originAsset, isStellarOrigin, activeAccount?.address, tonAccount?.friendlyAddress]);

  useEffect(() => {
    if (isStellarOrigin && destAsset === "nep141:ton.omft.near" && tonAccount?.friendlyAddress) {
      setNearDestAddress(tonAccount.friendlyAddress);
    } else if (!isStellarOrigin && activeAccount?.address) {
      setNearDestAddress(activeAccount.address);
    } else if (isStellarOrigin && nearDestAddress === activeAccount?.address) {
      setNearDestAddress("");
    }
  }, [destAsset, isStellarOrigin, activeAccount?.address, tonAccount?.friendlyAddress]);

  useEffect(() => {
    setAnchorDomain(config.moneygramAnchorDomain ?? "");
    setCashSessionUrl(null);
    setCashError(null);
  }, [config.network, config.moneygramAnchorDomain]);

  // Pro Bridge (CCTP V2 + LayerZero V2 OFT) state
  const [proRail, setProRail] = useState<"cctp" | "layerzero">("cctp");
  const [direction, setDirection] = useState<"onramp" | "offramp">("offramp");
  const [amount, setAmount] = useState("25.00");
  const [evmDestAddress, setEvmDestAddress] = useState("");
  const [cctpDestDomain, setCctpDestDomain] = useState<number>(6);
  const [cctpTmmId, setCctpTmmId] = useState(
    () => config.cctpTokenMessengerContractId ?? "",
  );
  const [forwarderId, setForwarderId] = useState(
    () => config.cctpForwarderContractId ?? "",
  );
  const [cctpMessageHex, setCctpMessageHex] = useState("");
  const [cctpAttestationHex, setCctpAttestationHex] = useState("");
  const [lzDestEid, setLzDestEid] = useState<number>(
    () => (config.network === "mainnet" ? 30101 : 40161),
  );
  const [lzOftContractId, setLzOftContractId] = useState(() => config.lzOftContractId ?? "");
  const [lzSlippageBps, setLzSlippageBps] = useState("50");
  const [lzQuote, setLzQuote] = useState<LayerZeroOftQuoteResult | null>(null);
  const [pendingBridgeStage, setPendingBridgeStage] = useState<{
    label: string;
    unsignedXdr: string;
    summary: string;
    step: "cctp_approve" | "cctp_burn" | "cctp_forward" | "lz_send";
  } | null>(null);
  const [bridgeTxHash, setBridgeTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setCctpTmmId(config.cctpTokenMessengerContractId ?? "");
    setForwarderId(config.cctpForwarderContractId ?? "");
    setLzOftContractId(config.lzOftContractId ?? "");
    setLzDestEid(config.network === "mainnet" ? 30101 : 40161);
    setLzQuote(null);
    setPendingBridgeStage(null);
    setErrorMsg(null);
    setBridgeTxHash(null);
  }, [
    config.network,
    config.cctpTokenMessengerContractId,
    config.cctpForwarderContractId,
    config.lzOftContractId,
  ]);

  const CANONICAL_CIRCLE_USDC_ISSUER: Record<"testnet" | "mainnet", string> = {
    mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  };

  const resolvedUsdcSacContractId = useMemo(() => {
    const canonicalIssuer = CANONICAL_CIRCLE_USDC_ISSUER[config.network];
    try {
      return deriveAssetContractId("USDC", canonicalIssuer, config.networkPassphrase);
    } catch {
      const match = verifiedAssets.find((v) => v.code.trim().toUpperCase() === "USDC");
      if (!match) return null;
      try {
        return deriveAssetContractId("USDC", match.issuer, config.networkPassphrase);
      } catch {
        return null;
      }
    }
  }, [config.network, config.networkPassphrase, verifiedAssets]);

  const cctpInboundHookPreview = useMemo(() => {
    if (!activeAccount) return null;
    try {
      const hook = buildCctpForwarderHookData(activeAccount.address);
      const parsedForwarder = ContractAddressSchema.safeParse(forwarderId.trim());
      return {
        ok: true as const,
        hookDataHex: hook.hex,
        forwarderBytes32: parsedForwarder.success
          ? contractStrkeyToBytes32Hex(parsedForwarder.data)
          : null,
      };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Invalid forwarder recipient",
      };
    }
  }, [activeAccount, forwarderId]);

  const hasUsdcTrustline = useMemo(() => {
    if (!accountState?.funded) return false;
    return accountState.balances.some((b) => b.assetCode.toUpperCase() === "USDC");
  }, [accountState]);

  const decimalPreview = useMemo(() => {
    try {
      const evm = convertStellarUsdcToEvmAtomic6(amount);
      const back = convertEvmUsdc6ToStellarStroops7(evm.atomic6);
      return {
        ok: true as const,
        atomic6: evm.atomic6.toString(),
        stroops7: evm.stroops7.toString(),
        formatted: back.formattedStellarUsdc,
      };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Invalid decimal precision",
      };
    }
  }, [amount]);

  const oftPreview = useMemo(() => {
    if (!activeAccount) return null;
    try {
      const oft = computeLayerZeroOftSharedAmount(amount);
      const recipientBytes32 = encodeLayerZeroRecipientBytes32(activeAccount.address);
      return {
        ok: true as const,
        ...oft,
        recipientBytes32,
      };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Invalid OFT parameters",
      };
    }
  }, [amount, activeAccount]);

  const cashBusyRef = useRef(false);
  const nearBusyRef = useRef(false);
  const bridgeSubmittingRef = useRef(false);

  useEffect(() => {
    if (
      activeTab === "any_chain" &&
      (originAsset === "nep141:ton.omft.near" || destAsset === "nep141:ton.omft.near") &&
      !tonAccount
    ) {
      void ensureTonAccount();
    }
  }, [activeTab, originAsset, destAsset, tonAccount, ensureTonAccount]);

  if (!activeAccount) return null;

  const handleBuildMoneyGramSession = async (e: FormEvent) => {
    e.preventDefault();
    if (cashBusyRef.current) return;
    cashBusyRef.current = true;
    setCashBusy(true);
    setCashError(null);
    setCashSessionUrl(null);
    try {
      if (activeAccount.kind !== "classic" || !activeAccount.address.startsWith("G")) {
        throw new Error(
          "MoneyGram SEP-10 authentication requires a Classic G... account. Switch from your Smart Account first.",
        );
      }
      if (accountState?.funded) {
        const hasUsdcTrustline = accountState.balances.some(
          (b) => b.assetCode.toUpperCase() === "USDC" && Boolean(b.assetIssuer),
        );
        if (!hasUsdcTrustline) {
          throw new Error(
            "Activate a USDC trustline first before starting MoneyGram SEP-24 Cash-In/Out.",
          );
        }
      }
      const apiBase = config.apiBaseUrl.replace(/\/+$/, "");
      const cleanDomain = anchorDomain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
      if (!cleanDomain) {
        throw new Error("Enter a valid SEP-24 anchor domain.");
      }
      const chRes = await fetch(
        `${apiBase}/v1/proxy/sep10/challenge?domain=${encodeURIComponent(cleanDomain)}&account=${encodeURIComponent(activeAccount.address)}`,
        { headers: { "X-Astro-Network": config.network } },
      );
      const chJson = await readJsonSafe<{ transaction?: string; error?: string }>(chRes);
      if (!chRes.ok || !chJson.transaction) {
        throw new Error(chJson.error ?? "Failed to fetch MoneyGram SEP-10 challenge");
      }

      const signedXdr = await signSep10ChallengeXdr(chJson.transaction);
      const tokRes = await fetch(`${apiBase}/v1/proxy/sep10/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Astro-Network": config.network,
        },
        body: JSON.stringify({ domain: cleanDomain, transaction: signedXdr }),
      });
      const tokJson = await readJsonSafe<{ token?: string; error?: string }>(tokRes);
      if (!tokRes.ok || !tokJson.token) {
        throw new Error(tokJson.error ?? "MoneyGram SEP-10 authentication failed");
      }

      const sep24Res = await fetch(`${apiBase}/v1/proxy/sep24/interactive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Astro-Network": config.network,
        },
        body: JSON.stringify({
          domain: cleanDomain,
          direction: cashDirection === "offramp" ? "withdraw" : "deposit",
          token: tokJson.token,
          assetCode: "USDC",
          amount: cashAmount.trim(),
          account: activeAccount.address,
        }),
      });
      const sep24Json = await readJsonSafe<{ url?: string; error?: string }>(sep24Res);
      if (!sep24Res.ok || !sep24Json.url || !sep24Json.url.startsWith("https://")) {
        throw new Error(sep24Json.error ?? "MoneyGram SEP-24 interactive session failed");
      }
      setCashSessionUrl(sep24Json.url);
    } catch (err) {
      setCashError(err instanceof Error ? err.message : "Failed to prepare MoneyGram SEP-24 session");
    } finally {
      cashBusyRef.current = false;
      setCashBusy(false);
    }
  };

  const requestNearQuote = async (dry: boolean) => {
    if (nearBusyRef.current) return;
    nearBusyRef.current = true;
    setNearBusy(true);
    setNearError(null);
    if (dry) {
      setNearQuote(null);
      setNearLockedQuote(null);
    } else {
      setNearLockedQuote(null);
    }
    try {
      const originMeta = NEAR_ORIGIN_ASSETS.find((a) => a.id === originAsset);
      const effectiveRecipient = (
        isStellarOrigin ? nearDestAddress : nearDestAddress || activeAccount.address
      ).trim();
      const effectiveRefundTo = (
        isStellarOrigin ? nearRefundAddress || activeAccount.address : nearRefundAddress
      ).trim();
      if (!effectiveRecipient) {
        throw new Error("Enter a valid destination address for the target chain.");
      }
      if (!effectiveRefundTo) {
        throw new Error(
          `Enter your ${originMeta?.chain ?? "origin chain"} refund address before quoting.`,
        );
      }
      if (
        originAsset !== NEAR_STELLAR_USDC_ASSET_ID &&
        effectiveRefundTo === activeAccount.address
      ) {
        throw new Error(
          `Refund address must be a valid ${originMeta?.chain ?? "origin chain"} address (not Stellar G...).`,
        );
      }
      const amountAtomic = decimalToAtomicString(nearAmountDecimal, originMeta?.decimals ?? 8);
      const adapter = createNearIntentsQuoteAdapter({
        apiBaseUrl: config.nearIntentsApiBase,
      });
      const q = await adapter.requestQuote({
        originAsset,
        destinationAsset: destAsset,
        amountAtomic,
        recipient: effectiveRecipient,
        refundTo: effectiveRefundTo,
        dry,
      });
      if (dry) {
        setNearQuote(q);
      } else {
        setNearLockedQuote(q);
      }
    } catch (err) {
      setNearError(err instanceof Error ? err.message : "Failed to fetch NEAR Intents quote");
    } finally {
      nearBusyRef.current = false;
      setNearBusy(false);
    }
  };

  const handleNearDryQuote = async (e: FormEvent) => {
    e.preventDefault();
    await requestNearQuote(true);
  };

  const buildCctpOutboundStage = async (skipApproveCheck = false) => {
    if (activeAccount.kind !== "classic" || !activeAccount.address.startsWith("G")) {
      throw new Error("Pro Bridge signing requires an active Classic G... signer account.");
    }
    if (!resolvedUsdcSacContractId) {
      throw new Error("USDC SEP-42 issuer / SAC contract could not be resolved on this network.");
    }
    const parsedTmm = ContractAddressSchema.safeParse(cctpTmmId.trim());
    if (!parsedTmm.success) {
      throw new Error("Enter a valid CCTP TokenMessengerMinter C... contract ID.");
    }
    const evmBytes32 = evmAddressToBytes32(evmDestAddress);
    const { stroops7, formattedStellarUsdc } = convertEvmUsdc6ToStellarStroops7(
      convertStellarUsdcToEvmAtomic6(amount).atomic6,
    );

    if (!skipApproveCheck) {
      const approveRes = await buildCctpApproveXdr({
        from: activeAccount.address as ClassicAddress,
        usdcSacContractId: resolvedUsdcSacContractId,
        tokenMessengerMinterContractId: parsedTmm.data,
        amountStroops7: stroops7,
        rpcUrls: config.rpcUrls,
        networkPassphrase: config.networkPassphrase,
      });
      if (!approveRes.alreadyApproved && approveRes.unsignedXdr) {
        setPendingBridgeStage({
          step: "cctp_approve",
          label: `Step 1/2 · Approve ${formattedStellarUsdc} USDC Allowance`,
          unsignedXdr: approveRes.unsignedXdr,
          summary: `Approve TokenMessengerMinter (${parsedTmm.data.slice(0, 6)}…) to burn ${formattedStellarUsdc} USDC via CCTP.`,
        });
        return;
      }
    }

    const burnRes = await buildCctpDepositForBurnXdr({
      from: activeAccount.address as ClassicAddress,
      usdcSacContractId: resolvedUsdcSacContractId,
      tokenMessengerMinterContractId: parsedTmm.data,
      destinationDomain: cctpDestDomain,
      mintRecipientBytes32: evmBytes32,
      amountStroops7: stroops7,
      rpcUrls: config.rpcUrls,
      networkPassphrase: config.networkPassphrase,
    });
    const destLabel =
      CCTP_DOMAINS.find((d) => d.domain === cctpDestDomain)?.label ?? `Domain ${cctpDestDomain}`;
    setPendingBridgeStage({
      step: "cctp_burn",
      label: `Burn ${formattedStellarUsdc} USDC via CCTP -> ${destLabel}`,
      unsignedXdr: burnRes.unsignedXdr,
      summary: `Burn ${formattedStellarUsdc} USDC on Stellar via Circle CCTP V2 to ${evmDestAddress.trim()} on ${destLabel}.`,
    });
  };

  const handlePrepareProBridge = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    setBridgeTxHash(null);
    setPendingBridgeStage(null);

    try {
      if (activeAccount.kind !== "classic" || !activeAccount.address.startsWith("G")) {
        throw new Error("Pro Bridge execution requires an active Classic G... signer account.");
      }

      if (proRail === "cctp") {
        if (direction === "offramp") {
          await buildCctpOutboundStage(false);
        } else {
          const parsedFwd = ContractAddressSchema.safeParse(forwarderId.trim());
          if (!parsedFwd.success) {
            throw new Error("Enter a valid CctpForwarder C... contract address.");
          }
          const fwdRes = await buildCctpMintAndForwardXdr({
            caller: activeAccount.address as ClassicAddress,
            cctpForwarderContractId: parsedFwd.data,
            messageHex: cctpMessageHex,
            attestationHex: cctpAttestationHex,
            rpcUrls: config.rpcUrls,
            networkPassphrase: config.networkPassphrase,
          });
          setPendingBridgeStage({
            step: "cctp_forward",
            label: "Execute CctpForwarder.mint_and_forward",
            unsignedXdr: fwdRes.unsignedXdr,
            summary: `Verify Circle attestation & mint forwarded USDC onto Stellar via CctpForwarder (${parsedFwd.data.slice(0, 6)}…).`,
          });
        }
      } else {
        const parsedOft = ContractAddressSchema.safeParse(lzOftContractId.trim());
        if (!parsedOft.success) {
          throw new Error("Enter a valid LayerZero V2 OFT C... contract ID.");
        }
        const toBytes32 = evmAddressToBytes32(evmDestAddress);
        const { sendableStroops7, sendableFormatted } = computeLayerZeroOftSharedAmount(amount);
        const slip = Number.parseInt(lzSlippageBps.trim() || "50", 10);
        const quote = await quoteLayerZeroOftBridge({
          oftContractId: parsedOft.data,
          from: activeAccount.address,
          dstEid: lzDestEid,
          toBytes32,
          amountLdStroops7: sendableStroops7,
          slippageBps: Number.isFinite(slip) ? slip : 50,
          rpcUrls: config.rpcUrls,
          networkPassphrase: config.networkPassphrase,
        });
        setLzQuote(quote);

        const built = await buildLayerZeroOftSendXdr({
          oftContractId: parsedOft.data,
          from: activeAccount.address as ClassicAddress,
          refundAddress: activeAccount.address as ClassicAddress,
          dstEid: lzDestEid,
          toBytes32,
          amountLdStroops7: sendableStroops7,
          minAmountLdStroops7: quote.minAmountLdStroops7,
          nativeFeeStroops: quote.nativeFeeStroops,
          zroFee: quote.zroFee,
          rpcUrls: config.rpcUrls,
          networkPassphrase: config.networkPassphrase,
        });
        const destLabel =
          LAYERZERO_EIDS.find((x) => x.eid === lzDestEid)?.label ?? `EID ${lzDestEid}`;
        const feeXlm = stroops7ToDecimal(quote.nativeFeeStroops);
        setPendingBridgeStage({
          step: "lz_send",
          label: `Send ${sendableFormatted} OFT -> ${destLabel}`,
          unsignedXdr: built.unsignedXdr,
          summary: `Bridge ${sendableFormatted} OFT to ${evmDestAddress.trim()} on ${destLabel} · LayerZero Fee: ${feeXlm} XLM.`,
        });
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to simulate cross-chain transaction");
    } finally {
      setBusy(false);
    }
  };

  const handleSignProBridgeStage = async () => {
    if (!pendingBridgeStage || bridgeSubmittingRef.current) return;
    bridgeSubmittingRef.current = true;
    setBusy(true);
    setErrorMsg(null);
    try {
      const stage = pendingBridgeStage;
      const res = await signAndSubmitRawXdrWithShield(stage.unsignedXdr, false);
      setBridgeTxHash(res.hash);
      showToast(`Pro Bridge tx confirmed: ${res.hash.slice(0, 8)}…`);
      if (stage.step === "cctp_approve") {
        // Allowance confirmed; immediately prepare the CCTP deposit_for_burn tx for signature
        await buildCctpOutboundStage(true);
      } else {
        setPendingBridgeStage(null);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Pro Bridge signing failed");
    } finally {
      bridgeSubmittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <section
      className="glass-card"
      aria-label="Cash and Cross-Chain Hub"
      style={{ display: "grid", gap: 12 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <AstroNavigatorAvatar
          seedKey={`${activeAccount.address}:ramp`}
          kind={activeAccount.kind}
          state={cashSessionUrl || nearQuote || bridgeTxHash ? "zenith" : busy || nearBusy ? "warp" : "float"}
          size={52}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>
            Cash &amp; Cross-Chain Hub
          </div>
          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
            MoneyGram SEP-24 Cash-Out · 1-Click Deposits · CCTP &amp; OFT · {config.network.toUpperCase()}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} role="tablist" aria-label="Ramp mode">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "cash"}
          className={activeTab === "cash" ? "aw-btn-primary" : "aw-chip-btn"}
          style={{ minHeight: 44, padding: "6px 12px", fontSize: 12 }}
          onClick={() => setActiveTab("cash")}
        >
          Cash (MoneyGram)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "any_chain"}
          className={activeTab === "any_chain" ? "aw-btn-primary" : "aw-chip-btn"}
          style={{ minHeight: 44, padding: "6px 12px", fontSize: 12 }}
          onClick={() => setActiveTab("any_chain")}
        >
          Any Chain (1-Click)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "pro_bridge"}
          className={activeTab === "pro_bridge" ? "aw-btn-primary" : "aw-chip-btn"}
          style={{ minHeight: 44, padding: "6px 12px", fontSize: 12 }}
          onClick={() => setActiveTab("pro_bridge")}
        >
          Pro Bridge (CCTP / OFT)
        </button>
      </div>

      {activeTab === "cash" && (
        <form onSubmit={handleBuildMoneyGramSession} style={{ display: "grid", gap: 10 }}>
          <div className="aw-banner" style={{ fontSize: 12, display: "grid", gap: 4 }}>
            <strong>MoneyGram Ramps (SEP-24 · 500,000+ Locations)</strong>
            <span>
              Cash out USDC to physical cash or deposit cash into Stellar USDC with zero bank account required.
            </span>
            <span style={{ color: hasUsdcTrustline ? "#6EE7B7" : "#FDBA74" }}>
              {hasUsdcTrustline
                ? "✓ USDC trustline active on this account"
                : "⚠ Activate a USDC trustline first (or receive via Auto-Escrow)"}
            </span>
          </div>

          <div className="aw-two-col-inputs">
            <div>
              <label className="aw-label" htmlFor="mg-direction">
                Action
              </label>
              <select
                id="mg-direction"
                className="aw-input"
                value={cashDirection}
                onChange={(e) => setCashDirection(e.target.value as "offramp" | "onramp")}
              >
                <option value="offramp">Cash-Out (USDC → Cash)</option>
                <option value="onramp">Cash-In (Cash → USDC)</option>
              </select>
            </div>
            <div>
              <label className="aw-label" htmlFor="mg-amount">
                Amount (USDC)
              </label>
              <input
                id="mg-amount"
                type="text"
                inputMode="decimal"
                className="aw-input tabular-nums"
                value={cashAmount}
                onChange={(e) => setCashAmount(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="aw-label" htmlFor="mg-domain">
              SEP-24 Anchor Domain
            </label>
            <input
              id="mg-domain"
              type="text"
              className="aw-input"
              placeholder={
                config.network === "mainnet" ? "stellar.moneygram.com" : "extstellar.moneygram.com"
              }
              value={anchorDomain}
              onChange={(e) => setAnchorDomain(e.target.value)}
            />
          </div>

          <button type="submit" className="aw-btn-primary" disabled={cashBusy}>
            {cashBusy ? "Authenticating SEP-10 & Starting SEP-24..." : "Launch MoneyGram SEP-24 Checkout"}
          </button>

          {cashError && <div className="aw-banner aw-banner--danger">{cashError}</div>}
          {cashSessionUrl && (
            <div className="aw-banner" style={{ display: "grid", gap: 6, fontSize: 12 }}>
              <strong>Validated SEP-24 Interactive Session:</strong>
              <code style={{ wordBreak: "break-all" }}>{cashSessionUrl}</code>
              <button
                type="button"
                className="aw-btn-secondary"
                onClick={() => openExternalUrl(cashSessionUrl)}
              >
                Open Anchor Checkout ↗
              </button>
            </div>
          )}
        </form>
      )}

      {activeTab === "any_chain" && (
        <form onSubmit={handleNearDryQuote} style={{ display: "grid", gap: 10 }}>
          <div className="aw-banner" style={{ fontSize: 12 }}>
            <strong>1-Click Cross-Chain Deposit (NEAR Intents):</strong> Swap BTC, ETH, SOL, or TON directly into Stellar USDC or XLM without managing bridge contracts.
          </div>

          <div className="aw-two-col-inputs">
            <div>
              <label className="aw-label" htmlFor="near-origin">
                From Asset
              </label>
              <select
                id="near-origin"
                className="aw-input"
                value={originAsset}
                onChange={(e) => setOriginAsset(e.target.value)}
              >
                {NEAR_ORIGIN_ASSETS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="aw-label" htmlFor="near-dest">
                Destination Asset
              </label>
              <select
                id="near-dest"
                className="aw-input"
                value={destAsset}
                onChange={(e) => setDestAsset(e.target.value)}
              >
                {destOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {!isStellarOrigin && destAsset === NEAR_STELLAR_USDC_ASSET_ID && !hasUsdcTrustline && (
            <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
              Your Stellar account does not have a USDC trustline yet. Add a USDC trustline first
              or switch destination to Stellar XLM.
            </div>
          )}

          <div>
            <label className="aw-label" htmlFor="near-dest-addr">
              {isStellarOrigin ? "Destination Chain Recipient Address" : "Stellar Recipient Address"}
            </label>
            <input
              id="near-dest-addr"
              type="text"
              className="aw-input"
              placeholder={
                isStellarOrigin ? "Enter target chain wallet address" : activeAccount.address
              }
              value={nearDestAddress}
              onChange={(e) => {
                setNearDestAddress(e.target.value);
                setNearQuote(null);
                setNearLockedQuote(null);
              }}
            />
          </div>

          <div>
            <label className="aw-label" htmlFor="near-refund-addr">
              Origin Chain Refund Address ({NEAR_ORIGIN_ASSETS.find((a) => a.id === originAsset)?.chain ?? "Origin"})
            </label>
            <input
              id="near-refund-addr"
              type="text"
              className="aw-input"
              placeholder={`Enter ${NEAR_ORIGIN_ASSETS.find((a) => a.id === originAsset)?.chain ?? "origin"} refund address`}
              value={nearRefundAddress}
              onChange={(e) => {
                setNearRefundAddress(e.target.value);
                setNearQuote(null);
                setNearLockedQuote(null);
              }}
            />
          </div>

          <div>
            <label className="aw-label" htmlFor="near-amt">
              Input Amount (Decimal)
            </label>
            <input
              id="near-amt"
              type="text"
              inputMode="decimal"
              className="aw-input tabular-nums"
              value={nearAmountDecimal}
              onChange={(e) => {
                setNearAmountDecimal(e.target.value);
                setNearQuote(null);
                setNearLockedQuote(null);
              }}
            />
          </div>

          <button type="submit" className="aw-btn-primary" disabled={nearBusy}>
            {nearBusy ? "Quoting Market Makers..." : "Preview 1-Click Cross-Chain Quote"}
          </button>

          {nearError && <div className="aw-banner aw-banner--danger">{nearError}</div>}
          {nearQuote && !nearLockedQuote && (
            <div className="aw-banner" style={{ display: "grid", gap: 8, fontSize: 12 }}>
              <strong>
                Dry Quote Preview ({nearQuote.amountOutFormatted ?? nearQuote.minAmountOut ?? "est."})
              </strong>
              <span style={{ color: "var(--aw-ink-secondary)" }}>
                Refund address:{" "}
                <code style={{ wordBreak: "break-all" }}>
                  {nearRefundAddress || activeAccount.address}
                </code>
              </span>
              <button
                type="button"
                className="aw-btn-gold"
                disabled={nearBusy}
                onClick={() => void requestNearQuote(false)}
              >
                {nearBusy ? "Locking Deposit Address..." : "Lock Deposit Address (Live)"}
              </button>
            </div>
          )}
          {nearLockedQuote && (
            <div className="aw-banner" style={{ display: "grid", gap: 6, fontSize: 12 }}>
              <strong>
                Live Deposit Ready ({nearLockedQuote.amountOutFormatted ?? nearLockedQuote.minAmountOut ?? "est."})
              </strong>
              <div style={{ wordBreak: "break-all" }}>
                <strong>Deposit Address:</strong> <code>{nearLockedQuote.depositAddress}</code>
              </div>
              {nearLockedQuote.depositMemo && (
                <div className="aw-banner aw-banner--warn" style={{ margin: 0 }}>
                  <strong>REQUIRED MEMO:</strong> <code>{nearLockedQuote.depositMemo}</code> — Never send without this memo.
                </div>
              )}
              {nearLockedQuote.depositAddress && (
                <button
                  type="button"
                  className="aw-btn-secondary"
                    onClick={async () => {
                    const ok = await copyTextToClipboard(nearLockedQuote.depositAddress!);
                    if (ok) {
                      setCopiedAddr(true);
                      setTimeout(() => setCopiedAddr(false), 1800);
                    } else {
                      showToast("Clipboard copy blocked by WebView", "error");
                    }
                  }}
                >
                  {copiedAddr ? "Copied Deposit Address" : "Copy Deposit Address"}
                </button>
              )}
            </div>
          )}
        </form>
      )}

      {activeTab === "pro_bridge" && (
        <form onSubmit={handlePrepareProBridge} style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className={`aw-tab ${proRail === "cctp" ? "aw-tab--active" : ""}`}
              style={{ flex: 1 }}
              onClick={() => {
                setProRail("cctp");
                setPendingBridgeStage(null);
                setErrorMsg(null);
              }}
            >
              Circle CCTP V2 (USDC)
            </button>
            <button
              type="button"
              className={`aw-tab ${proRail === "layerzero" ? "aw-tab--active" : ""}`}
              style={{ flex: 1 }}
              onClick={() => {
                setProRail("layerzero");
                setPendingBridgeStage(null);
                setErrorMsg(null);
              }}
            >
              LayerZero V2 OFT
            </button>
          </div>

          {proRail === "cctp" ? (
            <>
              <div className="aw-two-col-inputs">
                <div>
                  <label className="aw-label" htmlFor="ramp-direction">
                    Direction
                  </label>
                  <select
                    id="ramp-direction"
                    className="aw-input"
                    value={direction}
                    onChange={(e) => {
                      setDirection(e.target.value as "onramp" | "offramp");
                      setPendingBridgeStage(null);
                    }}
                  >
                    <option value="offramp">Burn Stellar USDC → EVM</option>
                    <option value="onramp">Claim EVM → Stellar Forwarder</option>
                  </select>
                </div>
                <div>
                  <label className="aw-label" htmlFor="ramp-amount">
                    Amount (USDC)
                  </label>
                  <input
                    id="ramp-amount"
                    type="text"
                    inputMode="decimal"
                    className="aw-input tabular-nums"
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setPendingBridgeStage(null);
                    }}
                  />
                </div>
              </div>

              {direction === "offramp" ? (
                <>
                  <div className="aw-two-col-inputs">
                    <div>
                      <label className="aw-label" htmlFor="cctp-domain">
                        Destination Chain
                      </label>
                      <select
                        id="cctp-domain"
                        className="aw-input"
                        value={cctpDestDomain}
                        onChange={(e) => {
                          setCctpDestDomain(Number(e.target.value));
                          setPendingBridgeStage(null);
                        }}
                      >
                        {CCTP_DOMAINS.map((d) => (
                          <option key={d.domain} value={d.domain}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="aw-label" htmlFor="cctp-evm-dest">
                        EVM Recipient (0x…)
                      </label>
                      <input
                        id="cctp-evm-dest"
                        type="text"
                        className="aw-input"
                        style={{ fontFamily: "monospace" }}
                        placeholder="0x..."
                        value={evmDestAddress}
                        onChange={(e) => {
                          setEvmDestAddress(e.target.value);
                          setPendingBridgeStage(null);
                        }}
                      />
                    </div>
                  </div>
                  <input
                    type="text"
                    className="aw-input"
                    style={{ fontFamily: "monospace" }}
                    placeholder="TokenMessengerMinter C..."
                    value={cctpTmmId}
                    onChange={(e) => setCctpTmmId(e.target.value)}
                  />
                  {decimalPreview && (
                    <div
                      className={decimalPreview.ok ? "aw-banner" : "aw-banner aw-banner--danger"}
                      style={{ fontSize: 12 }}
                    >
                      {decimalPreview.ok ? (
                        <>
                          <strong>CCTP 6&harr;7 Decimal Guard OK:</strong> {decimalPreview.atomic6} EVM units
                          (6d) = {decimalPreview.stroops7} stroops ({decimalPreview.formatted} USDC)
                        </>
                      ) : (
                        decimalPreview.error
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <input
                    type="text"
                    className="aw-input"
                    style={{ fontFamily: "monospace" }}
                    placeholder="CctpForwarder Contract C..."
                    value={forwarderId}
                    onChange={(e) => setForwarderId(e.target.value)}
                  />
                  {cctpInboundHookPreview && cctpInboundHookPreview.ok && (
                    <div className="aw-banner" style={{ fontSize: 11, display: "grid", gap: 4 }}>
                      <strong>EVM → Stellar Safe CctpForwarder Hook Params:</strong>
                      {cctpInboundHookPreview.forwarderBytes32 && (
                        <code style={{ wordBreak: "break-all" }}>
                          mintRecipient / destinationCaller: {cctpInboundHookPreview.forwarderBytes32}
                        </code>
                      )}
                      <code style={{ wordBreak: "break-all" }}>
                        hookData: {cctpInboundHookPreview.hookDataHex}
                      </code>
                    </div>
                  )}
                  <input
                    type="text"
                    className="aw-input"
                    style={{ fontFamily: "monospace" }}
                    placeholder="Circle Iris Message Hex (0x...)"
                    value={cctpMessageHex}
                    onChange={(e) => setCctpMessageHex(e.target.value)}
                  />
                  <input
                    type="text"
                    className="aw-input"
                    style={{ fontFamily: "monospace" }}
                    placeholder="Circle Iris Attestation Hex (0x...)"
                    value={cctpAttestationHex}
                    onChange={(e) => setCctpAttestationHex(e.target.value)}
                  />
                </>
              )}
            </>
          ) : (
            <>
              <div className="aw-two-col-inputs">
                <div>
                  <label className="aw-label" htmlFor="lz-eid">
                    Destination EVM Chain
                  </label>
                  <select
                    id="lz-eid"
                    className="aw-input"
                    value={lzDestEid}
                    onChange={(e) => {
                      setLzDestEid(Number(e.target.value));
                      setLzQuote(null);
                      setPendingBridgeStage(null);
                    }}
                  >
                    {LAYERZERO_EIDS.map((item) => (
                      <option key={item.eid} value={item.eid}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="aw-label" htmlFor="lz-amount">
                    Amount (USDT0 / OFT)
                  </label>
                  <input
                    id="lz-amount"
                    type="text"
                    inputMode="decimal"
                    className="aw-input tabular-nums"
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setLzQuote(null);
                      setPendingBridgeStage(null);
                    }}
                  />
                </div>
              </div>

              <div className="aw-two-col-inputs">
                <input
                  type="text"
                  className="aw-input"
                  style={{ fontFamily: "monospace" }}
                  placeholder="EVM Recipient (0x...)"
                  value={evmDestAddress}
                  onChange={(e) => {
                    setEvmDestAddress(e.target.value);
                    setLzQuote(null);
                    setPendingBridgeStage(null);
                  }}
                />
                <input
                  type="text"
                  inputMode="numeric"
                  className="aw-input tabular-nums"
                  placeholder="Slippage bps (50 = 0.5%)"
                  value={lzSlippageBps}
                  onChange={(e) => {
                    setLzSlippageBps(e.target.value);
                    setLzQuote(null);
                  }}
                />
              </div>

              <input
                type="text"
                className="aw-input"
                style={{ fontFamily: "monospace" }}
                placeholder="LayerZero V2 OFT Contract C... (Mainnet USDT0 prefilled)"
                value={lzOftContractId}
                onChange={(e) => {
                  setLzOftContractId(e.target.value);
                  setLzQuote(null);
                  setPendingBridgeStage(null);
                }}
              />

              {config.network === "testnet" && (
                <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
                  USDT0 does not maintain an official Stellar Testnet OFT deployment; paste a custom
                  Testnet OFT contract ID above or switch to Mainnet for canonical USDT0.
                </div>
              )}

              {oftPreview && (
                <div
                  className={oftPreview.ok ? "aw-banner" : "aw-banner aw-banner--danger"}
                  style={{ fontSize: 12, display: "grid", gap: 4 }}
                >
                  {oftPreview.ok ? (
                    <>
                      <strong>LayerZero V2 OFT (6d Shared / 7d Local Guard):</strong>{" "}
                      <span className="tabular-nums">
                        {oftPreview.sharedUnits6.toString()} shared units · Sendable: {oftPreview.sendableFormatted}
                        {oftPreview.dustStroops > 0n
                          ? ` (7th-digit dust: ${oftPreview.dustStroops.toString()} stroops)`
                          : ""}
                      </span>
                      <code style={{ wordBreak: "break-all", fontSize: 11 }}>
                        sender bytes32: {oftPreview.recipientBytes32}
                      </code>
                    </>
                  ) : (
                    oftPreview.error
                  )}
                </div>
              )}

              {lzQuote && (
                <div className="aw-banner aw-banner--trust" style={{ fontSize: 12, display: "grid", gap: 4 }}>
                  <strong>Live On-Chain OFT Quote:</strong>
                  <span className="tabular-nums">
                    Expected Received: {stroops7ToDecimal(lzQuote.amountReceivedLdStroops7)} · Min
                    Guaranteed: {stroops7ToDecimal(lzQuote.minAmountLdStroops7)} · Messaging Fee:{" "}
                    {stroops7ToDecimal(lzQuote.nativeFeeStroops)} XLM
                  </span>
                </div>
              )}
            </>
          )}

          <button type="submit" className="aw-btn-primary" disabled={busy}>
            {busy
              ? "Simulating On Soroban RPC..."
              : proRail === "layerzero"
                ? "Quote OFT & Preview Send"
                : direction === "offramp"
                  ? "Simulate CCTP Burn Transaction"
                  : "Simulate CctpForwarder Claim"}
          </button>

          {errorMsg && <div className="aw-banner aw-banner--danger">{errorMsg}</div>}
          {bridgeTxHash && (
            <div className="aw-banner aw-banner--trust" style={{ fontSize: 12 }}>
              Submitted on-chain! Hash: <code style={{ wordBreak: "break-all" }}>{bridgeTxHash}</code>
            </div>
          )}

          {pendingBridgeStage && (
            <div style={{ display: "grid", gap: 8 }}>
              <ClearSignSummaryCard
                unsignedXdr={pendingBridgeStage.unsignedXdr}
                networkPassphrase={config.networkPassphrase}
                scanReport={null}
                overrideSummary={pendingBridgeStage.summary}
              />
              <button
                type="button"
                className="aw-btn-gold"
                disabled={busy}
                onClick={() => void handleSignProBridgeStage()}
              >
                {busy ? "Signing & Submitting..." : `Sign & Submit · ${pendingBridgeStage.label}`}
              </button>
            </div>
          )}
        </form>
      )}
    </section>
  );
}
