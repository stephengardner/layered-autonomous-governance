// scripts/lib/auditor.mjs
const RANK = { none: 0, docs: 1, tooling: 2, framework: 3, 'l3-canon-proposal': 4 };

export function classifyDiffBlastRadius(files) {
  if (!Array.isArray(files) || files.length === 0) return 'none';
  let max = 0;
  for (const f of files) {
    if (f.startsWith('scripts/bootstrap-') && f.endsWith('-canon.mjs')) {
      max = Math.max(max, RANK['l3-canon-proposal']);
    } else if (f.startsWith('src/')) {
      max = Math.max(max, RANK['framework']);
    } else if (f.startsWith('scripts/') || f === 'package.json' || f === 'package-lock.json' || f.endsWith('.yml') || f.endsWith('.yaml') || f.endsWith('.json')) {
      max = Math.max(max, RANK['tooling']);
    } else if (f.startsWith('docs/') || f.endsWith('.md')) {
      max = Math.max(max, RANK['docs']);
    } else {
      max = Math.max(max, RANK['tooling']);
    }
  }
  return Object.entries(RANK).find(([, r]) => r === max)?.[0] ?? 'none';
}

export function computeVerdict({ diffRadius, envelopeMax }) {
  if (RANK[diffRadius] <= RANK[envelopeMax]) {
    return { verdict: 'pass', reason: 'within envelope' };
  }
  return {
    verdict: 'fail',
    reason: `diff radius ${diffRadius} exceeds envelope ${envelopeMax}`,
  };
}
