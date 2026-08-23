import { getDatabase, setCollectorStatus } from '../db/database.js';
import { loadSourcesConfig } from '../config/sources.js';
import { IndexStore } from '../indexing/index-store.js';

async function main() {
  console.log('🔄 Resetting AegisRAG Collector State & Knowledge Base...');
  const db = getDatabase();
  const sources = loadSourcesConfig();
  const source = sources[0];

  setCollectorStatus(source.collector_id, 'HEALTHY', db);
  const indexStore = new IndexStore(db);
  indexStore.syncBm25FromDatabase();

  console.log(`✅ Collector '${source.collector_id}' reset to HEALTHY.`);
  console.log(`✅ Knowledge index synchronized (${indexStore.size()} chunks active).`);
}

main().catch((err) => {
  console.error('Reset error:', err);
  process.exit(1);
});
