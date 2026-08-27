import type { Damage, EvidenceMark } from "../types.js";

const IOU_MERGE_THRESHOLD = 0.25;

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Local safety net, run AFTER the main Gemini call — which is already explicitly instructed to
 * consolidate the same physical defect across views into one entry. This catches whatever slips through.
 *
 * Pass 1 — same image, same type, overlapping box (IoU): the rare case Gemini reports one spot twice
 * within a single photo.
 *
 * Pass 2 — same type + same (normalized, exact-match) part AND semanticLocation, regardless of source
 * image. semanticLocation is in the key because the inspection prompt explicitly tells the model that
 * two defects on the same part but in different places ARE distinct: keying on the part alone merged
 * them anyway, collapsing several real defects into one and suppressing the rubric's >=3 thresholds.
 * Bounding boxes are never IoU-compared ACROSS different images — they don't share a coordinate system.
 */
export function dedupeDamages(damages: Damage[]): Damage[] {
  const afterIou = mergeByIouWithinImage(damages);
  return mergeByTypeAndPart(afterIou);
}

function mergeByIouWithinImage(damages: Damage[]): Damage[] {
  const groups = new Map<string, Damage[]>();
  for (const d of damages) {
    const primaryImageId = d.evidence[0]?.imageId ?? `__no_evidence_${d.id}`;
    const key = `${primaryImageId}::${d.type}`;
    const group = groups.get(key);
    if (group) group.push(d);
    else groups.set(key, [d]);
  }

  const result: Damage[] = [];
  for (const group of groups.values()) {
    result.push(...mergeGroupByIou(group));
  }
  return result;
}

function mergeGroupByIou(group: Damage[]): Damage[] {
  if (group.length <= 1) return group;

  const parent = group.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      if (boxIou(group[i].evidence[0]?.mark, group[j].evidence[0]?.mark) >= IOU_MERGE_THRESHOLD) {
        union(i, j);
      }
    }
  }

  const clusters = new Map<number, Damage[]>();
  group.forEach((d, i) => {
    const root = find(i);
    const list = clusters.get(root) ?? [];
    list.push(d);
    clusters.set(root, list);
  });

  return [...clusters.values()].map((cluster) => (cluster.length === 1 ? cluster[0] : mergeGroup(cluster)));
}

function boxIou(a: EvidenceMark | undefined, b: EvidenceMark | undefined): number {
  if (!a || !b || a.kind !== "box" || b.kind !== "box") return 0;
  const aw = a.w ?? 0;
  const ah = a.h ?? 0;
  const bw = b.w ?? 0;
  const bh = b.h ?? 0;
  const ax1 = a.x + aw;
  const ay1 = a.y + ah;
  const bx1 = b.x + bw;
  const by1 = b.y + bh;

  const ix0 = Math.max(a.x, b.x);
  const iy0 = Math.max(a.y, b.y);
  const ix1 = Math.min(ax1, bx1);
  const iy1 = Math.min(ay1, by1);
  const interW = Math.max(0, ix1 - ix0);
  const interH = Math.max(0, iy1 - iy0);
  const interArea = interW * interH;
  if (interArea <= 0) return 0;

  const unionArea = aw * ah + bw * bh - interArea;
  return unionArea > 0 ? interArea / unionArea : 0;
}

function mergeByTypeAndPart(damages: Damage[]): Damage[] {
  const groups = new Map<string, Damage[]>();
  for (const d of damages) {
    const key = `${d.type}::${normalizeLabel(d.part)}::${normalizeLabel(d.semanticLocation)}`;
    const group = groups.get(key);
    if (group) group.push(d);
    else groups.set(key, [d]);
  }

  const merged: Damage[] = [];
  for (const group of groups.values()) {
    merged.push(group.length === 1 ? group[0] : mergeGroup(group));
  }
  return merged;
}

function mergeGroup(group: Damage[]): Damage {
  const bySeverityDesc: Record<string, number> = { S4: 4, S3: 3, S2: 2, S1: 1 };
  const primary = [...group].sort((a, b) => bySeverityDesc[b.severity] - bySeverityDesc[a.severity])[0];

  const seenImages = new Set<string>();
  const evidence = group
    .flatMap((d) => d.evidence)
    .filter((e) => {
      const key = `${e.imageId}:${e.mark.x.toFixed(3)}:${e.mark.y.toFixed(3)}`;
      if (seenImages.has(key)) return false;
      seenImages.add(key);
      return true;
    });

  return {
    ...primary,
    confidence: Math.round(group.reduce((sum, d) => sum + d.confidence, 0) / group.length),
    evidence,
  };
}
