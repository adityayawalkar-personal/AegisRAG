import { getDatabase } from '../db/database.js';
import { IndexStore } from '../indexing/index-store.js';
import { RagService } from '../retrieval/rag-service.js';

async function main() {
  console.log('========================================================================');
  console.log('       AegisRAG — Step 3: Verifiable Hybrid Retrieval & Citations       ');
  console.log('========================================================================\n');

  const db = getDatabase();
  const indexStore = new IndexStore(db);
  const rag = new RagService(indexStore, db);

  const query = 'What does facebook/react provide according to indexed trending repositories?';
  console.log(`[demo:verify] 🔍 Query: "${query}"\n`);

  const response = await rag.query({ query });
  console.log(`💬 VERIFIED RAG ANSWER:\n${response.answer}\n`);

  console.log(`📌 INLINE CITATIONS:`);
  console.table(
    response.citations.map((c) => ({
      source_url: c.sourceUrl,
      last_verified_at: c.lastVerifiedAt,
    }))
  );

  console.log(`\n🛡️ UNANSWERABLE NEGATIVE CONTROL TEST:`);
  const negativeQuery = 'What is the stock price of Apple AAPL?';
  console.log(`Query: "${negativeQuery}"`);
  const negativeRes = await rag.query({ query: negativeQuery });
  console.log(`Answer: "${negativeRes.answer}"`);
  console.log(`-> Refusal Gate Triggered (Zero Hallucination): ${!negativeRes.hasSufficientContext}\n`);
}

main().catch((err) => {
  console.error('Verify error:', err);
  process.exit(1);
});
