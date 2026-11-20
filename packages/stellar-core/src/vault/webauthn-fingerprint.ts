import { zeroizeBytes } from "../sep0005.js";
import {
  clearBiometricRecord,
  loadBiometricRecord,
  saveBiometricRecord,
} from "./indexeddb-store.js";

function toB64(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }
  return btoa(out);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

type PrfExtensionOutputs = {
  prf?: {
    enabled?: boolean;
    results?: { first?: ArrayBuffer };
  };
};

/**
 * Checks whether platform biometrics (Fingerprint / Touch ID / screen lock) are available.
 * Never requires FaceID hardware.
 */
export async function isFingerprintSupported(): Promise<boolean> {
  if (
    typeof window === "undefined" ||
    typeof PublicKeyCredential === "undefined" ||
    !navigator.credentials
  ) {
    return false;
  }
  try {
    if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function") {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    }
    return false;
  } catch {
    return false;
  }
}

const PRF_HKDF_INFO = new TextEncoder().encode("astrowallet:webauthn-prf-pin-wrap:v1");

async function deriveAesKeyFromPrf(
  prfBytes: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  usage: KeyUsage,
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    prfBytes,
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: PRF_HKDF_INFO,
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/**
 * Enrolls optional Fingerprint / device biometric convenience unlock via WebAuthn PRF.
 * Degrades cleanly if the browser/authenticator does not expose PRF.
 */
export async function enrollFingerprintUnlock(
  pinOrPassphrase: string,
  accountLabel = "AstroWallet",
  rpId?: string,
): Promise<{ enrolled: true } | { enrolled: false; reason: string }> {
  const supported = await isFingerprintSupported();
  if (!supported) {
    return {
      enrolled: false,
      reason: "Platform Fingerprint/Biometric authenticator is unavailable in this browser",
    };
  }

  const challenge = new Uint8Array(new ArrayBuffer(32));
  const userId = new Uint8Array(new ArrayBuffer(16));
  const prfSalt = new Uint8Array(new ArrayBuffer(32));
  const iv = new Uint8Array(new ArrayBuffer(12));
  crypto.getRandomValues(challenge);
  crypto.getRandomValues(userId);
  crypto.getRandomValues(prfSalt);
  crypto.getRandomValues(iv);

  const extensionsRequest = { prf: { eval: { first: prfSalt } } } as unknown as AuthenticationExtensionsClientInputs;
  const resolvedRpId = rpId?.trim() || window.location.hostname;

  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "AstroWallet", id: resolvedRpId },
      user: {
        id: userId,
        name: accountLabel,
        displayName: accountLabel,
      },
      challenge,
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "preferred",
        userVerification: "required",
      },
      timeout: 60_000,
      extensions: extensionsRequest,
    },
  })) as PublicKeyCredential | null;

  if (!credential) {
    return { enrolled: false, reason: "Biometric enrollment cancelled" };
  }

  const ext = credential.getClientExtensionResults() as PrfExtensionOutputs;
  const prfOutput = ext.prf?.results?.first;
  if (!prfOutput) {
    return {
      enrolled: false,
      reason: "Browser registered passkey without PRF support; PIN remains your unlock method",
    };
  }

  const pinBytes = new TextEncoder().encode(pinOrPassphrase);
  const pinCopy = new Uint8Array(new ArrayBuffer(pinBytes.byteLength));
  pinCopy.set(pinBytes);
  zeroizeBytes(pinBytes);

  const prfKeyBytes = new Uint8Array(new ArrayBuffer(prfOutput.byteLength));
  prfKeyBytes.set(new Uint8Array(prfOutput));

  try {
    const aesKey = await deriveAesKeyFromPrf(prfKeyBytes, prfSalt, "encrypt");
    const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, pinCopy);

    await saveBiometricRecord({
      credentialIdB64: toB64(new Uint8Array(credential.rawId)),
      prfSaltB64: toB64(prfSalt),
      ivB64: toB64(iv),
      wrappedPinCiphertextB64: toB64(new Uint8Array(wrapped)),
      createdAt: Math.floor(Date.now() / 1000),
    });

    return { enrolled: true };
  } finally {
    zeroizeBytes(pinCopy);
    zeroizeBytes(prfKeyBytes);
  }
}

/**
 * Unlocks the wrapped vault PIN using platform Fingerprint / Biometrics.
 */
export async function unlockWithFingerprint(rpId?: string): Promise<string> {
  const record = await loadBiometricRecord();
  if (!record) {
    throw new Error("Fingerprint quick-unlock is not enrolled on this device");
  }

  const challenge = new Uint8Array(new ArrayBuffer(32));
  crypto.getRandomValues(challenge);
  const prfSalt = fromB64(record.prfSaltB64);
  const credId = fromB64(record.credentialIdB64);
  const iv = fromB64(record.ivB64);
  const ciphertext = fromB64(record.wrappedPinCiphertextB64);

  const extensionsRequest = { prf: { eval: { first: prfSalt } } } as unknown as AuthenticationExtensionsClientInputs;
  const resolvedRpId = rpId?.trim() || window.location.hostname;

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: resolvedRpId,
      allowCredentials: [{ type: "public-key", id: credId }],
      userVerification: "required",
      timeout: 60_000,
      extensions: extensionsRequest,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) {
    throw new Error("Fingerprint prompt dismissed");
  }

  const ext = assertion.getClientExtensionResults() as PrfExtensionOutputs;
  const prfOutput = ext.prf?.results?.first;
  if (!prfOutput) {
    throw new Error("Biometric PRF output missing; use your PIN to unlock");
  }

  const prfKeyBytes = new Uint8Array(new ArrayBuffer(prfOutput.byteLength));
  prfKeyBytes.set(new Uint8Array(prfOutput));
  let decryptedBytes = new Uint8Array(0);

  try {
    const aesKey = await deriveAesKeyFromPrf(prfKeyBytes, prfSalt, "decrypt");
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertext);
    decryptedBytes = new Uint8Array(plainBuf);
    return new TextDecoder().decode(decryptedBytes);
  } finally {
    zeroizeBytes(prfKeyBytes);
    zeroizeBytes(decryptedBytes);
  }
}

export async function disableFingerprintUnlock(): Promise<void> {
  await clearBiometricRecord();
}
