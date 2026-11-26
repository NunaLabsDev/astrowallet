# AstroWallet Developer Quickstart — Connect Any Stellar / Soroban Telegram Mini App in 5 Minutes

> **Zero custodial code, zero browser extensions, 100% Telegram-native.** Use `@astrowallet/connect` (or raw HTTP + `https://t.me/...`) to authenticate Stellar users (`G...` & `C...`), sign SEP-53 messages, and execute Soroban / Classic transactions from any Telegram Mini App.

---

## 1. Environment Configuration

Configure your project using environment variables (never hardcode URLs or network passphrases):

```env
# Testnet (use your AstroWallet instance origin)
VITE_ASTROWALLET_API_BASE_URL=https://astro-wallet.pages.dev
VITE_YOUR_BOT_USERNAME=YourProjectBot
VITE_YOUR_MINI_APP_SHORT_NAME=app
```

> **Live Discovery Endpoints:**
> - OpenAPI 3.1 spec: `<ASTROWALLET_BASE_URL>/openapi.json`
> - AI/Agent guide: `<ASTROWALLET_BASE_URL>/llms.txt`

---

## 2. Initialize the Client (`@astrowallet/connect`)

```ts
import { createAstroConnectClient } from "@astrowallet/connect";

export const astroConnect = createAstroConnectClient({
  apiBaseUrl: import.meta.env.VITE_ASTROWALLET_API_BASE_URL,
  app: {
    name: "My Soroban Protocol",
    botUsername: import.meta.env.VITE_YOUR_BOT_USERNAME,
    miniAppShortName: import.meta.env.VITE_YOUR_MINI_APP_SHORT_NAME,
    returnStartAppParam: "wallet_done",
  },
});
```

---

## 3. Sign-In with AstroWallet (SEP-53 Authentication)

### Frontend (Inside Your Telegram Mini App)

```ts
// 1. Opens AstroWallet inside Telegram with a 50-char startapp link & polls securely
const login = await astroConnect.login({
  statement: "Sign in to My Soroban Protocol",
  domain: window.location.hostname,
});

// 2. Send { address, challengeMessage, signatureBase64 } to your backend to issue a session JWT
await fetch("/api/auth/stellar", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(login),
});
```

### Backend (Offline Cryptographic Verification)

Verify the Ed25519 SEP-53 proof on your server with **zero** calls back to AstroWallet:

```ts
import { verifyAstroLoginProof } from "@astrowallet/connect";

const check = await verifyAstroLoginProof(proof, {
  network: "testnet",
  botUsername: process.env.YOUR_BOT_USERNAME,
  domain: process.env.YOUR_APP_DOMAIN,
});

if (!check.valid) {
  return Response.json({ error: check.reason }, { status: 401 });
}
// Authenticated Stellar user: proof.address (plus optional proof.accounts)
```

---

## 4. Execute a Soroban Smart Contract or Classic SDEX Transaction

Build and simulate your unsigned `TransactionEnvelope` XDR with `@stellar/stellar-sdk` (using the user's `G...` or `C...` address as source), then hand it off for **Clear-Sign + Scan & Shield** execution:

```ts
// Mode A: Sign & Submit directly on Stellar RPC / Horizon inside AstroWallet
const txResult = await astroConnect.signTransaction(unsignedXdrBase64, {
  humanSummary: "Deposit 50 USDC into Soroban Vault",
  submit: true,
  subAction: "vault_deposit",
});
console.log("Confirmed on ledger:", txResult.ledger, "hash:", txResult.txHash);

// Mode B: Sign-Only (for multi-sig, custom fee-bump sponsorship, or backend submission)
const signedOnly = await astroConnect.signTransaction(unsignedXdrBase64, {
  humanSummary: "Sign Soroban order authorization",
  submit: false,
});
console.log("Signed XDR:", signedOnly.signedXdr);
```

### Honest `G...` vs `C...` Guidance for Integrators
- **Classic (`G...`):** Supports Classic SDEX (`manageBuyOffer` / `manageSellOffer`), `pathPaymentStrictSend`, `changeTrust`, Claimable Balances, and Soroban contract invocations.
- **Smart Account (`C...`):** Supports Soroban contract invocations and sponsored execution, and **cannot** hold Classic trustlines or place Classic SDEX orderbook offers. Check `account.kind` in `login.accounts` before building Classic-only operations.

---

## 5. Sign an Off-Chain Message (SEP-53)

Useful for governance votes, off-chain limit orders, or API request signatures:

```ts
const signed = await astroConnect.signMessage("vote:proposal-42:yes", {
  humanSummary: "Vote YES on Proposal #42",
});
```

---

## 6. Drop-In `@creit.tech/stellar-wallets-kit` Bridge

Already using `@creit.tech/stellar-wallets-kit` in your Stellar dApp? Plug in `createAstroWalletKitModule`:

```ts
import { createAstroWalletKitModule } from "@astrowallet/connect";

const astroWalletModule = createAstroWalletKitModule({
  apiBaseUrl: import.meta.env.VITE_ASTROWALLET_API_BASE_URL,
  app: {
    name: "My Existing Stellar dApp",
    botUsername: import.meta.env.VITE_YOUR_BOT_USERNAME,
    miniAppShortName: import.meta.env.VITE_YOUR_MINI_APP_SHORT_NAME,
  },
  networkPassphrase: import.meta.env.VITE_STELLAR_NETWORK_PASSPHRASE,
});

const { address } = await astroWalletModule.getAddress();
const { signedTxXdr } = await astroWalletModule.signTransaction(unsignedXdr);
```

---

## 7. Resolve Public `AstroID` Directory (`@username` / Telegram ID $\leftrightarrow$ `G...`/`C...`)

Look up any user's public Stellar accounts without asking them to copy-paste addresses:

```ts
const profile = await astroConnect.resolveIdentity("@alice");
if (profile.found) {
  console.log("Primary address:", profile.primaryAddress);
  console.log("All linked accounts:", profile.accounts);
}
```
