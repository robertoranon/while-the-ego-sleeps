(() => {
  // src/sdk.ts
  /*!!
   * Copyright Layer, Inc. 2025.
   * All rights reserved.
   *
   * This software and its documentation are the confidential and proprietary information of
   * Layer, Inc ("Proprietary Information"). You shall not disclose such Proprietary
   * Information and shall use it only in accordance with the terms of the license agreement
   * you entered into with Layer, Inc.
   *
   * This software is the proprietary information of Layer, Inc. Use is subject to license terms.
   * License terms can be found at ./license.txt
   *
   * Authors: Sam Shull
   * Date: 2025-07-24
   * Version: 2.4.1
   */
  var MATCH_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  var HASH_VALIDATORS = {
    BASE64: /^[a-z0-9+/=_-]+$/i,
    HEX: /^[0-9a-f]+$/i,
    ALPHABETIC: /^[a-z ]+$/i,
    ALPHANUMERIC: /^[a-z0-9_ ]+$/i
  };
  var TIMEOUT_BLANK_CANVAS = 5e3;
  var THUMB_SIZE = 640;
  var SUPPORTED_VIDEO_MIME_TYPES = ["video/mp4", "video/webm"];
  var config = {};
  var url = new URL(location.href);
  var debug = async (...args) => {
    if (!DEBUG) return;
    const results = await Promise.all(args);
    console.log("DEBUG:", ...results);
  };
  var send = (message) => {
    debug("send", message);
    if (!message) {
      console.trace("No message to send");
      return;
    }
    if (typeof message === "string")
      window.parent.postMessage(`layer:${message}`, "*");
    else window.parent.postMessage(message, "*");
  };
  var trigger = (name, message) => {
    const event = typeof name === "string" ? new CustomEvent(`layer:${name}`) : name;
    debug("trigger", event);
    globalThis.dispatchEvent(event);
    if (message) send(message);
  };
  var decompressJSON = async (value, encoding) => {
    const byteArray = Uint8Array.from(
      [...atob(value)].map((x) => x.charCodeAt(0))
    );
    const stream = new Blob([byteArray]).stream().pipeThrough(new window.DecompressionStream(encoding || "deflate"));
    return await new Response(stream).json();
  };
  var sfc32 = (seed) => {
    const buf = new Uint32Array(4);
    buf.set(seed);
    return () => {
      const t = (buf[0] + buf[1] >>> 0) + buf[3] >>> 0;
      buf[3] = buf[3] + 1 >>> 0;
      buf[0] = buf[1] ^ buf[1] >>> 9;
      buf[1] = buf[2] + (buf[2] << 3) >>> 0;
      buf[2] = (buf[2] << 21 | buf[2] >>> 11) + t >>> 0;
      return t / 4294967296;
    };
  };
  var wait = (ms) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
  };
  var generateUUID = () => {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      var r = Math.random() * 16 | 0, v = c == "x" ? r : r & 3 | 8;
      return v.toString(16);
    });
  };
  var generatePreview = (canvas) => {
    return async (event) => {
      let recording = false;
      const willPause = _paused;
      const controller = new AbortController();
      const signal = controller.signal;
      const aborting = () => {
        debug("Aborting preview");
        controller.abort();
        recording = false;
      };
      globalThis.addEventListener("layer:cancelpreview", aborting, {
        once: true
      });
      const {
        width = THUMB_SIZE,
        height = THUMB_SIZE,
        thumbCaptureMs = 2e3,
        frameRate = 60,
        lengthInMs = 1e4,
        mimeType,
        thumbnailMimeType = "image/jpeg",
        videoBitsPerSecond,
        videoKeyFrameIntervalCount = 10,
        videoKeyFrameIntervalDuration
      } = event.detail ?? {};
      const mime = mimeType || SUPPORTED_VIDEO_MIME_TYPES.find(
        (type) => MediaRecorder.isTypeSupported(type)
      );
      if (!mime) {
        $layer.previewEnabled = false;
        sdkError("No supported mime type found for MediaRecorder.");
      }
      if (!MediaRecorder.isTypeSupported(mime)) {
        $layer.previewEnabled = false;
        sdkError(
          "MediaRecorder does not support recording with mime type: " + mime
        );
      }
      const videoThumb = document.createElement("canvas");
      videoThumb.width = width;
      videoThumb.height = height;
      try {
        debug("generatePreview");
        if (willPause) COMMANDS.play();
        debug("Checking for blank canvas");
        const start = Date.now();
        const videoCtx = videoThumb.getContext("2d");
        do {
          videoCtx.drawImage(canvas, 0, 0, width, height);
          const imageData = new Uint32Array(
            videoCtx.getImageData(0, 0, width, height).data.buffer
          );
          const first = imageData[0];
          const blank = imageData.every((value) => value === first);
          if (!blank) break;
          await wait(500);
          if (Date.now() - start > TIMEOUT_BLANK_CANVAS)
            throw new Error("blank canvas");
        } while (true);
        setTimeout(() => {
          videoThumb.toBlob((blob) => {
            if (signal.aborted) return;
            if (!blob) console.error("Failed to create preview");
            debug("Preview created");
            send(blob);
          }, thumbnailMimeType);
        }, thumbCaptureMs);
        const timerID = setInterval(() => {
          if (recording) {
            videoCtx.drawImage(canvas, 0, 0, videoThumb.width, videoThumb.height);
          } else {
            debug("Stopping capture interval timer");
            clearInterval(timerID);
          }
        }, 1e3 / frameRate);
        const stream = videoThumb.captureStream(frameRate);
        const mediaRecorderOptions = { mimeType: mime };
        if (videoKeyFrameIntervalDuration) {
          mediaRecorderOptions.videoKeyFrameIntervalDuration = videoKeyFrameIntervalDuration;
        }
        if (videoKeyFrameIntervalCount && !mediaRecorderOptions.videoKeyFrameIntervalDuration) {
          mediaRecorderOptions.videoKeyFrameIntervalCount = videoKeyFrameIntervalCount;
        }
        if (videoBitsPerSecond) {
          mediaRecorderOptions.videoBitsPerSecond = videoBitsPerSecond;
        }
        const recorder = new MediaRecorder(stream, mediaRecorderOptions);
        const chunks = [];
        recorder.ondataavailable = (event2) => {
          debug("ondataavailable", recorder.state);
          if (signal.aborted) {
            recording = false;
            recorder.stop();
            return;
          }
          chunks.push(event2.data);
        };
        const recorded = wait(lengthInMs).then(() => {
          debug("recorder.state:", recorder.state);
          if (recorder.state === "recording") {
            recording = false;
            recorder.stop();
          }
        });
        const stopped = new Promise((resolve, reject) => {
          recorder.onstop = resolve;
          recorder.onerror = (event2) => reject(event2.error);
          recording = true;
          recorder.start();
          send("preview-started");
          debug("recording started");
        }).then(() => {
          recording = false;
          send("preview-stopped");
          debug("recorder stopped");
          if (signal.aborted) return;
          if (!chunks.length) {
            console.error("No data available");
            return;
          }
          const video = new Blob(chunks, { type: mime });
          debug("Video created", video);
          send(video);
          debug("Video sent");
        }).catch((error) => {
          debug("recorder error:", error);
          throw error;
        });
        await Promise.all([stopped, recorded]);
        debug("Recording finished");
      } catch (error) {
        console.dir({
          mime,
          frameRate,
          thumbCaptureMs,
          lengthInMs,
          videoKeyFrameIntervalCount,
          videoKeyFrameIntervalDuration
        });
        if (error.message === "blank canvas") {
          debug("Canvas is blank");
          $layer.previewEnabled = false;
          send("preview-blank");
          console.warn(
            "The canvas is blank. If you are using WebGL, you may need to modify your code to preserve the drawing buffer between renders.\nSee https://docs.layer.com"
          );
          return;
        }
        if (recording) send("preview-stopped");
        console.error(error);
        recording = false;
      } finally {
        send("preview-finished");
        globalThis.removeEventListener("layer:cancelpreview", aborting);
        if (willPause) COMMANDS.pause();
      }
    };
  };
  var thumbnailFromVideo = async (video) => {
    const url2 = URL.createObjectURL(video);
    const videoElement = document.createElement("video");
    videoElement.addEventListener(
      "loadedmetadata",
      async () => {
        try {
          await videoElement.play();
          const canvas = document.createElement("canvas");
          Object.assign(canvas, {
            width: videoElement.videoWidth,
            height: videoElement.videoHeight
          });
          const ctx = canvas.getContext("2d");
          ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            if (!blob) console.error("Failed to create thumbnail from video");
            send(blob);
            videoElement.remove();
            URL.revokeObjectURL(url2);
          }, "image/png");
        } catch (error) {
          console.error(error);
        }
      },
      { once: true }
    );
    Object.assign(videoElement, {
      src: url2,
      muted: true,
      autoplay: true,
      loop: true
    });
    Object.assign(videoElement.style, {
      position: "absolute",
      bottom: "0",
      right: "0",
      zIndex: "-9999",
      opacity: "0",
      pointerEvents: "none"
    });
    document.body.appendChild(videoElement);
  };
  var parse = (config2, value) => {
    const impl = PARAM_TYPES[config2.kind.toUpperCase()];
    if (!impl) sdkError(`Invalid param type: ${config2.kind}`);
    if (!impl.validate(value, config2))
      sdkError(`Invalid value for param ${config2.id}: ${value}`);
    return impl.coerce(value);
  };
  var sdkError = (message) => {
    throw new Error(message);
  };
  var isNumber = (x) => {
    return typeof x === "number";
  };
  var isString = (x) => {
    return typeof x === "string";
  };
  var isValidParam = (x) => {
    return typeof x === "object" && isValidID(x.id) && x.kind && PARAM_TYPES[x.kind.toUpperCase()] && x.name;
  };
  var isValidID = (x) => {
    return isString(x) && !(x === "__proto__" || x === "prototype" || x === "constructor");
  };
  var clamp = (x, min, max) => {
    if (x < min) return min;
    return x > max ? max : x;
  };
  var round = (x, y) => {
    return Math.round(x / y) * y;
  };
  var deque = (samples, pred, index = []) => {
    return {
      head() {
        return samples[index[0]];
      },
      push(x) {
        while (index.length && pred(samples[index[index.length - 1]], x)) {
          index.pop();
        }
        index.push(samples.length - 1);
      },
      shift() {
        if (index[0] === 0) index.shift();
        for (let i = index.length; i-- > 0; ) index[i]--;
      }
    };
  };
  var LayerSDK = class {
    url;
    constructor(url2) {
      this.url = url2;
      if (MATCH_UUID.test(url2.pathname)) {
        _uuid = (url2.pathname.match(MATCH_UUID) || [])[0];
      } else if (MATCH_UUID.test(url2.search)) {
        _uuid = (url2.search.match(MATCH_UUID) || [])[0];
      } else if (MATCH_UUID.test(url2.href)) {
        _uuid = (url2.href.match(MATCH_UUID) || [])[0];
      }
      if (url2.searchParams.has("_layerdimensions")) {
        const dimensions = (url2.searchParams.get("_layerdimensions") || "").split("x").map(Number);
        if (dimensions.length === 2 && dimensions.every(isFinite)) {
          Object.defineProperties(this, {
            width: { value: dimensions[0] },
            height: { value: dimensions[1] }
          });
        }
      }
      if (url2.searchParams.has("_layerfps")) {
        const fps = parseInt(url2.searchParams.get("_layerfps") || "1", 10);
        this.startFPSOverlay(fps > 1 && fps < 121 ? fps : 60);
      }
    }
    /** The overall display width.
     * The artwork's canvas element should match this width exactly.
     */
    get width() {
      return window.innerWidth;
    }
    /** The overall display height.
     * The artwork's canvas element should match this width exactly.
     */
    get height() {
      return window.innerHeight;
    }
    /** A UUID that is unique to this version of the parameters */
    get uuid() {
      return _uuid;
    }
    get seed() {
      return this.uuid.replace(/-/g, "").match(/.{8}/g).map((x) => parseInt(x, 16));
    }
    /** Provides a pseudo-random number generator, seeded with the UUID */
    get prng() {
      if (_prng) return _prng;
      _prng = sfc32(this.seed);
      return _prng;
    }
    set canvas(value) {
      this.registerCanvas(value);
    }
    get canvas() {
      return _canvas;
    }
    /**
        This value (when true) indicates that the parent platform intends
        to send events that notify the art when to pause, play, or reset.
        This feature improves the experience for users that have the ability to
        configure parameters and create variations.
    
        When this value is false, the art should play automatically and only reset
        when reloaded.
      */
    get controlled() {
      return this.url.searchParams.get("controlled") === "1" || this.url.searchParams.get("broadcasting") === "1";
    }
    get debug() {
      return DEBUG;
    }
    set debug(value) {
      DEBUG = value ? true : false;
    }
    /**
        A dictionary of field/value pairs representing the runtime values for an
        artwork's input parameters.
    
        Parameters are configured by calling $layer.params(...entries).
    
        Once initialized, this will contain keys corresponding to the .id property
        of each parameter definition. Each value is either the default value
        configured for a given property, or the value that was passed in from the
        parent platform, when one has been provided.
      */
    get parameters() {
      return _parameterProxy;
    }
    /** Turn on 'layer:preview' events */
    set previewEnabled(value) {
      if (value === _previewEnabled) return;
      _previewEnabled = value;
      const action = value ? "enabled" : "disabled";
      send(`preview-${action}`);
    }
    get previewEnabled() {
      return _previewEnabled;
    }
    /** show FPS overlay */
    startFPSOverlay(targetFPS = 60, fill = true) {
      _overlay ??= new FPSOverlay(targetFPS, fill);
      _overlay.start();
      return this;
    }
    /** remopve FPS Overlay */
    stopFPSOverlay() {
      if (_overlay?.running) _overlay.detach();
      return this;
    }
    /** Register a canvas element that can be used tell the LayerSDK
     * where to capture a screenshot. Layer will call toDataUrl() on
     * the canvas when triggered by the parent platform.
     */
    registerCanvas(canvas, sampling = 0) {
      if (!canvas || typeof canvas.toBlob !== "function")
        throw new Error("Invalid canvas element");
      _canvas = canvas;
      globalThis.addEventListener("layer:preview", generatePreview(canvas));
      this.previewEnabled = true;
      this.reportBrightness(sampling);
      return this;
    }
    reportBrightness(sampling) {
      if (!sampling) return;
      if (!_canvas) throw new Error("No canvas registered");
      const worker = new Worker("/layer/brightness-worker.js");
      worker.onmessage = (event) => {
        const { type, brightness, examples } = event.data || {};
        if (examples) console.log("examples", examples);
        if (type === "brightness") {
          _brightness = brightness;
          postMessage(`layerapp:brightness:${brightness}`, "*");
        }
      };
      const offscreenCanvas = new OffscreenCanvas(_canvas.width, _canvas.height);
      worker.postMessage(
        {
          type: "init",
          canvas: offscreenCanvas
        },
        [offscreenCanvas]
      );
      setInterval(async () => {
        try {
          const bitmap = await createImageBitmap(
            _canvas,
            0,
            0,
            _canvas.width,
            _canvas.height
          );
          if (!bitmap) {
            console.error("Failed to create bitmap from canvas");
            return;
          }
          worker.postMessage(
            {
              type: "frame",
              sampling,
              bitmap,
              width: _canvas.width,
              height: _canvas.height
            },
            [bitmap]
          );
        } catch (error) {
          console.error("Error capturing frame:", error);
        }
      }, 1e3);
    }
    reportVideo(video, enableMonitoring = true) {
      if (!enableMonitoring) return this;
      if (!video || typeof video !== "object")
        throw new Error("Invalid video element");
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      setInterval(() => {
        if (video.paused || video.ended) {
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        let sum = 0;
        let count = 0;
        for (let i = 0; i < data.length; i += 8) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const brightness2 = (r + g + b) / 3;
          sum += brightness2;
          count++;
        }
        const averageBrightness = sum / count;
        const brightness = Math.round(averageBrightness / 255 * 100);
        _brightness = brightness;
        postMessage(`layerapp:brightness:${brightness}`, "*");
      }, 1e3);
      return this;
    }
    /** Define one or more parameters using the Parameter schema.
     *  Resolves to the initialized value of the parameters.
     */
    async params(...entries) {
      for (const entry of entries) {
        if (!isValidParam(entry)) {
          console.error("Invalid parameter:", entry);
          throw new Error(
            "Invalid parameter. Must be an object with id, kind, and name properties. id must not be a reserved property name."
          );
        }
        const cleaned = { ...entry, kind: entry.kind.toUpperCase() };
        const impl = PARAM_TYPES[cleaned.kind];
        if (!impl) throw new Error(`Invalid param type: ${cleaned.kind}`);
        if (cleaned.default != null) {
          if (!impl.validate(cleaned.default, cleaned)) {
            console.error(
              `Invalid default value for param ${cleaned.id}: ${cleaned.default}`
            );
            cleaned.default = null;
          } else {
            cleaned.default = impl.coerce(cleaned.default);
          }
        }
        config[cleaned.id] = cleaned;
        _parameters[cleaned.id] = cleaned.default;
        const definition = {
          get: () => _parameters[cleaned.id] ?? cleaned.default,
          configurable: false,
          enumerable: true
        };
        Object.defineProperty(_parameterProxy, cleaned.id, definition);
        send(`parameter:${JSON.stringify(cleaned)}`);
      }
      if (this.url.searchParams.has("_layer")) {
        try {
          const compressed = this.url.searchParams.get("_layer");
          const input = await decompressJSON(
            compressed,
            this.url.searchParams.get("_layerformat") || "deflate"
          );
          if (input) {
            for (const [id, value] of Object.entries(input)) {
              if (!Object.hasOwn(config, id)) {
                console.warn("skipping override for unknown param:", id);
                continue;
              }
              try {
                _parameters[id] = parse(config[id], value);
              } catch (e) {
                console.warn("ignoring param override:", e.message);
              }
            }
          }
          return this.parameters;
        } catch (err) {
          console.error(err);
        }
      }
      if (this.controlled && !_parametersAvailable) {
        const promise = new Promise(
          (resolve) => globalThis.addEventListener(
            "layer:parameters",
            () => void resolve(this.parameters),
            { once: true }
          )
        );
        send("awaiting-parameters");
        return await promise;
      }
      return this.parameters;
    }
    screenshot(dataurl) {
      console.warn("DEPRECATED: Use $layer.preview instead of $layer.screenshot");
      if (!dataurl || typeof dataurl !== "string" || !dataurl.startsWith("data:image/"))
        throw new Error("Invalid dataurl");
      send(`screenshot-taken:${dataurl}`);
      return this;
    }
    /**
     * @param video Supply the parent platform with a generated video with MIME type "video/mp4"
     * @param thumbnail Optionally, supply a thumbnail image also, otherwise the first frame of
     *                  the video will be captured as the thumbnail.
     */
    preview(video, thumbnail) {
      if (!video || !(video instanceof Blob)) throw new Error("Invalid preview");
      if (thumbnail && thumbnail instanceof Blob) {
        send(thumbnail);
      } else {
        thumbnailFromVideo(video);
      }
      send(video);
      return this;
    }
  };
  var ColorResult = class {
    _rgb;
    _hsl;
    value = null;
    constructor(value) {
      this.value = typeof value === "string" ? value : null;
    }
    get hex() {
      return this.value;
    }
    get rgb() {
      if (this._rgb) return this._rgb;
      if (!this.value) return null;
      const rgb = parseInt(this.value.replace("#", ""), 16);
      this._rgb = Object.freeze([rgb >> 16 & 255, rgb >> 8 & 255, rgb & 255]);
      return this._rgb;
    }
    get hsl() {
      if (this._hsl) return this._hsl;
      const rgb = this.rgb;
      if (!rgb) return null;
      let [r, g, b] = rgb;
      r /= 255;
      g /= 255;
      b /= 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      let h = 0, s = 0, l = (max + min) / 2;
      if (delta !== 0) {
        s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
        switch (max) {
          case r:
            h = (g - b) / delta + (g < b ? 6 : 0);
            break;
          case g:
            h = (b - r) / delta + 2;
            break;
          case b:
            h = (r - g) / delta + 4;
            break;
        }
        h /= 6;
      }
      this._hsl = [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
      return this._hsl;
    }
    valueOf() {
      return this.value;
    }
    toString() {
      return this.value;
    }
    toJSON() {
      return this.value;
    }
  };
  var FPSOverlay = class {
    _targetFPS;
    _period;
    _running = false;
    canvas;
    ctx;
    samples = [];
    windowSum = 0;
    prevT = 0;
    peak;
    min;
    max;
    fill;
    constructor(targetFPS = 60, fill = true) {
      this._targetFPS = targetFPS;
      this.fill = fill;
      this.handleResize = this.handleResize.bind(this);
      this.canvas = document.createElement("canvas");
      this.canvas.setAttribute(
        "style",
        "position:fixed;top:0;right:0;z-index:9999;"
      );
      this.handleResize();
      this.canvas.title = "Double-click to close.";
      this.canvas.ondblclick = () => {
        this.detach();
        _overlay = null;
      };
      window.addEventListener("resize", this.handleResize);
      this.ctx = this.canvas.getContext("2d");
      this.ctx.font = "2vh sans-serif";
      this.ctx.textBaseline = "middle";
      this.ctx.strokeStyle = "#fff";
      this.ctx.setLineDash([1, 1]);
      this.samples = [];
      this.period = 600;
      this.peak = this.targetFPS * 1.2;
      this.update = this.update.bind(this);
      this.attach();
    }
    handleResize() {
      const width = this.canvas.width = ~~Math.max(
        Math.max(window.innerWidth, window.innerHeight) / 3,
        250
      );
      const height = this.canvas.height = width >> 1;
      Object.assign(this.canvas.style, {
        width: `${width}px`,
        height: `${height}px`
      });
    }
    get targetFPS() {
      return this._targetFPS;
    }
    set targetFPS(value) {
      this._targetFPS = value;
      this.peak = value * 1.2;
    }
    get period() {
      return this._period;
    }
    set period(value) {
      this._period = value;
      this.samples.length = 0;
      this.windowSum = 0;
      this.prevT = 0;
      this.min = deque(this.samples, (a, b) => a >= b);
      this.max = deque(this.samples, (a, b) => a <= b);
    }
    get running() {
      return this._running;
    }
    attach() {
      if (!document) return;
      if (!document.body)
        return document.addEventListener(
          "DOMContentLoaded",
          this.attach.bind(this),
          { once: true }
        );
      this._running = true;
      document.body.appendChild(this.canvas);
      requestAnimationFrame(this.update);
    }
    detach() {
      this._running = false;
      window.removeEventListener("resize", this.handleResize);
      this.canvas.remove();
    }
    start() {
      const update = (t) => {
        this.update(t);
        if (this._running) requestAnimationFrame(update);
      };
      requestAnimationFrame(update);
    }
    update(t) {
      if (!this._running) return;
      let {
        canvas: { width, height },
        ctx,
        peak,
        min,
        max,
        period,
        samples,
        targetFPS,
        fill
      } = this;
      const delta = t - this.prevT;
      if (delta < 1) return;
      const fps = 1e3 / delta;
      const scale = width / period;
      let num = this.samples.push(fps);
      this.prevT = t;
      min.push(fps);
      max.push(fps);
      if (num > period) {
        num--;
        this.windowSum -= samples.shift();
        min.shift();
        max.shift();
      }
      this.windowSum += fps;
      this.peak = peak += (max.head() * 1.1 - peak) * 0.1;
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(clamp(1 - targetFPS / peak, 0, 1), "#0f0");
      grad.addColorStop(clamp(1 - (targetFPS - 1) / peak, 0, 1), "#ff0");
      grad.addColorStop(clamp(1 - targetFPS / 2 / peak, 0, 1), "#f00");
      grad.addColorStop(1, "#306");
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      ctx[fill ? "fillStyle" : "strokeStyle"] = grad;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(-1, height);
      for (let i = 0; i < num; i++) {
        ctx.lineTo(i * scale, (1 - samples[i] / peak) * height);
      }
      if (fill) {
        ctx.lineTo((num - 1) * scale, height);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.stroke();
      }
      ctx.fillStyle = ctx.strokeStyle = "#fff";
      ctx.setLineDash([1, 1]);
      ctx.beginPath();
      const lower = peak > 30 ? 15 : 5;
      const step = peak > 90 ? 30 : lower;
      const fontSize = ~~(height * 0.1);
      const margin = fontSize * 0.75;
      for (let fps2 = round(Math.min(targetFPS, peak + step / 2), step); fps2 > 0; fps2 -= step) {
        const y = (1 - fps2 / peak) * height;
        ctx.moveTo(width - fontSize * 4, y);
        if (width >= 120) {
          ctx.lineTo(width - 1.5 * fontSize - margin, y);
          ctx.fillText(String(fps2), width - fontSize - margin, y + 1);
        } else {
          ctx.lineTo(width, y);
        }
      }
      ctx.stroke();
      ctx.font = `${fontSize}px sans-serif`;
      const lineHeight = fontSize * 1.4;
      [
        `sma(${num}): ${(this.windowSum / num).toFixed(1)} fps`,
        `max: ${max.head().toFixed(1)} fps`,
        `min: ${min.head().toFixed(1)} fps`,
        _brightness ? `brightness: ${_brightness}%` : ""
      ].forEach((label, i) => {
        if (!label) return;
        const y = height - margin - i * lineHeight;
        ctx.fillText(label, margin, y);
      });
      requestAnimationFrame(this.update);
    }
  };
  var COMMANDS = {
    cancelpreview() {
      trigger("cancelpreview");
    },
    debug() {
      DEBUG = !DEBUG;
    },
    screenshot() {
      trigger("screenshot");
    },
    preview(input) {
      try {
        const data = input ? JSON.parse(input) : {};
        trigger(new CustomEvent("layer:preview", { detail: data }));
      } catch (err) {
        console.error(err);
      }
    },
    play() {
      _paused = false;
      trigger("play", "playing");
    },
    pause() {
      _paused = true;
      trigger("pause", "paused");
    },
    reset() {
      trigger("reset");
    },
    paramchange(input) {
      try {
        if (!input) return;
        const data = JSON.parse(input);
        debug("parameter", data);
        if (!(data?.id && Object.hasOwn(config, data.id) && data.value != null))
          return;
        const { id, value } = data;
        if (_parameters[id] === value) return;
        _parameters[id] = parse(config[id], value);
        _uuid = generateUUID();
        _prng = null;
        const detail = { id, value: _parameterProxy[id] };
        trigger(new CustomEvent("layer:paramchange", { detail }));
        trigger("parameters");
      } catch (err) {
        console.error(err);
      }
    },
    parameters(input) {
      try {
        if (!input)
          throw new Error("layer:parameters message must include a JSON string");
        const data = JSON.parse(input);
        debug("parameters", _parametersAvailable, data);
        if (!data) return;
        _prng = null;
        for (const [id, value] of Object.entries(data)) {
          if (_parameters[id] === value) continue;
          _uuid = generateUUID();
          _parameters[id] = parse(config[id], value);
          if (_parametersAvailable) {
            const detail = { id, value: _parameterProxy[id] };
            trigger(new CustomEvent("layer:paramchange", { detail }));
          }
        }
        _parametersAvailable = true;
        trigger("parameters");
      } catch (err) {
        console.error(err);
      }
    },
    overlay(input) {
      try {
        const data = input ? JSON.parse(input) : {};
        if (data.show === false || data.hide) {
          if (_overlay?.running) _overlay.detach();
          return;
        }
        _overlay ??= new FPSOverlay(data.targetFPS, data.fill);
        if (Object.hasOwn(data, "targetFPS")) _overlay.targetFPS = data.targetFPS;
        if (Object.hasOwn(data, "fill")) _overlay.fill = data.fill;
        if (!_overlay.running) _overlay.attach();
      } catch (error) {
        console.error(error);
      }
    }
  };
  var PARAM_TYPES = {
    BOOLEAN: {
      validate(value) {
        return value === true || value === false || value === "true" || value === "false" || value === 1 || value === 0 || value === "1" || value === "0";
      },
      coerce(value) {
        return value === true || value === 1 || value === "true" || value === "1";
      }
    },
    COLOR: {
      validate(value) {
        return isString(value) && /^#[0-9a-f]{6}$/i.test(value);
      },
      coerce(value) {
        return new ColorResult(value);
      }
    },
    HASH: {
      validate(value, spec) {
        if (!isString(value)) return false;
        if (spec.minLength && value.length < spec.minLength) return false;
        if (spec.maxLength && value.length > spec.maxLength) return false;
        if (spec.pattern != null && !Object.hasOwn(HASH_VALIDATORS, spec.pattern))
          return false;
        return HASH_VALIDATORS[spec.pattern || "ALPHANUMERIC"].test(value);
      },
      coerce(value) {
        return value;
      }
    },
    LIST: {
      validate(value, spec) {
        if (!isString(value)) return false;
        return spec.options.some(
          (opt) => (isString(opt) ? opt : opt.value) === value
        );
      },
      coerce(value) {
        return value;
      }
    },
    NUMBER: {
      validate(value, spec) {
        if (isString(value)) value = +value;
        if (!isNumber(value) || isNaN(value) || !isFinite(value)) return false;
        if (spec.min != null) {
          if (isString(spec.min)) spec.min = +spec.min;
          if (value < spec.min) return false;
        }
        if (spec.max != null) {
          if (isString(spec.max)) spec.max = +spec.max;
          if (value > Number(spec.max)) return false;
        }
        return true;
      },
      coerce(value) {
        return +value;
      }
    }
  };
  var _uuid = generateUUID();
  var _canvas;
  var _prng;
  var _paused = false;
  var _brightness;
  var _parameters = {};
  var _parameterProxy = {};
  var _previewEnabled = false;
  var _parametersAvailable = false;
  var _overlay;
  var DEBUG = url.searchParams.has("debug") || url.hostname.endsWith(".art") || url.hostname.endsWith(".local") || url.hostname === "localhost" || url.hostname === "127.0.0.1" || localStorage.getItem("layer:generative-debug") === "true";
  if (localStorage.getItem("layer:generative-debug") === "false") DEBUG = false;
  debug("location.href", url.href);
  var $layer = new LayerSDK(url);
  _paused = $layer.controlled;
  addEventListener("message", (event) => {
    if (!event["data"]) return;
    const data = event["data"];
    debug("Message received generative.js:", data);
    if (typeof data !== "string") return;
    if (!data.startsWith("layer:")) return;
    const [, command, , input] = data.match(
      /^layer:([^:]+)(:(.+))?$/
    );
    if (Object.hasOwn(COMMANDS, command) && typeof COMMANDS[command] === "function") {
      return void COMMANDS[command](input);
    }
    debug("Unhandled message:", data);
  });
  addEventListener("load", () => {
    send("data-loaded");
  });
  addEventListener("beforeunload", () => {
    send("preview-disabled");
  });
  addEventListener("resize", () => {
    trigger(
      new CustomEvent("layer:dimensionschange", {
        detail: {
          width: $layer.width,
          height: $layer.height
        }
      })
    );
  });
  var layer_sdk = Object.freeze($layer);

  // src/sdk_iife.js
  globalThis.$layer = layer_sdk;
})();
