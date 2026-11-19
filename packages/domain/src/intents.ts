import { z } from "zod";
import { AccountKindSchema, ContractAddressSchema, StellarAddressSchema } from "./accounts.js";
import { StellarNetworkSchema } from "./config.js";

export const IntentActionTypeSchema = z.enum([
  "connect",
  "pay",
  "request",
  "split",
  "swap",
  "claim",
  "reclaim_reserve",
  "sign_xdr",
]);

export const IntentStatusSchema = z.enum([
  "pending",
  "signed",
  "confirmed",
  "expired",
  "cancelled",
]);

export const TelegramUserIdSchema = z
  .string()
  .regex(/^\d{1,20}$/, "telegramUserId must be an immutable numeric string");

export const SignedIntentSchema = z.object({
  intentId: z.string().min(8).max(64),
  network: StellarNetworkSchema,
  creatorTelegramUserId: TelegramUserIdSchema,
  actionType: IntentActionTypeSchema,
  payloadJson: z.string().min(2),
  hmacSig: z.string().min(32),
  status: IntentStatusSchema,
  chatId: z.string().optional(),
  messageId: z.string().optional(),
  inlineMessageId: z.string().optional(),
  txHash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  expiresAt: z.number().int().positive(),
  createdAt: z.number().int().positive(),
});

export const TelegramUserBindingSchema = z.object({
  telegramUserId: TelegramUserIdSchema,
  usernameLower: z
    .string()
    .regex(/^[a-z0-9_]{5,32}$/)
    .optional(),
  address: StellarAddressSchema,
  kind: AccountKindSchema,
  label: z.string().min(1).max(32),
  isDefault: z.boolean(),
});

export const ClaimLinkSchema = z.object({
  claimId: z.string().min(8).max(64),
  network: StellarNetworkSchema,
  senderAddress: StellarAddressSchema,
  recipientUsernameLower: z.string().regex(/^[a-z0-9_]{5,32}$/),
  assetCode: z.string().min(1).max(12),
  assetIssuer: StellarAddressSchema.optional(),
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/),
  escrowContractId: ContractAddressSchema,
  status: z.enum(["open", "claimed", "refunded", "expired"]),
  expiresAt: z.number().int().positive(),
});

export type IntentActionType = z.infer<typeof IntentActionTypeSchema>;
export type IntentStatus = z.infer<typeof IntentStatusSchema>;
export type SignedIntent = z.infer<typeof SignedIntentSchema>;
export type TelegramUserBinding = z.infer<typeof TelegramUserBindingSchema>;
export type ClaimLink = z.infer<typeof ClaimLinkSchema>;
