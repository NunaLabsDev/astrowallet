import { z } from "zod";
import { AccountKindSchema, StellarAddressSchema } from "./accounts.js";
import type { StellarNetwork } from "./config.js";

export const ConnectActionTypeSchema = z.enum([
  "auth",
  "sign_xdr",
  "sign_message",
  "sign_auth_entry",
]);
export const ConnectRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
]);
export const ConnectAppTrustTierSchema = z.enum(["official", "verified", "external"]);

function isSafeHttpsOrLocalUrl(raw: string): boolean {
  try {
    const UrlCtor = (globalThis as unknown as { URL?: new (input: string) => { protocol: string; hostname: string } }).URL;
    if (!UrlCtor) return false;
    const parsed = new UrlCtor(raw);
    if (parsed.protocol === "https:") return true;
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

export const ConnectAppMetadataSchema = z.object({
  name: z.string().trim().min(1).max(64),
  botUsername: z
    .string()
    .trim()
    .transform((v) => v.replace(/^@/, ""))
    .refine(
      (v) => /^[A-Za-z0-9_]{5,32}$/.test(v),
      "botUsername must be a valid Telegram bot username (5-32 chars)",
    ),
  miniAppShortName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{3,64}$/, "miniAppShortName must be 3-64 alphanumeric/underscore chars")
    .optional(),
  returnStartAppParam: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,128}$/, "returnStartAppParam must match [A-Za-z0-9_-]{1,128}")
    .optional(),
  iconUrl: z
    .string()
    .trim()
    .max(256)
    .refine((v) => {
      try {
        const UrlCtor = (globalThis as unknown as { URL?: new (input: string) => { protocol: string } }).URL;
        return Boolean(UrlCtor && new UrlCtor(v).protocol === "https:");
      } catch {
        return false;
      }
    }, "iconUrl must be a valid https:// URL")
    .optional(),
  origin: z
    .string()
    .trim()
    .max(160)
    .refine(isSafeHttpsOrLocalUrl, "origin must be a valid https:// (or localhost http://) URL")
    .optional(),
});

export const ConnectAuthPayloadSchema = z.object({
  nonce: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, "nonce must be 8-64 URL-safe characters"),
  statement: z.string().trim().max(280).optional(),
  domain: z.string().trim().max(128).optional(),
  includeAccounts: z.boolean().default(true),
  challengeMessage: z.string().trim().min(1).max(1024).optional(),
});

export const ConnectSignMessagePayloadSchema = z.object({
  message: z.string().min(1).max(2048),
  humanSummary: z.string().trim().max(280).optional(),
});

export const ConnectSignXdrPayloadSchema = z.object({
  unsignedXdr: z.string().trim().min(16).max(32_768),
  xdrSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  submit: z.boolean().default(true),
  humanSummary: z.string().trim().min(1).max(400),
  subAction: z.string().trim().max(64).optional(),
  sourceAddress: StellarAddressSchema.optional(),
});

export const ConnectAccountSummarySchema = z.object({
  address: StellarAddressSchema,
  kind: AccountKindSchema,
  label: z.string().min(1).max(32),
  isDefault: z.boolean(),
});

export const ConnectSignAuthEntryPayloadSchema = z.object({
  authEntryXdr: z.string().trim().min(16).max(32_768),
  entrySha256: z.string().regex(/^[a-f0-9]{64}$/i),
  humanSummary: z.string().trim().min(1).max(400),
  subAction: z.string().trim().max(64).optional(),
  sourceAddress: StellarAddressSchema.optional(),
});

export const ConnectResultSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(280).optional(),
  address: StellarAddressSchema.optional(),
  accounts: z.array(ConnectAccountSummarySchema).max(10).optional(),
  telegramUserId: z.string().regex(/^\d{1,20}$/).optional(),
  username: z.string().regex(/^[a-z0-9_]{5,32}$/).optional(),
  signedMessage: z.string().min(1).max(2048).optional(),
  signatureBase64: z.string().min(16).max(256).optional(),
  signedXdr: z.string().min(16).max(49_152).optional(),
  signedAuthEntry: z.string().min(16).max(49_152).optional(),
  txHash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  ledger: z.number().int().positive().optional(),
  completedAt: z.number().int().positive(),
});

export type ConnectActionType = z.infer<typeof ConnectActionTypeSchema>;
export type ConnectRequestStatus = z.infer<typeof ConnectRequestStatusSchema>;
export type ConnectAppTrustTier = z.infer<typeof ConnectAppTrustTierSchema>;
export type ConnectAppMetadata = z.infer<typeof ConnectAppMetadataSchema>;
export type ConnectAuthPayload = z.infer<typeof ConnectAuthPayloadSchema>;
export type ConnectSignMessagePayload = z.infer<typeof ConnectSignMessagePayloadSchema>;
export type ConnectSignXdrPayload = z.infer<typeof ConnectSignXdrPayloadSchema>;
export type ConnectSignAuthEntryPayload = z.infer<typeof ConnectSignAuthEntryPayloadSchema>;
export type ConnectAccountSummary = z.infer<typeof ConnectAccountSummarySchema>;
export type ConnectResult = z.infer<typeof ConnectResultSchema>;

export interface ConnectRequestRecord {
  requestId: string;
  network: StellarNetwork;
  action: ConnectActionType;
  status: ConnectRequestStatus;
  trustTier: ConnectAppTrustTier;
  hmacSig: string;
  resultTokenHash: string;
  appJson: string;
  payloadJson: string;
  resultJson?: string | undefined;
  responderTelegramUserId?: string | undefined;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}
