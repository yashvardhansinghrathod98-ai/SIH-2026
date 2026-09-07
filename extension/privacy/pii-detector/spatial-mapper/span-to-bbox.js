// privacy/pii-detector/spatial-mapper/span-to-bbox.js
// Spatial Grounding Layer: Converts character spans into precise entity-level bounding boxes.

class SpanToBBox {
  /**
   * Calculates the union bounding box of an array of bboxes.
   * @param {Array<{ x: number, y: number, width: number, height: number }>} bboxes
   * @returns {{ x: number, y: number, width: number, height: number }|null}
   */
  static computeUnionBBox(bboxes) {
    if (!Array.isArray(bboxes) || bboxes.length === 0) {
      return null;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let validCount = 0;

    for (const b of bboxes) {
      if (!b || typeof b.x !== "number" || typeof b.y !== "number" ||
          typeof b.width !== "number" || typeof b.height !== "number") {
        continue;
      }
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
      validCount++;
    }

    if (validCount === 0 || minX === Infinity || minY === Infinity) {
      return null;
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  /**
   * Derives entity-level geometry from a DOM Text Node using Range APIs.
   * Does NOT rely on parent element geometry.
   *
   * @param {Node} textNode - The DOM text node
   * @param {number} start - Character start index
   * @param {number} end - Character end index
   * @returns {{ x: number, y: number, width: number, height: number }|null}
   */
  static fromDOMTextNode(textNode, start, end) {
    if (!textNode || typeof start !== "number" || typeof end !== "number") {
      return null;
    }
    if (start < 0 || end <= start) {
      return null;
    }

    const nodeValue = textNode.nodeValue || textNode.textContent || "";
    if (start >= nodeValue.length || end > nodeValue.length) {
      return null;
    }

    // Check Range API availability (e.g. browser environment)
    if (typeof document === "undefined" || typeof document.createRange !== "function") {
      return null;
    }

    try {
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, end);

      const rects = range.getClientRects();
      let rect = range.getBoundingClientRect();

      if ((!rect || rect.width <= 0 || rect.height <= 0) && rects && rects.length > 0) {
        rect = rects[0];
      }

      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return null;
      }

      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    } catch (err) {
      return null;
    }
  }

  /**
   * Reconstructs character ranges from DOM serializable word geometry and computes
   * the union bbox of all DOM words overlapping the [start, end] entity character span.
   *
   * @param {Array<{ text: string, bbox: { x: number, y: number, width: number, height: number }, start?: number, end?: number }>} domWords
   * @param {number} start - Entity character start offset
   * @param {number} end - Entity character end offset
   * @param {string} [sourceText=""] - Full text matching domWords
   * @returns {{ x: number, y: number, width: number, height: number }|null}
   */
  static fromDOMWords(domWords, start, end, sourceText = "") {
    if (!Array.isArray(domWords) || domWords.length === 0) {
      return null;
    }
    if (typeof start !== "number" || typeof end !== "number" || start < 0 || end <= start) {
      return null;
    }

    const wordIntervals = [];

    if (sourceText && typeof sourceText === "string") {
      let cursor = 0;
      const lowerSource = sourceText.toLowerCase();

      for (const wordObj of domWords) {
        const cleanWord = (wordObj.text || "").trim().toLowerCase();
        if (!cleanWord) continue;

        if (typeof wordObj.start === "number" && typeof wordObj.end === "number") {
          wordIntervals.push({
            start: wordObj.start,
            end: wordObj.end,
            bbox: wordObj.bbox
          });
          continue;
        }

        const matchIdx = lowerSource.indexOf(cleanWord, cursor);
        if (matchIdx !== -1) {
          const wStart = matchIdx;
          const wEnd = matchIdx + cleanWord.length;
          wordIntervals.push({
            start: wStart,
            end: wEnd,
            bbox: wordObj.bbox
          });
          cursor = wEnd;
        } else {
          const wStart = cursor;
          const wEnd = cursor + cleanWord.length;
          wordIntervals.push({
            start: wStart,
            end: wEnd,
            bbox: wordObj.bbox
          });
          cursor = wEnd + 1;
        }
      }
    } else {
      let cursor = 0;
      for (let i = 0; i < domWords.length; i++) {
        const wordText = (domWords[i].text || "").trim();
        if (!wordText) continue;

        if (typeof domWords[i].start === "number" && typeof domWords[i].end === "number") {
          wordIntervals.push({
            start: domWords[i].start,
            end: domWords[i].end,
            bbox: domWords[i].bbox
          });
          continue;
        }

        const wStart = cursor;
        const wEnd = cursor + wordText.length;
        wordIntervals.push({
          start: wStart,
          end: wEnd,
          bbox: domWords[i].bbox
        });
        cursor = wEnd + 1;
      }
    }

    const overlappingBBoxes = [];
    for (const interval of wordIntervals) {
      if (Math.max(start, interval.start) < Math.min(end, interval.end)) {
        if (interval.bbox) {
          overlappingBBoxes.push(interval.bbox);
        }
      }
    }

    if (overlappingBBoxes.length === 0) {
      return null;
    }

    return this.computeUnionBBox(overlappingBBoxes);
  }

  /**
   * Reconstructs character ranges of OCR words and computes the union bbox of all
   * words overlapping the [start, end] entity character span.
   *
   * @param {Array<{ text: string, bbox: { x: number, y: number, width: number, height: number } }>} ocrWords
   * @param {number} start - Entity character start offset
   * @param {number} end - Entity character end offset
   * @param {string} [sourceText=""] - Full line text matching ocrWords (optional)
   * @returns {{ x: number, y: number, width: number, height: number }|null}
   */
  static fromOCRWords(ocrWords, start, end, sourceText = "") {
    if (!Array.isArray(ocrWords) || ocrWords.length === 0) {
      return null;
    }
    if (typeof start !== "number" || typeof end !== "number" || start < 0 || end <= start) {
      return null;
    }

    // 1. Build word character intervals [wStart, wEnd]
    const wordIntervals = [];

    if (sourceText && typeof sourceText === "string") {
      let cursor = 0;
      const lowerSource = sourceText.toLowerCase();

      for (const wordObj of ocrWords) {
        const cleanWord = (wordObj.text || "").trim().toLowerCase();
        if (!cleanWord) continue;

        const matchIdx = lowerSource.indexOf(cleanWord, cursor);
        if (matchIdx !== -1) {
          const wStart = matchIdx;
          const wEnd = matchIdx + cleanWord.length;
          wordIntervals.push({
            start: wStart,
            end: wEnd,
            bbox: wordObj.bbox
          });
          cursor = wEnd;
        } else {
          // Fallback sequential index
          const wStart = cursor;
          const wEnd = cursor + cleanWord.length;
          wordIntervals.push({
            start: wStart,
            end: wEnd,
            bbox: wordObj.bbox
          });
          cursor = wEnd + 1;
        }
      }
    } else {
      // Reconstruct sequential space-delimited character intervals
      let cursor = 0;
      for (let i = 0; i < ocrWords.length; i++) {
        const wordText = (ocrWords[i].text || "").trim();
        if (!wordText) continue;

        const wStart = cursor;
        const wEnd = cursor + wordText.length;
        wordIntervals.push({
          start: wStart,
          end: wEnd,
          bbox: ocrWords[i].bbox
        });
        cursor = wEnd + 1; // space
      }
    }

    // 2. Identify overlapping words: max(start, wStart) < min(end, wEnd)
    const overlappingBBoxes = [];
    for (const interval of wordIntervals) {
      if (Math.max(start, interval.start) < Math.min(end, interval.end)) {
        if (interval.bbox) {
          overlappingBBoxes.push(interval.bbox);
        }
      }
    }

    if (overlappingBBoxes.length === 0) {
      return null;
    }

    return this.computeUnionBBox(overlappingBBoxes);
  }

  /**
   * Main entry point: Maps a character span into an entity-level bounding box
   * using available spatial context.
   *
   * If only coarse region-level geometry exists (without text nodes or word-level bboxes),
   * returns null rather than claiming false precision.
   *
   * @param {number} start - Character start offset
   * @param {number} end - Character end offset
   * @param {Object} [spatialContext={}] - Available spatial data
   * @param {Node} [spatialContext.textNode] - DOM Text node
   * @param {Array<Object>} [spatialContext.ocrWords] - Word-level OCR results with bboxes
   * @param {string} [spatialContext.sourceText] - Full source text for OCR words
   * @returns {{ x: number, y: number, width: number, height: number }|null}
   */
  static getBBoxForSpan(start, end, spatialContext = {}) {
    if (typeof start !== "number" || typeof end !== "number" || start < 0 || end <= start) {
      return null;
    }
    if (!spatialContext || typeof spatialContext !== "object") {
      return null;
    }

    // Strategy 1: DOM Live Text Node via Range API
    if (spatialContext.textNode) {
      const domBBox = this.fromDOMTextNode(spatialContext.textNode, start, end);
      if (domBBox) return domBBox;
    }

    // Strategy 2: DOM Serializable Word Geometry
    if (Array.isArray(spatialContext.domWords) && spatialContext.domWords.length > 0) {
      const domWordBBox = this.fromDOMWords(spatialContext.domWords, start, end, spatialContext.sourceText || "");
      if (domWordBBox) return domWordBBox;
    }

    // Strategy 3: OCR word-level bounding box union
    if (Array.isArray(spatialContext.ocrWords) && spatialContext.ocrWords.length > 0) {
      const ocrBBox = this.fromOCRWords(spatialContext.ocrWords, start, end, spatialContext.sourceText || "");
      if (ocrBBox) return ocrBBox;
    }

    // Strategy 4: Coarse region fallback is intentionally rejected per requirement 4
    // "If only region-level geometry exists and precise entity geometry cannot be derived
    //  reliably, return bbox = null rather than pretending it is precise."
    return null;
  }

  /**
   * Grounds a PIIDetection object by assigning an entity-level bbox when available.
   * Preserves all other detection properties (type, source, text, confidence, offsets).
   *
   * @param {Object} detection - PIIDetection object
   * @param {Object} [spatialContext={}] - Spatial context
   * @returns {Object} Grounded PIIDetection object
   */
  static groundDetection(detection, spatialContext = {}) {
    if (!detection || typeof detection !== "object") {
      return detection;
    }

    const bbox = this.getBBoxForSpan(detection.start, detection.end, spatialContext);

    return {
      ...detection,
      bbox: bbox
    };
  }

  /**
   * Grounds an array of PIIDetection objects.
   *
   * @param {Array<Object>} detections - Array of PIIDetection objects
   * @param {Object} [spatialContext={}] - Spatial context
   * @returns {Array<Object>} Array of grounded PIIDetection objects
   */
  static groundDetections(detections, spatialContext = {}) {
    if (!Array.isArray(detections)) return [];
    return detections.map(d => this.groundDetection(d, spatialContext));
  }
}

if (typeof self !== "undefined") {
  self.SpanToBBox = SpanToBBox;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { SpanToBBox };
}
