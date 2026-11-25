import { useEffect, useMemo, useRef, useState } from "react";
import {
  calculateMinReceivedStroops7,
  createHorizonPathSwapAdapter,
  parseSwapAssetIdentifier,
  stroops7ToDecimal,
} from "@astrowallet/defi";
import {
  computeMaxSpendableStroops7,
  formatStroops7Trimmed,
  parsePositiveDecimalToStroops7,
  type ClassicAddress,
  type ContractAddress,
  type ScanReport,
  type StellarAddress,
} from "@astrowallet/domain";
import { useTelegram } from "../state/telegram-context.js";
import { useWallet } from "../state/wallet-context.js";
import {
  copyTextToClipboard,
  openTelegramMiniAppLink,
  triggerTelegramHaptic,
} from "../telegram/webapp.js";
import { AstroNavigatorAvatar } from "./AstroNavigatorAvatar.js";
import { ClearSignSummaryCard } from "./ClearSignSummaryCard.js";
import { requiresHighValueReauth } from "./flow-validators.js";
import { HighValueReauthGate } from "./HighValueReauthGate.js";
import {
  clearCachedClaimSecret,
  parseIntentRouteFromLocation,
  type ActiveIntentRoute,
} from "./deep-link-routes.js";

export { parseIntentRouteFromLocation, type ActiveIntentRoute };

interface RemoteIntentResponse {
  intentId: string;
  network: string;
  actionType:
    | "connect"
    | "pay"
    | "request"
    | "split"
    | "swap"
    | "claim"
    | "reclaim_reserve"
    | "sign_xdr";
  status: string;
  claimId?: string | undefined;
  claimStatus?: "pending_funding" | "open" | "claimed" | "refunded" | "expired" | undefined;
  escrowContractId?: string | undefined;
  paidCount?: number | undefined;
  payload: {
    originApp?: "astrodex" | "astrogate" | undefined;
    sourceAddress?: string | undefined;
    originConfirmSig?: string | undefined;
    subAction?: string | undefined;
    humanSummary?: string | undefined;
    xdrSha256?: string | undefined;
    returnStartAppParam?: string | undefined;
    escrowExpiresAt?: number | undefined;
    message?: string | undefined;
    amount?: string | undefined;
    totalAmount?: string | undefined;
    participantCount?: number | undefined;
    assetCode?: string | undefined;
    assetIssuer?: string | undefined;
    destination?: string | undefined;
    recipientLabel?: string | undefined;
    recipientUsername?: string | undefined;
    senderLabel?: string | undefined;
    memo?: string | undefined;
    targetAddress?: string | undefined;
    targetLabel?: string | undefined;
    reclaimableXlm?: string | undefined;
    trustlines?: Array<{ assetCode: string; assetIssuer: string }> | undefined;
    fromAsset?: string | undefined;
    toAsset?: string | undefined;
    expectedOutputAmount?: string | undefined;
    provider?: string | undefined;
    priceImpactPct?: string | undefined;
    unsignedXdr?: string | undefined;
    escrowContractId?: string | undefined;
  };
  txHash?: string | undefined;
  expiresAt: number;
}

export function IntentSheet({
  route,
  onDismiss,
}: {
  route: ActiveIntentRoute;
  onDismiss: () => void;
}) {
  const { sessionToken, refreshLinkedAccounts } = useTelegram();
  const {
    config,
    vaultStatus,
    accounts,
    activeAccount,
    setActiveIndex,
    accountState,
    fundActiveTestnetAccount,
    bootstrapActiveAccount,
    addOrRemoveTrustline,
    signConnectChallenge,
    sendPayment,
    reclaimZeroBalanceReserves,
    executePathSwap,
    signAndSubmitRawXdrWithShield,
    fundClaimEscrow,
    claimFromEscrow,
    cancelClaimEscrow,
    refundExpiredClaimEscrow,
  } = useWallet();

  const [intent, setIntent] = useState<RemoteIntentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const actionSubmittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [completedMsg, setCompletedMsg] = useState<string | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([0]);
  const [includeSmartAccount, setIncludeSmartAccount] = useState<boolean>(
    Boolean(config.smartAccountWasmHash),
  );
  const [confirmCode, setConfirmCode] = useState("");
  const [warningAcknowledged, setWarningAcknowledged] = useState(false);
  const [manualClaimSecret, setManualClaimSecret] = useState("");
  const [shareClaimUrl, setShareClaimUrl] = useState<string | null>(null);
  const [copiedClaimUrl, setCopiedClaimUrl] = useState(false);
  const [autoReturnCancelled, setAutoReturnCancelled] = useState(false);
  const [destScanReport, setDestScanReport] = useState<ScanReport | null>(null);
  const [scanningIntent, setScanningIntent] = useState(false);
  const [reauthVerified, setReauthVerified] = useState(false);

  const isAccountUnfunded = accountState !== null && !accountState.funded;
  const intentAssetCode = (intent?.payload.assetCode ?? "XLM").toUpperCase();
  const intentAssetIssuer = intent?.payload.assetIssuer;
  const isNativeIntentAsset = intentAssetCode === "XLM" && !intentAssetIssuer;

  const missingClaimTrustline = Boolean(
    activeAccount?.kind === "classic" &&
      accountState?.funded &&
      !isNativeIntentAsset &&
      intentAssetIssuer &&
      !accountState.balances.some(
        (b) =>
          b.assetCode.toUpperCase() === intentAssetCode &&
          b.assetIssuer === intentAssetIssuer,
      ),
  );

  const availableBalanceStr = useMemo(() => {
    if (!accountState) return null;
    if (!accountState.funded) return "0";
    if (isNativeIntentAsset) {
      return formatStroops7Trimmed(
        computeMaxSpendableStroops7(accountState.spendableXlm, "0", "0.001"),
      );
    }
    const match = accountState.balances.find(
      (b) =>
        b.assetCode.toUpperCase() === intentAssetCode &&
        (!intentAssetIssuer || b.assetIssuer === intentAssetIssuer),
    );
    if (!match) return "0";
    return formatStroops7Trimmed(
      computeMaxSpendableStroops7(match.balance, match.sellingLiabilities ?? "0", "0"),
    );
  }, [accountState, isNativeIntentAsset, intentAssetCode, intentAssetIssuer]);

  const intentAmountStroops = intent?.payload.amount
    ? parsePositiveDecimalToStroops7(intent.payload.amount)
    : null;
  const availableStroops =
    availableBalanceStr !== null ? parsePositiveDecimalToStroops7(availableBalanceStr) : null;
  const availableNum = availableBalanceStr !== null ? Number(availableBalanceStr) : null;
  const hasInsufficientFunds = Boolean(
    accountState &&
      intent?.payload.amount &&
      (!accountState.funded ||
        intentAmountStroops === null ||
        availableStroops === null ||
        intentAmountStroops > availableStroops),
  );

  const handleFriendbotActivate = async () => {
    setBusy(true);
    setError(null);
    try {
      await fundActiveTestnetAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Testnet Friendbot activation failed");
    } finally {
      setBusy(false);
    }
  };

  const handleBootstrapActivate = async () => {
    setBusy(true);
    setError(null);
    try {
      await bootstrapActiveAccount(sessionToken ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sponsored account activation failed");
    } finally {
      setBusy(false);
    }
  };

  const renderUnfundedBanner = (reason: string) => (
    <div className="aw-banner aw-banner--warn" style={{ display: "grid", gap: 8, fontSize: 12 }}>
      <div>{reason}</div>
      {config.network === "testnet" && config.friendbotUrl ? (
        <button
          type="button"
          className="aw-chip-btn"
          disabled={busy}
          onClick={() => void handleFriendbotActivate()}
        >
          {busy ? "Funding Testnet Account..." : "Activate Account with Testnet Friendbot"}
        </button>
      ) : (
        sessionToken && (
          <button
            type="button"
            className="aw-chip-btn"
            disabled={busy}
            onClick={() => void handleBootstrapActivate()}
          >
            {busy ? "Activating Account..." : "Activate Account (Sponsored Bootstrap)"}
          </button>
        )
      )}
    </div>
  );

  useEffect(() => {
    setWarningAcknowledged(false);
    setReauthVerified(false);
  }, [route.intentId, intent?.intentId]);

  const reauthGate = useMemo(() => {
    if (!intent) return { required: false };
    const isSwap = intent.actionType === "swap";
    const rawAsset = isSwap ? intent.payload.fromAsset : intent.payload.assetCode;
    const assetCode = rawAsset?.split(":")[0];
    return requiresHighValueReauth({
      amount: intent.payload.amount,
      assetCode,
      spendableBalance: availableNum ?? undefined,
      thresholdXlm: config.highValueReauthXlm,
      network: config.network,
      hasWarningVerdict: destScanReport?.verdict === "warning",
    });
  }, [intent, availableNum, config.highValueReauthXlm, config.network, destScanReport?.verdict]);

  useEffect(() => {
    const requestedSource = intent?.payload.sourceAddress?.trim();
    if (!requestedSource || activeAccount?.address === requestedSource) return;
    const match = accounts.find((a) => a.address === requestedSource);
    if (match && typeof match.derivationIndex === "number") {
      setActiveIndex(match.derivationIndex);
    }
  }, [intent?.payload.sourceAddress, activeAccount?.address, accounts, setActiveIndex]);

  useEffect(() => {
    if (accounts.length > 0) {
      setSelectedIndices(accounts.map((a) => a.derivationIndex ?? 0));
    }
  }, [accounts]);

  useEffect(() => {
    let cancelled = false;
    setIntent(null);
    setDestScanReport(null);
    async function fetchIntent() {
      setLoading(true);
      setError(null);
      try {
        const base = config.apiBaseUrl.replace(/\/+$/, "");
        const res = await fetch(
          `${base}/v1/intents/${encodeURIComponent(route.intentId)}?sig=${encodeURIComponent(route.sig)}`,
          {
            headers: {
              "X-Astro-Network": config.network,
              ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
            },
          },
        );
        const data = (await res.json()) as RemoteIntentResponse & { error?: string };
        if (!res.ok) {
          throw new Error(data.error ?? `Failed to load intent (${res.status})`);
        }
        if (!cancelled) {
          setIntent(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to load signed Telegram intent");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void fetchIntent();
    return () => {
      cancelled = true;
    };
  }, [config.apiBaseUrl, config.network, route.intentId, route.sig, sessionToken]);

  useEffect(() => {
    if (!intent) {
      setDestScanReport(null);
      return undefined;
    }

    const scanTarget =
      (intent.actionType === "pay" ||
        intent.actionType === "request" ||
        intent.actionType === "split") &&
      intent.payload.destination
        ? intent.payload.destination
        : (intent.actionType === "swap" || intent.actionType === "sign_xdr") &&
            intent.payload.unsignedXdr
          ? intent.payload.unsignedXdr
          : null;

    if (!scanTarget) {
      setDestScanReport(null);
      return undefined;
    }

    let cancelled = false;
    setDestScanReport(null);
    async function runPreSignScan(targetValue: string) {
      setScanningIntent(true);
      try {
        const base = config.apiBaseUrl.replace(/\/+$/, "");
        const res = await fetch(`${base}/v1/proxy/scan`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Astro-Network": config.network,
          },
          body: JSON.stringify({
            target: targetValue,
            ...(activeAccount?.address ? { sourceAddress: activeAccount.address } : {}),
          }),
        });
        if (!res.ok) return;
        const body = (await res.json()) as { report?: ScanReport };
        if (!cancelled && body.report) {
          setDestScanReport(body.report);
        }
      } catch {
        // Non-fatal if proxy scan is temporarily unreachable
      } finally {
        if (!cancelled) setScanningIntent(false);
      }
    }
    void runPreSignScan(scanTarget);
    return () => {
      cancelled = true;
    };
  }, [intent, config.apiBaseUrl, config.network, activeAccount?.address]);

  const toggleIndex = (idx: number) => {
    setSelectedIndices((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx],
    );
  };

  const confirmOnServer = async (extraBody: Record<string, unknown>) => {
    const base = config.apiBaseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Astro-Network": config.network,
    };
    if (sessionToken) {
      headers.Authorization = `Bearer ${sessionToken}`;
    }
    const res = await fetch(
      `${base}/v1/intents/${encodeURIComponent(route.intentId)}/confirm`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sig: route.sig,
          ...extraBody,
        }),
      },
    );
    const body = (await res.json()) as {
      error?: string;
      telegramCardUpdated?: boolean;
      paidCount?: number;
      participantCount?: number;
      status?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? "Transaction confirmed on-chain, but bot callback failed");
    }
    triggerTelegramHaptic("success");
    return body;
  };

  const handleConfirmConnect = async () => {
    if (actionSubmittingRef.current) return;
    if (!intent?.payload.message) {
      setError("Connect challenge message is missing from intent");
      return;
    }
    const cleanCode = confirmCode.trim().toUpperCase();
    if (!sessionToken && !cleanCode) {
      setError("Enter the 6-character confirmation code shown in Telegram DM.");
      return;
    }
    actionSubmittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const proofs = await signConnectChallenge(
        intent.payload.message,
        selectedIndices,
        includeSmartAccount,
      );
      const base = config.apiBaseUrl.replace(/\/+$/, "");
      const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Astro-Network": config.network,
    };
      if (sessionToken) {
        headers.Authorization = `Bearer ${sessionToken}`;
      }
      const res = await fetch(
        `${base}/v1/intents/${encodeURIComponent(route.intentId)}/connect`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            sig: route.sig,
            ...(sessionToken ? {} : { confirmCode: cleanCode }),
            accounts: proofs,
          }),
        },
      );
      const body = (await res.json()) as { ok?: boolean; linkedCount?: number; error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? "Failed to verify connect signature");
      }
      triggerTelegramHaptic("success");
      await refreshLinkedAccounts();
      setCompletedMsg(
        `Linked ${body.linkedCount ?? proofs.length} account(s) to @${config.tgBotUsername}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete /connect");
    } finally {
      actionSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const handleConfirmPayment = async () => {
    if (actionSubmittingRef.current) return;
    if (!intent?.payload.destination || !intent.payload.amount) {
      setError("Payment intent is missing destination or amount");
      return;
    }
    if (isAccountUnfunded) {
      setError("Activate your Stellar account (minimum 1 XLM base reserve) before signing.");
      return;
    }
    if (hasInsufficientFunds) {
      setError(
        `Insufficient spendable ${intentAssetCode} (${availableBalanceStr ?? "0"} available; need ${intent.payload.amount}).`,
      );
      return;
    }
    if (destScanReport?.verdict === "malicious") {
      setError(
        `Scan & Shield blocked transaction: ${destScanReport.findings[0]?.title ?? "malicious target"}`,
      );
      return;
    }
    if (destScanReport?.verdict === "warning" && !warningAcknowledged) {
      setError("Acknowledge the Scan & Shield warning before signing this transaction.");
      return;
    }
    if (destScanReport?.requiresMemoCheck && !intent.payload.memo?.trim()) {
      setError(
        "Scan & Shield: Destination requires a SEP-29 Deposit Memo before sending.",
      );
      return;
    }
    actionSubmittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const tx = await sendPayment({
        destination: intent.payload.destination as StellarAddress,
        amount: intent.payload.amount,
        assetCode: intent.payload.assetCode ?? "XLM",
        assetIssuer: intent.payload.assetIssuer,
        memoText: intent.payload.memo,
      });

      const confirmRes = await confirmOnServer({
        txHash: tx.hash,
        ...(activeAccount ? { payerAddress: activeAccount.address } : {}),
      });

      if (intent.actionType === "split") {
        setCompletedMsg(
          `Split share paid (${confirmRes.paidCount ?? 1}/${confirmRes.participantCount ?? intent.payload.participantCount ?? 2}) — ${tx.hash.slice(0, 8)}…${tx.hash.slice(-8)}.`,
        );
      } else {
        setCompletedMsg(
          `Confirmed on Stellar (${tx.hash.slice(0, 8)}…${tx.hash.slice(-8)}). Telegram chat card updated live!`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment execution failed");
    } finally {
      actionSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const handleConfirmSwap = async () => {
    if (!intent || actionSubmittingRef.current) return;
    if (destScanReport?.verdict === "malicious") {
      setError(
        `Scan & Shield blocked swap: ${destScanReport.findings[0]?.title ?? "malicious contract"}`,
      );
      return;
    }
    if (destScanReport?.verdict === "warning" && !warningAcknowledged) {
      setError("Acknowledge the Scan & Shield warning before signing this swap.");
      return;
    }
    actionSubmittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      let txHash: string;
      if (intent.payload.unsignedXdr) {
        const allowWarningFlag =
          destScanReport?.verdict === "warning" ? warningAcknowledged : false;
        const res = await signAndSubmitRawXdrWithShield(
          intent.payload.unsignedXdr,
          allowWarningFlag,
          {
            intentId: route.intentId,
            sig: route.sig,
          },
        );
        txHash = res.hash;
      } else {
        const { fromAsset, toAsset, amount } = intent.payload;
        if (!fromAsset || !toAsset || !amount) {
          throw new Error("Swap intent is missing pair or amount parameters");
        }
        const horizonAdapter = createHorizonPathSwapAdapter({
          horizonUrls: config.horizonUrls,
        });
        const freshQuote = await horizonAdapter.getQuote({
          fromAsset,
          toAsset,
          amount,
          slippageBps: 100,
        });
        const destMin = stroops7ToDecimal(
          calculateMinReceivedStroops7(freshQuote.expectedOutputAmount, 100),
        );
        const sendParsed = parseSwapAssetIdentifier(fromAsset);
        const destParsed = parseSwapAssetIdentifier(toAsset);
        const res = await executePathSwap({
          sendAssetCode: sendParsed.code,
          sendAssetIssuer: sendParsed.issuer as ClassicAddress | undefined,
          sendAmount: amount,
          destAssetCode: destParsed.code,
          destAssetIssuer: destParsed.issuer as ClassicAddress | undefined,
          destMin,
          path: freshQuote.pathAssets,
        });
        txHash = res.hash;
      }

      await confirmOnServer({
        txHash,
        ...(activeAccount ? { payerAddress: activeAccount.address } : {}),
      });
      setCompletedMsg(
        `Swap settled (${txHash.slice(0, 8)}…${txHash.slice(-8)}). Telegram chat card updated live!`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Swap execution failed");
    } finally {
      actionSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const resolvedEscrowContract = (intent?.escrowContractId ??
    intent?.payload.escrowContractId ??
    config.claimEscrowContractId) as ContractAddress | undefined;

  const handleFundClaimEscrow = async () => {
    if (actionSubmittingRef.current) return;
    if (!intent || !activeAccount || !intent.claimId || !resolvedEscrowContract || !intent.payload.amount) {
      setError("Claim escrow configuration or claimId is missing");
      return;
    }
    if (isAccountUnfunded) {
      setError("Activate your Stellar account (minimum 1 XLM base reserve) before funding escrow.");
      return;
    }
    if (hasInsufficientFunds) {
      setError(
        `Insufficient spendable ${intentAssetCode} (${availableBalanceStr ?? "0"} available; need ${intent.payload.amount}).`,
      );
      return;
    }
    actionSubmittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const fundResult = await fundClaimEscrow({
        escrowContractId: resolvedEscrowContract,
        claimIdHex: intent.claimId,
        amount: intent.payload.amount,
        assetCode: intent.payload.assetCode ?? "XLM",
        assetIssuer: intent.payload.assetIssuer,
        expiresAtUnix: intent.payload.escrowExpiresAt ?? intent.expiresAt,
        intentAuth: { intentId: route.intentId, sig: route.sig },
      });

      await confirmOnServer({
        txHash: fundResult.hash,
        stage: "funded",
        senderAddress: activeAccount.address,
        expiresAt: fundResult.expiresAtUnix,
      });

      const privateUrl = `${config.pwaOrigin.replace(/\/+$/, "")}/intent/${encodeURIComponent(route.intentId)}?sig=${encodeURIComponent(route.sig)}#k=${fundResult.claimSecretSeedHex}`;
      setShareClaimUrl(privateUrl);
      setCompletedMsg(
        `Escrow locked (${fundResult.hash.slice(0, 8)}…${fundResult.hash.slice(-8)}). Send the private Claim Link below to @${intent.payload.recipientUsername ?? "recipient"}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Escrow funding failed");
    } finally {
      actionSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const handleClaimFromEscrow = async () => {
    if (actionSubmittingRef.current) return;
    if (!intent || !activeAccount || !intent.claimId || !resolvedEscrowContract) {
      setError("Claim escrow configuration or claimId is missing");
      return;
    }
    if (isAccountUnfunded) {
      setError("Activate your Stellar account (minimum 1 XLM base reserve) before claiming on-chain.");
      return;
    }
    const secretHex = (route.claimSecretHex ?? manualClaimSecret.trim()).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(secretHex)) {
      setError("Valid 64-char claim secret key (#k=) is required to unlock escrow");
      return;
    }
    actionSubmittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (missingClaimTrustline && intentAssetIssuer) {
        await addOrRemoveTrustline(
          intent.payload.assetCode ?? intentAssetCode,
          intentAssetIssuer as ClassicAddress,
        );
      }
      const res = await claimFromEscrow({
        escrowContractId: resolvedEscrowContract,
        claimIdHex: intent.claimId,
        claimSecretSeedHex: secretHex,
        intentAuth: { intentId: route.intentId, sig: route.sig },
      });

      await confirmOnServer({
        txHash: res.hash,
        stage: "claimed",
        payerAddress: activeAccount.address,
      });

      clearCachedClaimSecret();
      setCompletedMsg(
        `Claimed ${intent.payload.amount ?? ""} ${intent.payload.assetCode ?? "XLM"} into ${activeAccount.label} (${res.hash.slice(0, 8)}…${res.hash.slice(-8)}).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim execution failed");
    } finally {
      actionSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const handleReclaimClaimLink = async () => {
    if (actionSubmittingRef.current) return;
    if (!intent || !activeAccount || !intent.claimId || !resolvedEscrowContract) {
      setError("Claim escrow configuration or claimId is missing");
      return;
    }
    const isExpired =
      Math.floor(Date.now() / 1000) > (intent.payload.escrowExpiresAt ?? intent.expiresAt);
    actionSubmittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const intentAuth = { intentId: route.intentId, sig: route.sig };
      const res = isExpired
        ? await refundExpiredClaimEscrow({
            escrowContractId: resolvedEscrowContract,
            claimIdHex: intent.claimId,
            intentAuth,
          })
        : await cancelClaimEscrow({
            escrowContractId: resolvedEscrowContract,
            claimIdHex: intent.claimId,
            intentAuth,
          });

      await confirmOnServer({
        txHash: res.hash,
        stage: isExpired ? "refunded" : "cancelled",
        payerAddress: activeAccount.address,
      });

      clearCachedClaimSecret();
      setCompletedMsg(
        `${isExpired ? "Refunded expired escrow" : "Cancelled escrow"} (${res.hash.slice(0, 8)}…${res.hash.slice(-8)}). Telegram chat card updated live!`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Escrow reclaim failed");
    } finally {
      actionSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const handleConfirmReclaimReserve = async () => {
    if (actionSubmittingRef.current) return;
    actionSubmittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const tx = await reclaimZeroBalanceReserves();
      await confirmOnServer({
        txHash: tx.hash,
        ...(activeAccount ? { payerAddress: activeAccount.address } : {}),
      });
      setCompletedMsg(
        `Reclaimed +${tx.reclaimedXlm} XLM via LumenWipe (${tx.hash.slice(0, 8)}…${tx.hash.slice(-8)}).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reserve reclaim failed");
    } finally {
      actionSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const handleConfirmSignXdr = async () => {
    if (actionSubmittingRef.current) return;
    if (!intent?.payload.unsignedXdr) {
      setError("Signed XDR intent is missing unsignedXdr payload");
      return;
    }
    if (destScanReport?.verdict === "malicious") {
      setError(
        `Scan & Shield blocked transaction: ${destScanReport.findings[0]?.title ?? "malicious transaction"}`,
      );
      return;
    }
    if (destScanReport?.verdict === "warning" && !warningAcknowledged) {
      setError("Acknowledge the Scan & Shield warning before signing this transaction.");
      return;
    }
    actionSubmittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const allowWarningFlag =
        destScanReport?.verdict === "warning" ? warningAcknowledged : false;
      const res = await signAndSubmitRawXdrWithShield(intent.payload.unsignedXdr, allowWarningFlag, {
        intentId: route.intentId,
        sig: route.sig,
      });
      await confirmOnServer({
        txHash: res.hash,
        ...(activeAccount ? { payerAddress: activeAccount.address } : {}),
      });
      setCompletedMsg(
        `Transaction confirmed on Stellar (${res.hash.slice(0, 8)}…${res.hash.slice(-8)}).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction execution failed");
    } finally {
      actionSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const boomerangReturn = useMemo(() => {
    const origin = intent?.payload.originApp;
    const param = intent?.payload.returnStartAppParam?.trim();
    if (origin === "astrodex" && config.astrodexBotUsername) {
      const base = config.astrodexMiniAppShortName
        ? `https://t.me/${config.astrodexBotUsername}/${config.astrodexMiniAppShortName}`
        : `https://t.me/${config.astrodexBotUsername}`;
      return {
        label: "Return to AstroDex",
        href: param ? `${base}?startapp=${encodeURIComponent(param)}` : base,
      };
    }
    if (origin === "astrogate" && config.astrogateBotUsername) {
      const base = `https://t.me/${config.astrogateBotUsername}`;
      return {
        label: "Return to AstroGate",
        href: param ? `${base}?startapp=${encodeURIComponent(param)}` : base,
      };
    }
    return null;
  }, [
    intent?.payload.originApp,
    intent?.payload.returnStartAppParam,
    config.astrodexBotUsername,
    config.astrodexMiniAppShortName,
    config.astrogateBotUsername,
  ]);

  useEffect(() => {
    if (!completedMsg || autoReturnCancelled || shareClaimUrl) return undefined;
    if (typeof window !== "undefined" && window.opener && !window.opener.closed) {
      const allowedOrigins = new Set<string>();
      for (const candidate of [
        config.pwaOrigin,
        config.astrodexApiBaseUrl,
        config.altNetworkProfile?.astrodexApiBaseUrl,
      ]) {
        if (!candidate) continue;
        try {
          const parsed = new URL(candidate);
          if (parsed.protocol === "https:") {
            allowedOrigins.add(parsed.origin);
          }
        } catch {
          // Ignore malformed configured URL
        }
      }
      let targetOrigin: string | null = null;
      try {
        if (document.referrer) {
          const refOrigin = new URL(document.referrer).origin;
          if (allowedOrigins.has(refOrigin)) {
            targetOrigin = refOrigin;
          }
        }
      } catch {
        targetOrigin = null;
      }
      if (targetOrigin) {
        try {
          window.opener.postMessage(
            {
              type: "ASTRO_SIGN_COMPLETE",
              status: "approved",
              intentId: route.intentId,
            },
            targetOrigin,
          );
        } catch {
          // Ignore postMessage error
        }
      }
      const timer = window.setTimeout(() => {
        window.close();
      }, 900);
      return () => window.clearTimeout(timer);
    }
    if (boomerangReturn) {
      const timer = window.setTimeout(() => {
        openTelegramMiniAppLink(boomerangReturn.href);
      }, 900);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [
    completedMsg,
    autoReturnCancelled,
    shareClaimUrl,
    route.intentId,
    boomerangReturn,
    config.pwaOrigin,
    config.astrodexApiBaseUrl,
    config.altNetworkProfile?.astrodexApiBaseUrl,
  ]);

  const handleCopyClaimUrl = async () => {
    if (!shareClaimUrl) return;
    const copied = await copyTextToClipboard(shareClaimUrl);
    if (copied) {
      setCopiedClaimUrl(true);
      setTimeout(() => setCopiedClaimUrl(false), 2000);
    }
  };

  const isClaimFundingView =
    intent?.actionType === "claim" &&
    (intent.claimStatus ?? "pending_funding") === "pending_funding" &&
    !route.claimSecretHex;

  return (
    <section className="glass-sheet" aria-label="Telegram Signed Intent">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: "1 1 200px" }}>
          <AstroNavigatorAvatar
            seedKey={route.intentId}
            kind="classic"
            state={completedMsg ? "zenith" : intent?.actionType === "connect" ? "comms" : "shield"}
            size={54}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              Telegram Signed Intent
            </div>
            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)", overflowWrap: "anywhere" }}>
              ID: {route.intentId} • {config.network.toUpperCase()}
            </div>
          </div>
        </div>
        <button type="button" className="aw-chip-btn" onClick={onDismiss}>
          Close
        </button>
      </div>

      {loading && (
        <div style={{ fontSize: 13, color: "var(--aw-ink-secondary)" }}>
          Verifying HMAC signature &amp; loading intent from server...
        </div>
      )}

      {error && (
        <div className="aw-banner aw-banner--danger" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {completedMsg && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12, minWidth: 0 }}>
          <div className="aw-banner">{completedMsg}</div>
          {shareClaimUrl && (
            <div
              className="aw-banner aw-banner--warn"
              style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8, minWidth: 0 }}
            >
              <div style={{ fontWeight: 700, fontSize: 13 }}>
                Private Claim Link (Secret stays client-side in #k=)
              </div>
              <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                Neither the server nor the Telegram bot stores the #k= secret. Share this link
                directly with @{intent?.payload.recipientUsername ?? "recipient"}.
              </div>
              <input
                type="text"
                readOnly
                className="aw-input"
                value={shareClaimUrl}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                className="aw-btn-secondary"
                onClick={() => void handleCopyClaimUrl()}
              >
                {copiedClaimUrl ? "Copied Claim Link" : "Copy Private Claim Link"}
              </button>
            </div>
          )}
          {boomerangReturn && (
            <>
              {!autoReturnCancelled && !shareClaimUrl && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                  <span>Returning automatically…</span>
                  <button
                    type="button"
                    className="aw-chip-btn"
                    onClick={() => setAutoReturnCancelled(true)}
                  >
                    Stay Here
                  </button>
                </div>
              )}
              <a
                href={boomerangReturn.href}
                className="aw-btn-primary"
                style={{
                  textAlign: "center",
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {boomerangReturn.label}
              </a>
            </>
          )}
          <a
            href={`https://t.me/${config.tgBotUsername}`}
            className={boomerangReturn ? "aw-btn-secondary" : "aw-btn-primary"}
            style={{
              textAlign: "center",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            Return to @{config.tgBotUsername}
          </a>
        </div>
      )}

      {!loading && intent && !completedMsg && (
        <div style={{ display: "grid", gap: 12 }}>
          {vaultStatus !== "unlocked" ? (
            <div className="aw-banner aw-banner--warn">
              Unlock or create your vault below first—this Telegram Intent will stay ready right
              here.
            </div>
          ) : intent.actionType === "connect" ? (
            <>
              <div style={{ fontSize: 13, color: "var(--aw-ink-secondary)" }}>
                Select which derived SEP-0005 accounts to link to your Telegram handle (your seed
                phrase never leaves this phone):
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {accounts.map((acc) => {
                  const idx = acc.derivationIndex ?? 0;
                  const checked = selectedIndices.includes(idx);
                  return (
                    <label
                      key={acc.id}
                      className="aw-list-row"
                      style={{ cursor: "pointer" }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleIndex(idx)}
                        />
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{acc.label}</div>
                          <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                            {acc.address.slice(0, 8)}…{acc.address.slice(-8)}
                          </div>
                        </div>
                      </div>
                      <span className="glass-pill">m/44&apos;/148&apos;/{idx}&apos;</span>
                    </label>
                  );
                })}
                {config.smartAccountWasmHash && (
                  <label className="aw-list-row" style={{ cursor: "pointer" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <input
                        type="checkbox"
                        checked={includeSmartAccount}
                        onChange={(e) => setIncludeSmartAccount(e.target.checked)}
                      />
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>
                          Include paired Soroban Smart Account (C...)
                        </div>
                        <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                          Signed via your Primary G... Recovery Guardian
                        </div>
                      </div>
                    </div>
                    <span className="glass-pill glass-pill--gold">C...</span>
                  </label>
                )}
              </div>
              {sessionToken ? (
                <div className="aw-banner" style={{ fontSize: 12 }}>
                  <strong>Telegram Identity Verified:</strong> Authenticated automatically via
                  signed Telegram <code>initData</code>.
                </div>
              ) : (
                <div>
                  <label className="aw-label" htmlFor="tg-connect-confirm-code">
                    Telegram DM Confirmation Code
                  </label>
                  <input
                    id="tg-connect-confirm-code"
                    type="text"
                    maxLength={12}
                    className="aw-input"
                    placeholder="Enter 6-character code from DM (e.g. A7K9M2)"
                    value={confirmCode}
                    onChange={(e) => setConfirmCode(e.target.value.toUpperCase())}
                  />
                </div>
              )}
              <button
                type="button"
                className="aw-btn-primary"
                disabled={
                  busy ||
                  selectedIndices.length === 0 ||
                  (!sessionToken && confirmCode.trim().length < 4)
                }
                onClick={() => void handleConfirmConnect()}
              >
                {busy ? "Signing Challenge..." : `Sign & Link ${selectedIndices.length} Account(s)`}
              </button>
            </>
          ) : intent.actionType === "claim" ? (
            <>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Amount</span>
                <strong className="tabular-nums">
                  {intent.payload.amount} {intent.payload.assetCode ?? "XLM"}
                </strong>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Recipient</span>
                <strong>@{intent.payload.recipientUsername ?? "recipient"}</strong>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                  Escrow Status
                </span>
                <span className="glass-pill">{intent.claimStatus ?? "pending_funding"}</span>
              </div>

              {intent.claimStatus === "claimed" ? (
                <div className="aw-banner">
                  This Claim Link has already been claimed on-chain.
                </div>
              ) : intent.claimStatus === "refunded" ? (
                <div className="aw-banner">
                  This Claim Link was cancelled or refunded on-chain.
                </div>
              ) : isClaimFundingView ? (
                <>
                  <div className="aw-list-row">
                    <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                      Available Balance
                    </span>
                    <strong className="tabular-nums">
                      {availableBalanceStr ?? "…"} {intentAssetCode}
                    </strong>
                  </div>
                  <div className="aw-list-row">
                    <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                      Est. Network Fee
                    </span>
                    <code className="tabular-nums">~0.00001 XLM (or sponsored relay)</code>
                  </div>
                  {isAccountUnfunded
                    ? renderUnfundedBanner(
                        `This account is not activated on ${config.network.toUpperCase()} yet (minimum 1 XLM base reserve required).`,
                      )
                    : hasInsufficientFunds && (
                        <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
                          Insufficient spendable {intentAssetCode} ({availableBalanceStr ?? "0"}{" "}
                          available; need {intent.payload.amount}).
                        </div>
                      )}
                  {reauthGate.required && reauthGate.reason && (
                    <HighValueReauthGate
                      reason={reauthGate.reason}
                      verified={reauthVerified}
                      onVerified={() => setReauthVerified(true)}
                    />
                  )}
                  <button
                    type="button"
                    className="aw-btn-primary"
                    disabled={
                      busy ||
                      !resolvedEscrowContract ||
                      isAccountUnfunded ||
                      hasInsufficientFunds ||
                      (reauthGate.required && !reauthVerified)
                    }
                    onClick={() => void handleFundClaimEscrow()}
                  >
                    {busy
                      ? "Locking Escrow on Soroban..."
                      : `Fund Escrow (${intent.payload.amount} ${intent.payload.assetCode ?? "XLM"})`}
                  </button>
                </>
              ) : (
                <>
                  <div className="aw-list-row">
                    <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                      Claiming Into
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      {activeAccount?.label} ({activeAccount?.address.slice(0, 6)}…
                      {activeAccount?.address.slice(-4)})
                    </span>
                  </div>
                  <div className="aw-list-row">
                    <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                      Est. Network Fee
                    </span>
                    <code className="tabular-nums">Sponsored relay / ~0.00001 XLM</code>
                  </div>
                  {isAccountUnfunded
                    ? renderUnfundedBanner(
                        "Activate your Classic G... account (minimum 1 XLM base reserve) before claiming on-chain.",
                      )
                    : missingClaimTrustline &&
                      intentAssetIssuer && (
                        <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
                          Auto-Trustline: claiming will activate your {intentAssetCode} trustline
                          (0.5 XLM reserve) before unlocking this escrow.
                        </div>
                      )}
                  {!route.claimSecretHex && (
                    <div>
                      <label className="aw-label" htmlFor="manual-claim-secret">
                        Claim Secret Key (64-hex from #k= link)
                      </label>
                      <input
                        id="manual-claim-secret"
                        type="password"
                        className="aw-input"
                        placeholder="Paste 64-character hex secret from sender's Claim Link"
                        value={manualClaimSecret}
                        onChange={(e) => setManualClaimSecret(e.target.value)}
                      />
                    </div>
                  )}
                  <button
                    type="button"
                    className="aw-btn-gold"
                    disabled={busy || !resolvedEscrowContract || isAccountUnfunded}
                    onClick={() => void handleClaimFromEscrow()}
                  >
                    {busy
                      ? "Claiming from Escrow..."
                      : missingClaimTrustline && intentAssetIssuer
                        ? `Add ${intentAssetCode} Trustline & Claim ${intent.payload.amount} ${intentAssetCode}`
                        : `Claim ${intent.payload.amount} ${intent.payload.assetCode ?? "XLM"} to ${activeAccount?.label ?? "Account"}`}
                  </button>
                  {intent.claimId && activeAccount && intent.claimStatus === "open" && (
                    <button
                      type="button"
                      className="aw-btn-secondary"
                      disabled={busy || !resolvedEscrowContract}
                      onClick={() => void handleReclaimClaimLink()}
                    >
                      {busy
                        ? "Processing Escrow Reclaim..."
                        : Math.floor(Date.now() / 1000) > (intent.payload.escrowExpiresAt ?? intent.expiresAt)
                          ? "Reclaim Expired Escrow"
                          : "Cancel & Reclaim Escrow"}
                    </button>
                  )}
                </>
              )}
            </>
          ) : intent.actionType === "swap" ? (
            <>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Sell</span>
                <strong className="tabular-nums">
                  {intent.payload.amount} {intent.payload.fromAsset}
                </strong>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                  Receive (est.)
                </span>
                <strong className="tabular-nums" style={{ color: "var(--aw-stellar-gold)" }}>
                  {intent.payload.expectedOutputAmount} {intent.payload.toAsset}
                </strong>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Route</span>
                <span>
                  {intent.payload.provider ?? "horizon-path"}{" "}
                  {!intent.payload.priceImpactPct || intent.payload.priceImpactPct === "N/A"
                    ? "(market rate)"
                    : `(~${intent.payload.priceImpactPct}% impact)`}
                </span>
              </div>
              {intent.payload.unsignedXdr && (
                <ClearSignSummaryCard
                  unsignedXdr={intent.payload.unsignedXdr}
                  networkPassphrase={config.networkPassphrase}
                  scanReport={destScanReport}
                  overrideSummary={`Swap ${intent.payload.amount ?? ""} ${intent.payload.fromAsset ?? ""} → ${intent.payload.toAsset ?? ""}`.trim()}
                />
              )}
              {scanningIntent && (
                <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                  Running Scan &amp; Shield pre-sign inspection...
                </div>
              )}
              {destScanReport && (
                <div
                  className={
                    destScanReport.verdict === "malicious"
                      ? "aw-banner aw-banner--danger"
                      : destScanReport.verdict === "warning"
                        ? "aw-banner aw-banner--warn"
                        : "aw-banner"
                  }
                  style={{ fontSize: 12, display: "grid", gap: 6 }}
                >
                  <strong>Scan &amp; Shield: {destScanReport.verdict.toUpperCase()}</strong>
                  {destScanReport.findings[0] && (
                    <div>{destScanReport.findings[0].description}</div>
                  )}
                  {destScanReport.verdict === "warning" && (
                    <label className="aw-checkbox-row" style={{ marginTop: 4 }}>
                      <input
                        type="checkbox"
                        checked={warningAcknowledged}
                        onChange={(e) => setWarningAcknowledged(e.target.checked)}
                      />
                      <span>I reviewed this warning and accept the risk.</span>
                    </label>
                  )}
                </div>
              )}
              {reauthGate.required && reauthGate.reason && (
                <HighValueReauthGate
                  reason={reauthGate.reason}
                  verified={reauthVerified}
                  onVerified={() => setReauthVerified(true)}
                />
              )}
              <button
                type="button"
                className="aw-btn-primary"
                disabled={
                  busy ||
                  scanningIntent ||
                  destScanReport?.verdict === "malicious" ||
                  (destScanReport?.verdict === "warning" && !warningAcknowledged) ||
                  (reauthGate.required && !reauthVerified)
                }
                onClick={() => void handleConfirmSwap()}
              >
                {busy ? "Signing & Settling Swap..." : "Sign & Execute Swap"}
              </button>
            </>
          ) : intent.actionType === "reclaim_reserve" ? (
            <>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Account</span>
                <strong style={{ fontSize: 13 }}>
                  {intent.payload.targetLabel ?? activeAccount?.label}
                </strong>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Reclaimable XLM</span>
                <strong className="tabular-nums">
                  +{intent.payload.reclaimableXlm ?? intent.payload.amount ?? "0.5"} XLM
                </strong>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                  Zero-Balance Trustlines
                </span>
                <span>{intent.payload.trustlines?.length ?? 0}</span>
              </div>
              <button
                type="button"
                className="aw-btn-gold"
                disabled={busy}
                onClick={() => void handleConfirmReclaimReserve()}
              >
                {busy ? "Reclaiming Locked Reserves..." : "Reclaim Locked XLM Now"}
              </button>
            </>
          ) : intent.actionType === "sign_xdr" ? (
            <>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Origin App</span>
                <strong style={{ fontSize: 13 }}>
                  {intent.payload.originApp === "astrodex"
                    ? "AstroDex Terminal"
                    : "ASTRO Ecosystem"}
                </strong>
              </div>
              {intent.payload.subAction && (
                <div className="aw-list-row">
                  <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Action</span>
                  <code>{intent.payload.subAction}</code>
                </div>
              )}
              {intent.payload.unsignedXdr ? (
                <ClearSignSummaryCard
                  unsignedXdr={intent.payload.unsignedXdr}
                  networkPassphrase={config.networkPassphrase}
                  scanReport={destScanReport}
                  overrideSummary={intent.payload.humanSummary}
                />
              ) : (
                intent.payload.humanSummary && (
                  <div className="aw-banner" style={{ fontSize: 12 }}>
                    <strong>Summary:</strong> {intent.payload.humanSummary}
                  </div>
                )
              )}
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                  Signing Account
                </span>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {activeAccount?.label} ({activeAccount?.address.slice(0, 6)}…
                  {activeAccount?.address.slice(-4)})
                </span>
              </div>
              {scanningIntent && (
                <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                  Running Scan &amp; Shield XDR inspection...
                </div>
              )}
              {destScanReport && (
                <div
                  className={
                    destScanReport.verdict === "malicious"
                      ? "aw-banner aw-banner--danger"
                      : destScanReport.verdict === "warning"
                        ? "aw-banner aw-banner--warn"
                        : "aw-banner"
                  }
                  style={{ fontSize: 12, display: "grid", gap: 6 }}
                >
                  <strong>Scan &amp; Shield: {destScanReport.verdict.toUpperCase()}</strong>
                  {destScanReport.findings[0] && (
                    <div>{destScanReport.findings[0].description}</div>
                  )}
                  {destScanReport.verdict === "warning" && (
                    <label className="aw-checkbox-row" style={{ marginTop: 4 }}>
                      <input
                        type="checkbox"
                        checked={warningAcknowledged}
                        onChange={(e) => setWarningAcknowledged(e.target.checked)}
                      />
                      <span>I reviewed this warning and accept the risk.</span>
                    </label>
                  )}
                </div>
              )}
              {reauthGate.required && reauthGate.reason && (
                <HighValueReauthGate
                  reason={reauthGate.reason}
                  verified={reauthVerified}
                  onVerified={() => setReauthVerified(true)}
                />
              )}
              <button
                type="button"
                className="aw-btn-primary"
                disabled={
                  busy ||
                  scanningIntent ||
                  !intent.payload.unsignedXdr ||
                  destScanReport?.verdict === "malicious" ||
                  (destScanReport?.verdict === "warning" && !warningAcknowledged) ||
                  (reauthGate.required && !reauthVerified)
                }
                onClick={() => void handleConfirmSignXdr()}
              >
                {busy ? "Signing & Submitting..." : "Sign & Execute Transaction"}
              </button>
            </>
          ) : (
            <>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Amount</span>
                <strong className="tabular-nums">
                  {intent.payload.amount} {intent.payload.assetCode ?? "XLM"}
                </strong>
              </div>
              {intent.actionType === "split" && (
                <div className="aw-list-row">
                  <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                    Split Progress
                  </span>
                  <strong className="tabular-nums">
                    {intent.paidCount ?? 0} / {intent.payload.participantCount ?? 2} paid
                  </strong>
                </div>
              )}
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Recipient</span>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    minWidth: 0,
                    overflowWrap: "anywhere",
                    wordBreak: "break-all",
                    textAlign: "right",
                  }}
                >
                  {intent.payload.recipientLabel ?? intent.payload.destination}
                </span>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                  Paying From
                </span>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {activeAccount?.label} ({activeAccount?.address.slice(0, 6)}…
                  {activeAccount?.address.slice(-4)})
                </span>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                  Available Balance
                </span>
                <strong className="tabular-nums">
                  {availableBalanceStr ?? "…"} {intentAssetCode}
                </strong>
              </div>
              <div className="aw-list-row">
                <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                  Est. Network Fee
                </span>
                <code className="tabular-nums">~0.00001 XLM (100 stroops)</code>
              </div>
              {intent.payload.memo && (
                <div className="aw-list-row">
                  <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Memo</span>
                  <code>{intent.payload.memo}</code>
                </div>
              )}
              {scanningIntent && (
                <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                  Running Scan &amp; Shield destination &amp; SEP-29 memo check...
                </div>
              )}
              {destScanReport && (
                <div
                  className={
                    destScanReport.verdict === "malicious"
                      ? "aw-banner aw-banner--danger"
                      : destScanReport.requiresMemoCheck || destScanReport.verdict === "warning"
                        ? "aw-banner aw-banner--warn"
                        : "aw-banner"
                  }
                  style={{ fontSize: 12 }}
                >
                  <strong>Scan &amp; Shield: {destScanReport.verdict.toUpperCase()}</strong>
                  {destScanReport.requiresMemoCheck && !intent.payload.memo && (
                    <div style={{ marginTop: 3, color: "var(--aw-stellar-gold)" }}>
                      SEP-29 Memo Required by destination, and none is set on this intent.
                    </div>
                  )}
                  {destScanReport.findings[0] && (
                    <div style={{ marginTop: 3 }}>{destScanReport.findings[0].description}</div>
                  )}
                  {destScanReport.verdict === "warning" && (
                    <label className="aw-checkbox-row" style={{ marginTop: 6 }}>
                      <input
                        type="checkbox"
                        checked={warningAcknowledged}
                        onChange={(e) => setWarningAcknowledged(e.target.checked)}
                      />
                      <span>I reviewed this warning and accept the risk.</span>
                    </label>
                  )}
                </div>
              )}
              {isAccountUnfunded
                ? renderUnfundedBanner(
                    `This account is not activated on ${config.network.toUpperCase()} yet (minimum 1 XLM base reserve required).`,
                  )
                : hasInsufficientFunds && (
                    <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
                      Insufficient spendable {intentAssetCode} ({availableBalanceStr ?? "0"}{" "}
                      available; need {intent.payload.amount}).
                    </div>
                  )}
              {reauthGate.required && reauthGate.reason && (
                <HighValueReauthGate
                  reason={reauthGate.reason}
                  verified={reauthVerified}
                  onVerified={() => setReauthVerified(true)}
                />
              )}
              <button
                type="button"
                className="aw-btn-primary"
                disabled={
                  busy ||
                  scanningIntent ||
                  isAccountUnfunded ||
                  hasInsufficientFunds ||
                  destScanReport?.verdict === "malicious" ||
                  (destScanReport?.verdict === "warning" && !warningAcknowledged) ||
                  Boolean(destScanReport?.requiresMemoCheck && !intent.payload.memo?.trim()) ||
                  (reauthGate.required && !reauthVerified)
                }
                onClick={() => void handleConfirmPayment()}
              >
                {busy
                  ? "Signing & Updating Telegram..."
                  : `Confirm ${intent.payload.amount} ${intent.payload.assetCode ?? "XLM"}`}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
