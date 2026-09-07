// privacy/pii-detector/ner-detector/model-loader.js
// Isolated Model Loader for nationaldesignstudio/rampart using Transformers.js

class ModelLoader {
  static MODEL_ID = "nationaldesignstudio/rampart";
  static DTYPE = "q4"; // Quantized 4-bit MatMul + INT8 embedding (~14.7 MB)
  static TASK = "token-classification";

  static _pipelineInstance = null;
  static _executionProvider = null;
  static _loadingPromise = null;

  /**
   * Resolves the Transformers.js library instance across environments.
   */
  static async getTransformers() {
    if (typeof globalThis.transformers !== "undefined" && globalThis.transformers.pipeline) {
      return globalThis.transformers;
    }
    if (typeof self !== "undefined" && self.transformers && self.transformers.pipeline) {
      return self.transformers;
    }
    if (typeof window !== "undefined" && window.transformers && window.transformers.pipeline) {
      return window.transformers;
    }
    if (typeof require !== "undefined") {
      try {
        return require("@huggingface/transformers");
      } catch (e) {
        // Fall through
      }
    }
    try {
      return await import("@huggingface/transformers");
    } catch (err) {
      throw new Error("Failed to resolve @huggingface/transformers in the current environment.");
    }
  }

  /**
   * Checks if WebGPU is supported by the current environment.
   */
  static isWebGPUSupported() {
    return typeof navigator !== "undefined" && Boolean(navigator.gpu);
  }

  /**
   * Loads the Rampart token-classification pipeline.
   * Prefers WebGPU if available, with automatic fallback to WASM (or CPU in Node).
   */
  static async getPipeline(options = {}) {
    if (this._pipelineInstance) {
      return this._pipelineInstance;
    }

    if (this._loadingPromise) {
      return this._loadingPromise;
    }

    this._loadingPromise = (async () => {
      const transformers = await this.getTransformers();
      const { pipeline, env } = transformers;

      if (env) {
        env.allowLocalModels = true;
        env.allowRemoteModels = true;
        if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
          env.backends.onnx.wasm.numThreads = 1;

          // 100% Offline MV3 compliance: Load ONNX Runtime wasm/mjs from local extension assets
          if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getURL === "function") {
            const localLibPath = chrome.runtime.getURL("lib/");
            env.backends.onnx.wasm.wasmPaths = localLibPath;
          }
        }
      }

      // Ensure global ONNX runtime env also points to local extension assets if present
      if (typeof globalThis !== "undefined" && globalThis.ort && globalThis.ort.env && globalThis.ort.env.wasm) {
        if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getURL === "function") {
          globalThis.ort.env.wasm.wasmPaths = chrome.runtime.getURL("lib/");
        }
      }
      if (typeof self !== "undefined" && self.ort && self.ort.env && self.ort.env.wasm) {
        if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getURL === "function") {
          self.ort.env.wasm.wasmPaths = chrome.runtime.getURL("lib/");
        }
      }

      const preferWebGPU = options.preferWebGPU !== false && this.isWebGPUSupported();
      const modelId = options.modelId || this.MODEL_ID;
      const dtype = options.dtype || this.DTYPE;

      // 1. Attempt WebGPU first if supported
      if (preferWebGPU) {
        try {
          console.log(`[ModelLoader] Attempting to load "${modelId}" with WebGPU (dtype: ${dtype})...`);
          
          // 5-second timeout for WebGPU adapter/shader compilation
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("WebGPU initialization timed out after 5s")), 5000)
          );

          const pipe = await Promise.race([
            pipeline(this.TASK, modelId, {
              device: "webgpu",
              dtype: dtype
            }),
            timeoutPromise
          ]);

          this._pipelineInstance = pipe;
          this._executionProvider = "WebGPU";
          console.log(`[ModelLoader] ✅ Model loaded successfully using WebGPU!`);
          return pipe;
        } catch (webgpuErr) {
          console.warn(`[ModelLoader] WebGPU initialization failed (${webgpuErr?.message || webgpuErr}). Falling back to WASM...`);
        }
      }

      // 2. Fallback to WASM (or CPU in Node.js)
      const isNode = typeof process !== "undefined" && process.versions && process.versions.node;
      const fallbackDevice = isNode ? "cpu" : "wasm";
      console.log(`[ModelLoader] Loading "${modelId}" with fallback execution provider: ${fallbackDevice.toUpperCase()} (dtype: ${dtype})...`);

      try {
        const pipe = await pipeline(this.TASK, modelId, {
          device: fallbackDevice,
          dtype: dtype
        });
        this._pipelineInstance = pipe;
        this._executionProvider = isNode ? "WASM/CPU" : "WASM";
        console.log(`[ModelLoader] ✅ Model loaded successfully using ${this._executionProvider}!`);
        return pipe;
      } catch (fallbackErr) {
        console.error(`[ModelLoader] ❌ Failed to load model with fallback provider:`, fallbackErr);
        throw fallbackErr;
      }
    })();

    return this._loadingPromise;
  }

  /**
   * Returns the active execution provider ("WebGPU", "WASM", "WASM/CPU", or null if not yet loaded).
   */
  static getExecutionProvider() {
    return this._executionProvider;
  }

  /**
   * Returns whether the pipeline is currently loaded and ready.
   */
  static isLoaded() {
    return this._pipelineInstance !== null;
  }
}

if (typeof self !== "undefined") {
  self.ModelLoader = ModelLoader;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { ModelLoader };
}
