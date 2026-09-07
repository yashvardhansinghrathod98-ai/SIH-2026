// privacy/confidence-fusion/fusion-engine.js
// Confidence Fusion Layer: Ingests raw PII detections from across observation branches,
// performs coordinate normalization, deduplication, and evidence aggregation,
// and produces canonical PII detections with preserved provenance.

const SOURCE_PRIORITY = {
  DOM: 5,
  DOM_TEXT: 4,
  OCR: 3,
  RAMPART_DOM: 2,
  RAMPART_OCR: 1,
  UNKNOWN: 0
};

function getSourceKey(det) {
  if (!det) return "UNKNOWN";
  if (det.source === "DOM") return "DOM";
  if (det.source === "DOM_TEXT") return "DOM_TEXT";
  if (det.source === "OCR") return "OCR";
  if (det.source === "RAMPART") {
    return det.contextSource === "DOM" ? "RAMPART_DOM" : "RAMPART_OCR";
  }
  return "UNKNOWN";
}

function getSourcePriority(det) {
  const key = getSourceKey(det);
  return SOURCE_PRIORITY[key] || 0;
}

/**
 * Normalizes text representation for comparison only.
 * Preserves structured values (email, phone, cards) and collapses whitespace for general text.
 * Never used to overwrite canonical displayed text.
 *
 * @param {string|null} text
 * @param {string} type - PIIType
 * @returns {string}
 */
function normalizeText(text, type) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (!trimmed) return "";

  if (type === "EMAIL") {
    return trimmed.toLowerCase().replace(/\s+/g, "");
  }

  if (type === "PHONE") {
    return trimmed.replace(/\D/g, "");
  }

  if (
    type === "CARD" ||
    type === "ZIP_CODE" ||
    type === "TAX_ID" ||
    type === "BANK_ACCOUNT" ||
    type === "ROUTING_NUMBER"
  ) {
    return trimmed.toLowerCase().replace(/[\s\-_]/g, "");
  }

  return trimmed.toLowerCase().replace(/\s+/g, " ");
}

/**
 * Lightweight two-row Levenshtein similarity metric (0.0 to 1.0).
 *
 * @param {string} s1
 * @param {string} s2
 * @returns {number}
 */
function computeLevenshteinSimilarity(s1, s2) {
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;
  const len1 = s1.length;
  const len2 = s2.length;
  const maxLen = Math.max(len1, len2);
  if (maxLen === 0) return 1.0;

  let prev = new Array(len2 + 1);
  let curr = new Array(len2 + 1);
  for (let j = 0; j <= len2; j++) prev[j] = j;

  for (let i = 1; i <= len1; i++) {
    curr[0] = i;
    const c1 = s1.charCodeAt(i - 1);
    for (let j = 1; j <= len2; j++) {
      const cost = c1 === s2.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const temp = prev;
    prev = curr;
    curr = temp;
  }
  return Math.max(0, 1.0 - prev[len2] / maxLen);
}

/**
 * Conservative similarity check for non-structured text (e.g. names, addresses).
 * Structured PII types (EMAIL, PHONE, etc.) are never fuzzy matched.
 *
 * @param {string} t1
 * @param {string} t2
 * @param {string} type
 * @returns {boolean}
 */
function areSimilarTexts(t1, t2, type) {
  if (!t1 || !t2) return false;
  if (t1 === t2) return true;

  const strictTypes = [
    "EMAIL",
    "PHONE",
    "CARD",
    "ZIP_CODE",
    "URL",
    "TAX_ID",
    "BANK_ACCOUNT",
    "ROUTING_NUMBER",
    "GOVERNMENT_ID",
    "PASSPORT",
    "DRIVERS_LICENSE"
  ];
  if (strictTypes.includes(type)) {
    return false;
  }

  // Strict similarity threshold for names and addresses
  const sim = computeLevenshteinSimilarity(t1, t2);
  if (sim >= 0.85) return true;

  // Token overlap for multi-word phrases
  const w1 = t1.split(" ").filter(Boolean);
  const w2 = t2.split(" ").filter(Boolean);
  if (w1.length > 1 && w2.length > 1) {
    const common = w1.filter(w => w2.includes(w));
    const tokenSim = (2 * common.length) / (w1.length + w2.length);
    if (tokenSim >= 0.8) return true;
  }

  return false;
}

/**
 * Derives coordinate scale factors from observation metadata.
 * Bridges OCR canvas pixels and DOM CSS viewport pixels.
 *
 * @param {Object} metadata
 * @returns {{ scaleX: number, scaleY: number, hasValidScale: boolean }}
 */
function getCoordinateScale(metadata) {
  let scaleX = 1;
  let scaleY = 1;
  let hasValidScale = false;

  if (!metadata || typeof metadata !== "object") {
    return { scaleX: 1, scaleY: 1, hasValidScale: false };
  }

  const vp = metadata.viewport;
  const canvas = metadata.canvas || metadata.screenshot;

  if (
    canvas &&
    typeof canvas.width === "number" &&
    canvas.width > 0 &&
    vp &&
    typeof vp.width === "number" &&
    vp.width > 0
  ) {
    scaleX = canvas.width / vp.width;
    scaleY = canvas.height / (vp.height || vp.width);
    hasValidScale = true;
  } else if (typeof vp?.devicePixelRatio === "number" && vp.devicePixelRatio > 0) {
    scaleX = vp.devicePixelRatio;
    scaleY = vp.devicePixelRatio;
    hasValidScale = true;
  } else if (typeof metadata.devicePixelRatio === "number" && metadata.devicePixelRatio > 0) {
    scaleX = metadata.devicePixelRatio;
    scaleY = metadata.devicePixelRatio;
    hasValidScale = true;
  }

  return { scaleX, scaleY, hasValidScale };
}

/**
 * Normalizes bounding box into the shared DOM CSS viewport coordinate space.
 *
 * @param {Object|null} bbox
 * @param {string} source
 * @param {string|null} contextSource
 * @param {{ scaleX: number, scaleY: number, hasValidScale: boolean }} scaleInfo
 * @returns {Object|null}
 */
function normalizeBBox(bbox, source, contextSource, scaleInfo) {
  if (!bbox || typeof bbox.x !== "number" || typeof bbox.y !== "number") {
    return null;
  }

  const isOCR = source === "OCR" || contextSource === "OCR";
  if (!isOCR) {
    return {
      x: bbox.x,
      y: bbox.y,
      width: bbox.width || 0,
      height: bbox.height || 0
    };
  }

  const { scaleX, scaleY, hasValidScale } = scaleInfo;
  if (!hasValidScale || scaleX <= 0 || scaleY <= 0) {
    return {
      x: bbox.x,
      y: bbox.y,
      width: bbox.width || 0,
      height: bbox.height || 0
    };
  }

  return {
    x: bbox.x / scaleX,
    y: bbox.y / scaleY,
    width: (bbox.width || 0) / scaleX,
    height: (bbox.height || 0) / scaleY
  };
}

/**
 * Calculates Intersection-over-Union (IoU) between two bounding boxes.
 *
 * @param {Object|null} b1
 * @param {Object|null} b2
 * @returns {number}
 */
function calculateIoU(b1, b2) {
  if (!b1 || !b2) return 0;
  const x1 = Math.max(b1.x, b2.x);
  const y1 = Math.max(b1.y, b2.y);
  const x2 = Math.min(b1.x + b1.width, b2.x + b2.width);
  const y2 = Math.min(b1.y + b1.height, b2.y + b2.height);

  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  const inter = w * h;
  if (inter <= 0) return 0;

  const area1 = b1.width * b1.height;
  const area2 = b2.width * b2.height;
  const union = area1 + area2 - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Calculates Euclidean distance between bounding box centers.
 *
 * @param {Object|null} b1
 * @param {Object|null} b2
 * @returns {number}
 */
function calculateCenterDistance(b1, b2) {
  if (!b1 || !b2) return Infinity;
  const c1x = b1.x + b1.width / 2;
  const c1y = b1.y + b1.height / 2;
  const c2x = b2.x + b2.width / 2;
  const c2y = b2.y + b2.height / 2;
  return Math.hypot(c1x - c2x, c1y - c2y);
}

/**
 * Privacy-first candidate matching logic.
 * Categorizes matches into "EXACT" (deterministic/exact normalized text/structural),
 * "FUZZY" (approximate similarity requiring spatial proximity), or null (no match).
 *
 * @param {Object} itemA - { raw, normText, normBBox }
 * @param {Object} itemB - { raw, normText, normBBox }
 * @returns {"EXACT"|"FUZZY"|null}
 */
function getMatchKind(itemA, itemB) {
  const detA = itemA.raw;
  const detB = itemB.raw;

  // 1. Strict PII Type compatibility (Privacy-First: Never merge across types)
  if (!detA.type || !detB.type || detA.type !== detB.type) {
    return null;
  }

  // 2. Explicit element ID match
  if (detA.elementId && detB.elementId && detA.elementId === detB.elementId) {
    return "EXACT";
  }

  // 3. DOM Structural detections (text is null, e.g. input element)
  const isAStruct = detA.source === "DOM" && detA.text === null;
  const isBStruct = detB.source === "DOM" && detB.text === null;

  if (isAStruct || isBStruct) {
    const structDet = isAStruct ? detA : detB;
    const otherDet = isAStruct ? detB : detA;
    const structNorm = isAStruct ? itemA : itemB;
    const otherNorm = isAStruct ? itemB : itemA;

    if (structDet.elementId && otherDet.elementId && structDet.elementId === otherDet.elementId) {
      return "EXACT";
    }

    if (structNorm.normBBox && otherNorm.normBBox) {
      const iou = calculateIoU(structNorm.normBBox, otherNorm.normBBox);
      if (iou > 0.2) return "EXACT";

      // Containment check
      const bS = structNorm.normBBox;
      const bO = otherNorm.normBBox;
      const xOverlap = Math.max(0, Math.min(bS.x + bS.width, bO.x + bO.width) - Math.max(bS.x, bO.x));
      const yOverlap = Math.max(0, Math.min(bS.y + bS.height, bO.y + bO.height) - Math.max(bS.y, bO.y));
      const overlapArea = xOverlap * yOverlap;
      const minArea = Math.min(bS.width * bS.height, bO.width * bO.height);
      if (minArea > 0 && overlapArea / minArea > 0.5) {
        return "EXACT";
      }
    }
    return null;
  }

  // 4. Text-bearing detections
  const tA = itemA.normText;
  const tB = itemB.normText;
  if (!tA || !tB) {
    return null;
  }

  // Exact normalized text match (Strongest case)
  if (tA === tB) {
    // If from the SAME source branch:
    if (detA.source === detB.source) {
      if (itemA.normBBox && itemB.normBBox) {
        const iou = calculateIoU(itemA.normBBox, itemB.normBBox);
        const dist = calculateCenterDistance(itemA.normBBox, itemB.normBBox);
        // Overlap or close proximity indicates duplicate extraction of same node
        if (iou > 0.3 || dist < 35) return "EXACT";
        // Distinct physical locations on page -> do not merge
        return null;
      }
      return null;
    }

    // From DIFFERENT source branches (e.g. DOM_TEXT + OCR, or DOM_TEXT + RAMPART):
    if (itemA.normBBox && itemB.normBBox) {
      const iou = calculateIoU(itemA.normBBox, itemB.normBBox);
      const dist = calculateCenterDistance(itemA.normBBox, itemB.normBBox);
      // Reasonable proximity or overlap across branches
      if (iou > 0 || dist < 200) {
        return "EXACT";
      }
      return null;
    }

    // If bounding box is missing on either, exact match across different branches is accepted
    return "EXACT";
  }

  // 5. Fuzzy text match with spatial proximity
  if (areSimilarTexts(tA, tB, detA.type)) {
    if (itemA.normBBox && itemB.normBBox) {
      const iou = calculateIoU(itemA.normBBox, itemB.normBBox);
      const dist = calculateCenterDistance(itemA.normBBox, itemB.normBBox);
      if (iou > 0.2 || dist < 80) {
        return "FUZZY";
      }
    }
  }

  return null;
}

/**
 * Lightweight cluster consistency check for fuzzy match candidate unions.
 * Avoids transitive over-merging (e.g. A ~ B and B ~ C leading to A ~ C when A and C are incompatible).
 *
 * @param {Array<Object>} clusterA
 * @param {Array<Object>} clusterB
 * @returns {boolean}
 */
function isClusterConsistent(clusterA, clusterB) {
  for (const itemA of clusterA) {
    for (const itemB of clusterB) {
      // Text compatibility check between all cross-cluster member pairs
      if (itemA.normText && itemB.normText) {
        if (itemA.normText !== itemB.normText) {
          const sim = computeLevenshteinSimilarity(itemA.normText, itemB.normText);
          if (sim < 0.75) {
            return false;
          }
        }
      }

      // Spatial compatibility check
      if (itemA.normBBox && itemB.normBBox) {
        const iou = calculateIoU(itemA.normBBox, itemB.normBBox);
        const dist = calculateCenterDistance(itemA.normBBox, itemB.normBBox);
        if (iou <= 0 && dist > 100) {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * Evaluates candidate text quality for canonical selection.
 * Prefers:
 * 1. Exact/high-quality deterministic regex text
 * 2. Structurally grounded DOM text
 * 3. High-confidence Rampart text
 * 4. OCR text, especially when OCR quality is imperfect
 *
 * For structured PII (EMAIL, PHONE, CARD), prefers exact and syntactically valid values.
 *
 * @param {Object} item - Detection object
 * @param {string} type - PIIType
 * @returns {number} Text quality score
 */
function evaluateTextQuality(item, type) {
  if (!item || typeof item.text !== "string") return -Infinity;
  const text = item.text.trim();
  if (!text) return -Infinity;

  let score = 0;

  // 1. Source and Grounding Precedence
  if (item.source === "DOM_TEXT") {
    score += 100; // Deterministic regex on clean DOM text
  } else if (item.source === "RAMPART" && item.contextSource === "DOM") {
    score += 80;  // Clean DOM text ground with ML NER
  } else if (item.source === "OCR") {
    score += 60;  // Deterministic regex, but text comes from OCR image scanning
  } else if (item.source === "RAMPART" && item.contextSource === "OCR") {
    score += 40;  // ML NER on OCR image text
  } else {
    score += 20;
  }

  // 2. OCR Quality penalty / bonus (respects OCR uncertainty)
  if (typeof item.ocrConfidence === "number") {
    if (item.ocrConfidence < 0.50) {
      score -= 30; // Highly uncertain OCR
    } else if (item.ocrConfidence < 0.70) {
      score -= 15;
    } else if (item.ocrConfidence >= 0.90) {
      score += 10;
    }
  }

  // 3. Syntactic validity for structured PII
  if (type === "EMAIL") {
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    if (emailRegex.test(text)) {
      score += 50; // Syntactically valid email
    } else {
      score -= 30; // Malformed email (OCR corrupted domain/characters)
    }
    if (/\s/.test(text)) {
      score -= 20; // Contains internal whitespace / OCR spacing artifacts
    }
  } else if (type === "PHONE") {
    const digits = text.replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 15) {
      score += 40; // Valid phone digit count
    } else {
      score -= 20;
    }
    if (/[a-zA-Z]/.test(text)) {
      score -= 40; // Letters in phone string (OCR corruption)
    }
  } else if (type === "CARD") {
    const digits = text.replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19) {
      score += 40;
    }
    if (/[^\d\s\-]/.test(text)) {
      score -= 30;
    }
  } else if (type === "ZIP_CODE") {
    const clean = text.replace(/[\s\-]/g, "");
    if (/^\d{5}(\d{4})?$/.test(clean) || /^[A-Z0-9]{3,10}$/i.test(clean)) {
      score += 30;
    }
  }

  // 4. Detection confidence weighting
  const conf = typeof item.confidence === "number" ? item.confidence : 0.5;
  score += conf * 15;

  // 5. Cleanliness penalty for control / unprintable characters
  if (/[\x00-\x1F\x7F]/.test(text)) {
    score -= 25;
  }

  return score;
}

/**
 * Disjoint Set Union (DSU) for entity clustering.
 */
class DisjointSet {
  constructor(size) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }

  find(i) {
    let root = i;
    while (root !== this.parent[root]) {
      root = this.parent[root];
    }
    let curr = i;
    while (curr !== root) {
      const next = this.parent[curr];
      this.parent[curr] = root;
      curr = next;
    }
    return root;
  }

  union(i, j) {
    const rootI = this.find(i);
    const rootJ = this.find(j);
    if (rootI !== rootJ) {
      this.parent[rootI] = rootJ;
      return true;
    }
    return false;
  }
}

/**
 * Conservative bounded confidence combination.
 * Strongest confidence remains dominant; additional independent agreeing sources provide diminishing boost.
 * Duplicates from the same source category do not inflate confidence.
 *
 * @param {Array<Object>} cluster
 * @returns {number}
 */
function computeFusedConfidence(cluster) {
  if (cluster.length === 0) return 0.0;
  if (cluster.length === 1) return cluster[0].confidence;

  let maxConf = 0;
  let primaryItem = cluster[0];
  for (const item of cluster) {
    const c = typeof item.confidence === "number" ? item.confidence : 0.5;
    if (c > maxConf) {
      maxConf = c;
      primaryItem = item;
    }
  }

  const primaryCategory = getSourceKey(primaryItem);
  const categories = new Map();

  for (const item of cluster) {
    const cat = getSourceKey(item);
    if (cat === primaryCategory) continue;
    const c = typeof item.confidence === "number" ? item.confidence : 0.5;
    const existing = categories.get(cat) || 0;
    if (c > existing) {
      categories.set(cat, c);
    }
  }

  let currConf = maxConf;
  for (const [, bestCatConf] of categories) {
    const headroom = 1.0 - currConf;
    const boost = headroom * (0.15 * bestCatConf);
    currConf += boost;
  }

  return Math.min(1.0, Math.round(currConf * 1000) / 1000);
}

/**
 * Constructs a canonical PII detection from a cluster of matched raw detections.
 * Preserves evidence and provenance.
 *
 * @param {Array<Object>} cluster
 * @param {Array<Object>} normItems
 * @returns {Object}
 */
function buildCanonicalDetection(cluster, normItems) {
  if (cluster.length === 1) {
    const det = cluster[0];
    const norm = normItems[0];
    return {
      type: det.type,
      text: det.text,
      confidence: det.confidence,
      bbox: det.bbox ? { ...det.bbox } : (norm.normBBox ? { ...norm.normBBox } : null),
      source: det.source,
      sources: [det.source],
      evidence: [
        {
          source: det.source,
          confidence: det.confidence,
          text: det.text,
          bbox: det.bbox || null,
          ...(det.elementId ? { elementId: det.elementId } : {}),
          ...(det.reason ? { reason: det.reason } : {}),
          ...(det.contextSource ? { contextSource: det.contextSource } : {}),
          ...(typeof det.ocrConfidence === "number" ? { ocrConfidence: det.ocrConfidence } : {}),
          ...(typeof det.start === "number" ? { start: det.start } : {}),
          ...(typeof det.end === "number" ? { end: det.end } : {})
        }
      ],
      elementId: det.elementId || null,
      reason: det.reason || null,
      ...(det.contextSource ? { contextSource: det.contextSource } : {}),
      ...(typeof det.ocrConfidence === "number" ? { ocrConfidence: det.ocrConfidence } : {}),
      ...(typeof det.start === "number" ? { start: det.start } : {}),
      ...(typeof det.end === "number" ? { end: det.end } : {})
    };
  }

  // Sort cluster by source reliability descending, then confidence descending
  const sorted = [...cluster].sort((a, b) => {
    const pDiff = getSourcePriority(b) - getSourcePriority(a);
    if (pDiff !== 0) return pDiff;
    return (b.confidence || 0) - (a.confidence || 0);
  });

  const primary = sorted[0];

  // Canonical text selection: evaluate text quality across all cluster candidates
  let canonicalText = null;
  let bestTextScore = -Infinity;
  for (const item of cluster) {
    const score = evaluateTextQuality(item, primary.type);
    if (score > bestTextScore) {
      bestTextScore = score;
      canonicalText = item.text.trim();
    }
  }

  // Canonical bbox: prioritize DOM/DOM_TEXT bboxes (already in viewport CSS pixels)
  let canonicalBBox = null;
  for (const item of sorted) {
    if (item.bbox && typeof item.bbox.x === "number") {
      const idx = cluster.indexOf(item);
      const norm = normItems[idx];
      canonicalBBox = norm?.normBBox ? { ...norm.normBBox } : { ...item.bbox };
      break;
    }
  }

  // Canonical elementId
  let canonicalElementId = null;
  for (const item of sorted) {
    if (item.elementId) {
      canonicalElementId = item.elementId;
      break;
    }
  }

  // Canonical reason
  const canonicalReason = primary.reason || null;

  // Canonical ocrConfidence (if present in any evidence)
  let bestOcrConf = null;
  for (const item of sorted) {
    if (typeof item.ocrConfidence === "number") {
      if (bestOcrConf === null || item.ocrConfidence > bestOcrConf) {
        bestOcrConf = item.ocrConfidence;
      }
    }
  }

  // Canonical contextSource (if present in any evidence)
  let canonicalContextSource = primary.contextSource || null;
  if (!canonicalContextSource) {
    for (const item of sorted) {
      if (item.contextSource) {
        canonicalContextSource = item.contextSource;
        break;
      }
    }
  }

  // Unique sources list in order of appearance
  const sourcesSet = new Set();
  for (const item of sorted) {
    sourcesSet.add(item.source);
  }

  // Complete evidence array preserving provenance
  const evidence = cluster.map(d => ({
    source: d.source,
    confidence: d.confidence,
    text: d.text,
    bbox: d.bbox || null,
    ...(d.elementId ? { elementId: d.elementId } : {}),
    ...(d.reason ? { reason: d.reason } : {}),
    ...(d.contextSource ? { contextSource: d.contextSource } : {}),
    ...(typeof d.ocrConfidence === "number" ? { ocrConfidence: d.ocrConfidence } : {}),
    ...(typeof d.start === "number" ? { start: d.start } : {}),
    ...(typeof d.end === "number" ? { end: d.end } : {})
  }));

  const fusedConfidence = computeFusedConfidence(cluster);

  return {
    type: primary.type,
    text: canonicalText,
    confidence: fusedConfidence,
    bbox: canonicalBBox,
    source: "FUSED",
    sources: Array.from(sourcesSet),
    evidence: evidence,
    elementId: canonicalElementId,
    reason: canonicalReason,
    ...(canonicalContextSource ? { contextSource: canonicalContextSource } : {}),
    ...(bestOcrConf !== null ? { ocrConfidence: bestOcrConf } : {})
  };
}

class FusionEngine {
  /**
   * Ingests all raw PII detections from across observation branches,
   * performs coordinate normalization, deduplication, and evidence aggregation,
   * and returns canonical PII detections.
   *
   * @param {Array<Object>} allRawDetections
   * @param {Object} [metadata={}] - Page/observation metadata for coordinate normalization
   * @returns {{ fusedDetections: Array<Object>, trace: Object }}
   */
  static fuse(allRawDetections, metadata = {}) {
    if (!Array.isArray(allRawDetections) || allRawDetections.length === 0) {
      return {
        fusedDetections: [],
        trace: {
          rawDetectionCount: 0,
          fusedDetectionCount: 0,
          mergedGroupCount: 0
        }
      };
    }

    try {
      const scaleInfo = getCoordinateScale(metadata);

      // Pre-compute normalized representations for fast, safe matching
      const validItems = [];
      for (let i = 0; i < allRawDetections.length; i++) {
        const raw = allRawDetections[i];
        if (!raw || typeof raw !== "object") continue;

        validItems.push({
          raw: raw,
          index: validItems.length,
          normText: normalizeText(raw.text, raw.type),
          normBBox: normalizeBBox(raw.bbox, raw.source, raw.contextSource, scaleInfo)
        });
      }

      const N = validItems.length;
      if (N === 0) {
        return {
          fusedDetections: [],
          trace: { rawDetectionCount: 0, fusedDetectionCount: 0, mergedGroupCount: 0 }
        };
      }

      const dsu = new DisjointSet(N);

      // Phase 1: Exact matches safely form connected components
      const pendingFuzzyMatches = [];
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const matchKind = getMatchKind(validItems[i], validItems[j]);
          if (matchKind === "EXACT") {
            dsu.union(i, j);
          } else if (matchKind === "FUZZY") {
            pendingFuzzyMatches.push({ i, j });
          }
        }
      }

      // Phase 2: Fuzzy matches with cluster-consistency check to prevent transitive drift (A ~ B ~ C)
      if (pendingFuzzyMatches.length > 0) {
        for (const { i, j } of pendingFuzzyMatches) {
          const rootI = dsu.find(i);
          const rootJ = dsu.find(j);
          if (rootI !== rootJ) {
            const clusterI = [];
            const clusterJ = [];
            for (let k = 0; k < N; k++) {
              const rootK = dsu.find(k);
              if (rootK === rootI) clusterI.push(validItems[k]);
              else if (rootK === rootJ) clusterJ.push(validItems[k]);
            }
            if (isClusterConsistent(clusterI, clusterJ)) {
              dsu.union(rootI, rootJ);
            }
          }
        }
      }

      // Group items by cluster root
      const clusters = new Map();
      for (let i = 0; i < N; i++) {
        const root = dsu.find(i);
        if (!clusters.has(root)) {
          clusters.set(root, []);
        }
        clusters.get(root).push(validItems[i]);
      }

      let mergedGroupCount = 0;
      const fusedDetections = [];

      for (const [, clusterItems] of clusters) {
        if (clusterItems.length > 1) {
          mergedGroupCount++;
        }
        const clusterRaw = clusterItems.map(item => item.raw);
        const canonical = buildCanonicalDetection(clusterRaw, clusterItems);
        fusedDetections.push(canonical);
      }

      console.log(
        `[FusionEngine] Fused ${N} raw detections into ${fusedDetections.length} canonical detections (${mergedGroupCount} merged groups).`
      );

      return {
        fusedDetections: fusedDetections,
        trace: {
          rawDetectionCount: N,
          fusedDetectionCount: fusedDetections.length,
          mergedGroupCount: mergedGroupCount
        }
      };
    } catch (err) {
      console.warn("[FusionEngine] Fusion error, falling back to raw detections:", err);
      return {
        fusedDetections: [...allRawDetections],
        trace: {
          rawDetectionCount: allRawDetections.length,
          fusedDetectionCount: allRawDetections.length,
          mergedGroupCount: 0
        }
      };
    }
  }
}

if (typeof self !== "undefined") {
  self.FusionEngine = FusionEngine;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { FusionEngine };
}
