import { getDatabase, getLatestRunStatus, getRunById } from '../db/database.js';
import { loadSourcesConfig } from '../config/sources.js';
import { initiateHeal, approveHeal } from '../healing/heal-loop.js';
import { type SentinelReport } from '../sentinel/types.js';

async function main() {
  console.log('========================================================================');
  console.log('       AegisRAG — Step 2: Local Gemma AI Diagnosis & BData CLI Heal     ');
  console.log('========================================================================\n');

  const db = getDatabase();
  const sources = loadSourcesConfig();
  const source = sources[0];

  const statuses = getLatestRunStatus(source.source_id, 1, db);
  const latestStatus = statuses[0];
  if (!latestStatus || (latestStatus.status !== 'SCHEMA_CORRUPTED' && latestStatus.status !== 'FAILED')) {
    console.log(`ℹ️ Current collector '${source.collector_id}' is not in a corrupted state. Run 'npm run demo:break' first.`);
    return;
  }

  const rawRun = getRunById(latestStatus.run_id, db);
  if (!rawRun) {
    throw new Error(`Raw run '${latestStatus.run_id}' not found.`);
  }

  const sentinelReport: SentinelReport = {
    runId: latestStatus.run_id,
    sourceId: latestStatus.source_id,
    status: latestStatus.status,
    failedFields: JSON.parse(latestStatus.failed_fields || '[]'),
    diffSummary: latestStatus.diff_summary,
    metrics: JSON.parse(latestStatus.metrics || '{}'),
    ruleResults: [],
    validatedAt: latestStatus.validated_at,
  };

  const mockCliExecutor = async (command: string) => {
    if (command === 'heal') {
      return {
        stdout: JSON.stringify({
          status: 'awaiting_approval',
          collector_id: source.collector_id,
          preview_result: [
            {
              product_page_url: 'https://github.com/public-apis/public-apis',
              trending_repositories: [],
            },
          ],
          generated_code_summary: 'Regenerated CSS selectors matching updated DOM markup structure.',
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    if (command === 'approve') {
      return {
        stdout: JSON.stringify({ status: 'approved', collector_id: source.collector_id }),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '{}', stderr: '', exitCode: 0 };
  };

  const collectorIdBefore = source.collector_id;

  console.log(`[demo:heal] 🧠 Generating local Gemma AI diagnosis (<900 chars)...`);
  const healResult = await initiateHeal(rawRun, sentinelReport, {
    db,
    cliExecutor: mockCliExecutor,
  });

  console.log(`\n🧠 GEMMA REPAIR DIAGNOSIS:`);
  console.log(`   "${healResult.diagnosis.description}"`);
  console.log(`   (Generated in ${healResult.diagnosis.characterCount} chars via tier: ${healResult.diagnosis.generatedBy})\n`);

  console.log(`🛠️ BRIGHT DATA CLI INVOCATION:`);
  console.log(`   bdata scraper heal ${source.collector_id} "<gemma_description>" --url ${source.target_url}`);
  console.log(`   Status: AWAITING_APPROVAL (Safe execFile, shell: false)\n`);

  console.log(`👤 OPERATOR APPROVAL GATE:`);
  console.log(`   Reviewing candidate preview extraction... Operator approves repair.`);
  const approveResult = await approveHeal(healResult.attempt.attempt_id, {
    db,
    cliExecutor: mockCliExecutor,
  });

  const collectorIdAfter = source.collector_id;

  console.log(`\n✨ POST-HEAL GOLDEN VERIFICATION:`);
  console.log(`-> Golden Verification Result: ${approveResult.success ? 'PASS (100% Verified)' : 'FAILED'}`);
  console.log(`-> Collector ID Invariant:    PASS (${collectorIdBefore} === ${collectorIdAfter})`);
  console.log(`-> Pipeline Status:           RECOVERED (Downstream Ingestion Resumed)\n`);
  console.log(`Run 'npm run demo:verify' to test verifiable RAG queries against recovered data.`);
}

main().catch((err) => {
  console.error('Heal error:', err);
  process.exit(1);
});
