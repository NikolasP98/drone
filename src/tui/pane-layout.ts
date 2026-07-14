const DEFAULT_MINIMUM_PAIR_SHARE = 0.15;
const DEFAULT_MINIMUM_TOTAL_SHARE = 0.12;

export function resizePaneBoundary(
  weights: readonly number[],
  boundaryIndex: number,
  pointerFraction: number,
  minimumPairShare = DEFAULT_MINIMUM_PAIR_SHARE,
): number[] {
  if (
    boundaryIndex < 0 ||
    boundaryIndex >= weights.length - 1 ||
    !Number.isFinite(pointerFraction)
  ) {
    return [...weights];
  }
  const normalized = weights.map((weight) =>
    Number.isFinite(weight) && weight > 0 ? weight : 1,
  );
  const total = normalized.reduce((sum, weight) => sum + weight, 0);
  const before = normalized
    .slice(0, boundaryIndex)
    .reduce((sum, weight) => sum + weight, 0);
  const pairTotal = normalized[boundaryIndex]! + normalized[boundaryIndex + 1]!;
  const pairShare = Math.max(0.05, Math.min(0.45, minimumPairShare));
  const minimum = Math.min(
    pairTotal / 2,
    Math.max(pairTotal * pairShare, total * DEFAULT_MINIMUM_TOTAL_SHARE),
  );
  const desiredLeft = pointerFraction * total - before;
  const left = Math.max(minimum, Math.min(pairTotal - minimum, desiredLeft));
  normalized[boundaryIndex] = left;
  normalized[boundaryIndex + 1] = pairTotal - left;
  return normalized;
}

export function visiblePaneCapacity(
  viewportWidth: number,
  agentShare: number,
  maximum = 4,
  minimumColumns = 20,
): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 1;
  const boundedShare = Math.max(0, Math.min(1, agentShare));
  const columns = Math.floor(viewportWidth * boundedShare);
  return Math.max(1, Math.min(maximum, Math.floor(columns / minimumColumns) || 1));
}

export function clampDroneSplit(pointerX: number, viewportWidth: number): number {
  if (!Number.isFinite(pointerX) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0.5;
  }
  return Math.max(0.25, Math.min(0.75, pointerX / viewportWidth));
}
