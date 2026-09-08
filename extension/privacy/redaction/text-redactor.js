// privacy/redaction/text-redactor.js
// Text Redactor: Produces sanitized DOM text representations from fused canonical PII detections.
// Enforces source-region provenance mapping: Rampart DOM, DOM_TEXT, OCR regex, and Rampart OCR.
// Offsets are strictly scoped to their originating context and NEVER applied to page-wide concatenated strings.

const REDACTION_PLACEHOLDERS = Object.freeze({
  GIVEN_NAME: "[PERSON]",
  SURNAME: "[PERSON]",
  NAME: "[PERSON]",
  EMAIL: "[EMAIL]",
  PHONE: "[PHONE]",
  CARD: "[CARD]",
  BUILDING_NUMBER: "[ADDRESS]",
  STREET_NAME: "[ADDRESS]",
  SECONDARY_ADDRESS: "[ADDRESS]",
  CITY: "[ADDRESS]",
  STATE: "[ADDRESS]",
  ZIP_CODE: "[ADDRESS]",
  URL: "[URL]",
  PASSWORD: "[PASSWORD]"
});

const DEFAULT_PLACEHOLDER = "[REDACTED]";

/**
 * Resolves a semantic placeholder for a given PII entity type.
 *
 * @param {string} type - PII entity type string
 * @returns {string} Semantic placeholder (e.g. "[PERSON]", "[EMAIL]")
 */
function getPlaceholder(type) {
  if (!type || typeof type !== "string") {
    return DEFAULT_PLACEHOLDER;
  }
  return REDACTION_PLACEHOLDERS[type.toUpperCase()] || DEFAULT_PLACEHOLDER;
}

/**
 * Checks if two bounding boxes intersect or touch within an allowed tolerance.
 * Both bboxes must be in the same coordinate space (viewport CSS pixels).
 *
 * @param {Object} b1 - { x, y, width, height }
 * @param {Object} b2 - { x, y, width, height }
 * @param {number} [tolerance=8]
 * @returns {boolean}
 */
function bboxesIntersect(b1, b2, tolerance = 8) {
  if (!b1 || !b2 || typeof b1.x !== "number" || typeof b2.x !== "number") {
    return false;
  }
  const x1 = Math.max(b1.x, b2.x);
  const y1 = Math.max(b1.y, b2.y);
  const x2 = Math.min(b1.x + (b1.width || 0), b2.x + (b2.width || 0));
  const y2 = Math.min(b1.y + (b1.height || 0), b2.y + (b2.height || 0));

  return (x2 - x1 >= -tolerance) && (y2 - y1 >= -tolerance);
}

/**
 * Searches for occurrences of targetText in text.
 *
 * @param {string} text
 * @param {string} targetText
 * @returns {Array<{ start: number, end: number }>}
 */
function findConservativeOccurrences(text, targetText) {
  if (!text || typeof text !== "string" || !targetText || typeof targetText !== "string") {
    return [];
  }
  const cleanTarget = targetText.trim();
  if (!cleanTarget) return [];

  const occurrences = [];
  let idx = 0;
  while (idx < text.length) {
    const found = text.indexOf(cleanTarget, idx);
    if (found === -1) break;
    occurrences.push({ start: found, end: found + cleanTarget.length });
    idx = found + cleanTarget.length;
  }

  // Case-insensitive fallback if no exact case match was found
  if (occurrences.length === 0) {
    const lowerText = text.toLowerCase();
    const lowerTarget = cleanTarget.toLowerCase();
    let lowerIdx = 0;
    while (lowerIdx < lowerText.length) {
      const found = lowerText.indexOf(lowerTarget, lowerIdx);
      if (found === -1) break;
      occurrences.push({ start: found, end: found + cleanTarget.length });
      lowerIdx = found + cleanTarget.length;
    }
  }

  // Diacritic-insensitive fallback if exact or case-insensitive search missed (e.g. "Wingårdh" vs "wingardh")
  if (occurrences.length === 0) {
    const stripAccents = s => (typeof s === "string" ? s.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : "");
    const normText = stripAccents(text.toLowerCase());
    const normTarget = stripAccents(cleanTarget.toLowerCase());

    if (normText.length === text.length && normTarget.length > 0) {
      let normIdx = 0;
      while (normIdx < normText.length) {
        const found = normText.indexOf(normTarget, normIdx);
        if (found === -1) break;
        occurrences.push({ start: found, end: found + normTarget.length });
        normIdx = found + normTarget.length;
      }
    }
  }

  return occurrences;
}

/**
 * Applies redaction spans from the END of the text toward the beginning
 * to ensure character offsets are not shifted during replacement.
 *
 * @param {string} text - Source text string
 * @param {Array<{ start: number, end: number, placeholder: string }>} spans
 * @returns {{ sanitizedText: string, appliedCount: number }}
 */
function applySpans(text, spans) {
  if (!text || typeof text !== "string" || !Array.isArray(spans) || spans.length === 0) {
    return { sanitizedText: text || "", appliedCount: 0, appliedSpans: [], coveredSpans: [] };
  }

  // 1. Filter valid spans
  const validSpans = spans.filter(span =>
    span &&
    typeof span.start === "number" &&
    typeof span.end === "number" &&
    span.start >= 0 &&
    span.end <= text.length &&
    span.start < span.end
  );

  if (validSpans.length === 0) {
    return { sanitizedText: text, appliedCount: 0, appliedSpans: [], coveredSpans: [] };
  }

  // 2. Sort spans: earlier start first; for identical start, longer span first (descending end)
  validSpans.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - a.end;
  });

  // 3. Merge overlapping intervals [s1, e1] and [s2, e2] into [min(s1, s2), max(e1, e2)] (Trap 3)
  const mergedClusters = [];
  for (const span of validSpans) {
    if (mergedClusters.length === 0) {
      mergedClusters.push({
        start: span.start,
        end: span.end,
        placeholder: span.placeholder,
        primarySpan: span,
        constituentSpans: [span]
      });
      continue;
    }

    const currentCluster = mergedClusters[mergedClusters.length - 1];

    // Overlapping condition: start of current span < end of current cluster
    if (span.start < currentCluster.end) {
      currentCluster.start = Math.min(currentCluster.start, span.start);
      currentCluster.end = Math.max(currentCluster.end, span.end);
      currentCluster.constituentSpans.push(span);

      // Prioritize specific semantic placeholders over generic [REDACTED] or [PERSON]
      if (
        (span.placeholder === "[EMAIL]" || span.placeholder === "[PHONE]" || span.placeholder === "[CARD]") &&
        (currentCluster.placeholder === "[REDACTED]" || currentCluster.placeholder === "[PERSON]")
      ) {
        currentCluster.placeholder = span.placeholder;
      }
    } else {
      mergedClusters.push({
        start: span.start,
        end: span.end,
        placeholder: span.placeholder,
        primarySpan: span,
        constituentSpans: [span]
      });
    }
  }

  // 4. Construct sanitized text using non-overlapping interval slices (Trap 2: prevents index invalidation)
  let result = "";
  let lastIndex = 0;
  const appliedSpans = [];
  const coveredSpans = [];

  for (const cluster of mergedClusters) {
    result += text.slice(lastIndex, cluster.start);

    const sanitizedStart = result.length;
    result += cluster.placeholder;
    const sanitizedEnd = result.length;

    lastIndex = cluster.end;

    // Track primary span as directly applied
    appliedSpans.push({
      ...cluster.primarySpan,
      start: cluster.start,
      end: cluster.end,
      placeholder: cluster.placeholder,
      sanitizedStart: sanitizedStart,
      sanitizedEnd: sanitizedEnd,
      originalSlice: text.slice(cluster.start, cluster.end)
    });

    // Track constituent spans merged into this cluster as covered/protected
    for (let i = 1; i < cluster.constituentSpans.length; i++) {
      const cSpan = cluster.constituentSpans[i];
      coveredSpans.push({
        ...cSpan,
        coveredBy: cluster.primarySpan.detectionIndex,
        placeholder: cluster.placeholder,
        sanitizedStart: sanitizedStart,
        sanitizedEnd: sanitizedEnd,
        originalSlice: text.slice(cSpan.start, cSpan.end)
      });
    }
  }

  result += text.slice(lastIndex);

  return {
    sanitizedText: result,
    appliedCount: appliedSpans.length,
    appliedSpans: appliedSpans,
    coveredSpans: coveredSpans
  };
}

class TextRedactor {
  /**
   * Identifies candidate redaction spans in a specific DOM text region based on
   * provenance mapping of the fused detection and its underlying evidence.
   *
   * Offsets are applied ONLY if they originated from this exact region.
   * OCR offsets are NEVER applied to DOM text.
   *
   * @param {Object} region - DOM text region { text, bbox, domWords }
   * @param {Object} det - Fused canonical detection
   * @returns {Array<{ start: number, end: number, placeholder: string, provenance: string }>}
   */
  static findSpansForRegion(region, det, rIdx = null) {
    if (!region || typeof region.text !== "string" || !det || typeof det !== "object") {
      return [];
    }

    const placeholder = getPlaceholder(det.type);
    const targetText = (det.text || "").trim();
    if (!targetText) {
      return [];
    }

    const rawRegionText = region.text;
    const regionIdx = typeof region.regionIndex === "number"
      ? region.regionIndex
      : (typeof rIdx === "number" ? rIdx : null);
    const regionBBox = region.bbox;
    const evidenceList = Array.isArray(det.evidence) ? det.evidence : [det];

    // -------------------------------------------------------------------------
    // Provenance Branch 1: Rampart on DOM (contextSource: "DOM", source: "RAMPART")
    // Offsets originate from a specific DOM text region.
    // DOM coordinates are NOT required for DOM text redaction.
    // -------------------------------------------------------------------------
    const domRampartEvidence = evidenceList.filter(
      e => e.source === "RAMPART" &&
           e.contextSource === "DOM" &&
           typeof e.start === "number" &&
           typeof e.end === "number"
    );

    for (const ev of domRampartEvidence) {
      // Check regionIndex provenance if available
      const regMatch = ev.reason && /:reg(\d+)/.exec(ev.reason);
      const evRegionIndex = regMatch ? parseInt(regMatch[1], 10) : (typeof ev.regionIndex === "number" ? ev.regionIndex : null);
      if (evRegionIndex !== null && regionIdx !== null && evRegionIndex !== regionIdx) {
        continue;
      }

      if (ev.start >= 0 && ev.end <= rawRegionText.length && ev.start < ev.end) {
        const rawSlice = rawRegionText.slice(ev.start, ev.end);
        const slice = rawSlice.trim().toLowerCase();
        const expected = (ev.text || targetText).trim().toLowerCase();
        const stripAccents = s => (typeof s === "string" ? s.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : "");
        const normSlice = stripAccents(slice);
        const normExpected = stripAccents(expected);

        if (
          slice === expected ||
          rawSlice.toLowerCase() === expected ||
          normSlice === normExpected ||
          (slice.length > 0 && expected.length > 0 && (
            slice.includes(expected) ||
            expected.includes(slice) ||
            (normSlice.length > 0 && normExpected.length > 0 && (normSlice.includes(normExpected) || normExpected.includes(normSlice)))
          ))
        ) {
          let spanStart = ev.start;
          let spanEnd = ev.end;
          while (spanStart < spanEnd && /\s/.test(rawRegionText[spanStart])) spanStart++;
          while (spanEnd > spanStart && /\s/.test(rawRegionText[spanEnd - 1])) spanEnd--;
          if (spanStart < spanEnd) {
            return [{
              start: spanStart,
              end: spanEnd,
              placeholder: placeholder,
              provenance: "rampart_dom_exact"
            }];
          }
        }
      }

      // Fallback within originating region: if this region is corroborated by regionIndex
      // but exact character offsets failed to align (e.g. tokenizer or casing offset drift)
      const evText = (ev.text || targetText).trim();
      if (evText) {
        const occurrences = findConservativeOccurrences(rawRegionText, evText);
        if (occurrences.length >= 1) {
          return occurrences.map(occ => ({
            start: occ.start,
            end: occ.end,
            placeholder: placeholder,
            provenance: occurrences.length === 1 ? "rampart_dom_region_unique" : "rampart_dom_region_all_occurrences"
          }));
        }
      }
    }

    // -------------------------------------------------------------------------
    // Provenance Branch 2: DOM_TEXT Regex (source: "DOM_TEXT")
    // -------------------------------------------------------------------------
    const domTextEvidence = evidenceList.filter(e => e.source === "DOM_TEXT");
    for (const ev of domTextEvidence) {
      // Check regionIndex provenance if available
      const regMatch = ev.reason && /:reg(\d+)/.exec(ev.reason);
      const evRegionIndex = regMatch ? parseInt(regMatch[1], 10) : (typeof ev.regionIndex === "number" ? ev.regionIndex : null);
      if (evRegionIndex !== null && regionIdx !== null && evRegionIndex !== regionIdx) {
        continue;
      }

      // If exact offsets exist on ev
      if (
        typeof ev.start === "number" &&
        typeof ev.end === "number" &&
        ev.start >= 0 &&
        ev.end <= rawRegionText.length &&
        ev.start < ev.end
      ) {
        const rawSlice = rawRegionText.slice(ev.start, ev.end);
        const slice = rawSlice.trim().toLowerCase();
        const expected = (ev.text || targetText).trim().toLowerCase();
        const stripAccents = s => (typeof s === "string" ? s.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : "");
        const normSlice = stripAccents(slice);
        const normExpected = stripAccents(expected);

        if (
          slice === expected ||
          rawSlice.toLowerCase() === expected ||
          normSlice === normExpected ||
          (slice.length > 0 && expected.length > 0 && (
            slice.includes(expected) ||
            expected.includes(slice) ||
            (normSlice.length > 0 && normExpected.length > 0 && (normSlice.includes(normExpected) || normExpected.includes(normSlice)))
          ))
        ) {
          let spanStart = ev.start;
          let spanEnd = ev.end;
          while (spanStart < spanEnd && /\s/.test(rawRegionText[spanStart])) spanStart++;
          while (spanEnd > spanStart && /\s/.test(rawRegionText[spanEnd - 1])) spanEnd--;
          if (spanStart < spanEnd) {
            return [{
              start: spanStart,
              end: spanEnd,
              placeholder: placeholder,
              provenance: "dom_text_regex_exact"
            }];
          }
        }
      }

      // Conservative occurrence match within originating region (Trap 4: redact all instances)
      const evText = (ev.text || targetText).trim();
      if (evText) {
        const occurrences = findConservativeOccurrences(rawRegionText, evText);
        if (occurrences.length >= 1) {
          return occurrences.map(occ => ({
            start: occ.start,
            end: occ.end,
            placeholder: placeholder,
            provenance: occurrences.length === 1 ? "dom_text_regex_unique" : "dom_text_regex_all_occurrences"
          }));
        }
      }
    }

    // -------------------------------------------------------------------------
    // Provenance Branch 3 & 4: OCR Regex (source: "OCR") & Rampart OCR (contextSource: "OCR")
    // Originates from screenshot canvas / OCR lines.
    // CRITICAL: NEVER USE OCR OFFSETS IN DOM TEXT.
    // OCR coordinates/bboxes remain strictly required because OCR is visual.
    // -------------------------------------------------------------------------
    const hasOCREvidence = evidenceList.some(
      e => e.source === "OCR" || e.contextSource === "OCR"
    );

    if (hasOCREvidence || det.source === "OCR" || det.contextSource === "OCR") {
      // Spatial prerequisite: canonical bbox in viewport CSS pixels must intersect region.bbox
      if (regionBBox && det.bbox && typeof det.bbox.x === "number") {
        if (!bboxesIntersect(det.bbox, regionBBox)) {
          return [];
        }
      }

      if (rawRegionText.toLowerCase().includes(targetText.toLowerCase())) {
        const occurrences = findConservativeOccurrences(rawRegionText, targetText);
        if (occurrences.length >= 1) {
          return occurrences.map(occ => ({
            start: occ.start,
            end: occ.end,
            placeholder: placeholder,
            provenance: occurrences.length === 1 ? "ocr_spatial_grounded_unique" : "ocr_spatial_grounded_all_occurrences"
          }));
        }
      }
      return [];
    }

    // -------------------------------------------------------------------------
    // Fallback: DOM-origin detection without direct offsets
    // Matches all conservative occurrences in the region (Trap 4: redact all instances)
    // -------------------------------------------------------------------------
    const isDomOrigin = det.contextSource === "DOM" || det.source === "DOM_TEXT" ||
      evidenceList.some(e => e.contextSource === "DOM" || e.source === "DOM_TEXT");

    if (isDomOrigin) {
      const candidatesToTry = [targetText];
      for (const ev of evidenceList) {
        const evT = (ev.text || "").trim();
        if (evT && !candidatesToTry.includes(evT)) {
          candidatesToTry.push(evT);
        }
      }

      for (const cand of candidatesToTry) {
        const occurrences = findConservativeOccurrences(rawRegionText, cand);
        if (occurrences.length >= 1) {
          return occurrences.map(occ => ({
            start: occ.start,
            end: occ.end,
            placeholder: placeholder,
            provenance: occurrences.length === 1 ? "dom_text_unique_fallback" : "dom_text_all_occurrences_fallback"
          }));
        }
      }
    }

    return [];
  }

  /**
   * Redacts visible DOM text regions into a coherent, sanitized textual context for the VLM.
   *
   * Crucial Architecture Constraint:
   * - Redaction is performed strictly on each individual region's text independently.
   * - Offsets are applied ONLY to their originating source region.
   * - Never applies start/end offsets directly to a concatenated page-wide DOM text string.
   *
   * @param {Array<Object>} domTextRegions - Array of { text, bbox, domWords, ... }
   * @param {Array<Object>} fusedDetections - Canonical PII detections from Fusion (preserved unchanged)
   * @returns {{ sanitizedText: string, sanitizedRegions: Array<Object>, totalRedactions: number, trace: Object, redactionMetadata: Object }}
   */
  static redactDomText(domTextRegions, fusedDetections = []) {
    if (!Array.isArray(domTextRegions) || domTextRegions.length === 0) {
      return {
        sanitizedText: "",
        sanitizedRegions: [],
        totalRedactions: 0,
        trace: { totalRegions: 0, totalRedactions: 0 },
        redactionMetadata: {
          textRedactions: [],
          textRedactionComplete: true,
          unredactedDetections: [],
          mappingChain: [],
          summary: {
            required: 0,
            mapped: 0,
            applied: 0,
            covered: 0,
            unresolved: 0,
            verificationFailures: 0
          }
        }
      };
    }

    const sanitizedRegions = [];
    let totalRedactions = 0;
    const textRedactions = [];
    const regionRedactionResults = [];
    const mappingChain = [];
    const allCandidateSpans = [];

    for (let rIdx = 0; rIdx < domTextRegions.length; rIdx++) {
      const region = domTextRegions[rIdx];
      if (!region || typeof region.text !== "string") continue;
      if (typeof region.regionIndex !== "number") {
        region.regionIndex = rIdx;
      }
      const rawText = region.text;

      // Collect spans strictly belonging to THIS specific region's context
      const spansForRegion = [];
      for (let dIdx = 0; dIdx < fusedDetections.length; dIdx++) {
        const det = fusedDetections[dIdx];
        if (!det || typeof det !== "object") continue;

        const candidateSpans = this.findSpansForRegion(region, det, rIdx);
        if (candidateSpans && candidateSpans.length > 0) {
          for (const sp of candidateSpans) {
            const spanInfo = {
              start: sp.start,
              end: sp.end
            };
            const candidateEntry = {
              ...sp,
              detectionIndex: dIdx,
              detectionType: det.type,
              targetText: (det.text || "").trim(),
              detectionBBox: det.bbox ? { ...det.bbox } : null,
              regionIndex: rIdx,
              regionBBox: region.bbox ? { ...region.bbox } : null,
              span: spanInfo
            };

            // Track complete mapping chain: detectionIndex, detectionBBox, regionBBox, span
            mappingChain.push({
              detectionIndex: dIdx,
              detectionBBox: det.bbox ? { ...det.bbox } : null,
              regionIndex: rIdx,
              regionBBox: region.bbox ? { ...region.bbox } : null,
              span: spanInfo
            });

            allCandidateSpans.push(candidateEntry);
            spansForRegion.push(candidateEntry);
          }
        }
      }

      // Apply spans from region text
      const { sanitizedText, appliedCount, appliedSpans = [], coveredSpans = [] } = applySpans(rawText, spansForRegion);
      totalRedactions += appliedCount;

      // Location/span-aware verification for each directly applied span
      for (const sp of appliedSpans) {
        const targetText = sp.targetText;
        const replacedContent = sanitizedText.slice(sp.sanitizedStart, sp.sanitizedEnd);

        // Strict location-aware verification:
        // 1. The placeholder must be exactly present at the mapped replacement span
        const placeholderPresent = replacedContent === sp.placeholder;
        // 2. The original raw text slice must no longer occupy that span
        const rawSliceReplaced = !sp.originalSlice || !replacedContent.includes(sp.originalSlice);
        // 3. The target text must not occupy that span
        const targetTextReplaced = !targetText || !replacedContent.includes(targetText);

        const textPersists = !placeholderPresent || !rawSliceReplaced || !targetTextReplaced;

        regionRedactionResults.push({
          detectionIndex: sp.detectionIndex,
          type: sp.detectionType,
          targetText: targetText,
          regionIndex: rIdx,
          applied: true,
          covered: false,
          placeholder: sp.placeholder,
          textPersists: textPersists,
          detectionBBox: sp.detectionBBox,
          regionBBox: sp.regionBBox,
          span: sp.span
        });

        if (!textPersists) {
          textRedactions.push({
            detectionIndex: sp.detectionIndex,
            type: sp.detectionType,
            text: targetText,
            regionIndex: rIdx,
            placeholder: sp.placeholder,
            applied: true,
            covered: false,
            detectionBBox: sp.detectionBBox,
            regionBBox: sp.regionBBox,
            span: sp.span
          });
        }
      }

      // Record covered duplicate/sub-spans: completely protected by an already-applied redaction
      for (const sp of coveredSpans) {
        regionRedactionResults.push({
          detectionIndex: sp.detectionIndex,
          type: sp.detectionType,
          targetText: sp.targetText,
          regionIndex: rIdx,
          applied: true,
          covered: true,
          coveredBy: sp.coveredBy,
          placeholder: sp.placeholder,
          textPersists: false,
          detectionBBox: sp.detectionBBox,
          regionBBox: sp.regionBBox,
          span: sp.span
        });

        textRedactions.push({
          detectionIndex: sp.detectionIndex,
          type: sp.detectionType,
          text: sp.targetText,
          regionIndex: rIdx,
          placeholder: sp.placeholder,
          applied: true,
          covered: true,
          detectionBBox: sp.detectionBBox,
          regionBBox: sp.regionBBox,
          span: sp.span
        });
      }

      sanitizedRegions.push({
        regionIndex: rIdx,
        text: sanitizedText,
        originalText: rawText,
        redactedCount: appliedCount,
        bbox: region.bbox || null
      });
    }

    // Determine which fused detections required text redaction and verify completeness
    const unredactedDetections = [];
    const summary = {
      required: 0,
      mapped: 0,
      applied: 0,
      covered: 0,
      unresolved: 0,
      verificationFailures: 0
    };

    console.log(`[TextRedactor Debug] Evaluating ${fusedDetections.length} fused detections against ${domTextRegions.length} DOM text regions...`);

    for (let dIdx = 0; dIdx < fusedDetections.length; dIdx++) {
      const det = fusedDetections[dIdx];
      if (!det || typeof det !== "object") continue;

      const targetText = (det.text || "").trim();
      const hasText = targetText.length > 0;
      if (!hasText) {
        // Non-textual detection (e.g. structural form container with no text)
        console.log(
          `[TextRedactor Debug] Detection #${dIdx + 1} (${det.type}): Skipped text redaction (no textual value). ` +
          `source=${det.source} | elementId=${det.elementId || "none"} | hasBBox=${Boolean(det.bbox)}`
        );
        continue;
      }

      // Check if this detection was matched in any DOM text region (directly applied or covered)
      const wasMatchedInAnyRegion = regionRedactionResults.some(r => r.detectionIndex === dIdx);

      // Issue 1: Structural inputs or element attributes (accessibleName, aria-label, input[type=...])
      // must NOT be treated as visible text-node content unless an explicit attribute-text redaction path exists.
      const isStructuralOrAttribute = Boolean(
        det.source === "DOM" ||
        (Array.isArray(det.sources) && det.sources.includes("DOM") && !det.sources.includes("DOM_TEXT") && det.contextSource !== "DOM") ||
        (det.elementId && !wasMatchedInAnyRegion) ||
        (det.reason && (
          det.reason.startsWith("input[") ||
          det.reason.startsWith("autocomplete") ||
          det.reason.startsWith("metadata-")
        ) && !wasMatchedInAnyRegion)
      );

      // Genuine visible DOM text-node content provenance
      const hasVisibleDomTextProvenance = !isStructuralOrAttribute && (
        det.contextSource === "DOM" ||
        (det.source === "DOM_TEXT" && !det.elementId) ||
        (Array.isArray(det.evidence) && det.evidence.some(e =>
          (e.contextSource === "DOM" || e.source === "DOM_TEXT") && !e.elementId
        ))
      );

      // Requires text redaction if it has genuine text-node provenance or was actually matched
      const requiresTextRedaction = hasVisibleDomTextProvenance || wasMatchedInAnyRegion;

      const resultsForDet = regionRedactionResults.filter(r => r.detectionIndex === dIdx);
      const candidateSpansForDet = allCandidateSpans.filter(c => c.detectionIndex === dIdx);
      const srcList = (Array.isArray(det.sources) ? det.sources : [det.source]).join(",");

      if (!requiresTextRedaction) {
        console.log(
          `[TextRedactor Debug] Detection #${dIdx + 1} (${det.type}): Skipped text redaction (structural/attribute provenance or no visible text-node content). ` +
          `source=${det.source} | sources=[${srcList}] | contextSource=${det.contextSource || "none"} | ` +
          `elementId=${det.elementId || "none"} | hasBBox=${Boolean(det.bbox)} | isStructuralOrAttribute=${isStructuralOrAttribute}`
        );
        continue;
      }

      // Detection strictly requires text redaction
      summary.required++;

      const isMapped = wasMatchedInAnyRegion || candidateSpansForDet.length > 0 || resultsForDet.length > 0;
      if (isMapped) {
        summary.mapped++;
      }

      if (resultsForDet.length === 0) {
        // Genuine DOM text detection was not applied/covered in any text region
        summary.unresolved++;

        const spanFound = candidateSpansForDet.length > 0;
        const matched = isMapped;
        const attempted = spanFound;

        let safeReason = "GENUINE_DOM_TEXT_SPAN_NOT_FOUND";
        if (spanFound) {
          safeReason = "REDACTION_SPAN_NOT_APPLIED";
        }

        unredactedDetections.push({
          detectionIndex: dIdx,
          type: det.type,
          source: det.source,
          sources: det.sources || [det.source],
          contextSource: det.contextSource || null,
          elementId: det.elementId || null,
          bbox: det.bbox ? { ...det.bbox } : null,
          hasBBox: Boolean(det.bbox),
          hasDomProvenance: hasVisibleDomTextProvenance,
          textMapping: {
            required: true,
            matched: Boolean(matched),
            spanFound: Boolean(spanFound)
          },
          redaction: {
            attempted: Boolean(attempted),
            applied: false,
            covered: false
          },
          reason: safeReason
        });

        console.warn(
          `[TextRedactor Debug] UNREDACTED Detection #${dIdx + 1}: ` +
          `type=${det.type} | source=${det.source} | sources=[${srcList}] | ` +
          `contextSource=${det.contextSource || "none"} | elementId=${det.elementId || "none"} | ` +
          `hasBBox=${Boolean(det.bbox)} | reason=${safeReason} | ` +
          `hasVisibleDomTextProvenance=${hasVisibleDomTextProvenance}`
        );
      } else {
        const anyFailed = resultsForDet.some(r => r.textPersists);
        if (anyFailed) {
          summary.unresolved++;
          summary.verificationFailures++;

          unredactedDetections.push({
            detectionIndex: dIdx,
            type: det.type,
            source: det.source,
            sources: det.sources || [det.source],
            contextSource: det.contextSource || null,
            elementId: det.elementId || null,
            bbox: det.bbox ? { ...det.bbox } : null,
            hasBBox: Boolean(det.bbox),
            hasDomProvenance: hasVisibleDomTextProvenance,
            textMapping: {
              required: true,
              matched: true,
              spanFound: true
            },
            redaction: {
              attempted: true,
              applied: false,
              covered: false
            },
            reason: "TEXT_PERSISTS_AT_REPLACEMENT_SPAN"
          });

          console.warn(
            `[TextRedactor Debug] UNREDACTED Detection #${dIdx + 1}: ` +
            `type=${det.type} | source=${det.source} | sources=[${srcList}] | ` +
            `contextSource=${det.contextSource || "none"} | elementId=${det.elementId || "none"} | ` +
            `hasBBox=${Boolean(det.bbox)} | reason=TEXT_PERSISTS_AT_REPLACEMENT_SPAN`
          );
        } else {
          const isDirectlyApplied = resultsForDet.some(r => r.applied && !r.covered);
          if (isDirectlyApplied) {
            summary.applied++;
          } else {
            summary.covered++;
          }

          const coveredCount = resultsForDet.filter(r => r.covered).length;
          const directCount = resultsForDet.filter(r => !r.covered).length;
          console.log(
            `[TextRedactor Debug] Detection #${dIdx + 1} (${det.type}): Successfully redacted in ${resultsForDet.length} region(s) ` +
            `(${directCount} direct, ${coveredCount} covered). ` +
            `source=${det.source} | sources=[${srcList}] | contextSource=${det.contextSource || "none"} | ` +
            `elementId=${det.elementId || "none"} | hasBBox=${Boolean(det.bbox)}`
          );
        }
      }
    }

    console.log(
      `[TextRedactor] Required: ${summary.required} | Mapped: ${summary.mapped} | Applied: ${summary.applied} | ` +
      `Covered: ${summary.covered} | Unresolved: ${summary.unresolved} | Verification failures: ${summary.verificationFailures}`
    );

    const textRedactionComplete = unredactedDetections.length === 0;

    // Concatenate sanitized region texts into final page context ONLY AFTER per-region redaction
    const sanitizedLines = sanitizedRegions
      .map(r => r.text.trim())
      .filter(Boolean);

    const fullSanitizedText = sanitizedLines.join("\n");

    return {
      sanitizedText: fullSanitizedText,
      sanitizedRegions: sanitizedRegions,
      totalRedactions: totalRedactions,
      trace: {
        totalRegions: domTextRegions.length,
        totalRedactions: totalRedactions
      },
      redactionMetadata: {
        textRedactions: textRedactions,
        textRedactionComplete: textRedactionComplete,
        unredactedDetections: unredactedDetections,
        mappingChain: mappingChain,
        summary: summary
      }
    };
  }

  /**
   * Redacts sensitive PII spans from a single standalone string using fused canonical detections.
   *
   * @param {string} sourceText - Input text string
   * @param {Array<Object>} fusedDetections - Array of canonical PII detections from Fusion
   * @returns {{ sanitizedText: string, appliedCount: number }}
   */
  static redactText(sourceText, fusedDetections = []) {
    if (!sourceText || typeof sourceText !== "string") {
      return { sanitizedText: "", appliedCount: 0 };
    }
    if (!Array.isArray(fusedDetections) || fusedDetections.length === 0) {
      return { sanitizedText: sourceText, appliedCount: 0 };
    }

    const spansToApply = [];

    for (const det of fusedDetections) {
      if (!det || typeof det !== "object") continue;
      const placeholder = getPlaceholder(det.type);
      const targetText = (det.text || "").trim();
      if (!targetText) continue;

      let offsetApplied = false;

      // Only check DOM Rampart evidence for valid offsets; NEVER apply OCR offsets to DOM/raw text
      const domEvidence = (det.evidence || []).filter(
        e => e.source === "RAMPART" &&
             e.contextSource === "DOM" &&
             typeof e.start === "number" &&
             typeof e.end === "number"
      );
      if (
        domEvidence.length === 0 &&
        det.source === "RAMPART" &&
        det.contextSource === "DOM" &&
        typeof det.start === "number" &&
        typeof det.end === "number"
      ) {
        domEvidence.push(det);
      }

      for (const ev of domEvidence) {
        if (ev.start >= 0 && ev.end <= sourceText.length && ev.start < ev.end) {
          const slice = sourceText.slice(ev.start, ev.end).trim().toLowerCase();
          if (slice === (ev.text || targetText).toLowerCase()) {
            spansToApply.push({
              start: ev.start,
              end: ev.end,
              placeholder: placeholder,
              provenance: "dom_rampart_offset"
            });
            offsetApplied = true;
            break;
          }
        }
      }

      if (offsetApplied) continue;

      // Conservative text matching (Trap 4: redact all occurrences if count >= 1)
      const occurrences = findConservativeOccurrences(sourceText, targetText);
      if (occurrences.length >= 1) {
        for (const occ of occurrences) {
          spansToApply.push({
            start: occ.start,
            end: occ.end,
            placeholder: placeholder,
            provenance: occurrences.length === 1 ? "unique_match" : "all_occurrences_match"
          });
        }
      }
    }

    return applySpans(sourceText, spansToApply);
  }
}

if (typeof self !== "undefined") {
  self.TextRedactor = TextRedactor;
  self.REDACTION_PLACEHOLDERS = REDACTION_PLACEHOLDERS;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { TextRedactor, REDACTION_PLACEHOLDERS };
}
