const BASE64_CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(index, index + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function extractBase64Payload(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("请输入 Base64 内容");

  const dataUrlMatch = trimmed.match(/^data:([^,]*?);base64,([\s\S]+)$/i);
  if (dataUrlMatch) {
    const mime = dataUrlMatch[1]?.split(";")[0]?.trim() || "application/octet-stream";
    return {
      mime,
      payload: dataUrlMatch[2].replace(/\s+/g, ""),
      hasDataUrlPrefix: true,
    };
  }

  return {
    mime: "",
    payload: trimmed.replace(/\s+/g, ""),
    hasDataUrlPrefix: false,
  };
}

export function base64ToBytes(value: string) {
  const { payload } = extractBase64Payload(value);
  return base64PayloadToBytes(payload);
}

export function base64PayloadToBytes(payload: string) {
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
