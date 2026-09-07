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

const RAMPART_SEMANTIC_MIN_CONFIDENCE = 0.80;

const RAMPART_SEMANTIC_TYPES = new Set([
  ...RAMPART_NAME_TYPES,
  ...ADDRESS_TYPES
]);

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
          rampartMinConfidenceThreshold: RAMPART_SEMANTIC_MIN_CONFIDENCE,
          passedToFusion: 0
        }
      };
    }

    try {
      const scaleInfo = getScale(metadata);
      const passed = [];
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

        // Rule 3: Rampart Confidence Gate: Semantic detections must have confidence >= 0.80
        if (RAMPART_SEMANTIC_TYPES.has(det.type)) {
          const rawConf = typeof det.confidence === "number" ? det.confidence : 0;
          const conf = rawConf > 1 ? rawConf / 100 : rawConf;
          if (conf < RAMPART_SEMANTIC_MIN_CONFIDENCE) {
            rampartRejectedCount++;
            rampartLowConfidenceCount++;
            continue;
          }
        }

        // Rule 4: Rampart semantic names pass through to Fusion
        if (RAMPART_NAME_TYPES.has(det.type)) {
          passed.push(det);
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

      // Step 2: Contextual grouping and evaluation of Rampart address candidates
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
        rampartMinConfidenceThreshold: RAMPART_SEMANTIC_MIN_CONFIDENCE,
        passedToFusion: passed.length
      };

      console.log(
        `[ContextAnalyzer] Filtered ${allRawDetections.length} raw detections: ` +
        `${rampartRejectedCount} Rampart detections rejected (${rampartLowConfidenceCount} low confidence < ${RAMPART_SEMANTIC_MIN_CONFIDENCE}), ` +
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
          rampartMinConfidenceThreshold: RAMPART_SEMANTIC_MIN_CONFIDENCE,
          passedToFusion: allRawDetections.length
        }
      };
    }
  }
}

if (typeof self !== "undefined") {
  self.ContextAnalyzer = ContextAnalyzer;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { ContextAnalyzer };
}
