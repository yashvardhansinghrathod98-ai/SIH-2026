// privacy/ocr-quality/ocr-line-builder.js
// Production component: Reconstructs spatially coherent text lines from OCR words
// using relative vertical tolerance and horizontal gap heuristics.
// Preserves individual source words and union bounding box for spatial mapping.

class OCRLineBuilder {
  // Configurable spatial heuristics (relative to word height)
  static LINE_Y_TOLERANCE_RATIO = 0.5;      // Max vertical center delta as fraction of word height
  static MAX_HORIZONTAL_GAP_RATIO = 2.5;    // Max horizontal gap between words before splitting line segments

  /**
   * Builds spatially grouped and ordered lines from accepted OCR words.
   *
   * @param {Array<Object>} ocrWords - Array of accepted { text, confidence, bbox }
   * @param {Object} [options={}]
   * @param {number} [options.yToleranceRatio=0.5] - Vertical tolerance ratio
   * @param {number} [options.maxHorizontalGapRatio=2.5] - Horizontal gap ratio
   * @returns {Array<{ text: string, words: Array<Object>, ocrWords: Array<Object>, bbox: { x: number, y: number, width: number, height: number } }>}
   */
  static buildLines(ocrWords, options = {}) {
    if (!Array.isArray(ocrWords) || ocrWords.length === 0) {
      return [];
    }

    const yToleranceRatio = (typeof options.yToleranceRatio === "number")
      ? options.yToleranceRatio
      : this.LINE_Y_TOLERANCE_RATIO;

    const maxGapRatio = (typeof options.maxHorizontalGapRatio === "number")
      ? options.maxHorizontalGapRatio
      : this.MAX_HORIZONTAL_GAP_RATIO;

    // Filter valid words with required geometry
    const validWords = ocrWords.filter(w => (
      w &&
      typeof w.text === "string" &&
      w.text.trim().length > 0 &&
      w.bbox &&
      typeof w.bbox.x === "number" &&
      typeof w.bbox.y === "number" &&
      typeof w.bbox.width === "number" &&
      typeof w.bbox.height === "number"
    ));

    if (validWords.length === 0) {
      return [];
    }

    // Step 1: Sort words primarily by vertical coordinate (y), then by horizontal (x)
    const sortedWords = [...validWords].sort((a, b) => {
      const dy = a.bbox.y - b.bbox.y;
      if (Math.abs(dy) > 4) return dy;
      return a.bbox.x - b.bbox.x;
    });

    // Step 2: Group words into vertical lines using relative tolerance and overlap
    const verticalLines = [];

    for (const word of sortedWords) {
      const wordH = Math.max(1, word.bbox.height);
      const wordCenterY = word.bbox.y + wordH / 2;

      let bestLine = null;
      let bestDist = Infinity;

      for (const line of verticalLines) {
        const lineCenterY = line.bbox.y + line.bbox.height / 2;
        const avgH = line.totalHeight / line.words.length;
        const tolerance = avgH * yToleranceRatio;

        const dist = Math.abs(wordCenterY - lineCenterY);

        // Check vertical overlap between word and line
        const overlapTop = Math.max(word.bbox.y, line.bbox.y);
        const overlapBottom = Math.min(word.bbox.y + wordH, line.bbox.y + line.bbox.height);
        const hasOverlap = overlapBottom > overlapTop;

        if (dist <= tolerance || hasOverlap) {
          if (dist < bestDist) {
            bestDist = dist;
            bestLine = line;
          }
        }
      }

      if (bestLine) {
        bestLine.words.push(word);
        bestLine.totalHeight += wordH;
        // Expand bounding box
        const minX = Math.min(bestLine.bbox.x, word.bbox.x);
        const minY = Math.min(bestLine.bbox.y, word.bbox.y);
        const maxX = Math.max(bestLine.bbox.x + bestLine.bbox.width, word.bbox.x + word.bbox.width);
        const maxY = Math.max(bestLine.bbox.y + bestLine.bbox.height, word.bbox.y + wordH);
        bestLine.bbox.x = minX;
        bestLine.bbox.y = minY;
        bestLine.bbox.width = maxX - minX;
        bestLine.bbox.height = maxY - minY;
      } else {
        verticalLines.push({
          bbox: { ...word.bbox },
          totalHeight: wordH,
          words: [word]
        });
      }
    }

    // Step 3: Within each vertical line, sort left-to-right and split on horizontal gaps
    const finalLines = [];

    for (const line of verticalLines) {
      // Sort words horizontally in reading order
      line.words.sort((a, b) => a.bbox.x - b.bbox.x);

      // Average word height for this line
      const avgLineHeight = line.totalHeight / line.words.length;
      const maxHorizontalGap = avgLineHeight * maxGapRatio;

      let currentSegment = [];

      for (let i = 0; i < line.words.length; i++) {
        const word = line.words[i];

        if (currentSegment.length === 0) {
          currentSegment.push(word);
          continue;
        }

        const prevWord = currentSegment[currentSegment.length - 1];
        const gap = word.bbox.x - (prevWord.bbox.x + prevWord.bbox.width);

        // If the horizontal gap is larger than relative tolerance, split into a new line segment
        if (gap > maxHorizontalGap) {
          finalLines.push(this.createLineObject(currentSegment));
          currentSegment = [word];
        } else {
          currentSegment.push(word);
        }
      }

      if (currentSegment.length > 0) {
        finalLines.push(this.createLineObject(currentSegment));
      }
    }

    // Step 4: Sort final constructed lines in reading order (top-to-bottom, left-to-right)
    finalLines.sort((a, b) => {
      const dy = a.bbox.y - b.bbox.y;
      if (Math.abs(dy) > 6) return dy;
      return a.bbox.x - b.bbox.x;
    });

    return finalLines;
  }

  /**
   * Constructs a single standardized Line object with text, union bbox, and source words.
   *
   * @param {Array<Object>} words - Array of word objects in left-to-right order
   * @returns {{ text: string, words: Array<Object>, ocrWords: Array<Object>, bbox: Object }}
   */
  static createLineObject(words) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const w of words) {
      minX = Math.min(minX, w.bbox.x);
      minY = Math.min(minY, w.bbox.y);
      maxX = Math.max(maxX, w.bbox.x + w.bbox.width);
      maxY = Math.max(maxY, w.bbox.y + w.bbox.height);
    }

    const bbox = {
      x: minX === Infinity ? 0 : minX,
      y: minY === Infinity ? 0 : minY,
      width: maxX === -Infinity ? 0 : maxX - minX,
      height: maxY === -Infinity ? 0 : maxY - minY
    };

    // Faithfully preserve token texts joined by standard spacing
    const lineText = words.map(w => w.text).join(" ");

    return {
      text: lineText,
      words: words,         // Primary words collection
      ocrWords: words,      // Aliased for direct SpanToBBox.fromOCRWords compatibility
      bbox: bbox
    };
  }
}

if (typeof self !== "undefined") {
  self.OCRLineBuilder = OCRLineBuilder;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { OCRLineBuilder };
}
