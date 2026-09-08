// privacy/privacy-gate/privacy-gate.js
// V1 Privacy Gate: Final local security boundary between browser and server-side VLM.
// Enforces complete verification of textual and visual redactions and builds strict allowlisted outboundContext.
// Principles: Zero PII detection in Gate, Fail Closed on any anomaly, No raw data leakage.

const DEFAULT_AVAILABLE_ACTIONS = Object.freeze([
  "click",
  "type",
  "scroll",
  "select",
  "wait",
  "finish"
]);

const FORBIDDEN_FIELD_PATTERNS = Object.freeze([
  "allRawDetections",
  "contextFilteredDetections",
  "fusedDetections",
  "rawOCR",
  "ocrResults",
  "evidence",
  "bboxes",
  "trace",
  "pageState",
  "canvas",
  "metadata",
  "tokens",
  "password",
  "api_key",
  "apiKey",
  "secret",
  "confidence",
  "rampart"
]);

/**
 * Sanitizes a raw URL by stripping all query parameters, hash fragments,
 * credentials, and non-standard schemes. Returns origin + pathname only.
 *
 * @param {string} rawUrl
 * @returns {string} Sanitized URL
 */
function sanitizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return "";
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "chrome-extension:") {
      return "";
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return "";
  }
}

/**
 * Recursively inspects an object to ensure no forbidden internal/debug fields are present.
 *
 * @param {any} obj
 * @returns {boolean} True if clean, false if any forbidden field is found
 */
function containsForbiddenFields(obj) {
  if (!obj || typeof obj !== "object") return false;

  for (const key of Object.keys(obj)) {
    const lowerKey = key.toLowerCase();
    for (const forbidden of FORBIDDEN_FIELD_PATTERNS) {
      if (lowerKey === forbidden.toLowerCase()) {
        return true;
      }
    }
    if (typeof obj[key] === "object" && obj[key] !== null) {
      if (containsForbiddenFields(obj[key])) {
        return true;
      }
    }
  }
  return false;
}

class PrivacyGate {
  /**
   * Validates the sanitized multimodal outputs produced by the Redaction layer
   * before any context is permitted to proceed toward the VLM.
   *
   * @param {Object} inputs
   * @param {Array<Object>} [inputs.fusedDetections=[]]
   * @param {string} [inputs.sanitizedDomText=""]
   * @param {Object|null} [inputs.sanitizedScreenshot=null]
   * @param {Object|null} [inputs.textRedactionMetadata=null]
   * @param {Object|null} [inputs.screenshotRedactionMetadata=null]
   * @param {Array<Object>} [inputs.domTextRegions=[]]
   * @param {HTMLCanvasElement|null} [inputs.sourceCanvas=null]
   * @param {Object} [inputs.context={}]
   * @returns {{ allowed: boolean, checks: Object, reasons: Array<string>, outboundContext: Object|null }}
   */
  static validate(inputs = {}) {
    try {
      const {
        fusedDetections = [],
        sanitizedDomText = "",
        sanitizedScreenshot = null,
        textRedactionMetadata = null,
        screenshotRedactionMetadata = null,
        domTextRegions = [],
        sourceCanvas = null,
        context = {}
      } = inputs;

      const reasons = [];
      const checks = {
        sanitizedDomPresent: false,
        sanitizedScreenshotPresent: false,
        textRedactionComplete: false,
        visualRedactionComplete: false,
        outboundSchemaValid: false
      };

      // -----------------------------------------------------------------------
      // CHECK #1: Sanitized DOM Check
      // -----------------------------------------------------------------------
      const domTextExpected = Array.isArray(domTextRegions) && domTextRegions.length > 0;
      if (typeof sanitizedDomText !== "string") {
        reasons.push("SANITIZED_DOM_MISSING");
        checks.sanitizedDomPresent = false;
      } else if (domTextExpected && sanitizedDomText.trim().length === 0) {
        reasons.push("SANITIZED_DOM_EMPTY");
        checks.sanitizedDomPresent = false;
      } else {
        checks.sanitizedDomPresent = true;
      }

      // -----------------------------------------------------------------------
      // CHECK #2: Sanitized Screenshot Check
      // -----------------------------------------------------------------------
      const screenshotProvided = Boolean(
        sourceCanvas &&
        typeof sourceCanvas.width === "number" &&
        sourceCanvas.width > 0 &&
        typeof sourceCanvas.height === "number" &&
        sourceCanvas.height > 0
      );

      if (!screenshotProvided) {
        // Screenshot modality was not provided/captured
        reasons.push("SANITIZED_SCREENSHOT_MISSING");
        checks.sanitizedScreenshotPresent = false;
      } else if (!sanitizedScreenshot || typeof sanitizedScreenshot !== "object") {
        reasons.push("SANITIZED_SCREENSHOT_MISSING");
        checks.sanitizedScreenshotPresent = false;
      } else if (sanitizedScreenshot.success !== true) {
        reasons.push("SANITIZED_SCREENSHOT_FAILED");
        checks.sanitizedScreenshotPresent = false;
      } else {
        const hasValidDataUrl = typeof sanitizedScreenshot.dataUrl === "string" && sanitizedScreenshot.dataUrl.startsWith("data:image/");
        const hasValidCanvas = Boolean(sanitizedScreenshot.canvas && sanitizedScreenshot.canvas.width > 0);
        if (!hasValidDataUrl && !hasValidCanvas) {
          reasons.push("SANITIZED_SCREENSHOT_INVALID_OUTPUT");
          checks.sanitizedScreenshotPresent = false;
        } else {
          checks.sanitizedScreenshotPresent = true;
        }
      }

      // -----------------------------------------------------------------------
      // CHECK #3: Text Redaction Completeness
      // -----------------------------------------------------------------------
      const numFused = Array.isArray(fusedDetections) ? fusedDetections.length : 0;
      if (numFused === 0) {
        // No PII detections to redact
        checks.textRedactionComplete = true;
      } else if (!textRedactionMetadata || typeof textRedactionMetadata !== "object") {
        reasons.push("TEXT_REDACTION_METADATA_MISSING");
        checks.textRedactionComplete = false;
      } else if (textRedactionMetadata.textRedactionComplete !== true) {
        reasons.push("TEXT_REDACTION_INCOMPLETE");
        checks.textRedactionComplete = false;
      } else if (
        Array.isArray(textRedactionMetadata.unredactedDetections) &&
        textRedactionMetadata.unredactedDetections.length > 0
      ) {
        reasons.push("UNREDACTED_TEXT_DETECTED");
        checks.textRedactionComplete = false;
      } else {
        checks.textRedactionComplete = true;
      }

      // -----------------------------------------------------------------------
      // CHECK #4: Visual Redaction Completeness
      // -----------------------------------------------------------------------
      if (numFused === 0) {
        // No PII detections to mask
        checks.visualRedactionComplete = true;
      } else if (!screenshotProvided) {
        // Screenshot required to visually protect detections on screen
        reasons.push("VISUAL_REDACTION_NOT_PERFORMED");
        checks.visualRedactionComplete = false;
      } else if (!screenshotRedactionMetadata || typeof screenshotRedactionMetadata !== "object") {
        reasons.push("VISUAL_REDACTION_METADATA_MISSING");
        checks.visualRedactionComplete = false;
      } else if (screenshotRedactionMetadata.visualRedactionComplete !== true) {
        reasons.push("VISUAL_REDACTION_INCOMPLETE");
        checks.visualRedactionComplete = false;
      } else if (
        Array.isArray(screenshotRedactionMetadata.unmaskedDetections) &&
        screenshotRedactionMetadata.unmaskedDetections.length > 0
      ) {
        reasons.push("UNMASKED_VISUAL_REGIONS_DETECTED");
        checks.visualRedactionComplete = false;
      } else {
        checks.visualRedactionComplete = true;
      }

      // -----------------------------------------------------------------------
      // CHECK #5: Outbound Schema Construction & Explicit Allowlist
      // -----------------------------------------------------------------------
      const rawUrl = context?.pageState?.metadata?.url || context?.metadata?.url || "";
      const sanitizedPageUrl = sanitizeUrl(rawUrl);

      const candidateOutbound = {
        goal: (typeof context?.goal === "string") ? context.goal : "",
        page: {
          url: sanitizedPageUrl
        },
        dom: {
          text: (typeof sanitizedDomText === "string") ? sanitizedDomText : ""
        },
        visual: {
          screenshot: (sanitizedScreenshot && typeof sanitizedScreenshot.dataUrl === "string")
            ? sanitizedScreenshot.dataUrl
            : ""
        },
        availableActions: Array.isArray(context?.availableActions) && context.availableActions.length > 0
          ? [...context.availableActions]
          : [...DEFAULT_AVAILABLE_ACTIONS]
      };

      // Validate schema conformance and ensure no internal fields are present
      const isSchemaValid = (
        typeof candidateOutbound.goal === "string" &&
        candidateOutbound.page && typeof candidateOutbound.page.url === "string" &&
        candidateOutbound.dom && typeof candidateOutbound.dom.text === "string" &&
        candidateOutbound.visual && typeof candidateOutbound.visual.screenshot === "string" &&
        Array.isArray(candidateOutbound.availableActions) &&
        !containsForbiddenFields(candidateOutbound)
      );

      if (!isSchemaValid) {
        reasons.push("INVALID_OUTBOUND_SCHEMA");
        checks.outboundSchemaValid = false;
      } else {
        checks.outboundSchemaValid = true;
      }

      // -----------------------------------------------------------------------
      // FINAL GATE DECISION: Fail Closed
      // -----------------------------------------------------------------------
      const allPassed = (
        checks.sanitizedDomPresent &&
        checks.sanitizedScreenshotPresent &&
        checks.textRedactionComplete &&
        checks.visualRedactionComplete &&
        checks.outboundSchemaValid
      );

      if (allPassed) {
        return {
          allowed: true,
          checks: checks,
          reasons: [],
          outboundContext: candidateOutbound
        };
      }

      // Fail Closed: If any check failed, outboundContext MUST be null
      return {
        allowed: false,
        checks: checks,
        reasons: reasons,
        outboundContext: null
      };

    } catch (err) {
      console.error("[PrivacyGate] Unexpected exception during validation (failing closed):", err);
      return {
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
  }
}

if (typeof self !== "undefined") {
  self.PrivacyGate = PrivacyGate;
  self.sanitizeUrl = sanitizeUrl;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PrivacyGate,
    sanitizeUrl,
    DEFAULT_AVAILABLE_ACTIONS
  };
}
