import { sha256 } from "@noble/hashes/sha2.js";
import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  createSep43Provider,
  createStellarWalletsKitModule,
  createWalletConnectStellarResponder,
} from "./index.js";

function buildDummyTxXdr(source: string, passphrase: string): string {
  const account = new Account(source, "100");
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(Operation.manageData({ name: "astrowallet", value: "dapp-test" }))
    .setTimeout(60)
    .build()
    .toXDR();
}

function buildDummyAuthPreimageB64(
  contractTarget: string,
  networkPassphrase: string = Networks.TESTNET,
): string {
  const networkId = sha256(new TextEncoder().encode(networkPassphrase));
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId,
      nonce: xdr.Int64.fromString("123456"),
      signatureExpirationLedger: 5000,
      invocation: new xdr.SorobanAuthorizedInvocation({
        function:
          xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: new Address(contractTarget).toScAddress(),
              functionName: "transfer",
              args: [],
            }),
          ),
        subInvocations: [],
      }),
    }),
  );
  return preimage.toXDR("base64");
}

describe("Ecosystem dApp interoperability (WalletConnect v2, Stellar Wallets Kit v2, SEP-43)", () => {
  it("handles stellar_signXDR, stellar_signAndSubmitXDR, stellar_signAuthEntry, and stellar_signMessage", async () => {
    const keypair = Keypair.random();
    const submitted: string[] = [];

    const responder = createWalletConnectStellarResponder({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      getKeypair: () => keypair,
      authorizeRequest: async () => true,
      submitSignedXdr: async (signed) => {
        submitted.push(signed);
        return { hash: "d".repeat(64), ledger: 4242 };
      },
    });

    expect(responder.getChainId()).toBe("stellar:testnet");
    expect(responder.getSupportedMethods()).toContain("stellar_signAuthEntry");

    // 1. stellar_signXDR
    const unsignedXdr = buildDummyTxXdr(keypair.publicKey(), Networks.TESTNET);
    const signRes = (await responder.handleRequest({
      method: "stellar_signXDR",
      chainId: "stellar:testnet",
      params: { xdr: unsignedXdr, networkPassphrase: Networks.TESTNET },
    })) as { signedXDR: string };
    const signedTx = TransactionBuilder.fromXDR(signRes.signedXDR, Networks.TESTNET);
    expect(signedTx.signatures).toHaveLength(1);

    // 2. stellar_signAndSubmitXDR
    const submitRes = (await responder.handleRequest({
      method: "stellar_signAndSubmitXDR",
      chainId: "stellar:testnet",
      params: { xdr: unsignedXdr },
    })) as { status: string; hash: string; ledger: number };
    expect(submitRes.status).toBe("submitted");
    expect(submitRes.hash).toBe("d".repeat(64));
    expect(submitted).toHaveLength(1);

    // 3. stellar_signAuthEntry
    const authPreimageB64 = buildDummyAuthPreimageB64(keypair.publicKey());
    const authRes = (await responder.handleRequest({
      method: "stellar_signAuthEntry",
      chainId: "stellar:testnet",
      params: { entryXdr: authPreimageB64 },
    })) as { signedAuthEntry: string; signerAddress: string };
    expect(authRes.signerAddress).toBe(keypair.publicKey());
    const sigBytes = Buffer.from(authRes.signedAuthEntry, "base64");
    const preimageDigest = sha256(Buffer.from(authPreimageB64, "base64"));
    expect(keypair.verify(preimageDigest, sigBytes)).toBe(true);

    // 4. stellar_signMessage
    const msgRes = (await responder.handleRequest({
      method: "stellar_signMessage",
      params: { message: "Sign in to Soroswap" },
    })) as { signedMessage: string; signerAddress: string };
    expect(msgRes.signerAddress).toBe(keypair.publicKey());
    expect(msgRes.signedMessage.length).toBeGreaterThan(20);
  });

  it("fails closed on cross-network chains/passphrases and user rejection", async () => {
    const keypair = Keypair.random();
    const responder = createWalletConnectStellarResponder({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      getKeypair: () => keypair,
      authorizeRequest: async (ctx) => ctx.origin !== "https://malicious.example",
    });

    const unsignedXdr = buildDummyTxXdr(keypair.publicKey(), Networks.TESTNET);

    await expect(
      responder.handleRequest({
        method: "stellar_signXDR",
        chainId: "stellar:pubnet",
        params: { xdr: unsignedXdr },
      }),
    ).rejects.toThrow(/Cross-network/i);

    await expect(
      responder.handleRequest({
        method: "stellar_signXDR",
        params: { xdr: unsignedXdr, networkPassphrase: Networks.PUBLIC },
      }),
    ).rejects.toThrow(/passphrase mismatch/i);

    await expect(
      responder.handleRequest({
        method: "stellar_signMessage",
        origin: "https://malicious.example",
        params: { message: "Authorize drain" },
      }),
    ).rejects.toThrow(/rejected/i);
  });

  it("exposes Stellar Wallets Kit v2 module and SEP-43 provider cleanly", async () => {
    const keypair = Keypair.random();
    const kit = createStellarWalletsKitModule({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      getKeypair: () => keypair,
    });

    expect(kit.id).toBe("astrowallet");
    expect(await kit.isAvailable()).toBe(true);
    expect((await kit.getAddress()).address).toBe(keypair.publicKey());
    expect((await kit.getNetwork()).network).toBe("TESTNET");

    const xdrStr = buildDummyTxXdr(keypair.publicKey(), Networks.TESTNET);
    const signed = await kit.signTransaction(xdrStr);
    expect(signed.signerAddress).toBe(keypair.publicKey());

    const sep43 = createSep43Provider({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      getKeypair: () => keypair,
    });
    expect(await sep43.isConnected()).toBe(true);
    const signedMsg = await sep43.signMessage("SEP-43 Auth");
    expect(signedMsg.signerAddress).toBe(keypair.publicKey());
  });

  it("validates HashIdPreimageWithAddress networkId and SorobanAuthorizationEntry validUntilLedgerSeq", async () => {
    const keypair = Keypair.random();
    const responder = createWalletConnectStellarResponder({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      getKeypair: () => keypair,
      authorizeRequest: async () => true,
    });

    const testnetWithAddr = xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
      new xdr.HashIdPreimageSorobanAuthorizationWithAddress({
        networkId: sha256(new TextEncoder().encode(Networks.TESTNET)),
        nonce: 99n,
        signatureExpirationLedger: 12000,
        address: new Address(keypair.publicKey()).toScAddress(),
        invocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: new Address(keypair.publicKey()).toScAddress(),
              functionName: "swap",
              args: [],
            }),
          ),
          subInvocations: [],
        }),
      }),
    ).toXDR("base64");

    const okWithAddr = (await responder.handleRequest({
      method: "stellar_signAuthEntry",
      chainId: "stellar:testnet",
      params: { entryXdr: testnetWithAddr },
    })) as { signedAuthEntry: string; signerAddress: string };
    expect(okWithAddr.signerAddress).toBe(keypair.publicKey());

    const wrongNetworkPreimage = buildDummyAuthPreimageB64(keypair.publicKey(), Networks.PUBLIC);
    await expect(
      responder.handleRequest({
        method: "stellar_signAuthEntry",
        chainId: "stellar:testnet",
        params: { entryXdr: wrongNetworkPreimage },
      }),
    ).rejects.toThrow(/networkId mismatch/i);

    const authEntryXdr = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(keypair.publicKey()).toScAddress(),
          nonce: 1n,
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVec([]),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(keypair.publicKey()).toScAddress(),
            functionName: "transfer",
            args: [],
          }),
        ),
        subInvocations: [],
      }),
    }).toXDR("base64");

    await expect(
      responder.handleRequest({
        method: "stellar_signAuthEntry",
        chainId: "stellar:testnet",
        params: { entryXdr: authEntryXdr },
      }),
    ).rejects.toThrow(/validUntilLedgerSeq/i);

    await expect(
      responder.handleRequest({
        method: "stellar_signAuthEntry",
        chainId: "stellar:testnet",
        params: { entryXdr: authEntryXdr, validUntilLedgerSeq: 2_000_000_001 },
      }),
    ).rejects.toThrow(/validUntilLedgerSeq/i);

    const signedEntry = (await responder.handleRequest({
      method: "stellar_signAuthEntry",
      chainId: "stellar:testnet",
      params: { entryXdr: authEntryXdr, validUntilLedgerSeq: 500_000 },
    })) as { signedAuthEntry: string; signerAddress: string };
    expect(signedEntry.signerAddress).toBe(keypair.publicKey());
    expect(signedEntry.signedAuthEntry.length).toBeGreaterThan(20);
  });
});
