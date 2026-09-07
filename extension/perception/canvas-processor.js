// perception/canvas-processor.js
// Modular Canvas Processor module

class CanvasProcessor {
  /**
   * Loads a Data URL or Image Source into an HTMLCanvasElement while preserving dimensions/aspect ratio,
   * optionally applying resolution upscaling (default: 2.0x) for enhanced OCR text recognition.
   * @param {string|HTMLImageElement} imageInput - Data URL string or Image element
   * @param {HTMLCanvasElement} [existingCanvas] - Optional existing canvas to render into
   * @param {Object|number} [options={}] - Options object { scale: number } or scale number directly
   * @returns {Promise<{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, width: number, height: number, scale: number, originalWidth: number, originalHeight: number }>}
   */
  static async loadToCanvas(imageInput, existingCanvas = null, options = {}) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = existingCanvas || document.createElement("canvas");
        const origWidth = img.naturalWidth || img.width;
        const origHeight = img.naturalHeight || img.height;

        const rawScale = (typeof options === "number") ? options : (options?.scale !== undefined ? options.scale : 2.0);
        const scale = (typeof rawScale === "number" && rawScale > 0) ? rawScale : 2.0;

        const targetWidth = Math.round(origWidth * scale);
        const targetHeight = Math.round(origHeight * scale);

        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.clearRect(0, 0, targetWidth, targetHeight);
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

        resolve({
          canvas: canvas,
          ctx: ctx,
          width: targetWidth,
          height: targetHeight,
          scale: scale,
          originalWidth: origWidth,
          originalHeight: origHeight
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
   * Upscales an existing HTMLCanvasElement by a given scale factor with high-quality smoothing.
   * @param {HTMLCanvasElement} sourceCanvas
   * @param {number} [scale=2.0]
   * @returns {HTMLCanvasElement}
   */
  static upscaleCanvas(sourceCanvas, scale = 2.0) {
    if (!sourceCanvas || sourceCanvas.width === 0 || sourceCanvas.height === 0) {
      return sourceCanvas;
    }
    const targetCanvas = document.createElement("canvas");
    targetCanvas.width = Math.round(sourceCanvas.width * scale);
    targetCanvas.height = Math.round(sourceCanvas.height * scale);

    const ctx = targetCanvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(sourceCanvas, 0, 0, targetCanvas.width, targetCanvas.height);
    return targetCanvas;
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
}

// Global exposure for scripts
if (typeof self !== "undefined") {
  self.CanvasProcessor = CanvasProcessor;
}
