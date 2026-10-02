import fs from "node:fs";
import path from "node:path";
import { app, clipboard, dialog, nativeImage } from "electron";
import { createWorker, type Worker } from "tesseract.js";
import { suspendBlurHide, resumeBlurHide } from "./launcher-window";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
let workerPromise: Promise<Worker> | null = null;

function ensureLanguageData(): string {
  const target = path.join(app.getPath("userData"), "ocr-data");
  fs.mkdirSync(target, { recursive: true });
  for (const code of ["chi_sim", "eng"] as const) {
    const pkg = require(`@tesseract.js-data/${code}`) as {
      langPath: string;
    };
    const source = path.join(pkg.langPath, `${code}.traineddata.gz`);
    const dest = path.join(target, `${code}.traineddata.gz`);
    if (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(source).size) {
      fs.copyFileSync(source, dest);
    }
  }
  return target;
}

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    const langPath = ensureLanguageData();
    workerPromise = createWorker("chi_sim+eng", undefined, {
      langPath,
      gzip: true,
      cachePath: path.join(app.getPath("userData"), "ocr-cache"),
    }).catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

function imageResult(image: Electron.NativeImage, name: string) {
  if (image.isEmpty()) throw new Error("图片为空或格式不受支持");
  const size = image.getSize();
  const png = image.toPNG();
  if (png.length > MAX_IMAGE_BYTES) throw new Error("图片过大，请选择 20 MB 以内的图片");
  return {
    dataUrl: `data:image/png;base64,${png.toString("base64")}`,
    name,
    width: size.width,
    height: size.height,
  };
}

export function readClipboardImage() {
  return imageResult(clipboard.readImage(), "剪贴板图片");
}

export async function pickOcrImage() {
  suspendBlurHide();
  try {
    const result = await dialog.showOpenDialog({
      title: "选择要识别的图片",
      properties: ["openFile"],
      filters: [
        { name: "图片", extensions: ["png", "jpg", "jpeg", "bmp", "webp", "gif"] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const file = result.filePaths[0];
    if (fs.statSync(file).size > MAX_IMAGE_BYTES) {
      throw new Error("图片过大，请选择 20 MB 以内的图片");
    }
    return imageResult(nativeImage.createFromPath(file), path.basename(file));
  } finally {
    resumeBlurHide();
  }
}

export async function recognizeImage(dataUrl: string) {
  if (!/^data:image\/(?:png|jpeg|jpg|bmp|webp|gif);base64,/i.test(dataUrl)) {
    throw new Error("无效的图片数据");
  }
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const image = Buffer.from(base64, "base64");
  if (!image.length || image.length > MAX_IMAGE_BYTES) {
    throw new Error("图片为空或超过 20 MB");
  }
  const worker = await getWorker();
  const result = await worker.recognize(image, { rotateAuto: true });
  return {
    text: result.data.text.trim(),
    confidence: Math.round(result.data.confidence || 0),
  };
}
