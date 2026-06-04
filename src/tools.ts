export type ContentToolKind = "json" | "xml";
export type Base64ToolKind = "base64-text" | "base64-image" | "base64-audio";
export type MediaBase64ToolKind = "base64-image" | "base64-audio";
export type TextOperationKind = "json-format" | "json-minify" | "json-sort-key" | "xml-format" | "xml-minify";
export type AesToolKind = "aes";
export type SmToolKind = "sm2" | "sm3-hash" | "sm4";
export type ImageToolKind = "image-compress";
export type ToolKind = ContentToolKind | Base64ToolKind | AesToolKind | SmToolKind | ImageToolKind;

export interface ToolDef {
  id: ToolKind;
  label: string;
  description: string;
}

export const categories = [
  {
    name: "JSON",
    tools: [
      { id: "json", label: "JSON 格式化/压缩", description: "JSON 格式化与压缩" },
    ],
  },
  {
    name: "XML",
    tools: [
      { id: "xml", label: "XML 格式化/压缩", description: "XML 格式化与压缩" },
    ],
  },
  {
    name: "Base64",
    tools: [
      { id: "base64-text", label: "文本 ↔ Base64", description: "UTF-8 文本与 Base64 互转" },
      { id: "base64-image", label: "图片 ↔ Base64", description: "图片文件与 Base64 互转" },
      { id: "base64-audio", label: "音频 ↔ Base64", description: "音频文件与 Base64 互转" },
    ],
  },
  {
    name: "加解密",
    tools: [
      { id: "aes", label: "AES 加密/解密", description: "AES ECB/CBC/CTR/OFB/CFB 加密与解密" },
      { id: "sm2", label: "SM2 加密/解密", description: "国密 SM2 公钥加密与私钥解密" },
      { id: "sm3-hash", label: "SM3 摘要", description: "国密 SM3 哈希摘要" },
      { id: "sm4", label: "SM4 加密/解密", description: "国密 SM4 CBC/CFB/CTR/OFB 加密与解密" },
    ],
  },
  {
    name: "图片",
    tools: [
      { id: "image-compress", label: "图片压缩", description: "压缩 JPEG/PNG 图片并保存" },
    ],
  },
] satisfies Array<{ name: string; tools: ToolDef[] }>;

export function isAesToolKind(value: ToolKind): value is AesToolKind {
  return value === "aes";
}

export function isContentToolKind(value: ToolKind): value is ContentToolKind {
  return value === "json" || value === "xml";
}

export function isMediaBase64ToolKind(value: ToolKind): value is MediaBase64ToolKind {
  return value === "base64-image" || value === "base64-audio";
}

export function isSmToolKind(value: ToolKind): value is SmToolKind {
  return value === "sm2" || value === "sm3-hash" || value === "sm4";
}
