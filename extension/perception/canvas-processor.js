// perception/canvas-processor.js
// Modular Canvas Processor module

class CanvasProcessor {
  /**
   * Loads a Data URL or Image Source into an HTMLCanvasElement while preserving dimensions/aspect ratio.
   * @param {string|HTMLImageElement} imageInput - Data URL string or Image element
   * @param {HTMLCanvasElement} [existingCanvas] - Optional existing canvas to render into
   * @returns {Promise<{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, width: number, height: number }>}
   */
  static async loadToCanvas(imageInput, existingCanvas = null) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = existingCanvas || document.createElement("canvas");
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        resolve({
          canvas: canvas,
          ctx: ctx,
          width: width,
          height: height
        });
      };
      img.onerror = (err) => reject(new Error("Failed to load image into Canvas: " + err));

      if (typeof imageInput === "string") {
        img.src = imageInput;
      } else if (imageInput instanceof HTMLImageElement) {
        img.src = imageInput.src;
      } else {
        reject(new Error("Invalid image input type for CanvasProcessor."));
      }
    });
  }

  /**
   * Generates a synthetic high-contrast test canvas for diagnostic OCR verification.
   * @param {number} [width=800]
   * @param {number} [height=400]
   * @returns {HTMLCanvasElement}
   */
  static createSyntheticTestCanvas(width = 800, height = 400) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    // Pure white background
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, width, height);

    // Large high-contrast black text
    ctx.fillStyle = "#000000";
    ctx.font = "bold 36px Arial, sans-serif";
    ctx.fillText("HELLO WORLD", 50, 100);
    ctx.fillText("THIS IS OCR TEST", 50, 180);
    ctx.fillText("123456789", 50, 260);

    return canvas;
  }

  /**
   * Performs a diagnostic pixel check on the provided HTMLCanvasElement.
   * @param {HTMLCanvasElement} canvas
   * @returns {{ width: number, height: number, hasData: boolean, nonZeroPercent: number, nonZeroPixels: number, totalPixels: number }}
   */
  static inspectCanvas(canvas) {
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
      return {
        width: 0,
        height: 0,
        hasData: false,
        nonZeroPercent: 0,
        nonZeroPixels: 0,
        totalPixels: 0
      };
    }

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const width = canvas.width;
    const height = canvas.height;
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;

    let nonZeroCount = 0;
    const totalPixels = width * height;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      if (a > 0 && (r > 0 || g > 0 || b > 0)) {
        nonZeroCount++;
      }
    }

    const nonZeroPercent = Math.round((nonZeroCount / totalPixels) * 10000) / 100;

    return {
      width: width,
      height: height,
      hasData: nonZeroCount > 0,
      nonZeroPercent: nonZeroPercent,
      nonZeroPixels: nonZeroCount,
      totalPixels: totalPixels
    };
  }

  /**
   * Extracts raw ImageData from a canvas context for downstream processing (OCR / Vision).
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} width
   * @param {number} height
   * @returns {ImageData}
   */
  static getImageData(ctx, width, height) {
    return ctx.getImageData(0, 0, width, height);
  }

  /**
   * Maps bounding box coordinates between source and target pixel dimension systems.
   * @param {{ x: number, y: number, width: number, height: number }} bbox
   * @param {{ width: number, height: number }} sourceDim
   * @param {{ width: number, height: number }} targetDim
   * @returns {{ x: number, y: number, width: number, height: number }}
   */
  static mapBoxCoordinates(bbox, sourceDim, targetDim) {
    if (!sourceDim || !targetDim || (sourceDim.width === targetDim.width && sourceDim.height === targetDim.height)) {
      return { ...bbox };
    }
    const scaleX = targetDim.width / sourceDim.width;
    const scaleY = targetDim.height / sourceDim.height;

    return {
      x: Math.round(bbox.x * scaleX),
      y: Math.round(bbox.y * scaleY),
      width: Math.round(bbox.width * scaleX),
      height: Math.round(bbox.height * scaleY)
    };
  }

  /**
   * Adds configurable padding (e.g. 15%) around a bounding box and clamps to canvas bounds.
   * @param {{ x: number, y: number, width: number, height: number }} bbox
   * @param {number} [paddingPercent=0.15]
   * @param {{ width: number, height: number }} canvasDim
   * @returns {{ x: number, y: number, width: number, height: number }}
   */
  static applyBoundingBoxPadding(bbox, paddingPercent = 0.15, canvasDim) {
    const padX = Math.round(bbox.width * paddingPercent);
    const padY = Math.round(bbox.height * paddingPercent);

    const x = Math.max(0, bbox.x - padX);
    const y = Math.max(0, bbox.y - padY);

    const maxW = canvasDim ? canvasDim.width : x + bbox.width + padX * 2;
    const maxH = canvasDim ? canvasDim.height : y + bbox.height + padY * 2;

    const width = Math.min(maxW - x, bbox.width + (padX * 2));
    const height = Math.min(maxH - y, bbox.height + (padY * 2));

    return { x, y, width, height };
  }

  /**
   * Draws non-destructive debug visualization overlays on a canvas for testing (Chunk 7).
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{ type: string, x: number, y: number, width: number, height: number, confidence: number }>} detections
   * @param {string} [labelPrefix="Face"]
   */
  static drawDebugOverlays(canvas, detections, labelPrefix = "FACE") {
    if (!canvas || !detections || detections.length === 0) return;
    const ctx = canvas.getContext("2d");

    ctx.save();
    for (const det of detections) {
      const box = det.bbox || det;
      // Draw bright green bounding box outline ONLY (no black redaction masks)
      ctx.strokeStyle = "#00FF66";
      ctx.lineWidth = Math.max(2, Math.round(canvas.width / 400));
      ctx.strokeRect(box.x, box.y, box.width, box.height);

      // Label banner: FACE confidence: 0.94
      const text = `${labelPrefix} confidence: ${det.confidence.toFixed(2)}`;
      ctx.font = `bold ${Math.max(12, Math.round(canvas.width / 50))}px sans-serif`;
      const textWidth = ctx.measureText(text).width;

      ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
      ctx.fillRect(box.x, Math.max(0, box.y - 24), textWidth + 12, 24);

      ctx.fillStyle = "#00FF66";
      ctx.fillText(text, box.x + 6, Math.max(16, box.y - 8));
    }
    ctx.restore();
  }



  /**
   * Applies privacy mask / redaction overlay over specified bounding box regions (Chunk 8).
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{ x: number, y: number, width: number, height: number }>} regions
   * @param {Object} [options={}] - Options (paddingPercent: 0.15, fillColor: "#000000")
   */
  static applyRedactionMask(canvas, regions, options = {}) {
    if (!canvas || !regions || regions.length === 0) return;
    const ctx = canvas.getContext("2d");
    const paddingPercent = typeof options.paddingPercent === "number" ? options.paddingPercent : 0.15;
    const fillColor = options.fillColor || "#000000";

    const canvasDim = { width: canvas.width, height: canvas.height };

    ctx.save();
    for (const item of regions) {
      const region = item.bbox || item;
      const padded = this.applyBoundingBoxPadding(region, paddingPercent, canvasDim);
      ctx.fillStyle = fillColor;
      ctx.fillRect(padded.x, padded.y, padded.width, padded.height);

      // Add clear warning icon/text pattern on redaction mask
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `bold ${Math.max(10, Math.round(padded.height / 5))}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("[REDACTED QR]", padded.x + padded.width / 2, padded.y + padded.height / 2);
    }
    ctx.restore();
  }
}

// Global exposure for scripts
if (typeof self !== "undefined") {
  self.CanvasProcessor = CanvasProcessor;
}
