const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434';
const MODEL = 'nomic-embed-text';

export async function generateEmbedding(text: string): Promise<number[]> {
  const input = (text || '').trim();
  if (!input) {
    throw new Error('Cannot generate embedding for empty text');
  }

  let response: Response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input })
    });
  } catch (err: any) {
    throw new Error(`Ollama unavailable at ${OLLAMA_URL}: ${err?.message || 'request failed'}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama embed failed (${response.status}): ${body || response.statusText}`);
  }

  const data = await response.json();
  const embedding = Array.isArray(data?.embeddings) ? data.embeddings[0] : data?.embedding;

  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Invalid embedding response from Ollama');
  }

  return embedding.map((v: any) => Number(v));
}
