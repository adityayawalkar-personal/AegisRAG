import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

export const FieldTypeSchema = z.enum(['string', 'number', 'boolean', 'url', 'array', 'object', 'date']);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const FieldCategorySchema = z.enum(['structural', 'semantic', 'dynamic_numeric']);
export type FieldCategory = z.infer<typeof FieldCategorySchema>;

export const VerificationPolicySchema = z.enum(['strict', 'numeric_tolerance', 'presence_only', 'distribution']);
export type VerificationPolicy = z.infer<typeof VerificationPolicySchema>;

export const FieldPolicySchema = z.object({
  category: FieldCategorySchema.default('structural'),
  policy: VerificationPolicySchema.default('strict'),
  tolerance_pct: z.number().min(0).max(100).optional(),
});
export type FieldPolicy = z.infer<typeof FieldPolicySchema>;

export const ValidationThresholdsSchema = z.object({
  baseline_window: z.number().int().positive().default(5),
  corruption_threshold_pct: z.number().min(1).max(100).default(20),
  duplicate_threshold_pct: z.number().min(1).max(100).default(50),
});
export type ValidationThresholds = z.infer<typeof ValidationThresholdsSchema>;

export const SourceConfigSchema = z.object({
  source_id: z.string().min(1),
  name: z.string().min(1),
  target_url: z.string().url(),
  collector_id: z.string().min(1),
  expected_fields: z.array(z.string().min(1)),
  field_types: z.record(z.string(), FieldTypeSchema).optional(),
  field_policies: z.record(z.string(), FieldPolicySchema).optional(),
  validation_thresholds: ValidationThresholdsSchema.default({
    baseline_window: 5,
    corruption_threshold_pct: 20,
    duplicate_threshold_pct: 50,
  }),
  created_at: z.string().optional(),
});
export type SourceConfig = z.infer<typeof SourceConfigSchema>;

export const SourcesListSchema = z.array(SourceConfigSchema);

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), 'config', 'sources.json');

export function loadSourcesConfig(filePath: string = DEFAULT_CONFIG_PATH): SourceConfig[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Sources configuration file not found at: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse sources configuration JSON: ${msg}`);
  }

  return SourcesListSchema.parse(parsed);
}

export function getSourceById(sourceId: string, filePath: string = DEFAULT_CONFIG_PATH): SourceConfig | undefined {
  const sources = loadSourcesConfig(filePath);
  return sources.find(s => s.source_id === sourceId);
}
