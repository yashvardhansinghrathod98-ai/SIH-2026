// privacy/pii-detector/dom-text-extractor.js
// Whole-Page Visible DOM Text Extractor using DOM Range & Text Node Traversal

class DOMTextExtractor {
  /**
   * Traverses the actual document DOM to extract all visible text nodes and their bounding boxes.
   * @param {HTMLElement|Document} [rootNode=document.body] - Root node to traverse
   * @returns {Array<{ text: string, bbox: { x: number, y: number, width: number, height: number }, visible: boolean, inViewport: boolean }>}
   */
  static extractVisibleTextRegions(rootNode = document.body) {
    if (!rootNode) return [];

    const textRegions = [];
    const walker = document.createTreeWalker(
      rootNode,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (!node || !node.nodeValue || !node.nodeValue.trim()) {
            return NodeFilter.FILTER_REJECT;
          }

          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          const tag = parent.tagName.toLowerCase();
          if (["script", "style", "noscript", "template", "svg", "iframe", "textarea"].includes(tag)) {
            return NodeFilter.FILTER_REJECT;
          }

          // Never extract text from input fields (preserves privacy)
          if (tag === "input") {
            return NodeFilter.FILTER_REJECT;
          }

          if (!DOMTextExtractor.isElementVisible(parent)) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const range = document.createRange();

    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const rawText = textNode.nodeValue.trim().replace(/\s+/g, " ");
      if (!rawText) continue;

      try {
        range.selectNodeContents(textNode);
        const rects = range.getClientRects();

        let rect = range.getBoundingClientRect();
        if ((!rect || rect.width <= 0 || rect.height <= 0) && rects.length > 0) {
          rect = rects[0];
        }

        if (!rect || rect.width <= 0 || rect.height <= 0) {
          rect = textNode.parentElement.getBoundingClientRect();
        }

        if (!rect || rect.width <= 0 || rect.height <= 0) continue;

        const inViewport = (
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          rect.right > 0 &&
          rect.left < window.innerWidth
        );

        // Extract serializable word-level geometry directly in content script
        const domWords = [];
        const nodeStr = textNode.nodeValue;
        const wordRegex = /\S+/g;
        let match;
        const wordRange = document.createRange();

        while ((match = wordRegex.exec(nodeStr)) !== null) {
          const wordText = match[0];
          const wordStart = match.index;
          const wordEnd = match.index + wordText.length;

          try {
            wordRange.setStart(textNode, wordStart);
            wordRange.setEnd(textNode, wordEnd);
            const wRect = wordRange.getBoundingClientRect();
            if (wRect && wRect.width > 0 && wRect.height > 0) {
              domWords.push({
                text: wordText,
                bbox: {
                  x: Math.round(wRect.left),
                  y: Math.round(wRect.top),
                  width: Math.round(wRect.width),
                  height: Math.round(wRect.height)
                }
              });
            }
          } catch (we) {
            // Ignore individual word measurement errors
          }
        }

        textRegions.push({
          text: rawText,
          bbox: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          domWords: domWords,
          visible: true,
          inViewport: inViewport
        });
      } catch (e) {
        console.warn("[DOMTextExtractor] Range calculation notice:", e);
      }
    }

    return textRegions;
  }

  /**
   * Checks if an HTML element is rendered and visible on screen.
   */
  static isElementVisible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    return true;
  }

  /**
   * Runs whole-page DOM text extraction. Detection is owned by PrivacyPipeline.
   * @returns {{ textRegions: Array, detections: Array }}
   */
  static extractAndDetect() {
    const textRegions = DOMTextExtractor.extractVisibleTextRegions();
    return {
      textRegions: textRegions,
      detections: []
    };
  }
}

if (typeof self !== "undefined") {
  self.DOMTextExtractor = DOMTextExtractor;
}
