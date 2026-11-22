import { z } from "zod";
import { StellarAddressSchema } from "./accounts.js";

export const ThreatVerdictSchema = z.enum(["benign", "warning", "malicious"]);

export const SecurityFindingSchema = z.object({
  code: z.string().min(1),
  severity: ThreatVerdictSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  blocksSigning: z.boolean(),
});

export const BalanceDiffSchema = z.object({
  address: StellarAddressSchema,
  assetCode: z.string().min(1).max(12),
  assetIssuer: StellarAddressSchema.optional(),
  delta: z.string(),
});

export const ScanReportSchema = z.object({
  verdict: ThreatVerdictSchema,
  operationsCount: z.number().int().nonnegative(),
  findings: z.array(SecurityFindingSchema),
  balanceDiffs: z.array(BalanceDiffSchema),
  requiresMemoCheck: z.boolean(),
  estimatedFeeStroops: z.string().regex(/^\d+$/),
  assembledXdr: z.string().optional(),
});

export type ThreatVerdict = z.infer<typeof ThreatVerdictSchema>;
export type SecurityFinding = z.infer<typeof SecurityFindingSchema>;
export type BalanceDiff = z.infer<typeof BalanceDiffSchema>;
export type ScanReport = z.infer<typeof ScanReportSchema>;
