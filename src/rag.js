// Parse the RAG evaluation Markdown table into structured results.
// Robust against header wording: any table row whose 3rd cell is numeric is used.
export function parseRagMarkdown(md) {
  const results = [];
  for (const line of String(md || '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim()).slice(1, -1);
    if (cells.length < 3) continue;

    const rank = cells[0];
    if (!/^\d+$/.test(rank)) continue; // skip header / separator rows

    const score = parseFloat(cells[2]);
    if (!Number.isFinite(score)) continue;

    results.push({
      rank,
      caseId: cells[1] || '',
      score,
      status: score >= 0.8 ? 'pass' : score >= 0.5 ? 'mid' : 'fail',
    });
  }
  const max = results.reduce((m, r) => Math.max(m, r.score), 0);
  return { results, max, topK: results.length, testCases: results.length };
}
