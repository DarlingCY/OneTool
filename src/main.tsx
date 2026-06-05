import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { Check, Copy, Github, Image as ImageIcon, Play, Plus, RefreshCw, Save, X } from "lucide-react";
import type { SyntaxKind } from "./components/CodeEditor";
import { base64PayloadToBytes, base64ToBytes, bytesToBase64, extractBase64Payload } from "./lib/base64";
import { categories, isAesToolKind, isContentToolKind, isMediaBase64ToolKind, isSmToolKind, type AesToolKind, type ContentToolKind, type ImageToolKind, type MediaBase64ToolKind, type SmToolKind, type TextOperationKind, type ToolKind } from "./tools";
import "./styles.css";

const CodeEditor = React.lazy(() => import("./components/CodeEditor"));

interface AesOptions {
  action: "encrypt" | "decrypt";
  mode: string;
  padding: string;
  key: string;
  iv: string;
  inputFormat: string;
  outputFormat: string;
}

interface Sm2Options {
  action: "encrypt" | "decrypt";
  publicKey: string;
  privateKey: string;
  keyFormat: string;
  inputFormat: string;
  outputFormat: string;
}

interface Sm4Options {
  action: "encrypt" | "decrypt";
  mode: string;
  padding: string;
  key: string;
  iv: string;
  inputFormat: string;
  outputFormat: string;
}

interface ImageCompressOptions {
  mode: "lossless" | "high";
  quality?: number;
}

interface ImageCompressResult {
  data: string;
  extension: string;
  originalSize: number;
  compressedSize: number;
  width: number;
  height: number;
}

interface MediaToolConfig {
  title: string;
  pickerLabel: string;
  accept: string;
  defaultMime: string;
  defaultExtension: string;
  defaultFileName: string;
  emptyPreviewText: string;
  helpText: string;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_IMAGE_FILE_BYTES = 50 * 1024 * 1024;
const MAX_MEDIA_FILE_BYTES = 30 * 1024 * 1024;
const MAX_MEDIA_BASE64_CHARS = Math.ceil((MAX_MEDIA_FILE_BYTES * 4) / 3) + 1024;
const MAX_SYNTAX_DETECT_CHARS = 200_000;

function isFileTooLarge(file: File, maxBytes: number) {
  return file.size > maxBytes;
}

async function processText(operation: TextOperationKind, input: string) {
  return invoke<string>("process_text", { operation, input });
}

async function processAes(input: string, options: AesOptions) {
  return invoke<string>("process_aes", { input, options });
}

async function processSm2(input: string, options: Sm2Options) {
  return invoke<string>("process_sm2", { input, options });
}

async function processSm3(input: string, inputFormat: string, outputFormat: string) {
  return invoke<string>("process_sm3", { input, inputFormat, outputFormat });
}

async function processSm4(input: string, options: Sm4Options) {
  return invoke<string>("process_sm4", { input, options });
}

async function generateSm2Keypair(outputFormat: string) {
  return invoke<[string, string]>("generate_sm2_keypair", { outputFormat, compressed: false });
}

async function compressImage(input: Uint8Array, options: ImageCompressOptions) {
  const headers: Record<string, string> = { "x-mode": options.mode };
  if (options.quality !== undefined) headers["x-quality"] = String(options.quality);
  return invoke<ImageCompressResult>("compress_image", input, { headers });
}

function encodeTextAsBase64(value: string) {
  return bytesToBase64(utf8Encoder.encode(value));
}

function decodeBase64AsText(value: string) {
  return utf8Decoder.decode(base64ToBytes(value));
}

function extensionFromName(name: string) {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/i);
  return match?.[1] || "";
}

function extensionFromMime(mime: string, fallback: string) {
  const normalized = mime.toLowerCase();
  const mimeMap: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "image/x-icon": "ico",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
  };
  return mimeMap[normalized] || fallback;
}

function getMediaToolConfig(tool: MediaBase64ToolKind): MediaToolConfig {
  if (tool === "base64-image") {
    return {
      title: "图片 ↔ Base64",
      pickerLabel: "选择图片文件",
      accept: "image/png,image/jpeg,image/webp,image/bmp,image/gif,image/tiff,image/x-icon",
      defaultMime: "image/png",
      defaultExtension: "png",
      defaultFileName: "image-from-base64",
      emptyPreviewText: "选择图片后可转为 Base64；粘贴 Base64 后可解码预览并保存。",
      helpText: "支持原始 Base64 和 data:image/...;base64, 前缀格式。",
    };
  }

  return {
    title: "音频 ↔ Base64",
    pickerLabel: "选择音频文件",
    accept: "audio/*",
    defaultMime: "audio/mpeg",
    defaultExtension: "mp3",
    defaultFileName: "audio-from-base64",
    emptyPreviewText: "选择音频后可转为 Base64；粘贴 Base64 后可解码试听并保存。",
    helpText: "支持原始 Base64 和 data:audio/...;base64, 前缀格式。",
  };
}

function detectOutputSyntax(value: string): SyntaxKind {
  const trimmed = value.trim();
  if (!trimmed) return "text";
  if (trimmed.length > MAX_SYNTAX_DETECT_CHARS) return "text";

  try {
    JSON.parse(trimmed);
    return "json";
  } catch {
    // ignore
  }

  if ((trimmed.startsWith("<") && trimmed.endsWith(">")) || trimmed.startsWith("<?xml")) {
    return "xml";
  }

  return "text";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

interface ContentPane {
  id: number;
  value: string;
  error: string;
}

const MAX_CONTENT_PANES = 4;
const APP_VERSION = import.meta.env.VITE_APP_VERSION || "0.0.0";
const REPOSITORY_URL = "https://github.com/DarlingCY/OneTool";
const createEmptyContentPane = (): ContentPane => ({ id: 1, value: "", error: "" });
const createInitialContentPaneState = (): Record<ContentToolKind, ContentPane[]> => ({
  json: [createEmptyContentPane()],
  xml: [createEmptyContentPane()],
});

function App() {
  const [tool, setTool] = React.useState<ToolKind>("json");
  const [input, setInput] = React.useState("");
  const [output, setOutput] = React.useState("");
  const [error, setError] = React.useState("");
  const [contentPaneState, setContentPaneState] = React.useState<Record<ContentToolKind, ContentPane[]>>(createInitialContentPaneState);
  const [copied, setCopied] = React.useState(false);
  const [updateStatus, setUpdateStatus] = React.useState("");
  const [checkingUpdate, setCheckingUpdate] = React.useState(false);
  const [selectedImageName, setSelectedImageName] = React.useState("");
  const [selectedImageBytes, setSelectedImageBytes] = React.useState<Uint8Array<ArrayBuffer>>(new Uint8Array());
  const [imageMode, setImageMode] = React.useState<"lossless" | "high">("lossless");
  const [imageQuality, setImageQuality] = React.useState(80);
  const [imageResult, setImageResult] = React.useState<ImageCompressResult | null>(null);
  const [imageStatus, setImageStatus] = React.useState("");
  const [compressingImage, setCompressingImage] = React.useState(false);
  const [selectedMediaName, setSelectedMediaName] = React.useState("");
  const [selectedMediaBytes, setSelectedMediaBytes] = React.useState<Uint8Array<ArrayBuffer>>(new Uint8Array());
  const [selectedMediaMime, setSelectedMediaMime] = React.useState("");
  const [mediaBase64, setMediaBase64] = React.useState("");
  const [mediaStatus, setMediaStatus] = React.useState("");
  const [mediaIncludeDataUrl, setMediaIncludeDataUrl] = React.useState(true);
  const [decodedMediaBytes, setDecodedMediaBytes] = React.useState<Uint8Array<ArrayBuffer>>(new Uint8Array());
  const [decodedMediaMime, setDecodedMediaMime] = React.useState("");
  const [decodedMediaExtension, setDecodedMediaExtension] = React.useState("");
  const [mediaPreviewUrl, setMediaPreviewUrl] = React.useState("");
  const [aesMode, setAesMode] = React.useState("CBC");
  const [aesPadding, setAesPadding] = React.useState("pkcs7padding");
  const [aesKey, setAesKey] = React.useState("");
  const [aesIv, setAesIv] = React.useState("");
  const [aesInputFormat, setAesInputFormat] = React.useState("string");
  const [aesOutputFormat, setAesOutputFormat] = React.useState("base64");
  const [sm2PublicKey, setSm2PublicKey] = React.useState("");
  const [sm2PrivateKey, setSm2PrivateKey] = React.useState("");
  const [sm2KeyFormat, setSm2KeyFormat] = React.useState("hex");
  const [smInputFormat, setSmInputFormat] = React.useState("string");
  const [smOutputFormat, setSmOutputFormat] = React.useState("hex");
  const [sm4Mode, setSm4Mode] = React.useState("CBC");
  const [sm4Padding, setSm4Padding] = React.useState("PKCS7Padding");
  const [sm4Key, setSm4Key] = React.useState("");
  const [sm4Iv, setSm4Iv] = React.useState("");

  React.useEffect(() => {
    setOutput("");
    setError("");
    setSelectedMediaName("");
    setSelectedMediaBytes(new Uint8Array());
    setSelectedMediaMime("");
    setMediaBase64("");
    setMediaStatus("");
    setDecodedMediaBytes(new Uint8Array());
    setDecodedMediaMime("");
    setDecodedMediaExtension("");
  }, [tool]);

  React.useEffect(() => {
    if (tool === "sm3-hash") {
      setSmInputFormat("string");
      setSmOutputFormat("hex");
    }
  }, [tool]);

  React.useEffect(() => {
    if (!isMediaBase64ToolKind(tool)) {
      setMediaPreviewUrl("");
      return;
    }

    const previewBytes = decodedMediaBytes.length ? decodedMediaBytes : selectedMediaBytes;
    const previewMime = decodedMediaBytes.length ? decodedMediaMime : selectedMediaMime;

    if (!previewBytes.length || !previewMime) {
      setMediaPreviewUrl("");
      return;
    }

    const url = URL.createObjectURL(new Blob([previewBytes], { type: previewMime }));
    setMediaPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [tool, decodedMediaBytes, decodedMediaMime, selectedMediaBytes, selectedMediaMime]);

  const run = async (actionOverride?: "encrypt" | "decrypt" | "encode" | "decode") => {
    setError("");
    setCopied(false);
    try {
      let result: string;
      if (tool === "base64-text") {
        result = (actionOverride ?? "encode") === "decode" ? decodeBase64AsText(input) : encodeTextAsBase64(input);
      } else if (isAesToolKind(tool)) {
        result = await processAes(input, {
            action: actionOverride === "decrypt" ? "decrypt" : "encrypt",
            mode: aesMode,
            padding: aesPadding,
            key: aesKey,
            iv: aesIv,
            inputFormat: aesInputFormat,
            outputFormat: aesOutputFormat,
          });
      } else if (tool === "sm2") {
        result = await processSm2(input, {
          action: actionOverride === "decrypt" ? "decrypt" : "encrypt",
          publicKey: sm2PublicKey,
          privateKey: sm2PrivateKey,
          keyFormat: sm2KeyFormat,
          inputFormat: smInputFormat,
          outputFormat: smOutputFormat,
        });
      } else if (tool === "sm3-hash") {
        result = await processSm3(input, smInputFormat, smOutputFormat);
      } else if (tool === "sm4") {
        result = await processSm4(input, {
          action: actionOverride === "decrypt" ? "decrypt" : "encrypt",
          mode: sm4Mode,
          padding: sm4Padding,
          key: sm4Key,
          iv: sm4Iv,
          inputFormat: smInputFormat,
          outputFormat: smOutputFormat,
        });
      } else {
        throw new Error("不支持的操作");
      }
      setOutput(result);
    } catch (err) {
      setOutput("");
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "处理失败，请检查输入内容");
    }
  };

  const copyText = async (value: string) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const updateContentPane = (id: number, value: string) => {
    if (!isContentToolKind(tool)) return;
    setContentPaneState((state) => ({
      ...state,
      [tool]: state[tool].map((pane) => (pane.id === id ? { ...pane, value, error: "" } : pane)),
    }));
  };

  const addContentPane = () => {
    if (!isContentToolKind(tool)) return;
    setContentPaneState((state) => {
      const panes = state[tool];
      if (panes.length >= MAX_CONTENT_PANES) return state;
      const nextId = Math.max(0, ...panes.map((pane) => pane.id)) + 1;
      return {
        ...state,
        [tool]: [...panes, { id: nextId, value: "", error: "" }],
      };
    });
  };

  const removeContentPane = (id: number) => {
    if (!isContentToolKind(tool)) return;
    setContentPaneState((state) => {
      const panes = state[tool];
      return {
        ...state,
        [tool]: panes.length <= 1 ? panes : panes.filter((pane) => pane.id !== id),
      };
    });
  };

  const runContentPane = async (id: number, operation: TextOperationKind) => {
    if (!isContentToolKind(tool)) return;
    const activeTool = tool;
    const contentPanes = contentPaneState[activeTool];
    const pane = contentPanes.find((item) => item.id === id);
    if (!pane) return;

    try {
      const result = await processText(operation, pane.value);
      setContentPaneState((state) => ({
        ...state,
        [activeTool]: state[activeTool].map((item) => (item.id === id ? { ...item, value: result, error: "" } : item)),
      }));
    } catch (err) {
      const message = typeof err === "string" ? err : err instanceof Error ? err.message : "输入格式不正确";
      setContentPaneState((state) => ({
        ...state,
        [activeTool]: state[activeTool].map((item) => (item.id === id ? { ...item, error: message } : item)),
      }));
    }
  };

  const activeSyntax: SyntaxKind = tool === "json" ? "json" : tool === "xml" ? "xml" : "text";
  const outputSyntax: SyntaxKind = React.useMemo(
    () => (error ? "text" : detectOutputSyntax(output)),
    [error, output],
  );
  const isContentTool = isContentToolKind(tool);
  const isBase64TextTool = tool === "base64-text";
  const isMediaBase64Tool = isMediaBase64ToolKind(tool);
  const isAesTool = isAesToolKind(tool);
  const isSmTool = isSmToolKind(tool);
  const isSm2Tool = tool === "sm2";
  const isSm4Tool = tool === "sm4";
  const isImageTool = tool === "image-compress";
  const mediaToolConfig = isMediaBase64Tool ? getMediaToolConfig(tool) : null;
  const previewBytes = decodedMediaBytes.length ? decodedMediaBytes : selectedMediaBytes;
  const previewMime = decodedMediaBytes.length ? decodedMediaMime : selectedMediaMime;
  const activeContentPanes = isContentTool ? contentPaneState[tool] : [];

  const generateKeys = async () => {
    setError("");
    try {
      const [publicKey, privateKey] = await generateSm2Keypair(sm2KeyFormat);
      setSm2PublicKey(publicKey);
      setSm2PrivateKey(privateKey);
    } catch (err) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "SM2 密钥生成失败");
    }
  };

  const checkForUpdates = async () => {
    setCheckingUpdate(true);
    setUpdateStatus("正在检查更新...");
    try {
      const update = await check();
      if (!update) {
        setUpdateStatus("当前已是最新版本");
        return;
      }

      const shouldInstall = window.confirm(`发现新版本 ${update.version}，是否下载并安装？`);
      if (!shouldInstall) {
        setUpdateStatus(`发现新版本 ${update.version}`);
        return;
      }

      setUpdateStatus(`正在下载 ${update.version}...`);
      await update.downloadAndInstall();
      setUpdateStatus("更新已安装，正在重启...");
      await relaunch();
    } catch (err) {
      setUpdateStatus(typeof err === "string" ? err : err instanceof Error ? err.message : "检查更新失败");
    } finally {
      setCheckingUpdate(false);
    }
  };

  const selectImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";

    if (isFileTooLarge(file, MAX_IMAGE_FILE_BYTES)) {
      setSelectedImageName("");
      setSelectedImageBytes(new Uint8Array());
      setImageResult(null);
      setImageStatus(`图片文件过大：${formatBytes(file.size)}，当前限制 ${formatBytes(MAX_IMAGE_FILE_BYTES)}`);
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    setSelectedImageName(file.name);
    setSelectedImageBytes(bytes);
    setImageResult(null);
    setImageStatus(`已选择 ${file.name}（${formatBytes(file.size)}）`);
  };

  const runImageCompress = async () => {
    if (!selectedImageBytes.length) {
      setImageStatus("请先选择图片");
      return;
    }

    setCompressingImage(true);
    setImageStatus("正在压缩...");
    try {
      const result = await compressImage(selectedImageBytes, {
        mode: imageMode,
        quality: imageMode === "high" ? imageQuality : undefined,
      });
      setImageResult(result);
      const saved = result.originalSize - result.compressedSize;
      const percent = result.originalSize > 0 ? ((saved / result.originalSize) * 100).toFixed(1) : "0.0";
      setImageStatus(`无损压缩完成：${formatBytes(result.originalSize)} → ${formatBytes(result.compressedSize)}，减少 ${percent}%`);
    } catch (err) {
      setImageResult(null);
      setImageStatus(typeof err === "string" ? err : err instanceof Error ? err.message : "图片压缩失败");
    } finally {
      setCompressingImage(false);
    }
  };

  const saveCompressedImage = async () => {
    if (!imageResult) return;

    const baseName = selectedImageName.replace(/\.[^.]+$/, "") || "image";
    const path = await save({
      defaultPath: `${baseName}-compressed.${imageResult.extension}`,
      filters: [{ name: imageResult.extension.toUpperCase(), extensions: [imageResult.extension] }],
    });
    if (!path) return;

    await writeFile(path, base64ToBytes(imageResult.data));
    setImageStatus(`已保存：${path}`);
  };

  const selectMediaFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !isMediaBase64ToolKind(tool)) return;
    event.target.value = "";

    if (isFileTooLarge(file, MAX_MEDIA_FILE_BYTES)) {
      setSelectedMediaName("");
      setSelectedMediaBytes(new Uint8Array());
      setSelectedMediaMime("");
      setDecodedMediaBytes(new Uint8Array());
      setDecodedMediaMime("");
      setDecodedMediaExtension("");
      setMediaStatus(`文件过大：${formatBytes(file.size)}，当前限制 ${formatBytes(MAX_MEDIA_FILE_BYTES)}`);
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const mediaConfig = getMediaToolConfig(tool);
    setSelectedMediaName(file.name);
    setSelectedMediaBytes(bytes);
    setSelectedMediaMime(file.type || mediaConfig.defaultMime);
    setDecodedMediaBytes(new Uint8Array());
    setDecodedMediaMime("");
    setDecodedMediaExtension("");
    setMediaStatus(`已选择 ${file.name}（${formatBytes(file.size)}）`);
  };

  const encodeMediaFile = () => {
    if (!isMediaBase64ToolKind(tool)) return;
    if (!selectedMediaBytes.length) {
      setMediaStatus("请先选择文件");
      return;
    }

    const mediaConfig = getMediaToolConfig(tool);
    const mime = selectedMediaMime || mediaConfig.defaultMime;
    const rawBase64 = bytesToBase64(selectedMediaBytes);
    const result = mediaIncludeDataUrl ? `data:${mime};base64,${rawBase64}` : rawBase64;
    setMediaBase64(result);
    setMediaStatus(`已生成 Base64（${mediaIncludeDataUrl ? "包含 data: 前缀" : "原始 Base64"}）`);
  };

  const decodeMediaFile = () => {
    if (!isMediaBase64ToolKind(tool)) return;
    const mediaConfig = getMediaToolConfig(tool);

    if (mediaBase64.length > MAX_MEDIA_BASE64_CHARS) {
      setDecodedMediaBytes(new Uint8Array());
      setDecodedMediaMime("");
      setDecodedMediaExtension("");
      setMediaStatus(`Base64 内容过大，当前限制约 ${formatBytes(MAX_MEDIA_FILE_BYTES)} 文件大小`);
      return;
    }

    try {
      const payload = extractBase64Payload(mediaBase64);
      const mime = payload.mime || selectedMediaMime || mediaConfig.defaultMime;
      const bytes = base64PayloadToBytes(payload.payload);
      if (bytes.length > MAX_MEDIA_FILE_BYTES) {
        setDecodedMediaBytes(new Uint8Array());
        setDecodedMediaMime("");
        setDecodedMediaExtension("");
        setMediaStatus(`解码后文件过大：${formatBytes(bytes.length)}，当前限制 ${formatBytes(MAX_MEDIA_FILE_BYTES)}`);
        return;
      }
      const extension = extensionFromMime(mime, selectedMediaName ? extensionFromName(selectedMediaName) || mediaConfig.defaultExtension : mediaConfig.defaultExtension);

      setDecodedMediaBytes(bytes);
      setDecodedMediaMime(mime);
      setDecodedMediaExtension(extension);
      setMediaStatus(`Base64 解码完成：${formatBytes(bytes.length)} · ${payload.hasDataUrlPrefix ? mime : `${mime}（按当前工具推断）`}`);
    } catch (err) {
      setDecodedMediaBytes(new Uint8Array());
      setDecodedMediaMime("");
      setDecodedMediaExtension("");
      setMediaStatus(typeof err === "string" ? err : err instanceof Error ? err.message : "Base64 解码失败");
    }
  };

  const saveDecodedMedia = async () => {
    if (!isMediaBase64ToolKind(tool)) return;
    if (!decodedMediaBytes.length) {
      setMediaStatus("请先将 Base64 解码为文件");
      return;
    }

    const mediaConfig = getMediaToolConfig(tool);
    const baseName = selectedMediaName.replace(/\.[^.]+$/, "") || mediaConfig.defaultFileName;
    const extension = decodedMediaExtension || mediaConfig.defaultExtension;
    const path = await save({
      defaultPath: `${baseName}.${extension}`,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (!path) return;

    await writeFile(path, decodedMediaBytes);
    setMediaStatus(`已保存：${path}`);
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>OneTool</h2>
        </div>
        <nav className="nav-menu">
          {categories.map((cat) => (
            <div key={cat.name} className="nav-category">
              <div className="category-title">{cat.name}</div>
              <ul className="tool-list">
                {cat.tools.map((item) => (
                  <li key={item.id}>
                    <button
                      className={`nav-item ${tool === item.id ? "active" : ""}`}
                      onClick={() => setTool(item.id)}
                    >
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="app-meta">
            <span>v{APP_VERSION}</span>
            <a className="repo-link" href={REPOSITORY_URL} target="_blank" rel="noreferrer" title="GitHub 仓库" aria-label="GitHub 仓库">
              <Github size={15} />
            </a>
            <button className="update-button" onClick={checkForUpdates} disabled={checkingUpdate}>
              <RefreshCw size={14} /> 检查更新
            </button>
          </div>
          {updateStatus && <div className="update-status">{updateStatus}</div>}
        </div>
      </aside>

      <main className="main-content">
        <React.Suspense fallback={<div className="editor-loading">编辑器加载中...</div>}>
        {isAesTool && (
          <section className="aes-options">
            <label>模式<select value={aesMode} onChange={(e) => setAesMode(e.target.value)}><option>ECB</option><option>CBC</option><option>CTR</option><option>OFB</option><option>CFB</option></select></label>
            <label>Padding<select value={aesPadding} onChange={(e) => setAesPadding(e.target.value)}><option value="pkcs5padding">pkcs5padding</option><option value="pkcs7padding">pkcs7padding</option><option value="nopadding">nopadding</option></select></label>
            <label>输入格式<select value={aesInputFormat} onChange={(e) => setAesInputFormat(e.target.value)}><option value="string">string</option><option value="hex">hex</option><option value="base64">base64</option></select></label>
            <label>输出格式<select value={aesOutputFormat} onChange={(e) => setAesOutputFormat(e.target.value)}><option value="string">string</option><option value="hex">hex</option><option value="base64">base64</option></select></label>
            <label className="wide">密钥<input value={aesKey} onChange={(e) => setAesKey(e.target.value)} placeholder="16/24/32 字节" /></label>
            {aesMode !== "ECB" && <label className="wide">偏移量 / IV<input value={aesIv} onChange={(e) => setAesIv(e.target.value)} placeholder="16 字节，自动识别 string/hex/base64" /></label>}
          </section>
        )}
        {isSmTool && (
          <section className="aes-options">
            {isSm2Tool && <label>密钥格式<select value={sm2KeyFormat} onChange={(e) => setSm2KeyFormat(e.target.value)}><option value="hex">hex</option><option value="base64">base64</option><option value="string">string</option></select></label>}
            {isSm2Tool && <label className="wide">公钥<input value={sm2PublicKey} onChange={(e) => setSm2PublicKey(e.target.value)} placeholder="SM2 公钥" /></label>}
            {isSm2Tool && <label className="wide">私钥<input value={sm2PrivateKey} onChange={(e) => setSm2PrivateKey(e.target.value)} placeholder="SM2 私钥" /></label>}
            {isSm2Tool && <label className="inline-action"><span>&nbsp;</span><button className="btn-copy" type="button" onClick={generateKeys}>生成密钥对</button></label>}
            {isSm4Tool && <label>模式<select value={sm4Mode} onChange={(e) => setSm4Mode(e.target.value)}><option>CBC</option><option>CFB</option><option>CTR</option><option>OFB</option></select></label>}
            {isSm4Tool && sm4Mode === "CBC" && <label>填充<select value={sm4Padding} onChange={(e) => setSm4Padding(e.target.value)}><option value="PKCS7Padding">PKCS7Padding</option><option value="ZeroPadding">ZeroPadding</option><option value="ISO10126Padding">ISO10126Padding</option><option value="NoPadding">NoPadding</option></select></label>}
            {isSm4Tool && <label className="wide">密钥<input value={sm4Key} onChange={(e) => setSm4Key(e.target.value)} placeholder="16 字节" /></label>}
            {isSm4Tool && <label className="wide">偏移量 / IV<input value={sm4Iv} onChange={(e) => setSm4Iv(e.target.value)} placeholder="16 字节，自动识别 string/hex/base64" /></label>}
            <label>输入格式<select value={smInputFormat} onChange={(e) => setSmInputFormat(e.target.value)}><option value="string">string</option><option value="hex">hex</option><option value="base64">base64</option></select></label>
            <label>输出格式<select value={smOutputFormat} onChange={(e) => setSmOutputFormat(e.target.value)}><option value="hex">hex</option><option value="base64">base64</option><option value="string">string</option></select></label>
          </section>
        )}
        {isImageTool ? (
          <section className="image-workspace">
            <div className="image-card">
              <div className="editor-header output-header">
                <span>图片压缩</span>
                <div className="button-group">
                  <button className="btn-run" onClick={runImageCompress} disabled={compressingImage || !selectedImageBytes.length}>
                    <ImageIcon size={14} /> {compressingImage ? "压缩中" : "压缩"}
                  </button>
                  <button className="btn-run secondary" onClick={saveCompressedImage} disabled={!imageResult}>
                    <Save size={14} /> 保存
                  </button>
                </div>
              </div>
              <div className="image-form">
                <label className="file-picker">
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif,image/tiff" onChange={selectImage} />
                  <span>{selectedImageName || "选择图片文件"}</span>
                </label>
                <div className="lossless-note">
                  <label>压缩模式<select value={imageMode} onChange={(event) => setImageMode(event.target.value as "lossless" | "high")}><option value="lossless">无损压缩</option><option value="high">高压缩</option></select></label>
                  {imageMode === "high" && <label>JPEG 质量 {imageQuality}<input type="range" min="1" max="100" value={imageQuality} onChange={(event) => setImageQuality(Number(event.target.value))} /></label>}
                  <span>{imageMode === "lossless" ? "保持原格式、原尺寸和原画质；PNG 会尝试无损重编码，其它格式无法安全优化时保持原文件。" : "保持原格式和原尺寸；JPEG 会按质量重新编码以获得更高压缩率。"}</span>
                </div>
              </div>
              <div className="image-status">{imageStatus || "支持 JPEG、PNG、WebP、BMP、GIF、TIFF 输入；无损模式优先保持原文件，高压缩模式可显著压缩 JPEG。"}</div>
              {imageResult && (
                <div className="image-result">
                  <div><strong>{formatBytes(imageResult.originalSize)}</strong><span>原始大小</span></div>
                  <div><strong>{formatBytes(imageResult.compressedSize)}</strong><span>压缩后</span></div>
                  <div><strong>{imageResult.width} × {imageResult.height}</strong><span>输出尺寸</span></div>
                </div>
              )}
            </div>
          </section>
        ) : isMediaBase64Tool && mediaToolConfig ? (
          <section className="workspace media-workspace">
            <div className="image-card media-card">
              <div className="editor-header output-header">
                <span>{mediaToolConfig.title}</span>
                <div className="button-group">
                  <button className="btn-run" onClick={encodeMediaFile} disabled={!selectedMediaBytes.length}>
                    <Play size={14} /> 编码
                  </button>
                  <button className="btn-run secondary" onClick={saveDecodedMedia} disabled={!decodedMediaBytes.length}>
                    <Save size={14} /> 保存
                  </button>
                </div>
              </div>
              <div className="image-form">
                <label className="file-picker">
                  <input type="file" accept={mediaToolConfig.accept} onChange={selectMediaFile} />
                  <span>{selectedMediaName || mediaToolConfig.pickerLabel}</span>
                </label>
                <div className="lossless-note">
                  <label>
                    输出内容
                    <select value={mediaIncludeDataUrl ? "data-url" : "raw"} onChange={(event) => setMediaIncludeDataUrl(event.target.value === "data-url")}>
                      <option value="data-url">Data URL</option>
                      <option value="raw">原始 Base64</option>
                    </select>
                  </label>
                  <span>{mediaToolConfig.helpText}</span>
                </div>
              </div>
              <div className="media-preview">
                {mediaPreviewUrl ? (
                  tool === "base64-image" ? (
                    <img src={mediaPreviewUrl} alt="preview" className="media-preview-image" />
                  ) : (
                    <audio className="media-preview-audio" controls src={mediaPreviewUrl} />
                  )
                ) : (
                  <div className="media-preview-empty">{mediaToolConfig.emptyPreviewText}</div>
                )}
              </div>
              {!!previewBytes.length && (
                <div className="media-result">
                  <div><strong>{formatBytes(previewBytes.length)}</strong><span>当前预览大小</span></div>
                  <div><strong>{previewMime || mediaToolConfig.defaultMime}</strong><span>MIME</span></div>
                </div>
              )}
              <div className="image-status">{mediaStatus || mediaToolConfig.helpText}</div>
            </div>

            <CodeEditor
              label="Base64"
              value={mediaBase64}
              syntax="text"
              placeholder="在此粘贴或查看 Base64 内容..."
              onChange={setMediaBase64}
              actions={
                <div className="button-group">
                  <button className="btn-run" onClick={decodeMediaFile} disabled={!mediaBase64.trim()}>
                    <Play size={14} /> 解码
                  </button>
                  <button
                    className="btn-copy"
                    onClick={() => {
                      void copyText(mediaBase64);
                    }}
                    disabled={!mediaBase64.trim()}
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? "已复制" : "复制 Base64"}
                  </button>
                </div>
              }
            />
          </section>
        ) : isContentTool ? (
          <div className="workspace content-workspace" style={{ gridTemplateColumns: `repeat(${activeContentPanes.length}, minmax(0, 1fr))` }}>
            {activeContentPanes.map((pane, index) => (
              <CodeEditor
                key={pane.id}
                label={`${tool.toUpperCase()} ${index + 1}`}
                value={pane.value}
                syntax={activeSyntax}
                error={Boolean(pane.error)}
                placeholder="在此粘贴您的内容..."
                onChange={(value) => updateContentPane(pane.id, value)}
                actions={
                  <div className="button-group">
                    {pane.error && <span className="content-error" title={pane.error}>{pane.error}</span>}
                    <button className="btn-run" onClick={() => runContentPane(pane.id, `${tool}-format` as TextOperationKind)}>
                      <Play size={14} /> 格式化
                    </button>
                    <button className="btn-run secondary" onClick={() => runContentPane(pane.id, `${tool}-minify` as TextOperationKind)}>
                      压缩
                    </button>
                    {tool === "json" && (
                      <button className="btn-run secondary" onClick={() => runContentPane(pane.id, "json-sort-key")}>
                        SortKey
                      </button>
                    )}
                    {activeContentPanes.length < MAX_CONTENT_PANES && index === activeContentPanes.length - 1 && (
                      <button className="btn-copy icon-only" onClick={addContentPane} title="向右添加内容框" aria-label="向右添加内容框">
                        <Plus size={14} />
                      </button>
                    )}
                    {activeContentPanes.length > 1 && (
                      <button className="btn-copy icon-only" onClick={() => removeContentPane(pane.id)} title="删除内容框" aria-label="删除内容框">
                        <X size={14} />
                      </button>
                    )}
                  </div>
                }
              />
            ))}
          </div>
        ) : (
          <div className="workspace">
            <CodeEditor
              label="输入"
              value={input}
              syntax={activeSyntax}
              placeholder="在此粘贴您的内容..."
              onChange={setInput}
              actions={
                <div className="button-group">
                  {(isAesTool || isSm2Tool || isSm4Tool || isBase64TextTool) ? (
                    <>
                      <button className="btn-run" onClick={() => {
                        void run(isBase64TextTool ? "encode" : "encrypt");
                      }}>
                        <Play size={14} /> {isBase64TextTool ? "编码" : "加密"}
                      </button>
                      <button className="btn-run secondary" onClick={() => {
                        void run(isBase64TextTool ? "decode" : "decrypt");
                      }}>
                        {isBase64TextTool ? "解码" : "解密"}
                      </button>
                    </>
                  ) : (
                    <button className="btn-run" onClick={() => run()}>
                      <Play size={14} /> 执行
                    </button>
                  )}
                </div>
              }
            />

            <CodeEditor
              label="输出"
              value={error || output}
              syntax={outputSyntax}
              readOnly
              error={Boolean(error)}
              placeholder="处理结果将显示在这里..."
              actions={
                <button
                  className="btn-copy"
                  onClick={() => {
                    void copyText(output);
                  }}
                  disabled={!output || Boolean(error)}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "已复制" : "复制结果"}
                </button>
              }
            />
          </div>
        )}
        </React.Suspense>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
