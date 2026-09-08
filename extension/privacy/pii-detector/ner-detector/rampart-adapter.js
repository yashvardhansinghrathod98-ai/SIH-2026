// privacy/pii-detector/ner-detector/rampart-adapter.js
// Adapter converting Rampart token-classification outputs into standardized PIIDetection objects

if (typeof createPIIDetection === "undefined" && typeof require !== "undefined") {
  const piiTypes = require("../pii-types.js");
  global.PIIType = piiTypes.PIIType;
  global.PIISource = piiTypes.PIISource;
  global.createPIIDetection = piiTypes.createPIIDetection;
}

class RampartAdapter {
  /**
   * Rampart BIO tag parser.
   * Splits tags like "B-GIVEN_NAME" into prefix: "B", type: "GIVEN_NAME".
   * Safely handles edge cases such as missing prefixes or "O".
   *
   * @param {string} rawEntity - Raw label from token classification
   * @returns {{ prefix: string, type: string }}
   */
  static parseTag(rawEntity) {
    if (!rawEntity || typeof rawEntity !== "string" || rawEntity === "O") {
      return { prefix: "O", type: "O" };
    }
    if (rawEntity.startsWith("B-")) {
      return { prefix: "B", type: rawEntity.slice(2) };
    }
    if (rawEntity.startsWith("I-")) {
      return { prefix: "I", type: rawEntity.slice(2) };
    }
    return { prefix: "B", type: rawEntity };
  }

  /**
   * Groups raw Transformers.js tokens into unified entity spans based on BIO tags,
   * subword markers ("##"), and sequential index continuity.
   *
   * @param {Array<Object>} rawTokens - Array of { entity, score, index, word }
   * @returns {Array<{ type: string, tokens: Array<Object> }>}
   */
  static groupTokens(rawTokens) {
    if (!Array.isArray(rawTokens) || rawTokens.length === 0) {
      return [];
    }

    const groups = [];
    let currentGroup = null;

    for (const token of rawTokens) {
      const { prefix, type } = this.parseTag(token.entity);

      // Skip non-PII tokens
      if (type === "O") {
        if (currentGroup) {
          groups.push(currentGroup);
          currentGroup = null;
        }
        continue;
      }

      // If no active group, start a new entity group
      if (!currentGroup) {
        currentGroup = { type, tokens: [token] };
        continue;
      }

      const lastToken = currentGroup.tokens[currentGroup.tokens.length - 1];
      const isSameType = (type === currentGroup.type);
      const isConsecutiveIndex = (token.index === lastToken.index + 1);
      const isSubword = token.word.startsWith("##");
      const isPunctOrContinuous = (
        currentGroup.type === "EMAIL" ||
        currentGroup.type === "PHONE" ||
        currentGroup.type === "URL" ||
        /^[.,@_\-/:;?!]+$/.test(token.word) ||
        /^[.,@_\-/:;?!]+$/.test(lastToken.word)
      );

      // Entity continuation conditions:
      // 1. Same entity type AND tagged as inside ("I-")
      // 2. Same entity type AND subword token ("##")
      // 3. Same entity type AND consecutive token index for continuous fields (EMAIL, PHONE, URL) or punctuation
      const isContinuation = isSameType && (
        prefix === "I" ||
        isSubword ||
        (isConsecutiveIndex && isPunctOrContinuous)
      );

      if (isContinuation) {
        currentGroup.tokens.push(token);
      } else {
        // Finalize previous group and start new group
        groups.push(currentGroup);
        currentGroup = { type, tokens: [token] };
      }
    }

    if (currentGroup) {
      groups.push(currentGroup);
    }

    return groups;
  }

  /**
   * Aligns a sequence of tokens with the original input text to extract exact character
   * offsets and preserve original source casing (e.g. "Main Street", "John Smith").
   *
   * @param {string} originalText - The complete original source text
   * @param {Array<Object>} tokens - Array of token objects in this entity group
   * @param {number} startSearchPos - Search cursor offset in source text
   * @returns {{ start: number, end: number, text: string }|null}
   */
  static alignSpan(originalText, tokens, startSearchPos = 0) {
    if (!originalText || typeof originalText !== "string" || !Array.isArray(tokens) || tokens.length === 0) {
      return null;
    }

    // Strategy 1: Direct token classification character offsets if provided by Transformers.js
    const firstTok = tokens[0];
    const lastTok = tokens[tokens.length - 1];
    if (
      firstTok &&
      lastTok &&
      typeof firstTok.start === "number" &&
      typeof lastTok.end === "number" &&
      firstTok.start >= 0 &&
      lastTok.end <= originalText.length &&
      firstTok.start < lastTok.end
    ) {
      return {
        start: firstTok.start,
        end: lastTok.end,
        text: originalText.slice(firstTok.start, lastTok.end)
      };
    }

    // Strategy 2: Sequential token alignment with diacritic-folding support
    const stripAccents = s => (typeof s === "string" ? s.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : "");
    const lowerText = originalText.toLowerCase();
    const normText = stripAccents(lowerText);
    const hasSameLen = normText.length === originalText.length;
    const searchText = hasSameLen ? normText : lowerText;

    let firstStart = -1;
    let lastEnd = -1;
    let currentPos = startSearchPos;

    for (let i = 0; i < tokens.length; i++) {
      const rawWord = tokens[i].word;
      if (!rawWord || typeof rawWord !== "string") continue;
      const cleanWord = rawWord.startsWith("##") ? rawWord.slice(2) : rawWord;
      const searchWord = (hasSameLen ? stripAccents(cleanWord) : cleanWord).toLowerCase();
      if (!searchWord) continue;

      const matchIdx = searchText.indexOf(searchWord, currentPos);
      if (matchIdx === -1) {
        // Fallback: search from beginning if forward search missed
        const retryIdx = searchText.indexOf(searchWord);
        if (retryIdx === -1) return null;
        currentPos = retryIdx;
      } else {
        currentPos = matchIdx;
      }

      if (firstStart === -1) {
        firstStart = currentPos;
      }
      lastEnd = currentPos + searchWord.length;
      currentPos = lastEnd;
    }

    if (firstStart === -1 || lastEnd === -1 || firstStart >= lastEnd) {
      return null;
    }

    return {
      start: firstStart,
      end: lastEnd,
      text: originalText.slice(firstStart, lastEnd)
    };
  }

  /**
   * Fallback string reconstruction from subword/word tokens when source text alignment is unavailable.
   *
   * @param {Array<Object>} tokens - Array of token objects
   * @returns {string} Reconstructed text string
   */
  static reconstructFallbackText(tokens) {
    let result = "";
    for (let i = 0; i < tokens.length; i++) {
      const word = tokens[i].word;
      const clean = word.startsWith("##") ? word.slice(2) : word;
      if (i === 0 || word.startsWith("##") || /^[.,@_\-/:;?!]+$/.test(clean)) {
        result += clean;
      } else {
        result += " " + clean;
      }
    }
    return result;
  }

  /**
   * Maps Rampart entity type strings to our standardized PIIType enum.
   *
   * @param {string} rawType - Rampart entity label (e.g. "GIVEN_NAME", "EMAIL")
   * @returns {string} Standardized PIIType
   */
  static mapToPIIType(rawType) {
    const Types = (typeof PIIType !== "undefined") ? PIIType : (typeof self !== "undefined" ? self.PIIType : {});
    return Types[rawType] || rawType;
  }

  /**
   * Aggregates token confidence scores deterministically.
   * Implements conservative PII detection using Minimum Token Confidence:
   * Confidence = Math.min(...tokenScores)
   *
   * @param {Array<Object>} tokens - Array of token objects with .score
   * @returns {number} Aggregated confidence score rounded to 4 decimals
   */
  static aggregateConfidence(tokens) {
    if (!tokens || tokens.length === 0) return 0.0;
    const minScore = Math.min(...tokens.map(t => typeof t.score === "number" ? t.score : 0.0));
    return Math.round(minScore * 10000) / 10000;
  }

  /**
   * Converts raw Rampart token-classification outputs into standardized PIIDetection[] objects.
   *
   * @param {Array<Object>} rawTokens - Output from Transformers.js token-classification
   * @param {string} [originalText=""] - Source input text
   * @param {Object} [options={}] - Additional context (elementId, bbox)
   * @returns {Array<Object>} Array of standardized PIIDetection objects
   */
  static toPIIDetections(rawTokens, originalText = "", options = {}) {
    if (!Array.isArray(rawTokens) || rawTokens.length === 0) {
      return [];
    }

    const groups = this.groupTokens(rawTokens);
    const detections = [];
    let searchCursor = 0;

    const source = (typeof PIISource !== "undefined" && PIISource.RAMPART) ? PIISource.RAMPART : "RAMPART";
    const creator = (typeof createPIIDetection === "function") ? createPIIDetection : (typeof self !== "undefined" && self.createPIIDetection ? self.createPIIDetection : null);

    for (const group of groups) {
      const piiType = this.mapToPIIType(group.type);
      const confidence = this.aggregateConfidence(group.tokens);

      // Attempt alignment with original text to extract offsets and preserve casing
      const aligned = this.alignSpan(originalText, group.tokens, searchCursor);

      let text;
      let start = null;
      let end = null;

      if (aligned) {
        text = aligned.text;
        start = aligned.start;
        end = aligned.end;
        searchCursor = aligned.end;
      } else {
        text = this.reconstructFallbackText(group.tokens);
      }

      const params = {
        type: piiType,
        source: source,
        elementId: options.elementId || null,
        text: text,
        confidence: confidence,
        reason: `rampart-ner:${group.type}`,
        bbox: options.bbox || null,
        start: start,
        end: end
      };

      if (creator) {
        detections.push(creator(params));
      } else {
        detections.push(params);
      }
    }

    return detections;
  }
}

if (typeof self !== "undefined") {
  self.RampartAdapter = RampartAdapter;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { RampartAdapter };
}
