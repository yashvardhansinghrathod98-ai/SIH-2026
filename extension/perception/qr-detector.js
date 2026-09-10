// perception/qr-detector.js
// On-Device Dedicated YOLO QR-Code Detector Module using ONNX Runtime Web (WebGPU/WASM)

class QRDetectorModule {
  static session = null;
  static isInitializing = false;
  static initPromise = null;

  // Dedicated QR Model Metadata specifications
  static modelMeta = {
    modelName: "Dedicated YOLO QR-Code Detector",
    modelFilename: "models/qr-model.onnx",
    modelArchitecture: "YOLOv8n-QR (Single Class)",
    targetClass: "QR_code",
    numClasses: 1,
    classNames: ["QR_code"],
    qrClassId: 0,
    qrClassName: "QR_code",
    inputTensorName: "images",
    inputTensorShape: [1, 3, 640, 640],
    inputWidth: 640,
    inputHeight: 640,
    inputDataType: "float32 (NCHW layout)",
    outputTensorName: "output0",
    outputTensorShape: [1, 5, 8400],
    isDedicatedQRModel: true,
    executionProviderUsed: "unknown"
  };

  /**
   * Initializes the ONNX Runtime Web InferenceSession for QR Code Detection offline.
   * Configures local WASM paths and attempts WebGPU / WASM execution providers.
   * @param {Object} [customOptions={}]
   * @returns {Promise<boolean>}
   */
  static async initialize(customOptions = {}) {
    if (this.session) return true;
    if (this.initPromise) return this.initPromise;

    this.isInitializing = true;
    this.initPromise = (async () => {
      try {
        console.log("[QRDetectorModule] Initializing dedicated QR ONNX model session...");

        const ortScope = typeof window !== "undefined" && window.ort
          ? window.ort
          : (typeof self !== "undefined" && self.ort ? self.ort : null);

        if (!ortScope || !ortScope.InferenceSession) {
          throw new Error("ONNX Runtime Web library (ort.all.min.js) is not loaded in scope.");
        }

        // Configure local ONNX WASM path inside Chrome Extension
        const onnxLibPath = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL)
          ? chrome.runtime.getURL("lib/onnx/")
          : "../lib/onnx/";

        if (ortScope.env && ortScope.env.wasm) {
          ortScope.env.wasm.wasmPaths = onnxLibPath;
          ortScope.env.wasm.numThreads = 1; // Single-threaded deterministic mode
        }

        const modelPath = customOptions.modelPath || (
          typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
            ? chrome.runtime.getURL("models/qr-model.onnx")
            : "../models/qr-model.onnx"
        );

        console.log("[QRDetectorModule] Loading QR ONNX model asset from:", modelPath);

        const webgpuAvailable = typeof navigator !== "undefined" && Boolean(navigator.gpu);
        let session = null;
        let providerUsed = "wasm";

        try {
          // Prefer WASM for deterministic CPU SIMD execution across environments
          session = await ortScope.InferenceSession.create(modelPath, {
            executionProviders: ["wasm"],
            graphOptimizationLevel: "all"
          });
          providerUsed = "WASM";
        } catch (sessErr) {
          console.warn("[QRDetectorModule] WASM session creation failed, retrying default provider:", sessErr);
          session = await ortScope.InferenceSession.create(modelPath);
          providerUsed = "default";
        }

        this.session = session;
        this.modelMeta.executionProviderUsed = providerUsed;
        console.log(`[QRDetectorModule] Session successfully initialized using provider: ${providerUsed}`);

        return true;
      } catch (err) {
        console.error("[QRDetectorModule Error] Model initialization failed:", err);
        this.session = null;
        throw err;
      } finally {
        this.isInitializing = false;
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  static isInitialized() {
    return Boolean(this.session);
  }

  /**
   * Letterbox Preprocessing preserving source aspect ratio with gray padding rgb(114, 114, 114).
   * Converts input canvas/image into Float32 NCHW Tensor [1, 3, targetH, targetW].
   * @param {HTMLCanvasElement|HTMLImageElement} imageSource
   * @param {number} [targetW=640]
   * @param {number} [targetH=640]
   * @returns {{ tensor: Object, letterboxParams: Object, debugCanvas: HTMLCanvasElement }}
   */
  static letterboxPreprocess(imageSource, targetW = 640, targetH = 640) {
    const srcW = imageSource.naturalWidth || imageSource.width || 0;
    const srcH = imageSource.naturalHeight || imageSource.height || 0;

    if (srcW === 0 || srcH === 0) {
      throw new Error("Invalid imageSource dimensions provided to letterboxPreprocess.");
    }

    const scale = Math.min(targetW / srcW, targetH / srcH);
    const newW = Math.round(srcW * scale);
    const newH = Math.round(srcH * scale);

    const padX = Math.round((targetW - newW) / 2);
    const padY = Math.round((targetH - newH) / 2);

    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    ctx.fillStyle = "rgb(114, 114, 114)";
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(imageSource, 0, 0, srcW, srcH, padX, padY, newW, newH);

    const imgData = ctx.getImageData(0, 0, targetW, targetH);
    const data = imgData.data;

    const float32Data = new Float32Array(3 * targetW * targetH);
    const channelLength = targetW * targetH;

    for (let i = 0; i < channelLength; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];

      float32Data[i] = r / 255.0;                      // R
      float32Data[channelLength + i] = g / 255.0;       // G
      float32Data[2 * channelLength + i] = b / 255.0;   // B
    }

    const ortScope = typeof window !== "undefined" && window.ort ? window.ort : self.ort;
    const tensor = new ortScope.Tensor("float32", float32Data, [1, 3, targetH, targetW]);

    const letterboxParams = {
      scale,
      padX,
      padY,
      newW,
      newH,
      srcW,
      srcH,
      targetW,
      targetH
    };

    return { tensor, letterboxParams, debugCanvas: canvas };
  }

  /**
   * Reverses letterbox scaling & gray padding to accurately map bounding box coordinates
   * back to the ORIGINAL screenshot canvas resolution.
   * @param {number} cx Center X in 640x640 space
   * @param {number} cy Center Y in 640x640 space
   * @param {number} w Width in 640x640 space
   * @param {number} h Height in 640x640 space
   * @param {Object} letterboxParams
   * @returns {{ x: number, y: number, width: number, height: number }}
   */
  static mapLetterboxToCanvas(cx, cy, w, h, letterboxParams) {
    const { scale, padX, padY, srcW, srcH } = letterboxParams;

    const x1_raw = cx - w / 2;
    const y1_raw = cy - h / 2;

    const unpaddedX1 = (x1_raw - padX) / scale;
    const unpaddedY1 = (y1_raw - padY) / scale;
    const unpaddedW = w / scale;
    const unpaddedH = h / scale;

    const unpaddedX2 = unpaddedX1 + unpaddedW;
    const unpaddedY2 = unpaddedY1 + unpaddedH;

    const x1 = Math.max(0, Math.min(srcW - 1, Math.round(unpaddedX1)));
    const y1 = Math.max(0, Math.min(srcH - 1, Math.round(unpaddedY1)));
    const x2 = Math.max(0, Math.min(srcW, Math.round(unpaddedX2)));
    const y2 = Math.max(0, Math.min(srcH, Math.round(unpaddedY2)));

    const finalW = Math.max(1, x2 - x1);
    const finalH = Math.max(1, y2 - y1);

    return { x: x1, y: y1, width: finalW, height: finalH };
  }

  /**
   * Decodes raw YOLO output tensor predictions [1, 5, 8400] for single class QR_code.
   * Handles both channel-first [1, C, N] and anchor-first interleaved [N, C] memory layouts.
   * @param {Object} outputTensor
   * @param {Object} letterboxParams
   * @param {number} [confidenceThreshold=0.50]
   * @returns {{ rawStats: Object, candidates: Array<Object> }}
   */
  static decodeYOLOOutput(outputTensor, letterboxParams, confidenceThreshold = 0.50) {
    if (!outputTensor || !outputTensor.data) {
      return { rawStats: {}, candidates: [] };
    }

    const data = outputTensor.data;
    const dims = outputTensor.dims;
    const numAnchors = 8400;
    const channels = 5;

    // Dynamic Memory Layout Inspection:
    // If channel-first [1, 5, 8400], data[4 * 8400] is confidence score of anchor 0 (strictly <= 1.0).
    // If interleaved [8400, 5], data[4 * 8400] is index 33600 (anchor 6720, ch 0 cx, which is > 1.5).
    const isTransposed = (dims.length === 3 && dims[1] > dims[2]) ||
      (data.length >= 4 * numAnchors && Math.abs(data[4 * numAnchors]) > 1.5);

    let minScore = Infinity;
    let maxScore = -Infinity;
    const candidates = [];

    for (let i = 0; i < numAnchors; i++) {
      let cx, cy, w, h, conf;

      if (!isTransposed) {
        cx = data[0 * numAnchors + i];
        cy = data[1 * numAnchors + i];
        w  = data[2 * numAnchors + i];
        h  = data[3 * numAnchors + i];
        conf = data[4 * numAnchors + i];
      } else {
        const offset = i * channels;
        cx = data[offset + 0];
        cy = data[offset + 1];
        w  = data[offset + 2];
        h  = data[offset + 3];
        conf = data[offset + 4];
      }

      if (conf < minScore) minScore = conf;
      if (conf > maxScore) maxScore = conf;

      if (conf >= confidenceThreshold) {
        const mappedBox = this.mapLetterboxToCanvas(cx, cy, w, h, letterboxParams);
        candidates.push({
          class: "QR_code",
          confidence: Math.round(conf * 100) / 100,
          rawScore: conf,
          bbox: {
            x: mappedBox.x,
            y: mappedBox.y,
            width: mappedBox.width,
            height: mappedBox.height
          }
        });
      }
    }

    return {
      rawStats: { dims, numAnchors, minScore, maxScore },
      candidates
    };
  }

  /**
   * Calculates Intersection over Union (IoU) ratio between two bounding boxes.
   * @param {{ x: number, y: number, width: number, height: number }} boxA
   * @param {{ x: number, y: number, width: number, height: number }} boxB
   * @returns {number}
   */
  static calculateIoU(boxA, boxB) {
    if (!boxA || !boxB) return 0;

    const x1 = Math.max(boxA.x, boxB.x);
    const y1 = Math.max(boxA.y, boxB.y);
    const x2 = Math.min(boxA.x + boxA.width, boxB.x + boxB.width);
    const y2 = Math.min(boxA.y + boxA.height, boxB.y + boxB.height);

    const intersectionW = Math.max(0, x2 - x1);
    const intersectionH = Math.max(0, y2 - y1);
    const intersectionArea = intersectionW * intersectionH;

    if (intersectionArea === 0) return 0;

    const areaA = boxA.width * boxA.height;
    const areaB = boxB.width * boxB.height;
    const unionArea = areaA + areaB - intersectionArea;

    return unionArea > 0 ? intersectionArea / unionArea : 0;
  }

  /**
   * Applies Non-Maximum Suppression (NMS) to eliminate duplicate overlapping QR detections.
   * @param {Array<Object>} candidates
   * @param {number} [iouThreshold=0.45]
   * @returns {Array<Object>}
   */
  static suppressNonMax(candidates, iouThreshold = 0.45) {
    if (!candidates || candidates.length <= 1) return candidates || [];

    const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
    const keep = [];

    while (sorted.length > 0) {
      const current = sorted.shift();
      keep.push(current);

      for (let i = sorted.length - 1; i >= 0; i--) {
        const iou = this.calculateIoU(current.bbox, sorted[i].bbox);
        if (iou >= iouThreshold) {
          sorted.splice(i, 1);
        }
      }
    }

    return keep;
  }

  /**
   * Main Public API Method: Detects all QR codes present in screenshot canvas / image source.
   * Returns exact required output structure per specification:
   * [
   *   {
   *     class: "QR_code",
   *     confidence: 0.94,
   *     bbox: { x: ..., y: ..., width: ..., height: ... }
   *   }
   * ]
   * @param {HTMLCanvasElement|HTMLImageElement} imageSource
   * @param {number} [confidenceThreshold=0.50] Configurable threshold
   * @param {number} [iouThreshold=0.45] NMS IoU threshold
   * @returns {Promise<{ detections: Array<Object>, metrics: Object }>}
   */
  static async detectQRCodes(imageSource, confidenceThreshold = 0.50, iouThreshold = 0.45) {
    const totalStart = performance.now();

    if (!imageSource) {
      throw new Error("Invalid imageSource provided to detectQRCodes.");
    }

    if (!this.session) {
      await this.initialize();
    }

    // Preprocessing
    const preprocessStart = performance.now();
    const { tensor, letterboxParams, debugCanvas } = this.letterboxPreprocess(imageSource, 640, 640);
    const preprocessTimeMs = Math.round(performance.now() - preprocessStart);

    // Inference
    const inferenceStart = performance.now();
    const inputName = this.session.inputNames[0];
    const feeds = { [inputName]: tensor };
    const results = await this.session.run(feeds);
    const inferenceTimeMs = Math.round(performance.now() - inferenceStart);

    // Decoding
    const postprocessStart = performance.now();
    const outputName = this.session.outputNames[0] || Object.keys(results)[0];
    const outputTensor = results[outputName];

    const decoded = this.decodeYOLOOutput(outputTensor, letterboxParams, confidenceThreshold);
    const { rawStats, candidates } = decoded;

    // IoU Non-Maximum Suppression
    const finalDetections = this.suppressNonMax(candidates, iouThreshold);
    const postprocessTimeMs = Math.round(performance.now() - postprocessStart);
    const totalTimeMs = Math.round(performance.now() - totalStart);

    const metrics = {
      preprocessTimeMs,
      inferenceTimeMs,
      postprocessTimeMs,
      totalTimeMs,
      rawPredictionsTotal: rawStats.numAnchors || 8400,
      candidatesAboveConfThresh: candidates.length,
      finalDetectionsCount: finalDetections.length,
      confidenceThreshold,
      iouThreshold,
      executionProvider: this.modelMeta.executionProviderUsed,
      canvasResolution: `${letterboxParams.srcW} × ${letterboxParams.srcH} px`
    };

    console.log(`[QRDetectorModule] Detection Complete: Found ${finalDetections.length} QR Code(s) in ${totalTimeMs}ms.`);

    return {
      detections: finalDetections,
      metrics,
      rawStats,
      debugCanvas
    };
  }

  static getModelMetadata() {
    return { ...this.modelMeta };
  }

  static async close() {
    if (this.session) {
      try {
        await this.session.release();
      } catch (e) {
        console.warn("[QRDetectorModule] Exception during session release:", e);
      }
      this.session = null;
    }
  }
}

if (typeof self !== "undefined") {
  self.QRDetectorModule = QRDetectorModule;
}
