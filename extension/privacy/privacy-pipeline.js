// privacy/privacy-pipeline.js
// Pipeline Orchestration Layer: Connects DOM, OCR, and Rampart NER detection branches
// Output: ALL RAW DETECTIONS (strictly unmerged, unfused, and unredacted)

if (typeof require !== "undefined") {
  const fs = require("fs");
  const path = require("path");
  if (typeof global.self === "undefined") {
    global.self = global;
  }
  if (typeof global.PIIType === "undefined") {
    eval(fs.readFileSync(path.join(__dirname, "pii-detector/pii-types.js"), "utf8"));
  }
  if (typeof global.DOMDetector === "undefined") {
    eval(fs.readFileSync(path.join(__dirname, "pii-detector/dom-detector.js"), "utf8"));
  }
  if (typeof global.TextDetector === "undefined") {
    eval(fs.readFileSync(path.join(__dirname, "pii-detector/text-detector.js"), "utf8"));
  }
  if (typeof global.RampartDetector === "undefined") {
    const rampart = require("./pii-detector/ner-detector/rampart-detector.js");
    global.RampartDetector = rampart.RampartDetector || rampart;
  }
  if (typeof global.SpanToBBox === "undefined") {
    const mapper = require("./pii-detector/spatial-mapper/span-to-bbox.js");
    global.SpanToBBox = mapper.SpanToBBox || mapper;
  }
  if (typeof global.OCRQualityFilter === "undefined") {
    const filterPath = path.join(__dirname, "ocr-quality/ocr-quality-filter.js");
    if (fs.existsSync(filterPath)) {
      eval(fs.readFileSync(filterPath, "utf8"));
    }
  }
  if (typeof global.OCRLineBuilder === "undefined") {
    const builderPath = path.join(__dirname, "ocr-quality/ocr-line-builder.js");
    if (fs.existsSync(builderPath)) {
      eval(fs.readFileSync(builderPath, "utf8"));
    }
  }
  if (typeof global.ContextAnalyzer === "undefined") {
    const analyzerPath = path.join(__dirname, "context-analysis/context-analyzer.js");
    if (fs.existsSync(analyzerPath)) {
      const analyzer = require(analyzerPath);
      global.ContextAnalyzer = analyzer.ContextAnalyzer || analyzer;
    }
  }
  if (typeof global.FusionEngine === "undefined") {
    const fusionPath = path.join(__dirname, "confidence-fusion/fusion-engine.js");
    if (fs.existsSync(fusionPath)) {
      const fusion = require(fusionPath);
      global.FusionEngine = fusion.FusionEngine || fusion;
    }
  }
  if (typeof global.TextRedactor === "undefined") {
    const redactorPath = path.join(__dirname, "redaction/text-redactor.js");
    if (fs.existsSync(redactorPath)) {
      const redactor = require(redactorPath);
      global.TextRedactor = redactor.TextRedactor || redactor;
    }
  }
  if (typeof global.ScreenshotRedactor === "undefined") {
    const redactorPath = path.join(__dirname, "redaction/screenshot-redactor.js");
    if (fs.existsSync(redactorPath)) {
      const redactor = require(redactorPath);
      global.ScreenshotRedactor = redactor.ScreenshotRedactor || redactor;
    }
  }
  if (typeof global.PrivacyGate === "undefined") {
    const gatePath = path.join(__dirname, "privacy-gate/privacy-gate.js");
    if (fs.existsSync(gatePath)) {
      const gate = require(gatePath);
      global.PrivacyGate = gate.PrivacyGate || gate;
    }
  }
}

class PrivacyPipeline {
  /**
   * Branch 1: DOM Structural PII
   * Inspects form elements / inputs metadata from PageState.
   * Output goes directly into ALL RAW DETECTIONS.
   *
   * @param {Object} pageState - PageState or array of elements
   * @returns {Array<Object>} PIIDetection[] with source "DOM"
   */
  static runDOMStructural(pageState) {
    if (!pageState) return [];
    const detector = (typeof DOMDetector !== "undefined") ? DOMDetector : (typeof self !== "undefined" ? self.DOMDetector : null);
    if (!detector) {
      console.warn("[PrivacyPipeline] DOMDetector unavailable, skipping Branch 1.");
      return [];
    }
    const elements = pageState.elements || (Array.isArray(pageState) ? pageState : []);
    const detections = detector.detect(elements);
    console.log(`[PrivacyPipeline] Branch 1 (DOM Structural): ${detections.length} detections`);
    return detections;
  }

  /**
   * Branch 2: DOM Visible Text + Regex
   * Passes extracted visible DOM text regions through shared TextDetector.
   * Output goes into ALL RAW DETECTIONS.
   *
   * @param {Array<Object>} textRegions - Array of { text, bbox, elementId }
   * @returns {Array<Object>} PIIDetection[] with source "DOM_TEXT"
   */
  static runDOMTextRegex(textRegions) {
    if (!Array.isArray(textRegions) || textRegions.length === 0) return [];
    const detector = (typeof TextDetector !== "undefined") ? TextDetector : (typeof self !== "undefined" ? self.TextDetector : null);
    if (!detector) {
      console.warn("[PrivacyPipeline] TextDetector unavailable, skipping Branch 2.");
      return [];
    }
    const source = (typeof PIISource !== "undefined" && PIISource.DOM_TEXT) ? PIISource.DOM_TEXT : "DOM_TEXT";
    const detections = [];
    for (let rIdx = 0; rIdx < textRegions.length; rIdx++) {
      const region = textRegions[rIdx];
      if (!region || !region.text) continue;
      const regIndex = typeof region.regionIndex === "number" ? region.regionIndex : rIdx;
      const matched = detector.detect(region.text, {
        source: source,
        elementId: region.elementId || null,
        bbox: region.bbox || null
      });
      for (const m of matched) {
        m.regionIndex = regIndex;
        if (m.reason) {
          m.reason = `${m.reason}:reg${regIndex}`;
        }
      }
      detections.push(...matched);
    }
    console.log(`[PrivacyPipeline] Branch 2 (DOM Text + Regex): ${detections.length} detections`);
    return detections;
  }

  /**
   * Branch 3: Screenshot -> OCR -> Regex
   * Passes OCR recognized text regions through shared TextDetector.
   * Output goes into ALL RAW DETECTIONS.
   *
   * @param {Array<Object>} ocrResults - Array of { text, confidence, bbox }
   * @returns {Array<Object>} PIIDetection[] with source "OCR"
   */
  static runOCRRegex(ocrResults) {
    if (!Array.isArray(ocrResults) || ocrResults.length === 0) return [];
    const detector = (typeof TextDetector !== "undefined") ? TextDetector : (typeof self !== "undefined" ? self.TextDetector : null);
    if (!detector) {
      console.warn("[PrivacyPipeline] TextDetector unavailable, skipping Branch 3.");
      return [];
    }
    const source = (typeof PIISource !== "undefined" && PIISource.OCR) ? PIISource.OCR : "OCR";
    const detections = [];
    for (const item of ocrResults) {
      if (!item || !item.text) continue;
      const matched = detector.detect(item.text, {
        source: source,
        elementId: null,
        bbox: item.bbox || null
      });
      detections.push(...matched);
    }
    console.log(`[PrivacyPipeline] Branch 3 (OCR + Regex): ${detections.length} detections`);
    return detections;
  }

  /**
   * Groups OCR word tokens into natural reading lines/blocks based on vertical
   * alignment, preserving layout context and word geometry for NER.
   *
   * @param {Array<Object>} ocrWords - Array of { text, confidence, bbox }
   * @returns {Array<{ text: string, bbox: Object, ocrWords: Array<Object> }>}
   */
  static groupOCRWordsIntoLines(ocrWords) {
    if (!Array.isArray(ocrWords) || ocrWords.length === 0) {
      return [];
    }

    const validWords = ocrWords.filter(w => w && w.text && w.bbox && typeof w.bbox.y === "number");
    if (validWords.length === 0) return [];

    // Sort words primarily by vertical coordinate (y), secondarily by horizontal (x)
    const sorted = [...validWords].sort((a, b) => {
      const dy = a.bbox.y - b.bbox.y;
      if (Math.abs(dy) > 6) return dy;
      return a.bbox.x - b.bbox.x;
    });

    const lines = [];
    for (const word of sorted) {
      const wordY = word.bbox.y;
      const wordH = word.bbox.height || 16;
      const wordMidY = wordY + wordH / 2;

      let placed = false;
      for (const line of lines) {
        const lineMidY = line.bbox.y + line.bbox.height / 2;
        const lineH = line.bbox.height || 16;
        const maxH = Math.max(wordH, lineH);

        if (Math.abs(wordMidY - lineMidY) <= maxH * 0.5) {
          line.words.push(word);
          line.bbox.x = Math.min(line.bbox.x, word.bbox.x);
          line.bbox.y = Math.min(line.bbox.y, word.bbox.y);
          const right = Math.max(line.bbox.x + line.bbox.width, word.bbox.x + word.bbox.width);
          const bottom = Math.max(line.bbox.y + line.bbox.height, word.bbox.y + word.bbox.height);
          line.bbox.width = right - line.bbox.x;
          line.bbox.height = bottom - line.bbox.y;
          placed = true;
          break;
        }
      }

      if (!placed) {
        lines.push({
          bbox: { ...word.bbox },
          words: [word]
        });
      }
    }

    return lines.map(line => {
      const sortedWords = line.words.sort((a, b) => a.bbox.x - b.bbox.x);
      return {
        text: sortedWords.map(w => w.text).join(" "),
        bbox: line.bbox,
        ocrWords: sortedWords
      };
    });
  }

  /**
   * Runs Rampart NER on visible DOM text regions with DOM-specific spatial mapping.
   * Emits PIIDetection[] with source: "RAMPART" and contextSource: "DOM".
   *
   * @param {Array<Object>} domTextRegions - Array of { text, bbox, domWords }
   * @returns {Promise<Array<Object>>}
   */
  static async runRampartDOM(domTextRegions) {
    if (!Array.isArray(domTextRegions) || domTextRegions.length === 0) return [];
    const rampart = (typeof RampartDetector !== "undefined") ? RampartDetector : (typeof self !== "undefined" ? self.RampartDetector : null);
    const mapper = (typeof SpanToBBox !== "undefined") ? SpanToBBox : (typeof self !== "undefined" ? self.SpanToBBox : null);

    if (!rampart) {
      console.warn("[PrivacyPipeline] RampartDetector unavailable, skipping DOM Rampart.");
      return [];
    }

    const detections = [];
    for (let rIdx = 0; rIdx < domTextRegions.length; rIdx++) {
      const region = domTextRegions[rIdx];
      const text = region?.text;
      if (!text || typeof text !== "string") continue;
      const regIndex = typeof region.regionIndex === "number" ? region.regionIndex : rIdx;

      try {
        const rawEntities = await rampart.detect(text);
        for (const entity of rawEntities) {
          const detection = {
            ...entity,
            source: (typeof PIISource !== "undefined" && PIISource.RAMPART) ? PIISource.RAMPART : "RAMPART",
            contextSource: "DOM",
            regionIndex: regIndex,
            reason: entity.reason ? `${entity.reason}:reg${regIndex}` : `rampart-dom:reg${regIndex}`
          };

          if (mapper) {
            const spatialContext = {
              domWords: region.domWords || null,
              textNode: region.textNode || null,
              sourceText: text
            };
            const grounded = mapper.groundDetection(detection, spatialContext);
            grounded.regionIndex = regIndex;
            if (grounded.reason && !grounded.reason.includes(`:reg${regIndex}`)) {
              grounded.reason = `${grounded.reason}:reg${regIndex}`;
            }
            detections.push(grounded);
          } else {
            detections.push(detection);
          }
        }
      } catch (err) {
        console.warn("[PrivacyPipeline] DOM Rampart notice for text item:", err?.message || err);
      }
    }

    console.log(`[PrivacyPipeline] Branch 4A (DOM Visible Text -> Rampart -> DOM Spatial): ${detections.length} detections`);
    return detections;
  }

  /**
   * Runs Rampart NER on grouped OCR lines with OCR-specific spatial mapping.
   * Emits PIIDetection[] with source: "RAMPART" and contextSource: "OCR".
   *
   * @param {Array<Object>} ocrLines - Array of { text, bbox, ocrWords }
   * @returns {Promise<Array<Object>>}
   */
  static async runRampartOCR(ocrLines) {
    if (!Array.isArray(ocrLines) || ocrLines.length === 0) return [];
    const rampart = (typeof RampartDetector !== "undefined") ? RampartDetector : (typeof self !== "undefined" ? self.RampartDetector : null);
    const mapper = (typeof SpanToBBox !== "undefined") ? SpanToBBox : (typeof self !== "undefined" ? self.SpanToBBox : null);

    if (!rampart) {
      console.warn("[PrivacyPipeline] RampartDetector unavailable, skipping OCR Rampart.");
      return [];
    }

    const detections = [];
    for (const line of ocrLines) {
      const text = line?.text;
      if (!text || typeof text !== "string") continue;

      try {
        const rawEntities = await rampart.detect(text);
        for (const entity of rawEntities) {
          const detection = {
            ...entity,
            source: (typeof PIISource !== "undefined" && PIISource.RAMPART) ? PIISource.RAMPART : "RAMPART",
            contextSource: "OCR"
          };

          if (mapper) {
            const spatialContext = {
              ocrWords: line.ocrWords || line.words || null,
              sourceText: text
            };
            const grounded = mapper.groundDetection(detection, spatialContext);

            // Preserve source OCR confidence information associated with mapped words (Requirement 8)
            const wordsList = line.words || line.ocrWords;
            if (grounded && grounded.bbox && Array.isArray(wordsList) && wordsList.length > 0) {
              const overlappingWords = wordsList.filter(w => (
                w && w.bbox &&
                Math.max(grounded.bbox.x, w.bbox.x) < Math.min(grounded.bbox.x + grounded.bbox.width, w.bbox.x + w.bbox.width) &&
                Math.max(grounded.bbox.y, w.bbox.y) < Math.min(grounded.bbox.y + grounded.bbox.height, w.bbox.y + w.bbox.height)
              ));
              if (overlappingWords.length > 0) {
                const confs = overlappingWords.map(w => {
                  const c = typeof w.confidence === "number" ? w.confidence : 1;
                  return c > 1 ? c / 100 : c;
                });
                grounded.ocrConfidence = Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 100) / 100;
              }
            }

            detections.push(grounded);
          } else {
            detections.push(detection);
          }
        }
      } catch (err) {
        console.warn("[PrivacyPipeline] OCR Rampart notice for text item:", err?.message || err);
      }
    }

    console.log(`[PrivacyPipeline] Branch 4B (OCR Text -> Rampart -> OCR Spatial): ${detections.length} detections`);
    return detections;
  }

  /**
   * Branch 4: Contextual Text -> Rampart -> Spatial Mapper
   * Passes contextual textual inputs through Rampart NER and grounds entity bboxes via SpanToBBox.
   * Output goes into ALL RAW DETECTIONS.
   *
   * @param {Array<Object|string>} contextualItems - Array of { text, domWords, ocrWords, textNode } or strings
   * @param {string} [defaultContextSource="CONTEXTUAL"]
   * @returns {Promise<Array<Object>>} PIIDetection[] with source "RAMPART" and grounded bboxes
   */
  static async runRampartSpatial(contextualItems, defaultContextSource = "CONTEXTUAL") {
    if (!contextualItems) return [];
    const items = Array.isArray(contextualItems) ? contextualItems : [contextualItems];
    if (items.length === 0) return [];

    const rampart = (typeof RampartDetector !== "undefined") ? RampartDetector : (typeof self !== "undefined" ? self.RampartDetector : null);
    const mapper = (typeof SpanToBBox !== "undefined") ? SpanToBBox : (typeof self !== "undefined" ? self.SpanToBBox : null);

    if (!rampart) {
      console.warn("[PrivacyPipeline] RampartDetector unavailable, skipping Branch 4.");
      return [];
    }

    const allGrounded = [];

    for (const item of items) {
      const text = typeof item === "string" ? item : (item?.text || "");
      if (!text || typeof text !== "string") continue;

      const rawRampartDetections = await rampart.detect(text);
      const contextSrc = (typeof item === "object" && item?.contextSource)
        ? item.contextSource
        : (item?.domWords ? "DOM" : (item?.ocrWords ? "OCR" : defaultContextSource));

      for (const rawDet of rawRampartDetections) {
        const detection = {
          ...rawDet,
          source: (typeof PIISource !== "undefined" && PIISource.RAMPART) ? PIISource.RAMPART : "RAMPART",
          contextSource: contextSrc
        };

        if (mapper && typeof item === "object") {
          const spatialContext = {
            domWords: item.domWords || null,
            textNode: item.textNode || null,
            ocrWords: item.ocrWords || null,
            sourceText: text
          };
          allGrounded.push(mapper.groundDetection(detection, spatialContext));
        } else {
          allGrounded.push(detection);
        }
      }
    }

    console.log(`[PrivacyPipeline] Branch 4 (Contextual Text -> Rampart -> Spatial Mapper): ${allGrounded.length} detections`);
    return allGrounded;
  }

  /**
   * Orchestrates the full pipeline across all 4 branches.
   * Produces ALL RAW DETECTIONS without deduplication, fusion, or redaction.
   *
   * @param {Object} inputs
   * @param {Object} [inputs.pageState] - PageState for Branch 1
   * @param {Array<Object>} [inputs.domTextRegions] - Visible DOM text regions for Branch 2
   * @param {Array<Object>} [inputs.ocrResults] - OCR results for Branch 3
   * @param {Array<Object|string>} [inputs.contextualTexts] - Optional override/supplementary contextual items
   * @returns {Promise<{ allRawDetections: Array<Object>, bySource: Object, trace: Object }>}
   */
  static async execute(inputs = {}) {
    console.log("==================================================");
    console.log(" EXECUTING PRIVACY PIPELINE ORCHESTRATION ");
    console.log("==================================================");

    // Branch 1: DOM Structural PII
    const domStructural = this.runDOMStructural(inputs.pageState);

    // Branch 2: DOM Visible Text -> Regex
    const domTextRegex = this.runDOMTextRegex(inputs.domTextRegions);

    // Branch 3: Screenshot -> OCR -> Regex (RAW OCR text path - MUST remain untouched)
    const ocrRegex = this.runOCRRegex(inputs.ocrResults);

    // Branch 4: Contextual Text -> Rampart -> Spatial Mapper
    let rampartDetections = [];
    try {
      if (Array.isArray(inputs.contextualTexts) && inputs.contextualTexts.length > 0) {
        rampartDetections = await this.runRampartSpatial(inputs.contextualTexts);
      } else {
        // Branch 4A: DOM visible text -> Rampart -> DOM Spatial
        const rampartDOM = await this.runRampartDOM(inputs.domTextRegions);

        // Branch 4B: Raw OCR Words -> Quality Filter -> Accepted Words -> Line Builder -> Rampart
        let acceptedOCRWords = inputs.ocrResults || [];
        if (typeof OCRQualityFilter !== "undefined" && Array.isArray(inputs.ocrResults)) {
          const filterResult = OCRQualityFilter.filter(inputs.ocrResults);
          acceptedOCRWords = filterResult.acceptedWords;
        }

        const ocrLines = (typeof OCRLineBuilder !== "undefined")
          ? OCRLineBuilder.buildLines(acceptedOCRWords)
          : this.groupOCRWordsIntoLines(acceptedOCRWords);

        const rampartOCR = await this.runRampartOCR(ocrLines);

        rampartDetections = [...rampartDOM, ...rampartOCR];
      }
    } catch (rampartErr) {
      console.warn("[PrivacyPipeline] Rampart NER branch notice:", rampartErr?.message || rampartErr);
      rampartDetections = [];
    }

    // ALL RAW DETECTIONS: Combined unmerged array
    const allRawDetections = [
      ...domStructural,
      ...domTextRegex,
      ...ocrRegex,
      ...rampartDetections
    ];

    const metadata = {
      ...(inputs.pageState?.metadata || {}),
      ...(inputs.metadata || {})
    };

    // CONTEXT ANALYSIS LAYER: Filters weak/irrelevant Rampart detections before Fusion
    let contextFilteredDetections = allRawDetections;
    let contextTrace = {
      totalRaw: allRawDetections.length,
      rampartBefore: rampartDetections.length,
      rampartRejected: 0,
      passedToFusion: allRawDetections.length
    };

    const contextAnalyzer = (typeof ContextAnalyzer !== "undefined")
      ? ContextAnalyzer
      : (typeof self !== "undefined" && self.ContextAnalyzer
          ? self.ContextAnalyzer
          : (typeof global !== "undefined" && global.ContextAnalyzer ? global.ContextAnalyzer : null));

    if (contextAnalyzer && typeof contextAnalyzer.filter === "function") {
      try {
        const analysisResult = contextAnalyzer.filter(allRawDetections, metadata);
        contextFilteredDetections = analysisResult.contextFilteredDetections || allRawDetections;
        contextTrace = analysisResult.trace || contextTrace;
      } catch (contextErr) {
        console.warn("[PrivacyPipeline] ContextAnalyzer notice:", contextErr?.message || contextErr);
        contextFilteredDetections = allRawDetections;
      }
    } else {
      console.warn("[PrivacyPipeline] ContextAnalyzer unavailable, passing all raw detections to Fusion.");
    }

    // FUSION LAYER: Deduplication, spatial/text matching, and evidence aggregation (UNCHANGED)
    let fusedDetections = contextFilteredDetections;
    let fusionTrace = {
      rawDetectionCount: contextFilteredDetections.length,
      fusedDetectionCount: contextFilteredDetections.length,
      mergedGroupCount: 0
    };

    const fusionEngine = (typeof FusionEngine !== "undefined")
      ? FusionEngine
      : (typeof self !== "undefined" && self.FusionEngine
          ? self.FusionEngine
          : (typeof global !== "undefined" && global.FusionEngine ? global.FusionEngine : null));

    if (fusionEngine && typeof fusionEngine.fuse === "function") {
      try {
        const fusionResult = fusionEngine.fuse(contextFilteredDetections, metadata);
        fusedDetections = fusionResult.fusedDetections || [];
        fusionTrace = fusionResult.trace || fusionTrace;
      } catch (fusionErr) {
        console.warn("[PrivacyPipeline] FusionEngine notice:", fusionErr?.message || fusionErr);
        fusedDetections = contextFilteredDetections;
      }
    } else {
      console.warn("[PrivacyPipeline] FusionEngine unavailable, keeping filtered detections as fused.");
    }

    // REDACTION LAYER: Text Redactor (Sanitized DOM Text) + Screenshot Redactor (Sanitized Screenshot)
    let sanitizedDomText = "";
    let textRedactionTrace = { totalRedactions: 0 };
    let textRedactionResult = null;
    const textRedactor = (typeof TextRedactor !== "undefined")
      ? TextRedactor
      : (typeof self !== "undefined" && self.TextRedactor
          ? self.TextRedactor
          : (typeof global !== "undefined" && global.TextRedactor ? global.TextRedactor : null));

    if (textRedactor && typeof textRedactor.redactDomText === "function") {
      try {
        textRedactionResult = textRedactor.redactDomText(inputs.domTextRegions || [], fusedDetections);
        sanitizedDomText = textRedactionResult.sanitizedText || "";
        textRedactionTrace = textRedactionResult.trace || { totalRedactions: textRedactionResult.totalRedactions || 0 };
      } catch (redactErr) {
        console.warn("[PrivacyPipeline] TextRedactor notice:", redactErr?.message || redactErr);
        sanitizedDomText = "";
      }
    } else {
      console.warn("[PrivacyPipeline] TextRedactor unavailable, skipping DOM text redaction.");
    }

    let sanitizedScreenshot = null;
    let screenshotRedactionTrace = { maskedCount: 0 };
    const screenshotRedactor = (typeof ScreenshotRedactor !== "undefined")
      ? ScreenshotRedactor
      : (typeof self !== "undefined" && self.ScreenshotRedactor
          ? self.ScreenshotRedactor
          : (typeof global !== "undefined" && global.ScreenshotRedactor ? global.ScreenshotRedactor : null));

    const sourceCanvas = inputs.screenshotCanvas || inputs.canvas || null;
    if (screenshotRedactor && typeof screenshotRedactor.redact === "function" && sourceCanvas) {
      try {
        sanitizedScreenshot = screenshotRedactor.redact(sourceCanvas, fusedDetections, metadata);
        screenshotRedactionTrace = { maskedCount: sanitizedScreenshot.maskedCount || 0 };
      } catch (imgErr) {
        console.warn("[PrivacyPipeline] ScreenshotRedactor notice:", imgErr?.message || imgErr);
        sanitizedScreenshot = {
          success: false,
          canvas: null,
          dataUrl: null,
          maskedCount: 0,
          error: imgErr?.message || String(imgErr)
        };
      }
    } else if (!sourceCanvas) {
      sanitizedScreenshot = {
        success: false,
        canvas: null,
        dataUrl: null,
        maskedCount: 0,
        reason: "no_source_canvas"
      };
    }

    // PRIVACY GATE: Final Local Security Boundary
    let privacyGateResult = {
      allowed: false,
      checks: {
        sanitizedDomPresent: false,
        sanitizedScreenshotPresent: false,
        textRedactionComplete: false,
        visualRedactionComplete: false,
        outboundSchemaValid: false
      },
      reasons: ["PRIVACY_GATE_UNAVAILABLE"],
      outboundContext: null
    };

    const privacyGate = (typeof PrivacyGate !== "undefined")
      ? PrivacyGate
      : (typeof self !== "undefined" && self.PrivacyGate
          ? self.PrivacyGate
          : (typeof global !== "undefined" && global.PrivacyGate ? global.PrivacyGate : null));

    if (privacyGate && typeof privacyGate.validate === "function") {
      try {
        privacyGateResult = privacyGate.validate({
          fusedDetections: fusedDetections,
          sanitizedDomText: sanitizedDomText,
          sanitizedScreenshot: sanitizedScreenshot,
          textRedactionMetadata: textRedactionResult?.redactionMetadata || null,
          screenshotRedactionMetadata: sanitizedScreenshot?.redactionMetadata || null,
          domTextRegions: inputs.domTextRegions || [],
          sourceCanvas: sourceCanvas,
          context: {
            goal: inputs.goal || inputs.metadata?.goal || "",
            pageState: inputs.pageState || null,
            metadata: metadata,
            availableActions: inputs.availableActions || null
          }
        });
      } catch (gateErr) {
        console.error("[PrivacyPipeline] PrivacyGate exception (failing closed):", gateErr);
        privacyGateResult = {
          allowed: false,
          checks: {
            sanitizedDomPresent: false,
            sanitizedScreenshotPresent: false,
            textRedactionComplete: false,
            visualRedactionComplete: false,
            outboundSchemaValid: false
          },
          reasons: ["INTERNAL_VALIDATION_ERROR"],
          outboundContext: null
        };
      }
    } else {
      console.warn("[PrivacyPipeline] PrivacyGate unavailable, failing closed.");
    }

    const result = {
      allRawDetections: allRawDetections,
      contextFilteredDetections: contextFilteredDetections,
      fusedDetections: fusedDetections,
      sanitizedDomText: sanitizedDomText,
      sanitizedScreenshot: sanitizedScreenshot,
      privacyGate: privacyGateResult,
      textRedactionMetadata: textRedactionResult?.redactionMetadata || null,
      bySource: {
        DOM: domStructural,
        DOM_TEXT: domTextRegex,
        OCR: ocrRegex,
        RAMPART: rampartDetections
      },
      trace: {
        domStructuralCount: domStructural.length,
        domTextRegexCount: domTextRegex.length,
        ocrRegexCount: ocrRegex.length,
        rampartSpatialCount: rampartDetections.length,
        totalRawDetections: allRawDetections.length,
        rampartBeforeContextCount: contextTrace.rampartBefore,
        rampartRejectedCount: contextTrace.rampartRejected,
        rampartLowConfidenceCount: contextTrace.rampartLowConfidence || 0,
        passedToFusionCount: contextTrace.passedToFusion,
        rawDetectionCount: fusionTrace.rawDetectionCount,
        fusedDetectionCount: fusionTrace.fusedDetectionCount,
        mergedGroupCount: fusionTrace.mergedGroupCount,
        textRedactionsCount: textRedactionTrace.totalRedactions || 0,
        screenshotMaskedCount: screenshotRedactionTrace.maskedCount || 0,
        privacyGateAllowed: privacyGateResult.allowed
      }
    };

    console.log("==================================================");
    console.log(" PRIVACY PIPELINE TRACE SUMMARY ");
    console.log(` - DOM Structural:           ${result.trace.domStructuralCount}`);
    console.log(` - DOM Text + Regex:         ${result.trace.domTextRegexCount}`);
    console.log(` - OCR + Regex:              ${result.trace.ocrRegexCount}`);
    console.log(` - Rampart + Spatial:        ${result.trace.rampartSpatialCount}`);
    console.log(` - TOTAL RAW DETECTIONS:     ${result.trace.totalRawDetections}`);
    console.log(` - Rampart Rejected Context: ${result.trace.rampartRejectedCount} (${result.trace.rampartLowConfidenceCount} below candidate thresholds)`);
    console.log(` - Passed to Fusion:         ${result.trace.passedToFusionCount}`);
    console.log(` - CANONICAL FUSED:          ${result.trace.fusedDetectionCount}`);
    console.log(` - MERGED GROUPS:            ${result.trace.mergedGroupCount}`);
    console.log(` - Text Redactions:          ${result.trace.textRedactionsCount}`);
    console.log(` - Screenshot Masked BBoxes: ${result.trace.screenshotMaskedCount}`);
    console.log("--------------------------------------------------");
    console.log(" CANONICAL FUSED DETECTIONS (PIPELINE OUTPUT) ");
    console.log(result.fusedDetections);
    result.fusedDetections.forEach((det, idx) => {
      const srcList = Array.isArray(det.sources) ? det.sources.join(", ") : det.source;
      const bboxStr = det.bbox
        ? `[x:${Math.round(det.bbox.x)}, y:${Math.round(det.bbox.y)}, w:${Math.round(det.bbox.width)}, h:${Math.round(det.bbox.height)}]`
        : "null";
      const ocrConfStr = typeof det.ocrConfidence === "number" ? ` | OCR-Conf: ${det.ocrConfidence}` : "";
      const ctxSrcStr = det.contextSource ? ` | Context: ${det.contextSource}` : "";
      const evidCount = Array.isArray(det.evidence) ? det.evidence.length : 0;
      console.log(
        ` [Fused #${idx + 1}] ${det.type} | Text: "${det.text}" | Conf: ${det.confidence} | Source: ${det.source} (Sources: [${srcList}])${ctxSrcStr}${ocrConfStr} | BBox: ${bboxStr} | Evidence: ${evidCount}`
      );
    });
    console.log("--------------------------------------------------");
    console.log(" SANITIZED DOM TEXT (VLM PREVIEW) ");
    console.log(result.sanitizedDomText || "(none)");
    console.log("--------------------------------------------------");
    console.log(` SANITIZED SCREENSHOT: success=${result.sanitizedScreenshot?.success ?? false}, masked=${result.sanitizedScreenshot?.maskedCount ?? 0}`);
    console.log("--------------------------------------------------");
    console.log(
      ` PRIVACY GATE: ${privacyGateResult.allowed ? "ALLOWED" : "BLOCKED"} ` +
      (privacyGateResult.reasons.length > 0 ? `(Reasons: [${privacyGateResult.reasons.join(", ")}])` : "(Verified)")
    );
    console.log(
      ` Checks: DOM=${privacyGateResult.checks.sanitizedDomPresent} | Screenshot=${privacyGateResult.checks.sanitizedScreenshotPresent} | ` +
      `TextRedaction=${privacyGateResult.checks.textRedactionComplete} | VisualRedaction=${privacyGateResult.checks.visualRedactionComplete} | ` +
      `Schema=${privacyGateResult.checks.outboundSchemaValid}`
    );
    console.log("==================================================");

    return result;
  }
}

if (typeof self !== "undefined") {
  self.PrivacyPipeline = PrivacyPipeline;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { PrivacyPipeline };
}
