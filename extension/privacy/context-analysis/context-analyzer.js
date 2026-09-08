// privacy/context-analysis/context-analyzer.js
// Context Analysis Layer: Filters weak/irrelevant Rampart NER detections before Fusion.
// Enforces deterministic precedence for structured PII and contextual evidence rules for address components.

const RAMPART_STRUCTURED_REJECTS = new Set([
  "EMAIL",
  "PHONE",
  "CARD",
  "URL",
  "TAX_ID",
  "BANK_ACCOUNT",
  "ROUTING_NUMBER",
  "GOVERNMENT_ID",
  "PASSPORT",
  "DRIVERS_LICENSE"
]);

const ADDRESS_TYPES = new Set([
  "BUILDING_NUMBER",
  "STREET_NAME",
  "SECONDARY_ADDRESS",
  "CITY",
  "STATE",
  "ZIP_CODE"
]);

const RAMPART_NAME_TYPES = new Set([
  "GIVEN_NAME",
  "SURNAME",
  "NAME"
]);

// Centralized engineering candidate admission thresholds for Rampart NER detections.
// Lower thresholds admit candidates into Context Analysis so contextual evidence can validate them.
const RAMPART_CANDIDATE_THRESHOLDS = Object.freeze({
  // Identity & Names: Permissive candidate threshold (admit into Context Analysis)
  GIVEN_NAME: 0.55,
  SURNAME: 0.55,
  NAME: 0.55,

  // Address Components: Stricter candidate thresholds to filter standalone noise
  BUILDING_NUMBER: 0.80,
  STREET_NAME: 0.80,
  SECONDARY_ADDRESS: 0.80,

  CITY: 0.75,
  STATE: 0.75,
  ZIP_CODE: 0.80
});

const DEFAULT_RAMPART_CANDIDATE_THRESHOLD = 0.80;

/**
 * Resolves the minimum candidate admission threshold for a Rampart entity type.
 *
 * @param {string} type - Rampart entity type string
 * @returns {number} Minimum confidence threshold
 */
function getRampartCandidateThreshold(type) {
  if (!type || typeof type !== "string") {
    return DEFAULT_RAMPART_CANDIDATE_THRESHOLD;
  }
  return RAMPART_CANDIDATE_THRESHOLDS[type] ?? DEFAULT_RAMPART_CANDIDATE_THRESHOLD;
}

/**
 * Derives coordinate scale factors from observation metadata.
 *
 * @param {Object} metadata
 * @returns {{ scaleX: number, scaleY: number, hasValidScale: boolean }}
 */
function getScale(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return { scaleX: 1, scaleY: 1, hasValidScale: false };
  }
  const vp = metadata.viewport;
  const canvas = metadata.canvas || metadata.screenshot;
  if (canvas?.width > 0 && vp?.width > 0) {
    return {
      scaleX: canvas.width / vp.width,
      scaleY: canvas.height / (vp.height || vp.width),
      hasValidScale: true
    };
  }
  const dpr = vp?.devicePixelRatio || metadata.devicePixelRatio;
  if (typeof dpr === "number" && dpr > 0) {
    return { scaleX: dpr, scaleY: dpr, hasValidScale: true };
  }
  return { scaleX: 1, scaleY: 1, hasValidScale: false };
}

/**
 * Normalizes bounding box into shared CSS viewport coordinates.
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
  if (!isOCR || !scaleInfo.hasValidScale || scaleInfo.scaleX <= 0 || scaleInfo.scaleY <= 0) {
    return {
      x: bbox.x,
      y: bbox.y,
      width: bbox.width || 0,
      height: bbox.height || 0
    };
  }
  return {
    x: bbox.x / scaleInfo.scaleX,
    y: bbox.y / scaleInfo.scaleY,
    width: (bbox.width || 0) / scaleInfo.scaleX,
    height: (bbox.height || 0) / scaleInfo.scaleY
  };
}

/**
 * Checks if two address detections are spatially or contextually proximate.
 *
 * @param {Object} itemA - { raw, normBBox, index }
 * @param {Object} itemB - { raw, normBBox, index }
 * @returns {boolean}
 */
function areAddressDetectionsNearby(itemA, itemB) {
  const bA = itemA.normBBox;
  const bB = itemB.normBBox;

  if (bA && bB) {
    const cAx = bA.x + bA.width / 2;
    const cAy = bA.y + bA.height / 2;
    const cBx = bB.x + bB.width / 2;
    const cBy = bB.y + bB.height / 2;
    const dist = Math.hypot(cAx - cBx, cAy - cBy);

    // Nearby center distance
    if (dist <= 180) {
      return true;
    }

    // Nearby line/reading order proximity (aligned within vertical line threshold)
    const dy = Math.abs(cAy - cBy);
    const dx = Math.abs(cAx - cBx);
    if (dy <= 50 && dx <= 250) {
      return true;
    }

    return false;
  }

  // Fallback if bboxes are missing: same contextSource and extraction sequence proximity
  if (
    itemA.raw.contextSource &&
    itemB.raw.contextSource &&
    itemA.raw.contextSource === itemB.raw.contextSource
  ) {
    return Math.abs(itemA.index - itemB.index) <= 2;
  }

  return false;
}

/**
 * Evaluates whether a cluster of nearby Rampart address detections possesses
 * sufficient contextual evidence to be accepted as real address PII.
 *
 * @param {Array<Object>} cluster - Array of { raw, normBBox, index }
 * @returns {boolean}
 */
function isValidAddressCluster(cluster) {
  if (!Array.isArray(cluster) || cluster.length < 2) {
    return false;
  }

  const types = new Set(cluster.map(item => item.raw.type));

  // Strongest V1 signal: BUILDING_NUMBER + STREET_NAME
  if (types.has("BUILDING_NUMBER") && types.has("STREET_NAME")) {
    return true;
  }

  // STREET_NAME + municipal / postal context
  if (
    types.has("STREET_NAME") &&
    (types.has("CITY") || types.has("STATE") || types.has("ZIP_CODE") || types.has("SECONDARY_ADDRESS"))
  ) {
    return true;
  }

  // BUILDING_NUMBER + municipal / postal context
  if (
    types.has("BUILDING_NUMBER") &&
    (types.has("CITY") || types.has("STATE") || types.has("ZIP_CODE"))
  ) {
    return true;
  }

  // Multiple municipal / postal corroborations
  if (
    (types.has("CITY") && types.has("STATE")) ||
    (types.has("CITY") && types.has("ZIP_CODE")) ||
    (types.has("STATE") && types.has("ZIP_CODE"))
  ) {
    return true;
  }

// 3 or more distinct address component types
  if (types.size >= 3) {
    return true;
  }

  return false;
}

/**
 * Resolves the region index for a DOM-origin detection.
 *
 * @param {Object} det
 * @returns {number|null}
 */
function getDetectionRegionIndex(det) {
  if (!det || typeof det !== "object") return null;
  if (typeof det.regionIndex === "number") return det.regionIndex;
  if (typeof det.reason === "string") {
    const match = /:reg(\d+)/.exec(det.reason);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Checks whether a Rampart semantic name candidate (GIVEN_NAME, SURNAME, NAME)
 * has sufficient contextual evidence to proceed to Fusion.
 *
 * An isolated single-token Rampart name with no form context and no corroborating
 * counterpart name is rejected as statistical NLP noise on web UI text.
 *
 * @param {Object} candidate - Rampart name detection
 * @param {Array<Object>} allNameCandidates - All Rampart name candidates
 * @returns {boolean}
 */
function isCorroboratedNameCandidate(candidate, allNameCandidates) {
  if (!candidate || typeof candidate !== "object") return false;

  // 1. Names associated with explicit form/input context are retained
  if (candidate.elementId) {
    return true;
  }
  if (typeof candidate.reason === "string") {
    const r = candidate.reason.toLowerCase();
    if (r.startsWith("input[") || r.startsWith("autocomplete") || r.includes("name-field") || r.includes("form")) {
      return true;
    }
  }

  // 2. Multi-token names (e.g. "John Smith", "Alice Walker") contain internal first/last corroboration
  const rawText = (candidate.text || "").trim();
  const tokens = rawText.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    return true;
  }

  // 3. Corroborating GIVEN_NAME / SURNAME in the same canonical DOM text region / context
  const regIdx = getDetectionRegionIndex(candidate);
  if (regIdx !== null) {
    for (const other of allNameCandidates) {
      if (other === candidate) continue;
      const otherRegIdx = getDetectionRegionIndex(other);
      if (otherRegIdx === null) continue;

      // Same canonical DOM text region or immediately adjacent reading-order sibling region
      if (Math.abs(regIdx - otherRegIdx) <= 1) {
        if (
          (candidate.type === "SURNAME" && (other.type === "GIVEN_NAME" || other.type === "NAME")) ||
          (candidate.type === "GIVEN_NAME" && (other.type === "SURNAME" || other.type === "NAME")) ||
          (candidate.type === "NAME" && (other.type === "GIVEN_NAME" || other.type === "SURNAME" || other.type === "NAME"))
        ) {
          return true;
        }
      }
    }
  }

  // 4. OCR line context: if another complementary name exists on OCR
  if (candidate.contextSource === "OCR") {
    for (const other of allNameCandidates) {
      if (other === candidate || other.contextSource !== "OCR") continue;
      if (
        (candidate.type === "SURNAME" && (other.type === "GIVEN_NAME" || other.type === "NAME")) ||
        (candidate.type === "GIVEN_NAME" && (other.type === "SURNAME" || other.type === "NAME"))
      ) {
        return true;
      }
    }
  }

  // Isolated single-token Rampart name without contextual corroboration
  return false;
}

class ContextAnalyzer {
  /**
   * Filters raw detections before Fusion.
   * Deterministic detections pass through unchanged.
   * Weak or redundant Rampart detections are rejected based on context rules.
   *
   * @param {Array<Object>} allRawDetections
   * @param {Object} [metadata={}] - Observation metadata (viewport, canvas, etc.)
   * @returns {{ contextFilteredDetections: Array<Object>, trace: Object }}
   */
  static filter(allRawDetections, metadata = {}) {
    if (!Array.isArray(allRawDetections) || allRawDetections.length === 0) {
      return {
        contextFilteredDetections: [],
        trace: {
          totalRaw: 0,
          rampartBefore: 0,
          rampartRejected: 0,
          rampartLowConfidence: 0,
          rampartCandidateThresholds: RAMPART_CANDIDATE_THRESHOLDS,
          passedToFusion: 0
        }
      };
    }

    try {
      const scaleInfo = getScale(metadata);
      const passed = [];
      const rampartNameCandidates = [];
      const rampartAddressCandidates = [];

      let rampartBeforeCount = 0;
      let rampartRejectedCount = 0;
      let rampartLowConfidenceCount = 0;

      // Step 1: Process raw detections and route based on source and entity category
      for (let i = 0; i < allRawDetections.length; i++) {
        const det = allRawDetections[i];
        if (!det || typeof det !== "object") continue;

        // Rule 1: Deterministic detections pass through untouched
        if (det.source !== "RAMPART") {
          passed.push(det);
          continue;
        }

        // Rampart detection tracking
        rampartBeforeCount++;

        // Rule 2: Reject Rampart structured PII handled by deterministic detectors
        if (RAMPART_STRUCTURED_REJECTS.has(det.type)) {
          rampartRejectedCount++;
          continue;
        }

        // Rule 3: Type-Specific Rampart Candidate Confidence Gate
        const threshold = getRampartCandidateThreshold(det.type);
        const rawConf = typeof det.confidence === "number" ? det.confidence : 0;
        const conf = rawConf > 1 ? rawConf / 100 : rawConf;

        if (conf < threshold) {
          rampartRejectedCount++;
          rampartLowConfidenceCount++;
          continue;
        }

        // Rule 4: Rampart semantic names require contextual corroboration
        if (RAMPART_NAME_TYPES.has(det.type)) {
          rampartNameCandidates.push(det);
          continue;
        }

        // Rule 5: Rampart address components require contextual validation
        if (ADDRESS_TYPES.has(det.type)) {
          rampartAddressCandidates.push({
            raw: det,
            normBBox: normalizeBBox(det.bbox, det.source, det.contextSource, scaleInfo),
            index: i
          });
          continue;
        }

        // Fallback for any other Rampart category
        passed.push(det);
      }

      // Step 2A: Contextual evaluation of Rampart semantic name candidates (Rule 4)
      if (rampartNameCandidates.length > 0) {
        for (const nameCandidate of rampartNameCandidates) {
          if (isCorroboratedNameCandidate(nameCandidate, rampartNameCandidates)) {
            passed.push(nameCandidate);
          } else {
            rampartRejectedCount++;
            console.log(
              `[ContextAnalyzer] Rejected isolated Rampart name candidate "${nameCandidate.type}" ` +
              `without corroborating name/form context (confidence: ${nameCandidate.confidence}).`
            );
          }
        }
      }

      // Step 2B: Contextual grouping and evaluation of Rampart address candidates (Rule 5)
      if (rampartAddressCandidates.length > 0) {
        const numCandidates = rampartAddressCandidates.length;
        const visited = new Uint8Array(numCandidates);

        for (let i = 0; i < numCandidates; i++) {
          if (visited[i]) continue;

          // Gather connected address component candidates via BFS
          const cluster = [];
          const queue = [i];
          visited[i] = 1;

          while (queue.length > 0) {
            const currIdx = queue.shift();
            cluster.push(rampartAddressCandidates[currIdx]);

            for (let j = 0; j < numCandidates; j++) {
              if (visited[j]) continue;
              if (areAddressDetectionsNearby(rampartAddressCandidates[currIdx], rampartAddressCandidates[j])) {
                visited[j] = 1;
                queue.push(j);
              }
            }
          }

          // Evaluate the cluster's address context
          if (isValidAddressCluster(cluster)) {
            for (const item of cluster) {
              passed.push(item.raw);
            }
          } else {
            // Insufficient address context (standalone BUILDING_NUMBER, STREET_NAME, etc.)
            rampartRejectedCount += cluster.length;
          }
        }
      }

      const trace = {
        totalRaw: allRawDetections.length,
        rampartBefore: rampartBeforeCount,
        rampartRejected: rampartRejectedCount,
        rampartLowConfidence: rampartLowConfidenceCount,
        rampartCandidateThresholds: RAMPART_CANDIDATE_THRESHOLDS,
        passedToFusion: passed.length
      };

      console.log(
        `[ContextAnalyzer] Filtered ${allRawDetections.length} raw detections: ` +
        `${rampartRejectedCount} Rampart detections rejected (${rampartLowConfidenceCount} below candidate thresholds), ` +
        `${passed.length} passed to Fusion.`
      );

      return {
        contextFilteredDetections: passed,
        trace
      };
    } catch (err) {
      console.warn("[ContextAnalyzer] Notice during context filtering, falling back to raw detections:", err);
      return {
        contextFilteredDetections: [...allRawDetections],
        trace: {
          totalRaw: allRawDetections.length,
          rampartBefore: 0,
          rampartRejected: 0,
          rampartLowConfidence: 0,
          rampartCandidateThresholds: RAMPART_CANDIDATE_THRESHOLDS,
          passedToFusion: allRawDetections.length
        }
      };
    }
  }
}

ContextAnalyzer.RAMPART_CANDIDATE_THRESHOLDS = RAMPART_CANDIDATE_THRESHOLDS;
ContextAnalyzer.DEFAULT_RAMPART_CANDIDATE_THRESHOLD = DEFAULT_RAMPART_CANDIDATE_THRESHOLD;
ContextAnalyzer.getCandidateThreshold = getRampartCandidateThreshold;

if (typeof self !== "undefined") {
  self.ContextAnalyzer = ContextAnalyzer;
  self.RAMPART_CANDIDATE_THRESHOLDS = RAMPART_CANDIDATE_THRESHOLDS;
  self.getRampartCandidateThreshold = getRampartCandidateThreshold;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ContextAnalyzer,
    RAMPART_CANDIDATE_THRESHOLDS,
    DEFAULT_RAMPART_CANDIDATE_THRESHOLD,
    getRampartCandidateThreshold
  };
}
