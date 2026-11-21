import type {
  AccountKind,
  AccountReserveSummary,
  IntentStatus,
  ScanReport,
  StellarNetwork,
  TelegramUserBinding,
} from "@astrowallet/domain";

export function escapeTelegramHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

export function formatConnectPrompt(
  network: StellarNetwork,
  expiresMinutes: number,
  confirmCode?: string,
): string {
  const badge = escapeTelegramHtml(network.toUpperCase());
  const lines = [
    `<b>Link AstroWallet [${badge}]</b>`,
    "",
    "Tap below to prove ownership of one or more SEP-0005 accounts using your device PIN or Fingerprint.",
    `• Non-custodial: your seed phrase never leaves your phone.`,
    `• Link expires in ${expiresMinutes} minutes.`,
  ];
  if (confirmCode) {
    lines.push(
      `• Verification code: <code>${escapeTelegramHtml(confirmCode)}</code> (enter in AstroWallet PWA to prove this DM belongs to you).`,
    );
  }
  return lines.join("\n");
}

export interface PaymentIntentCardInput {
  status: IntentStatus;
  amount: string;
  assetCode: string;
  senderLabel: string;
  recipientLabel: string;
  memo?: string | undefined;
  network: StellarNetwork;
  txHash?: string | undefined;
}

export function formatPaymentIntentCard(input: PaymentIntentCardInput): string {
  const net = escapeTelegramHtml(input.network.toUpperCase());
  const amount = escapeTelegramHtml(input.amount);
  const asset = escapeTelegramHtml(input.assetCode);
  const sender = escapeTelegramHtml(input.senderLabel);
  const recipient = escapeTelegramHtml(input.recipientLabel);

  const statusLine =
    input.status === "confirmed"
      ? "✅ <b>Confirmed on Stellar</b>"
      : input.status === "expired"
        ? "⌛ <b>Intent Expired</b>"
        : input.status === "cancelled"
          ? "✖️ <b>Cancelled</b>"
          : "⏳ <b>Pending Signature</b>";

  const lines = [
    `${statusLine} · <code>${net}</code>`,
    "",
    `<b>Amount:</b> ${amount} ${asset}`,
    `<b>From:</b> ${sender}`,
    `<b>To:</b> ${recipient}`,
  ];

  if (input.memo) {
    lines.push(`<b>Memo:</b> <code>${escapeTelegramHtml(input.memo)}</code>`);
  }
  if (input.txHash) {
    lines.push(`<b>Tx Hash:</b> <code>${escapeTelegramHtml(shortenAddress(input.txHash))}</code>`);
    lines.push(`<code>${escapeTelegramHtml(input.txHash)}</code>`);
  } else if (input.status === "pending") {
    lines.push("", "Authorize in AstroWallet PWA with PIN or Fingerprint.");
  }

  return lines.join("\n");
}

export interface RequestCardInput {
  status: IntentStatus;
  amount: string;
  assetCode: string;
  requesterLabel: string;
  recipientAddress: string;
  memo?: string | undefined;
  network: StellarNetwork;
  txHash?: string | undefined;
}

export function formatRequestCard(input: RequestCardInput): string {
  const net = escapeTelegramHtml(input.network.toUpperCase());
  const statusHeader =
    input.status === "confirmed" ? "✅ <b>Request Paid</b>" : "💸 <b>Payment Request</b>";
  const lines = [
    `${statusHeader} · <code>${net}</code>`,
    "",
    `<b>Requested:</b> ${escapeTelegramHtml(input.amount)} ${escapeTelegramHtml(input.assetCode)}`,
    `<b>Payee:</b> ${escapeTelegramHtml(input.requesterLabel)} (<code>${escapeTelegramHtml(shortenAddress(input.recipientAddress))}</code>)`,
  ];
  if (input.memo) {
    lines.push(`<b>Note:</b> ${escapeTelegramHtml(input.memo)}`);
  }
  if (input.txHash) {
    lines.push(`<b>Tx Hash:</b> <code>${escapeTelegramHtml(input.txHash)}</code>`);
  }
  return lines.join("\n");
}

export interface SplitCardInput {
  amountPerPerson: string;
  totalAmount: string;
  assetCode: string;
  participantCount: number;
  requesterLabel: string;
  recipientAddress: string;
  network: StellarNetwork;
  paidCount?: number | undefined;
  status?: IntentStatus | undefined;
  txHashes?: readonly string[] | undefined;
}

export function formatSplitCard(input: SplitCardInput): string {
  const net = escapeTelegramHtml(input.network.toUpperCase());
  const paidCount = input.paidCount ?? 0;
  const complete = input.status === "confirmed" || paidCount >= input.participantCount;
  const header = complete
    ? `✅ <b>Split Fully Paid (${paidCount}/${input.participantCount})</b>`
    : `🧾 <b>Group Bill Split</b>`;

  const lines = [
    `${header} · <code>${net}</code>`,
    "",
    `<b>Total:</b> ${escapeTelegramHtml(input.totalAmount)} ${escapeTelegramHtml(input.assetCode)} (${input.participantCount} ways)`,
    `<b>Share per person:</b> ${escapeTelegramHtml(input.amountPerPerson)} ${escapeTelegramHtml(input.assetCode)}`,
    `<b>Paid:</b> ${paidCount}/${input.participantCount}`,
    `<b>Pay to:</b> ${escapeTelegramHtml(input.requesterLabel)} (<code>${escapeTelegramHtml(shortenAddress(input.recipientAddress))}</code>)`,
  ];

  if (input.txHashes && input.txHashes.length > 0) {
    const latest = input.txHashes[input.txHashes.length - 1];
    if (latest) {
      lines.push(`<b>Latest Tx:</b> <code>${escapeTelegramHtml(shortenAddress(latest))}</code>`);
    }
  }
  return lines.join("\n");
}

export function formatAccountsSummary(
  accounts: readonly TelegramUserBinding[],
  network: StellarNetwork,
): string {
  const net = escapeTelegramHtml(network.toUpperCase());
  if (accounts.length === 0) {
    return [
      `<b>Linked Accounts [${net}]</b>`,
      "",
      "No verified accounts linked yet. Run /connect to link your SEP-0005 accounts.",
    ].join("\n");
  }

  const rows = accounts.map((acc) => {
    const tag = acc.isDefault ? " ★ Default" : "";
    const kindLabel = acc.kind === "smart" ? "Smart C..." : "Classic G...";
    return `• <b>${escapeTelegramHtml(acc.label)}</b> (${kindLabel}${tag})\n  <code>${escapeTelegramHtml(acc.address)}</code>`;
  });

  return [`<b>Linked Accounts [${net}]</b>`, "", ...rows].join("\n");
}

export interface AccountBalanceSummaryEntry {
  label: string;
  address: string;
  kind: AccountKind;
  funded: boolean;
  balances: readonly { assetCode: string; balance: string }[];
}

export function formatBalancesSummary(
  entries: readonly AccountBalanceSummaryEntry[],
  network: StellarNetwork,
): string {
  const net = escapeTelegramHtml(network.toUpperCase());
  if (entries.length === 0) {
    return `<b>Balances [${net}]</b>\n\nNo linked accounts yet. Run /connect first.`;
  }

  const sections = entries.map((entry) => {
    const header = `<b>${escapeTelegramHtml(entry.label)}</b> (<code>${escapeTelegramHtml(shortenAddress(entry.address))}</code>)`;
    if (!entry.funded) {
      return `${header}\n  Unfunded on ${net}`;
    }
    if (entry.balances.length === 0) {
      return `${header}\n  0.0000000 XLM`;
    }
    const balLines = entry.balances.map(
      (b) => `  • ${escapeTelegramHtml(b.balance)} ${escapeTelegramHtml(b.assetCode)}`,
    );
    return [header, ...balLines].join("\n");
  });

  return [`<b>Live Stellar Balances [${net}]</b>`, "", ...sections].join("\n");
}

export interface IncomingAlertCardInput {
  addressLabel: string;
  address: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string | undefined;
  isVerifiedAsset?: boolean | undefined;
  fromAddress: string;
  txHash: string;
  network: StellarNetwork;
}

export function formatIncomingAlertCard(input: IncomingAlertCardInput): string {
  const net = escapeTelegramHtml(input.network.toUpperCase());
  const assetDisplay = input.assetIssuer
    ? input.isVerifiedAsset === true
      ? `${escapeTelegramHtml(input.assetCode)} (Verified)`
      : `${escapeTelegramHtml(input.assetCode)} ⚠️ Unverified (<code>${escapeTelegramHtml(shortenAddress(input.assetIssuer))}</code>)`
    : escapeTelegramHtml(input.assetCode);

  return [
    `📥 <b>Payment Received</b> · <code>${net}</code>`,
    "",
    `<b>Account:</b> ${escapeTelegramHtml(input.addressLabel)} (<code>${escapeTelegramHtml(shortenAddress(input.address))}</code>)`,
    `<b>Amount:</b> +${escapeTelegramHtml(input.amount)} ${assetDisplay}`,
    `<b>From:</b> <code>${escapeTelegramHtml(shortenAddress(input.fromAddress))}</code>`,
    `<b>Tx:</b> <code>${escapeTelegramHtml(shortenAddress(input.txHash))}</code>`,
  ].join("\n");
}

export interface ScanReportCardInput {
  targetLabel: string;
  report: ScanReport;
  network: StellarNetwork;
}

export function formatScanReportCard(input: ScanReportCardInput): string {
  const net = escapeTelegramHtml(input.network.toUpperCase());
  const verdictBadge =
    input.report.verdict === "malicious"
      ? "🚨 <b>MALICIOUS / BLOCKED</b>"
      : input.report.verdict === "warning"
        ? "⚠️ <b>WARNING / CAUTION</b>"
        : "🛡️ <b>BENIGN / VERIFIED</b>";

  const lines = [
    `<b>Scan &amp; Shield Report</b> · <code>${net}</code>`,
    `${verdictBadge}`,
    "",
    `<b>Target:</b> <code>${escapeTelegramHtml(input.targetLabel)}</code>`,
    `<b>Operations:</b> ${input.report.operationsCount}`,
  ];

  if (input.report.requiresMemoCheck) {
    lines.push("<b>SEP-29 Memo Guard:</b> Deposit Memo Required");
  }

  if (input.report.findings.length === 0) {
    lines.push("", "• No malicious drainer patterns, spoofed assets, or directory threats detected.");
  } else {
    lines.push("", "<b>Findings:</b>");
    for (const finding of input.report.findings) {
      const icon = finding.blocksSigning ? "⛔" : "⚠️";
      lines.push(
        `${icon} <b>${escapeTelegramHtml(finding.title)}</b>: ${escapeTelegramHtml(finding.description)}`,
      );
    }
  }

  return lines.join("\n");
}

export interface SwapQuoteCardInput {
  fromAsset: string;
  toAsset: string;
  inputAmount: string;
  expectedOutputAmount: string;
  provider: string;
  priceImpactPct: string;
  network: StellarNetwork;
  status?: IntentStatus | undefined;
  txHash?: string | undefined;
}

export function formatSwapQuoteCard(input: SwapQuoteCardInput): string {
  const net = escapeTelegramHtml(input.network.toUpperCase());
  const header =
    input.status === "confirmed" ? "✅ <b>Swap Confirmed</b>" : "🔄 <b>Swap Quote</b>";
  const impactText =
    !input.priceImpactPct || input.priceImpactPct.trim().toUpperCase() === "N/A"
      ? "market rate"
      : `impact ~${escapeTelegramHtml(input.priceImpactPct)}%`;
  const lines = [
    `${header} · <code>${net}</code>`,
    "",
    `<b>Sell:</b> ${escapeTelegramHtml(input.inputAmount)} ${escapeTelegramHtml(input.fromAsset)}`,
    `<b>Receive (est.):</b> ${escapeTelegramHtml(input.expectedOutputAmount)} ${escapeTelegramHtml(input.toAsset)}`,
    `<b>Route:</b> ${escapeTelegramHtml(input.provider)} (${impactText})`,
  ];

  if (input.txHash) {
    lines.push(`<b>Tx Hash:</b> <code>${escapeTelegramHtml(input.txHash)}</code>`);
  } else {
    lines.push(
      "",
      "Tap below to review in Scan &amp; Shield and sign with PIN or Fingerprint.",
    );
  }
  return lines.join("\n");
}

export interface ClaimLinkCardInput {
  status: "pending_funding" | "open" | "claimed" | "refunded" | "expired";
  amount: string;
  assetCode: string;
  senderLabel: string;
  recipientUsername: string;
  network: StellarNetwork;
  txHash?: string | undefined;
  claimUrlHint?: string | undefined;
}

export function formatClaimLinkCard(input: ClaimLinkCardInput): string {
  const net = escapeTelegramHtml(input.network.toUpperCase());
  const cleanRecipient = input.recipientUsername.replace(/^@/, "");
  const header =
    input.status === "claimed"
      ? "🎁 <b>Claim Link Claimed!</b>"
      : input.status === "refunded"
        ? "↩️ <b>Claim Link Refunded</b>"
        : input.status === "expired"
          ? "⌛ <b>Claim Link Expired</b>"
          : input.status === "pending_funding"
            ? "⏳ <b>Claim Link Awaiting Escrow Deposit</b>"
            : "🎁 <b>Stellar Claim Link Ready!</b>";

  const lines = [
    `${header} · <code>${net}</code>`,
    "",
    `<b>Amount:</b> ${escapeTelegramHtml(input.amount)} ${escapeTelegramHtml(input.assetCode)}`,
    `<b>From:</b> ${escapeTelegramHtml(input.senderLabel)}`,
    `<b>Reserved for:</b> @${escapeTelegramHtml(cleanRecipient)}`,
  ];

  if (input.status === "pending_funding") {
    lines.push(
      "",
      `${escapeTelegramHtml(input.senderLabel)}: tap below to lock funds into Soroban Escrow and generate the secret claim link for @${escapeTelegramHtml(cleanRecipient)}.`,
    );
  } else if (input.status === "open") {
    lines.push(
      "",
      `Escrow funded! Share the generated secret Claim Link with @${escapeTelegramHtml(cleanRecipient)} so they can claim on-chain (auto-refunds after expiry).`,
    );
    if (input.claimUrlHint) {
      lines.push(`<b>Link:</b> ${escapeTelegramHtml(input.claimUrlHint)}`);
    }
  }
  if (input.txHash) {
    lines.push(`<b>Tx:</b> <code>${escapeTelegramHtml(shortenAddress(input.txHash))}</code>`);
  }

  return lines.join("\n");
}

export interface AccountReserveEntry {
  label: string;
  address: string;
  funded: boolean;
  summary?: AccountReserveSummary | undefined;
}

export interface ReserveReportCardInput {
  entries: readonly AccountReserveEntry[];
  network: StellarNetwork;
}

export function formatReserveReportCard(input: ReserveReportCardInput): string {
  const net = escapeTelegramHtml(input.network.toUpperCase());
  if (input.entries.length === 0) {
    return `<b>Reserve &amp; LumenWipe Check [${net}]</b>\n\nNo Classic G... accounts linked yet. Run /connect first.`;
  }

  const lines: string[] = [`<b>Reserve &amp; LumenWipe Report [${net}]</b>`, ""];
  let totalReclaimable = 0;

  for (const entry of input.entries) {
    const header = `<b>${escapeTelegramHtml(entry.label)}</b> (<code>${escapeTelegramHtml(shortenAddress(entry.address))}</code>)`;
    if (!entry.funded || !entry.summary) {
      lines.push(`${header}\n  Unfunded on ${net} (requires &ge; 1 XLM activation)`);
      continue;
    }

    const s = entry.summary;
    totalReclaimable += Number(s.reclaimableXlm);
    lines.push(
      [
        header,
        `  • <b>Min Reserve:</b> ${escapeTelegramHtml(s.minReserveXlm)} XLM (${s.subentryCount} subentries, +${s.numSponsoring} sponsoring, -${s.numSponsored} sponsored)`,
        `  • <b>Spendable XLM:</b> ${escapeTelegramHtml(s.spendableXlm)} XLM`,
      ].join("\n"),
    );

    if (s.reclaimableTrustlines.length > 0) {
      const codes = s.reclaimableTrustlines.map((t) => escapeTelegramHtml(t.assetCode)).join(", ");
      lines.push(
        `  • <b>Reclaimable (LumenWipe):</b> +${escapeTelegramHtml(s.reclaimableXlm)} XLM from ${s.reclaimableTrustlines.length} zero-balance trustline(s) (${codes})`,
      );
    } else {
      lines.push("  • <b>Reclaimable:</b> 0.0 XLM (no zero-balance trustlines)");
    }
  }

  if (totalReclaimable > 0) {
    lines.push(
      "",
      `Tap below to reclaim <b>+${totalReclaimable.toFixed(1)} XLM</b> in AstroWallet PWA.`,
    );
  }

  return lines.join("\n");
}
