import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { Check, Copy, Image as ImageIcon, Play, RefreshCw, Save } from "lucide-react";
import "./styles.css";

type ContentToolKind = "json" | "xml";
type TextOperationKind = "json-format" | "json-minify" | "xml-format" | "xml-minify";
type AesToolKind = "aes";
type SmToolKind = "sm2" | "sm3-hash" | "sm4";
type ImageToolKind = "image-compress";
type ToolKind = ContentToolKind | AesToolKind | SmToolKind | ImageToolKind;
type SyntaxKind = "json" | "xml" | "text";

interface ToolDef {
  id: ToolKind;
  label: string;
  description: string;
}

const categories = [
  {
    name: "JSON",
    tools: [
      { id: "json", label: "JSON 格式化/压缩", description: "JSON 格式化与压缩" },
    ] as ToolDef[],
  },
  {
    name: "XML",
    tools: [
      { id: "xml", label: "XML 格式化/压缩", description: "XML 格式化与压缩" },
    ] as ToolDef[],
  },
  {
    name: "加解密",
    tools: [
      { id: "aes", label: "AES 加密/解密", description: "AES ECB/CBC/CTR/OFB/CFB 加密与解密" },
      { id: "sm2", label: "SM2 加密/解密", description: "国密 SM2 公钥加密与私钥解密" },
      { id: "sm3-hash", label: "SM3 摘要", description: "国密 SM3 哈希摘要" },
      { id: "sm4", label: "SM4 加密/解密", description: "国密 SM4 CBC/CFB/CTR/OFB/GCM 加密与解密" },
    ] as ToolDef[],
  },
  {
    name: "图片",
    tools: [
      { id: "image-compress", label: "图片压缩", description: "压缩 JPEG/PNG 图片并保存" },
    ] as ToolDef[],
  },
];

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

interface ImageCompressResult {
  data: number[];
  extension: string;
  mime: string;
  originalSize: number;
  compressedSize: number;
  width: number;
  height: number;
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

async function compressImage(input: number[]) {
  return invoke<ImageCompressResult>("compress_image", { input });
}

function isAesToolKind(value: ToolKind): value is AesToolKind {
  return value === "aes";
}

function isContentToolKind(value: ToolKind): value is ContentToolKind {
  return value === "json" || value === "xml";
}

function isSmToolKind(value: ToolKind): value is SmToolKind {
  return value.startsWith("sm") as boolean;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function highlightJson(value: string) {
  return escapeHtml(value).replace(
    /(&quot;(?:\\.|[^&])*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
    (match, quoted: string | undefined, colon: string | undefined, literal: string | undefined) => {
      if (quoted) {
        const className = colon ? "token key" : "token string";
        return `<span class="${className}">${quoted}</span>${colon ?? ""}`;
      }
      if (literal) return `<span class="token literal">${literal}</span>`;
      return `<span class="token number">${match}</span>`;
    },
  );
}

function highlightXml(value: string) {
  return escapeHtml(value).replace(
    /(&lt;\/?)([\w:.-]+)|([\w:.-]+)(=)(&quot;.*?&quot;)|(&lt;![\s\S]*?&gt;|&lt;\?[\s\S]*?\?&gt;|\/?>)/g,
    (match, open: string | undefined, tag: string | undefined, attr: string | undefined, equals: string | undefined, attrValue: string | undefined, metaOrClose: string | undefined) => {
      if (open && tag) return `<span class="token bracket">${open}</span><span class="token tag">${tag}</span>`;
      if (attr && equals && attrValue) return `<span class="token attr">${attr}</span>${equals}<span class="token string">${attrValue}</span>`;
      if (metaOrClose) return `<span class="token bracket">${metaOrClose}</span>`;
      return match;
    },
  );
}

function highlightCode(value: string, syntax: SyntaxKind) {
  if (syntax === "text") return escapeHtml(value);
  return syntax === "json" ? highlightJson(value) : highlightXml(value);
}

function detectOutputSyntax(value: string): SyntaxKind {
  const trimmed = value.trim();
  if (!trimmed) return "text";

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

interface CodeEditorProps {
  label: string;
  value: string;
  syntax: SyntaxKind;
  placeholder: string;
  readOnly?: boolean;
  error?: boolean;
  actions?: React.ReactNode;
  onChange?: (value: string) => void;
}

function CodeEditor({ label, value, syntax, placeholder, readOnly, error, actions, onChange }: CodeEditorProps) {
  const highlightRef = React.useRef<HTMLPreElement>(null);

  const syncScroll = (event: React.UIEvent<HTMLTextAreaElement>) => {
    if (!highlightRef.current) return;
    highlightRef.current.scrollTop = event.currentTarget.scrollTop;
    highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
  };

  return (
    <div className="editor-container">
      <div className="editor-header output-header">
        <span>{label}</span>
        {actions}
      </div>
      <div className={`code-surface ${error ? "has-error" : ""}`}>
        <pre
          ref={highlightRef}
          className="syntax-layer"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: error ? escapeHtml(value) : highlightCode(value, syntax) }}
        />
        <textarea
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          onScroll={syncScroll}
          readOnly={readOnly}
          wrap="soft"
          spellCheck={false}
          className={`editor-textarea ${error ? "error" : ""}`}
          placeholder={placeholder}
        />
      </div>
    </div>
  );
}

function App() {
  const [tool, setTool] = React.useState<ToolKind>("json");
  const [input, setInput] = React.useState("");
  const [output, setOutput] = React.useState("");
  const [error, setError] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const [updateStatus, setUpdateStatus] = React.useState("");
  const [checkingUpdate, setCheckingUpdate] = React.useState(false);
  const [selectedImageName, setSelectedImageName] = React.useState("");
  const [selectedImageBytes, setSelectedImageBytes] = React.useState<number[]>([]);
  const [imageResult, setImageResult] = React.useState<ImageCompressResult | null>(null);
  const [imageStatus, setImageStatus] = React.useState("");
  const [compressingImage, setCompressingImage] = React.useState(false);
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
  }, [tool]);

  React.useEffect(() => {
    if (tool === "sm3-hash") {
      setSmInputFormat("string");
      setSmOutputFormat("hex");
    }
  }, [tool]);

  const run = async (textOperation?: TextOperationKind, actionOverride?: "encrypt" | "decrypt") => {
    setError("");
    setCopied(false);
    try {
      let result: string;
      if (textOperation) {
        result = await processText(textOperation, input);
      } else if (isAesToolKind(tool)) {
        result = await processAes(input, {
            action: actionOverride ?? "encrypt",
            mode: aesMode,
            padding: aesPadding,
            key: aesKey,
            iv: aesIv,
            inputFormat: aesInputFormat,
            outputFormat: aesOutputFormat,
          });
      } else if (tool === "sm2") {
        result = await processSm2(input, {
          action: actionOverride ?? "encrypt",
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
          action: actionOverride ?? "encrypt",
          mode: sm4Mode,
          padding: sm4Padding,
          key: sm4Key,
          iv: sm4Iv,
          inputFormat: smInputFormat,
          outputFormat: smOutputFormat,
        });
      } else if (isContentToolKind(tool)) {
        result = await processText(`${tool}-format` as TextOperationKind, input);
      } else {
        throw new Error("不支持的操作");
      }
      setOutput(result);
    } catch (err) {
      setOutput("");
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "处理失败，请检查输入内容");
    }
  };

  const copy = async () => {
    if (!output) return;
    await navigator.clipboard.writeText(output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const activeSyntax: SyntaxKind = tool === "json" ? "json" : tool === "xml" ? "xml" : "text";
  const outputSyntax: SyntaxKind = error ? "text" : detectOutputSyntax(output);
  const isContentTool = isContentToolKind(tool);
  const isAesTool = isAesToolKind(tool);
  const isSmTool = isSmToolKind(tool);
  const isSm2Tool = tool === "sm2";
  const isSm4Tool = tool === "sm4";
  const isImageTool = tool === "image-compress";

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

    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
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
      const result = await compressImage(selectedImageBytes);
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

    await writeFile(path, new Uint8Array(imageResult.data));
    setImageStatus(`已保存：${path}`);
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
          <button className="update-button" onClick={checkForUpdates} disabled={checkingUpdate}>
            <RefreshCw size={14} /> 检查更新
          </button>
          {updateStatus && <div className="update-status">{updateStatus}</div>}
        </div>
      </aside>

      <main className="main-content">
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
            {isSm4Tool && <label>模式<select value={sm4Mode} onChange={(e) => setSm4Mode(e.target.value)}><option>CBC</option><option>CFB</option><option>CTR</option><option>OFB</option><option>GCM</option></select></label>}
            {isSm4Tool && <label>填充<select value={sm4Padding} onChange={(e) => setSm4Padding(e.target.value)}><option value="PKCS7Padding">PKCS7Padding</option><option value="ZeroPadding">ZeroPadding</option><option value="ISO10126Padding">ISO10126Padding</option><option value="NoPadding">NoPadding</option></select></label>}
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
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif,image/bmp,image/tiff" onChange={selectImage} />
                  <span>{selectedImageName || "选择图片文件"}</span>
                </label>
                <div className="lossless-note">
                  保持原格式、原尺寸和原画质。PNG 会尝试无损重编码减小体积；无法安全无损优化的格式会保持原文件不变。
                </div>
              </div>
              <div className="image-status">{imageStatus || "支持 JPEG、PNG、WebP、BMP、GIF 输入；输出 JPEG 或 PNG。"}</div>
              {imageResult && (
                <div className="image-result">
                  <div><strong>{formatBytes(imageResult.originalSize)}</strong><span>原始大小</span></div>
                  <div><strong>{formatBytes(imageResult.compressedSize)}</strong><span>压缩后</span></div>
                  <div><strong>{imageResult.width} × {imageResult.height}</strong><span>输出尺寸</span></div>
                </div>
              )}
            </div>
          </section>
        ) : (
          <div className="workspace">
            <CodeEditor
              label="输入"
              value={input}
              syntax={activeSyntax}
              placeholder="在此粘贴您的内容..."
              onChange={setInput}
              actions={
                isContentTool ? (
                  <div className="button-group">
                    <button className="btn-run" onClick={() => run(`${tool}-format` as TextOperationKind)}>
                      <Play size={14} /> 格式化
                    </button>
                    <button className="btn-run secondary" onClick={() => run(`${tool}-minify` as TextOperationKind)}>
                      压缩
                    </button>
                  </div>
                ) : (
                  <div className="button-group">
                    {(isAesTool || isSm2Tool || isSm4Tool) ? (
                      <>
                        <button className="btn-run" onClick={() => {
                          void run(undefined, "encrypt");
                        }}>
                          <Play size={14} /> 加密
                        </button>
                        <button className="btn-run secondary" onClick={() => {
                          void run(undefined, "decrypt");
                        }}>
                          解密
                        </button>
                      </>
                    ) : (
                      <button className="btn-run" onClick={() => run()}>
                        <Play size={14} /> 执行
                      </button>
                    )}
                  </div>
                )
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
                  onClick={copy}
                  disabled={!output || Boolean(error)}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "已复制" : "复制结果"}
                </button>
              }
            />
          </div>
        )}
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
