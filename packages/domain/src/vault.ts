import { z } from "zod";

/**
 * Pure schema for client-encrypted Zero-Knowledge AGVAULT v1 ciphertext envelopes.
 * Rejects extra plaintext fields (`strict`) and enforces minimum Argon2id cost floors.
 */
export const EncryptedVaultBackupEnvelopeSchema = z
  .object({
    version: z.literal(1),
    format: z.literal("AGVAULT"),
    kdf: z
      .object({
        algorithm: z.literal("argon2id"),
        memoryKiB: z.number().int().min(65536).max(524288),
        iterations: z.number().int().min(3).max(20),
        parallelism: z.number().int().min(1).max(8),
        hashLength: z.literal(32),
      })
      .strict(),
    saltB64: z.string().min(16).max(64),
    ivB64: z.string().min(12).max(64),
    ciphertextB64: z.string().min(16).max(12000),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
  })
  .strict();

export type EncryptedVaultBackupEnvelope = z.infer<typeof EncryptedVaultBackupEnvelopeSchema>;
