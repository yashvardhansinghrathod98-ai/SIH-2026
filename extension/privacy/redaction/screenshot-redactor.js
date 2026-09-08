// privacy/redaction/screenshot-redactor.js
// Visual Screenshot Redactor: Draws solid opaque rectangular masks over sensitive PII regions.
// Operates strictly on a sanitized copy of the canvas using the OCR/screenshot coordinate system.

class ScreenshotRedactor {
  /**
   * Generates a sanitized copy of the screenshot canvas by applying solid opaque
   * rectangular masks over sensitive bounding box regions.
   *
   * @param {HTMLCanvasElement} sourceCanvas - Original canvas from observation
   * @param {Array<Object>} fusedDetections - Canonical PII detections from Fusion
   * @param {Object} [metadata={}] - Observation metadata containing viewport and canvas dimensions
   * @param {Object} [options={}] - Options (e.g. maskColor, padding)
   * @returns {{ success: boolean, canvas: HTMLCanvasElement|null, dataUrl: string|null, maskedCount: number, error?: string, reason?: string }}
   */
  static redact(sourceCanvas, fusedDetections = [], metadata = {}, options = {}) {
    if (
      !sourceCanvas ||
      typeof sourceCanvas.getContext !== "function" ||
      sourceCanvas.width <= 0 ||
      sourceCanvas.height <= 0
    ) {
      return {
        success: false,
        canvas: null,
        dataUrl: null,
        maskedCount: 0,
        reason: "no_valid_canvas",
        error: "Invalid or empty source canvas.",
        redactionMetadata: {
          visualRedactions: [],
          visualRedactionComplete: false,
          unmaskedDetections: []
        }
      };
    }

    try {
      // 1. Create a clean copy of the canvas
      let targetCanvas;
      if (typeof document !== "undefined" && typeof document.createElement === "function") {
        targetCanvas = document.createElement("canvas");
      } else if (typeof OffscreenCanvas !== "undefined") {
        targetCanvas = new OffscreenCanvas(sourceCanvas.width, sourceCanvas.height);
      } else {
        return {
          success: false,
          canvas: null,
          dataUrl: null,
          maskedCount: 0,
          error: "Canvas creation unsupported in current environment.",
          redactionMetadata: {
            visualRedactions: [],
            visualRedactionComplete: false,
            unmaskedDetections: []
          }
        };
      }

      targetCanvas.width = sourceCanvas.width;
      targetCanvas.height = sourceCanvas.height;

      const ctx = targetCanvas.getContext("2d");
      if (!ctx) {
        return {
          success: false,
          canvas: null,
          dataUrl: null,
          maskedCount: 0,
          error: "Failed to create 2D canvas context.",
          redactionMetadata: {
            visualRedactions: [],
            visualRedactionComplete: false,
            unmaskedDetections: []
          }
        };
      }

      // Draw original image onto the copy
      ctx.drawImage(sourceCanvas, 0, 0);

      if (!Array.isArray(fusedDetections) || fusedDetections.length === 0) {
        let dataUrl = null;
        try {
          if (typeof targetCanvas.toDataURL === "function") {
            dataUrl = targetCanvas.toDataURL("image/png");
          }
        } catch (_) {}
        return {
          success: true,
          canvas: targetCanvas,
          dataUrl: dataUrl,
          maskedCount: 0,
          width: targetCanvas.width,
          height: targetCanvas.height,
          redactionMetadata: {
            visualRedactions: [],
            visualRedactionComplete: true,
            unmaskedDetections: []
          }
        };
      }

      // 2. Coordinate scaling derivation (Viewport CSS to Canvas Pixels)
      const vp = metadata.viewport;
      let scaleX = 1;
      let scaleY = 1;
      let hasValidScale = false;

      if (vp && typeof vp.width === "number" && vp.width > 0) {
        scaleX = targetCanvas.width / vp.width;
        scaleY = targetCanvas.height / (vp.height || vp.width);
        hasValidScale = true;
      } else {
        const dpr = vp?.devicePixelRatio || metadata.devicePixelRatio;
        if (typeof dpr === "number" && dpr > 0) {
          scaleX = dpr;
          scaleY = dpr;
          hasValidScale = true;
        }
      }

      const maskColor = options.maskColor || "#000000";
      const padding = typeof options.padding === "number" ? options.padding : 2;
      let maskedCount = 0;
      const visualRedactions = [];
      const unmaskedDetections = [];
      const offscreenDetections = [];

      // 3. Mask each reliable bounding box
      for (let dIdx = 0; dIdx < fusedDetections.length; dIdx++) {
        const det = fusedDetections[dIdx];
        if (!det || typeof det !== "object") continue;

        // Check if detection has visual coordinates requiring visual redaction
        const hasDirectBBox = det.bbox && typeof det.bbox.x === "number" && det.bbox.width > 0 && det.bbox.height > 0;
        const hasEvidenceBBox = Array.isArray(det.evidence) && det.evidence.some(
          e => e.bbox && typeof e.bbox.x === "number" && e.bbox.width > 0 && e.bbox.height > 0
        );
        const requiresVisualRedaction = hasDirectBBox || hasEvidenceBBox;

        let canvasX = null;
        let canvasY = null;
        let canvasW = null;
        let canvasH = null;

        // Priority 1: Check evidence for direct OCR canvas bbox
        if (Array.isArray(det.evidence)) {
          const ocrEvidence = det.evidence.find(
            e => (e.source === "OCR" || e.contextSource === "OCR") &&
                 e.bbox &&
                 typeof e.bbox.x === "number" &&
                 typeof e.bbox.y === "number" &&
                 e.bbox.width > 0 &&
                 e.bbox.height > 0
          );
          if (ocrEvidence) {
            canvasX = ocrEvidence.bbox.x;
            canvasY = ocrEvidence.bbox.y;
            canvasW = ocrEvidence.bbox.width;
            canvasH = ocrEvidence.bbox.height;
          }
        }

        // Priority 2: Use canonical bbox scaled from viewport CSS to canvas pixels
        if (
          canvasX === null &&
          det.bbox &&
          typeof det.bbox.x === "number" &&
          typeof det.bbox.y === "number" &&
          det.bbox.width > 0 &&
          det.bbox.height > 0
        ) {
          if (hasValidScale) {
            canvasX = det.bbox.x * scaleX;
            canvasY = det.bbox.y * scaleY;
            canvasW = det.bbox.width * scaleX;
            canvasH = det.bbox.height * scaleY;
          } else if (targetCanvas.width === (metadata.canvas?.width || 0)) {
            canvasX = det.bbox.x;
            canvasY = det.bbox.y;
            canvasW = det.bbox.width;
            canvasH = det.bbox.height;
          }
        }

        // Priority 3: Non-mappable bbox: DO NOT GUESS. Skip visual redaction.
        if (canvasX === null || canvasY === null || canvasW === null || canvasH === null) {
          if (requiresVisualRedaction) {
            unmaskedDetections.push({
              detectionIndex: dIdx,
              type: det.type,
              reason: "unmappable_visual_coordinates"
            });
          }
          continue;
        }

        // Viewport Intersect Check (Option B):
        // If an element is scrolled completely off-screen (e.g. below the fold where canvasY >= targetCanvas.height),
        // it contains zero rendered pixels in the visible screenshot. It requires no visual masking on this canvas.
        const intersectsCanvas = (
          canvasX < targetCanvas.width &&
          (canvasX + canvasW) > 0 &&
          canvasY < targetCanvas.height &&
          (canvasY + canvasH) > 0
        );

        if (!intersectsCanvas) {
          offscreenDetections.push({
            detectionIndex: dIdx,
            type: det.type,
            bbox: { x: canvasX, y: canvasY, width: canvasW, height: canvasH },
            reason: "outside_screenshot_viewport"
          });
          continue;
        }

        // Clamp to canvas boundaries with optional slight padding
        const x = Math.max(0, Math.floor(canvasX - padding));
        const y = Math.max(0, Math.floor(canvasY - padding));
        const right = Math.min(targetCanvas.width, Math.ceil(canvasX + canvasW + padding));
        const bottom = Math.min(targetCanvas.height, Math.ceil(canvasY + canvasH + padding));
        const width = right - x;
        const height = bottom - y;

        if (width <= 0 || height <= 0) {
          if (requiresVisualRedaction) {
            unmaskedDetections.push({
              detectionIndex: dIdx,
              type: det.type,
              reason: "zero_or_negative_mask_dimensions"
            });
          }
          continue;
        }

        // Solid opaque mask (removes visual information entirely, no blur)
        ctx.fillStyle = maskColor;
        ctx.fillRect(x, y, width, height);
        maskedCount++;

        visualRedactions.push({
          detectionIndex: dIdx,
          type: det.type,
          bbox: { x, y, width, height },
          masked: true
        });
      }

      const visualRedactionComplete = unmaskedDetections.length === 0;

      let dataUrl = null;
      try {
        if (typeof targetCanvas.toDataURL === "function") {
          dataUrl = targetCanvas.toDataURL("image/png");
        }
      } catch (_) {}

      console.log(
        `[ScreenshotRedactor] Masked ${maskedCount} PII bounding box regions on canvas (${targetCanvas.width}x${targetCanvas.height}). Off-screen: ${offscreenDetections.length}.`
      );

      return {
        success: true,
        canvas: targetCanvas,
        dataUrl: dataUrl,
        maskedCount: maskedCount,
        width: targetCanvas.width,
        height: targetCanvas.height,
        redactionMetadata: {
          visualRedactions: visualRedactions,
          visualRedactionComplete: visualRedactionComplete,
          unmaskedDetections: unmaskedDetections,
          offscreenDetections: offscreenDetections
        }
      };
    } catch (err) {
      console.error("[ScreenshotRedactor] Error during screenshot redaction:", err);
      return {
        success: false,
        canvas: null,
        dataUrl: null,
        maskedCount: 0,
        error: err?.message || String(err),
        redactionMetadata: {
          visualRedactions: [],
          visualRedactionComplete: false,
          unmaskedDetections: [{ reason: "exception_during_visual_redaction" }]
        }
      };
    }
  }
}

if (typeof self !== "undefined") {
  self.ScreenshotRedactor = ScreenshotRedactor;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { ScreenshotRedactor };
}
