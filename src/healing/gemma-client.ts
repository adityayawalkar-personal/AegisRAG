import dotenv from 'dotenv';

dotenv.config();

export interface GemmaDiagnosisRequest {
  collectorId: string;
  targetUrl: string;
  failedFields: string[];
  diffSummary: string;
  expectedFields: string[];
}

export interface GemmaDiagnosisResult {
  description: string;
  characterCount: number;
  isUnderLimit: boolean;
  generatedBy: 'local_gemma_server' | 'deterministic_fallback';
}

const DEFAULT_GEMMA_ENDPOINT = process.env.GEMMA_ENDPOINT || 'http://localhost:8081/completion';
const MAX_CHAR_LIMIT = 900;

export async function generateHealDescription(
  request: GemmaDiagnosisRequest,
  endpoint: string = DEFAULT_GEMMA_ENDPOINT
): Promise<GemmaDiagnosisResult> {
  const prompt = buildGemmaPrompt(request);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        n_predict: 200,
        temperature: 0.1,
        stop: ['\n', 'Instruction:', 'Response:'],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = (await response.json()) as { content?: string };
      const rawText = data.content?.trim();
      if (rawText) {
        const cleaned = sanitizeSentence(rawText);
        if (cleaned.length > 0 && cleaned.length <= MAX_CHAR_LIMIT) {
          return {
            description: cleaned,
            characterCount: cleaned.length,
            isUnderLimit: true,
            generatedBy: 'local_gemma_server',
          };
        }
      }
    }
  } catch {
    // Local server offline or not ready — proceed to deterministic diagnosis
  }

  // Deterministic fallback rule-based diagnosis conforming strictly to < 900 chars
  const fallback = buildDeterministicDiagnosis(request);
  return {
    description: fallback,
    characterCount: fallback.length,
    isUnderLimit: fallback.length <= MAX_CHAR_LIMIT,
    generatedBy: 'deterministic_fallback',
  };
}

export function buildGemmaPrompt(request: GemmaDiagnosisRequest): string {
  return `<start_of_turn>user
You are an expert web scraping self-healing assistant.
The scraper for "${request.targetUrl}" broke due to a DOM change.
Failed fields: [${request.failedFields.join(', ')}].
Diagnostic summary: "${request.diffSummary}".
Expected schema fields: [${request.expectedFields.join(', ')}].

INSTRUCTION: Write exactly ONE plain-language sentence (under 800 characters) describing what fields are broken and what HTML elements or text values they should extract instead. Do not output markdown, lists, or multiple sentences.
<end_of_turn>
<start_of_turn>model
`;
}

export function sanitizeSentence(text: string): string {
  // Remove markdown quotes, multiple newlines, and truncate to first sentence if needed
  let cleaned = text.replace(/["`\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length > MAX_CHAR_LIMIT) {
    cleaned = cleaned.slice(0, MAX_CHAR_LIMIT - 3) + '...';
  }
  return cleaned;
}

export function buildDeterministicDiagnosis(request: GemmaDiagnosisRequest): string {
  const fields = request.failedFields.length > 0 ? request.failedFields.join(', ') : request.expectedFields.join(', ');
  const sentence = `The page layout redesigned, breaking extraction for [${fields}]; update selectors to locate the updated element hierarchy for ${fields} on ${request.targetUrl}.`;
  return sentence.slice(0, MAX_CHAR_LIMIT);
}
