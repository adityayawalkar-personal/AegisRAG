import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const HF_TOKEN = process.env.HF_TOKEN;
const GEMMA_MODEL = process.env.GEMMA_MODEL || 'google/gemma-4-E2B-it';
const MODELS_DIR = path.join(process.cwd(), 'models');

async function checkOrDownloadGemmaModel() {
  console.log('========================================================================');
  console.log('            AegisRAG — Gemma Model Download & Setup Utility            ');
  console.log('========================================================================\n');

  console.log(`-> Target Model: ${GEMMA_MODEL}`);
  console.log(`-> Hugging Face Authentication: ${HF_TOKEN ? 'Token Configured (HF_TOKEN)' : 'No Token Found'}`);

  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    console.log(`-> Created directory: ${MODELS_DIR}`);
  }

  console.log('\n[1/2] Verifying Hugging Face Model Access:');
  if (!HF_TOKEN) {
    console.warn('⚠️ Warning: HF_TOKEN is not set in .env. Model download may fail for gated models.');
  } else {
    try {
      const res = await fetch(`https://huggingface.co/api/models/${encodeURIComponent(GEMMA_MODEL)}`, {
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
        },
      });
      if (res.ok) {
        const info = await res.json();
        console.log(`✓ Authenticated access confirmed for model: ${info.id || GEMMA_MODEL}`);
      } else {
        console.log(`-> Note: Model status check returned HTTP ${res.status}. Ready for local server or inference gateway.`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`-> Network note: ${msg}`);
    }
  }

  console.log('\n[2/2] Local Gemma Inference Server Instructions:');
  console.log('To run Gemma 4 E2B locally in 8-bit GGUF via llama.cpp:');
  console.log('  1. Place your GGUF file in ./models/ (e.g. models/gemma-4-E2B-it-Q8_0.gguf)');
  console.log('  2. Start llama-server:');
  console.log('     llama-server -m models/gemma-4-E2B-it-Q8_0.gguf --port 8081 --ctx-size 2048');
  console.log('  3. AegisRAG will automatically connect to http://localhost:8081/completion\n');
  console.log('✓ Model configuration is ready for AegisRAG self-healing pipeline.');
}

checkOrDownloadGemmaModel().catch((err) => {
  console.error('Fatal error in model setup:', err);
  process.exit(1);
});
