use aes::cipher::{block_padding::Pkcs7, AsyncStreamCipher, BlockDecryptMut, BlockEncryptMut, KeyIvInit, KeyInit, StreamCipher};
use aes::{Aes128, Aes192, Aes256};
use base64::{engine::general_purpose, Engine as _};
use cbc::{Decryptor as CbcDecryptor, Encryptor as CbcEncryptor};
use cfb_mode::{Decryptor as CfbDecryptor, Encryptor as CfbEncryptor};
use ctr::Ctr128BE;
use ecb::{Decryptor as EcbDecryptor, Encryptor as EcbEncryptor};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{GenericImageView, ImageEncoder};
use libsm::sm2::encrypt::{DecryptCtx, EncryptCtx};
use libsm::sm2::signature::SigCtx;
use libsm::sm3::hash::Sm3Hash;
use libsm::sm4::cipher_mode::{CipherMode, Sm4CipherMode};
use ofb::Ofb;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[tauri::command]
fn process_text(operation: &str, input: &str) -> Result<String, String> {
    match operation {
        "json-format" => format_json(input),
        "json-minify" => minify_json(input),
        "xml-format" => format_xml(input),
        "xml-minify" => minify_xml(input),
        _ => Err("不支持的操作".to_string()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageCompressOptions {
    quality: u8,
    max_width: Option<u32>,
    max_height: Option<u32>,
    output_format: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageCompressResult {
    data: Vec<u8>,
    extension: String,
    mime: String,
    original_size: usize,
    compressed_size: usize,
    width: u32,
    height: u32,
}

#[tauri::command]
fn compress_image(input: Vec<u8>, options: ImageCompressOptions) -> Result<ImageCompressResult, String> {
    if input.is_empty() {
        return Err("请选择图片文件".to_string());
    }

    let image = image::load_from_memory(&input).map_err(|err| format!("图片读取失败：{err}"))?;
    let image = resize_image_if_needed(image, options.max_width, options.max_height);
    let (width, height) = image.dimensions();
    let quality = options.quality.clamp(1, 100);
    let format = options.output_format.to_ascii_lowercase();

    let (data, extension, mime) = match format.as_str() {
        "png" => {
            let rgba = image.to_rgba8();
            let mut output = Vec::new();
            let compression = if quality >= 80 {
                CompressionType::Fast
            } else if quality >= 40 {
                CompressionType::Default
            } else {
                CompressionType::Best
            };
            PngEncoder::new_with_quality(&mut output, compression, FilterType::Adaptive)
                .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
                .map_err(|err| format!("PNG 压缩失败：{err}"))?;
            (output, "png".to_string(), "image/png".to_string())
        }
        "jpeg" | "jpg" => {
            let rgb = image.to_rgb8();
            let mut output = Vec::new();
            JpegEncoder::new_with_quality(&mut output, quality)
                .encode(&rgb, width, height, image::ExtendedColorType::Rgb8)
                .map_err(|err| format!("JPEG 压缩失败：{err}"))?;
            (output, "jpg".to_string(), "image/jpeg".to_string())
        }
        _ => return Err("输出格式仅支持 JPEG 或 PNG".to_string()),
    };

    let compressed_size = data.len();
    Ok(ImageCompressResult {
        data,
        extension,
        mime,
        original_size: input.len(),
        compressed_size,
        width,
        height,
    })
}

fn resize_image_if_needed(image: image::DynamicImage, max_width: Option<u32>, max_height: Option<u32>) -> image::DynamicImage {
    let (width, height) = image.dimensions();
    let max_width = max_width.filter(|value| *value > 0).unwrap_or(width);
    let max_height = max_height.filter(|value| *value > 0).unwrap_or(height);

    if width <= max_width && height <= max_height {
        return image;
    }

    image.resize(max_width, max_height, image::imageops::FilterType::Lanczos3)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AesOptions {
    action: String,
    mode: String,
    padding: String,
    key: String,
    iv: String,
    input_format: String,
    output_format: String,
}

#[tauri::command]
fn process_aes(input: &str, options: AesOptions) -> Result<String, String> {
    let key = decode_auto_value(&options.key, &[16, 24, 32])?;
    validate_aes_key(&key)?;

    let iv = if options.mode.eq_ignore_ascii_case("ECB") {
        Vec::new()
    } else {
        let iv = decode_auto_value(&options.iv, &[16])?;
        if iv.len() != 16 {
            return Err("IV 长度必须为 16 字节（128 bits），ECB 模式不需要 IV".to_string());
        }
        iv
    };

    let data = decode_by_format(input, &options.input_format)?;
    let result = match options.action.as_str() {
        "encrypt" => aes_encrypt(&data, &key, &iv, &options.mode, &options.padding)?,
        "decrypt" => aes_decrypt(&data, &key, &iv, &options.mode, &options.padding)?,
        _ => return Err("AES 操作只支持 encrypt 或 decrypt".to_string()),
    };

    encode_by_format(&result, &options.output_format)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sm2Options {
    action: String,
    public_key: String,
    private_key: String,
    key_format: String,
    input_format: String,
    output_format: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sm4Options {
    action: String,
    mode: String,
    padding: String,
    key: String,
    iv: String,
    input_format: String,
    output_format: String,
}

#[tauri::command]
fn process_sm2(input: &str, options: Sm2Options) -> Result<String, String> {
    let ctx = SigCtx::new();

    match options.action.as_str() {
        "encrypt" => {
            let public_key = decode_by_format(&options.public_key, &options.key_format)?;
            let public_key = ctx.load_pubkey(&public_key).map_err(|err| format!("SM2 公钥解析失败：{err:?}"))?;
            let data = decode_by_format(input, &options.input_format)?;
            let cipher = EncryptCtx::new(data.len(), public_key)
                .encrypt(&data)
                .map_err(|err| format!("SM2 加密失败：{err:?}"))?;
            encode_by_format(&cipher, &options.output_format)
        }
        "decrypt" => {
            let private_key = decode_by_format(&options.private_key, &options.key_format)?;
            let private_key = ctx.load_seckey(&private_key).map_err(|err| format!("SM2 私钥解析失败：{err:?}"))?;
            let data = decode_by_format(input, &options.input_format)?;
            if data.len() < 97 {
                return Err("SM2 密文长度不正确".to_string());
            }
            let plain_len = data.len() - 65 - 32;
            let plain = DecryptCtx::new(plain_len, private_key)
                .decrypt(&data)
                .map_err(|err| format!("SM2 解密失败：{err:?}"))?;
            encode_by_format(&plain, &options.output_format)
        }
        _ => Err("SM2 操作只支持 encrypt 或 decrypt".to_string()),
    }
}

#[tauri::command]
fn process_sm3(input: &str, input_format: &str, output_format: &str) -> Result<String, String> {
    let data = decode_by_format(input, input_format)?;
    let mut hash = Sm3Hash::new(&data);
    let digest = hash.get_hash();
    encode_by_format(&digest, output_format)
}

#[tauri::command]
fn process_sm4(input: &str, options: Sm4Options) -> Result<String, String> {
    let key = decode_auto_value(&options.key, &[16])?;
    if key.len() != 16 {
        return Err("SM4 密钥长度必须为 16 字节（128 bits）".to_string());
    }
    let iv = decode_auto_value(&options.iv, &[16])?;
    if iv.len() != 16 {
        return Err("SM4 IV 长度必须为 16 字节".to_string());
    }

    let mode = parse_sm4_mode(&options.mode)?;
    let cipher = Sm4CipherMode::new(&key, mode).map_err(|err| format!("SM4 初始化失败：{err:?}"))?;
    let data = decode_by_format(input, &options.input_format)?;
    let action = options.action.to_ascii_lowercase();
    let use_builtin_cbc_pkcs7 = options.mode.eq_ignore_ascii_case("CBC") && options.padding.eq_ignore_ascii_case("PKCS7Padding");

    let prepared = if action == "encrypt" {
        if use_builtin_cbc_pkcs7 {
            data.clone()
        } else {
            apply_sm4_padding(&data, &options.padding)?
        }
    } else {
        data.clone()
    };

    let result = match options.action.as_str() {
        "encrypt" => cipher.encrypt(&[], &prepared, &iv).map_err(|err| format!("SM4 加密失败：{err:?}"))?,
        "decrypt" => {
            let decrypted = cipher.decrypt(&[], &prepared, &iv).map_err(|err| format!("SM4 解密失败：{err:?}"))?;
            if use_builtin_cbc_pkcs7 {
                decrypted
            } else {
                remove_sm4_padding(&decrypted, &options.padding)?
            }
        }
        _ => return Err("SM4 操作只支持 encrypt 或 decrypt".to_string()),
    };

    encode_by_format(&result, &options.output_format)
}

#[tauri::command]
fn generate_sm2_keypair(output_format: &str, compressed: bool) -> Result<(String, String), String> {
    let ctx = SigCtx::new();
    let (public_key, private_key) = ctx.new_keypair().map_err(|err| format!("SM2 密钥生成失败：{err:?}"))?;
    let public_key = ctx
        .serialize_pubkey(&public_key, compressed)
        .map_err(|err| format!("SM2 公钥序列化失败：{err:?}"))?;
    let private_key = ctx
        .serialize_seckey(&private_key)
        .map_err(|err| format!("SM2 私钥序列化失败：{err:?}"))?;

    Ok((
        encode_by_format(&public_key, output_format)?,
        encode_by_format(&private_key, output_format)?,
    ))
}

fn format_json(input: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(input).map_err(|err| format!("JSON 解析失败：{err}"))?;
    serde_json::to_string_pretty(&value).map_err(|err| format!("JSON 格式化失败：{err}"))
}

fn minify_json(input: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(input).map_err(|err| format!("JSON 解析失败：{err}"))?;
    serde_json::to_string(&value).map_err(|err| format!("JSON 压缩失败：{err}"))
}

fn decode_by_format(input: &str, format: &str) -> Result<Vec<u8>, String> {
    match format.to_ascii_lowercase().as_str() {
        "string" => Ok(input.as_bytes().to_vec()),
        "hex" => hex::decode(input.trim()).map_err(|err| format!("Hex 解码失败：{err}")),
        "base64" => general_purpose::STANDARD
            .decode(input.trim())
            .map_err(|err| format!("Base64 解码失败：{err}")),
        _ => Err("编码格式仅支持 string、hex、base64".to_string()),
    }
}

fn decode_auto_value(input: &str, valid_lengths: &[usize]) -> Result<Vec<u8>, String> {
    let trimmed = input.trim();

    if !trimmed.is_empty() && trimmed.len() % 2 == 0 && trimmed.chars().all(|ch| ch.is_ascii_hexdigit()) {
        if let Ok(bytes) = hex::decode(trimmed) {
            if valid_lengths.contains(&bytes.len()) {
                return Ok(bytes);
            }
        }
    }

    Ok(input.as_bytes().to_vec())
}

fn encode_by_format(bytes: &[u8], format: &str) -> Result<String, String> {
    match format.to_ascii_lowercase().as_str() {
        "string" => String::from_utf8(bytes.to_vec()).map_err(|err| format!("UTF-8 转字符串失败：{err}")),
        "hex" => Ok(hex::encode(bytes)),
        "base64" => Ok(general_purpose::STANDARD.encode(bytes)),
        _ => Err("编码格式仅支持 string、hex、base64".to_string()),
    }
}

fn validate_aes_key(key: &[u8]) -> Result<(), String> {
    match key.len() {
        16 | 24 | 32 => Ok(()),
        _ => Err("AES 密钥长度必须为 16/24/32 字节（128/192/256 bits）".to_string()),
    }
}

fn parse_sm4_mode(mode: &str) -> Result<CipherMode, String> {
    match mode.to_ascii_uppercase().as_str() {
        "CBC" => Ok(CipherMode::Cbc),
        "CFB" => Ok(CipherMode::Cfb),
        "CTR" => Ok(CipherMode::Ctr),
        "OFB" => Ok(CipherMode::Ofb),
        "GCM" => Ok(CipherMode::Gcm),
        _ => Err("SM4 当前支持 CBC/CFB/CTR/OFB/GCM；ECB/CTS 暂未实现".to_string()),
    }
}

fn apply_sm4_padding(data: &[u8], padding: &str) -> Result<Vec<u8>, String> {
    match padding.to_ascii_uppercase().as_str() {
        "NOPADDING" => {
            ensure_no_padding_len(data)?;
            Ok(data.to_vec())
        }
        "ZEROPADDING" => {
            let pad = (16 - (data.len() % 16)) % 16;
            let mut out = data.to_vec();
            if pad > 0 {
                out.extend(std::iter::repeat_n(0u8, pad));
            }
            Ok(out)
        }
        "PKCS7PADDING" => {
            let pad = 16 - (data.len() % 16);
            let mut out = data.to_vec();
            out.extend(std::iter::repeat_n(pad as u8, pad));
            Ok(out)
        }
        "ISO10126PADDING" => {
            let pad = 16 - (data.len() % 16);
            let mut out = data.to_vec();
            if pad > 1 {
                out.extend(std::iter::repeat_n(0xAA, pad - 1));
            }
            out.push(pad as u8);
            Ok(out)
        }
        _ => Err("SM4 Padding 仅支持 PKCS7Padding、ZeroPadding、ISO10126Padding、NoPadding".to_string()),
    }
}

fn remove_sm4_padding(data: &[u8], padding: &str) -> Result<Vec<u8>, String> {
    match padding.to_ascii_uppercase().as_str() {
        "NOPADDING" => Ok(data.to_vec()),
        "ZEROPADDING" => Ok(data.iter().copied().rev().skip_while(|b| *b == 0).collect::<Vec<_>>().into_iter().rev().collect()),
        "PKCS7PADDING" | "ISO10126PADDING" => {
            let Some(&last) = data.last() else {
                return Ok(Vec::new());
            };
            let pad = last as usize;
            if pad == 0 || pad > 16 || pad > data.len() {
                return Err("SM4 去填充失败：Padding 不正确".to_string());
            }
            Ok(data[..data.len() - pad].to_vec())
        }
        _ => Err("SM4 Padding 仅支持 PKCS7Padding、ZeroPadding、ISO10126Padding、NoPadding".to_string()),
    }
}

fn normalize_padding(padding: &str) -> Result<&'static str, String> {
    match padding.to_ascii_lowercase().as_str() {
        "pkcs5padding" | "pkcs7padding" => Ok("pkcs7"),
        "nopadding" => Ok("none"),
        _ => Err("Padding 仅支持 pkcs5padding、pkcs7padding、nopadding".to_string()),
    }
}

fn ensure_no_padding_len(data: &[u8]) -> Result<(), String> {
    if data.len() % 16 == 0 {
        Ok(())
    } else {
        Err("NoPadding 要求输入长度必须是 16 字节的倍数".to_string())
    }
}

fn aes_encrypt(data: &[u8], key: &[u8], iv: &[u8], mode: &str, padding: &str) -> Result<Vec<u8>, String> {
    let mode = mode.to_ascii_uppercase();
    let padding = normalize_padding(padding)?;

    match (mode.as_str(), key.len(), padding) {
        ("ECB", 16, "pkcs7") => Ok(EcbEncryptor::<Aes128>::new_from_slice(key).unwrap().encrypt_padded_vec_mut::<Pkcs7>(data)),
        ("ECB", 24, "pkcs7") => Ok(EcbEncryptor::<Aes192>::new_from_slice(key).unwrap().encrypt_padded_vec_mut::<Pkcs7>(data)),
        ("ECB", 32, "pkcs7") => Ok(EcbEncryptor::<Aes256>::new_from_slice(key).unwrap().encrypt_padded_vec_mut::<Pkcs7>(data)),
        ("CBC", 16, "pkcs7") => Ok(CbcEncryptor::<Aes128>::new_from_slices(key, iv).unwrap().encrypt_padded_vec_mut::<Pkcs7>(data)),
        ("CBC", 24, "pkcs7") => Ok(CbcEncryptor::<Aes192>::new_from_slices(key, iv).unwrap().encrypt_padded_vec_mut::<Pkcs7>(data)),
        ("CBC", 32, "pkcs7") => Ok(CbcEncryptor::<Aes256>::new_from_slices(key, iv).unwrap().encrypt_padded_vec_mut::<Pkcs7>(data)),
        ("ECB", _, "none") => {
            ensure_no_padding_len(data)?;
            aes_ecb_no_padding_encrypt(data, key)
        }
        ("CBC", _, "none") => {
            ensure_no_padding_len(data)?;
            aes_cbc_no_padding_encrypt(data, key, iv)
        }
        ("CTR", _, _) => aes_stream_apply(data, key, iv, "CTR"),
        ("OFB", _, _) => aes_stream_apply(data, key, iv, "OFB"),
        ("CFB", _, _) => aes_cfb_encrypt(data, key, iv),
        _ => Err("当前 AES 模式仅支持 ECB/CBC/CTR/OFB/CFB；GCM 暂未实现".to_string()),
    }
}

fn aes_decrypt(data: &[u8], key: &[u8], iv: &[u8], mode: &str, padding: &str) -> Result<Vec<u8>, String> {
    let mode = mode.to_ascii_uppercase();
    let padding = normalize_padding(padding)?;

    match (mode.as_str(), key.len(), padding) {
        ("ECB", 16, "pkcs7") => EcbDecryptor::<Aes128>::new_from_slice(key).unwrap().decrypt_padded_vec_mut::<Pkcs7>(data).map_err(|_| "AES 解密失败：Padding 或密文不正确".to_string()),
        ("ECB", 24, "pkcs7") => EcbDecryptor::<Aes192>::new_from_slice(key).unwrap().decrypt_padded_vec_mut::<Pkcs7>(data).map_err(|_| "AES 解密失败：Padding 或密文不正确".to_string()),
        ("ECB", 32, "pkcs7") => EcbDecryptor::<Aes256>::new_from_slice(key).unwrap().decrypt_padded_vec_mut::<Pkcs7>(data).map_err(|_| "AES 解密失败：Padding 或密文不正确".to_string()),
        ("CBC", 16, "pkcs7") => CbcDecryptor::<Aes128>::new_from_slices(key, iv).unwrap().decrypt_padded_vec_mut::<Pkcs7>(data).map_err(|_| "AES 解密失败：Padding 或密文不正确".to_string()),
        ("CBC", 24, "pkcs7") => CbcDecryptor::<Aes192>::new_from_slices(key, iv).unwrap().decrypt_padded_vec_mut::<Pkcs7>(data).map_err(|_| "AES 解密失败：Padding 或密文不正确".to_string()),
        ("CBC", 32, "pkcs7") => CbcDecryptor::<Aes256>::new_from_slices(key, iv).unwrap().decrypt_padded_vec_mut::<Pkcs7>(data).map_err(|_| "AES 解密失败：Padding 或密文不正确".to_string()),
        ("ECB", _, "none") => {
            ensure_no_padding_len(data)?;
            aes_ecb_no_padding_decrypt(data, key)
        }
        ("CBC", _, "none") => {
            ensure_no_padding_len(data)?;
            aes_cbc_no_padding_decrypt(data, key, iv)
        }
        ("CTR", _, _) => aes_stream_apply(data, key, iv, "CTR"),
        ("OFB", _, _) => aes_stream_apply(data, key, iv, "OFB"),
        ("CFB", _, _) => aes_cfb_decrypt(data, key, iv),
        _ => Err("当前 AES 模式仅支持 ECB/CBC/CTR/OFB/CFB；GCM 暂未实现".to_string()),
    }
}

fn aes_stream_apply(data: &[u8], key: &[u8], iv: &[u8], mode: &str) -> Result<Vec<u8>, String> {
    let mut buffer = data.to_vec();
    match (mode, key.len()) {
        ("CTR", 16) => Ctr128BE::<Aes128>::new_from_slices(key, iv).unwrap().apply_keystream(&mut buffer),
        ("CTR", 24) => Ctr128BE::<Aes192>::new_from_slices(key, iv).unwrap().apply_keystream(&mut buffer),
        ("CTR", 32) => Ctr128BE::<Aes256>::new_from_slices(key, iv).unwrap().apply_keystream(&mut buffer),
        ("OFB", 16) => Ofb::<Aes128>::new_from_slices(key, iv).unwrap().apply_keystream(&mut buffer),
        ("OFB", 24) => Ofb::<Aes192>::new_from_slices(key, iv).unwrap().apply_keystream(&mut buffer),
        ("OFB", 32) => Ofb::<Aes256>::new_from_slices(key, iv).unwrap().apply_keystream(&mut buffer),
        _ => return Err("AES 参数错误".to_string()),
    }
    Ok(buffer)
}

fn aes_cfb_encrypt(data: &[u8], key: &[u8], iv: &[u8]) -> Result<Vec<u8>, String> {
    let mut buffer = data.to_vec();
    match key.len() {
        16 => CfbEncryptor::<Aes128>::new_from_slices(key, iv).unwrap().encrypt(&mut buffer),
        24 => CfbEncryptor::<Aes192>::new_from_slices(key, iv).unwrap().encrypt(&mut buffer),
        32 => CfbEncryptor::<Aes256>::new_from_slices(key, iv).unwrap().encrypt(&mut buffer),
        _ => return Err("AES 参数错误".to_string()),
    }
    Ok(buffer)
}

fn aes_cfb_decrypt(data: &[u8], key: &[u8], iv: &[u8]) -> Result<Vec<u8>, String> {
    let mut buffer = data.to_vec();
    match key.len() {
        16 => CfbDecryptor::<Aes128>::new_from_slices(key, iv).unwrap().decrypt(&mut buffer),
        24 => CfbDecryptor::<Aes192>::new_from_slices(key, iv).unwrap().decrypt(&mut buffer),
        32 => CfbDecryptor::<Aes256>::new_from_slices(key, iv).unwrap().decrypt(&mut buffer),
        _ => return Err("AES 参数错误".to_string()),
    }
    Ok(buffer)
}

fn aes_ecb_no_padding_encrypt(data: &[u8], key: &[u8]) -> Result<Vec<u8>, String> {
    match key.len() {
        16 => Ok(EcbEncryptor::<Aes128>::new_from_slice(key).unwrap().encrypt_padded_vec_mut::<aes::cipher::block_padding::NoPadding>(data)),
        24 => Ok(EcbEncryptor::<Aes192>::new_from_slice(key).unwrap().encrypt_padded_vec_mut::<aes::cipher::block_padding::NoPadding>(data)),
        32 => Ok(EcbEncryptor::<Aes256>::new_from_slice(key).unwrap().encrypt_padded_vec_mut::<aes::cipher::block_padding::NoPadding>(data)),
        _ => Err("AES 参数错误".to_string()),
    }
}

fn aes_ecb_no_padding_decrypt(data: &[u8], key: &[u8]) -> Result<Vec<u8>, String> {
    match key.len() {
        16 => EcbDecryptor::<Aes128>::new_from_slice(key).unwrap().decrypt_padded_vec_mut::<aes::cipher::block_padding::NoPadding>(data).map_err(|_| "AES 解密失败".to_string()),
        24 => EcbDecryptor::<Aes192>::new_from_slice(key).unwrap().decrypt_padded_vec_mut::<aes::cipher::block_padding::NoPadding>(data).map_err(|_| "AES 解密失败".to_string()),
        32 => EcbDecryptor::<Aes256>::new_from_slice(key).unwrap().decrypt_padded_vec_mut::<aes::cipher::block_padding::NoPadding>(data).map_err(|_| "AES 解密失败".to_string()),
        _ => Err("AES 参数错误".to_string()),
    }
}

fn aes_cbc_no_padding_encrypt(data: &[u8], key: &[u8], iv: &[u8]) -> Result<Vec<u8>, String> {
    match key.len() {
        16 => Ok(CbcEncryptor::<Aes128>::new_from_slices(key, iv).unwrap().encrypt_padded_vec_mut::<aes::cipher::block_padding::NoPadding>(data)),
        24 => Ok(CbcEncryptor::<Aes192>::new_from_slices(key, iv).unwrap().encrypt_padded_vec_mut::<aes::cipher::block_padding::NoPadding>(data)),
        32 => Ok(CbcEncryptor::<Aes256>::new_from_slices(key, iv).unwrap().encrypt_padded_vec_mut::<aes::cipher::block_padding::NoPadding>(data)),
        _ => Err("AES 参数错误".to_string()),
    }
}

fn aes_cbc_no_padding_decrypt(data: &[u8], key: &[u8], iv: &[u8]) -> Result<Vec<u8>, String> {
    match key.len() {
        16 => CbcDecryptor::<Aes128>::new_from_slices(key, iv).unwrap().decrypt_padded_vec_mut::<aes::cipher::block_padding::NoPadding>(data).map_err(|_| "AES 解密失败".to_string()),
        24 => CbcDecryptor::<Aes192>::new_from_slices(key, iv).unwrap().decrypt_padded_vec_mut::<aes::cipher::block_padding::NoPadding>(data).map_err(|_| "AES 解密失败".to_string()),
        32 => CbcDecryptor::<Aes256>::new_from_slices(key, iv).unwrap().decrypt_padded_vec_mut::<aes::cipher::block_padding::NoPadding>(data).map_err(|_| "AES 解密失败".to_string()),
        _ => Err("AES 参数错误".to_string()),
    }
}

fn format_xml(input: &str) -> Result<String, String> {
    let source = input.trim();
    if source.is_empty() {
        return Ok(String::new());
    }

    let mut tokens = Vec::new();
    let mut text = String::new();
    let mut tag = String::new();
    let mut in_tag = false;

    for ch in source.chars() {
        match (in_tag, ch) {
            (false, '<') => {
                push_trimmed(&mut tokens, &mut text);
                tag.push(ch);
                in_tag = true;
            }
            (true, '>') => {
                tag.push(ch);
                tokens.push(tag.trim().to_string());
                tag.clear();
                in_tag = false;
            }
            (true, _) => tag.push(ch),
            (false, _) => text.push(ch),
        }
    }

    if in_tag {
        return Err("XML 标签未闭合".to_string());
    }
    push_trimmed(&mut tokens, &mut text);

    let mut depth = 0usize;
    let mut output = Vec::with_capacity(tokens.len());

    let mut index = 0usize;
    while index < tokens.len() {
        let token = &tokens[index];
        let next = tokens.get(index + 1);
        let after_next = tokens.get(index + 2);

        if is_opening_xml_tag(token)
            && next.is_some_and(|value| !value.starts_with('<'))
            && after_next == closing_xml_tag_for(token).as_ref()
        {
            output.push(format!(
                "{}{}{}{}",
                "  ".repeat(depth),
                token,
                next.unwrap(),
                after_next.unwrap()
            ));
            index += 3;
            continue;
        }

        if token.starts_with("</") {
            depth = depth.saturating_sub(1);
        }

        output.push(format!("{}{}", "  ".repeat(depth), token));

        if is_opening_xml_tag(&token) {
            depth += 1;
        }
        index += 1;
    }

    Ok(output.join("\n"))
}

fn minify_xml(input: &str) -> Result<String, String> {
    let formatted = format_xml(input)?;
    Ok(formatted
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(""))
}

fn push_trimmed(tokens: &mut Vec<String>, text: &mut String) {
    let trimmed = text.trim();
    if !trimmed.is_empty() {
        tokens.push(trimmed.to_string());
    }
    text.clear();
}

fn is_opening_xml_tag(token: &str) -> bool {
    token.starts_with('<')
        && !token.starts_with("</")
        && !token.starts_with("<?")
        && !token.starts_with("<!")
        && !token.ends_with("/>")
}

fn closing_xml_tag_for(token: &str) -> Option<String> {
    let name = token
        .trim_start_matches('<')
        .split(|ch: char| ch.is_whitespace() || ch == '>' || ch == '/')
        .next()?;

    if name.is_empty() {
        None
    } else {
        Some(format!("</{name}>"))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![process_text, compress_image, process_aes, process_sm2, process_sm3, process_sm4, generate_sm2_keypair])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_and_minifies_json() {
        assert_eq!(format_json(r#"{"a":1,"b":[true]}"#).unwrap(), "{\n  \"a\": 1,\n  \"b\": [\n    true\n  ]\n}");
        assert_eq!(minify_json("{ \"a\" : 1 }").unwrap(), r#"{"a":1}"#);
    }

    #[test]
    fn formats_and_minifies_xml() {
        let xml = "<root><item>value</item><empty/></root>";
        assert_eq!(format_xml(xml).unwrap(), "<root>\n  <item>value</item>\n  <empty/>\n</root>");
        assert_eq!(minify_xml(xml).unwrap(), xml);
    }

    #[test]
    fn keeps_simple_xml_text_nodes_on_one_line() {
        let xml = "<root><feature>XML</feature><feature>JSON</feature></root>";
        assert_eq!(
            format_xml(xml).unwrap(),
            "<root>\n  <feature>XML</feature>\n  <feature>JSON</feature>\n</root>"
        );
    }

    #[test]
    fn aes_cbc_encrypts_and_decrypts() {
        let options = AesOptions {
            action: "encrypt".to_string(),
            mode: "CBC".to_string(),
            padding: "pkcs7padding".to_string(),
            key: "1234567890abcdef".to_string(),
            iv: "abcdef1234567890".to_string(),
            input_format: "string".to_string(),
            output_format: "base64".to_string(),
        };
        let encrypted = process_aes("hello aes", options).unwrap();

        let decrypt_options = AesOptions {
            action: "decrypt".to_string(),
            mode: "CBC".to_string(),
            padding: "pkcs7padding".to_string(),
            key: "1234567890abcdef".to_string(),
            iv: "abcdef1234567890".to_string(),
            input_format: "base64".to_string(),
            output_format: "string".to_string(),
        };

        assert_eq!(process_aes(&encrypted, decrypt_options).unwrap(), "hello aes");
    }

    #[test]
    fn sm3_hashes_abc() {
        assert_eq!(
            process_sm3("abc", "string", "hex").unwrap(),
            "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0"
        );
    }

    #[test]
    fn sm2_encrypts_and_decrypts() {
        let (public_key, private_key) = generate_sm2_keypair("hex", false).unwrap();
        let encrypted = process_sm2(
            "hello sm2",
            Sm2Options {
                action: "encrypt".to_string(),
                public_key,
                private_key: String::new(),
                key_format: "hex".to_string(),
                input_format: "string".to_string(),
                output_format: "hex".to_string(),
            },
        )
        .unwrap();

        let decrypted = process_sm2(
            &encrypted,
            Sm2Options {
                action: "decrypt".to_string(),
                public_key: String::new(),
                private_key,
                key_format: "hex".to_string(),
                input_format: "hex".to_string(),
                output_format: "string".to_string(),
            },
        )
        .unwrap();

        assert_eq!(decrypted, "hello sm2");
    }

    #[test]
    fn sm4_cbc_encrypts_and_decrypts() {
        let encrypted = process_sm4(
            "hello sm4",
            Sm4Options {
                action: "encrypt".to_string(),
                mode: "CBC".to_string(),
                padding: "PKCS7Padding".to_string(),
                key: "1234567890abcdef".to_string(),
                iv: "abcdef1234567890".to_string(),
                input_format: "string".to_string(),
                output_format: "hex".to_string(),
            },
        )
        .unwrap();

        let decrypted = process_sm4(
            &encrypted,
            Sm4Options {
                action: "decrypt".to_string(),
                mode: "CBC".to_string(),
                padding: "PKCS7Padding".to_string(),
                key: "1234567890abcdef".to_string(),
                iv: "abcdef1234567890".to_string(),
                input_format: "hex".to_string(),
                output_format: "string".to_string(),
            },
        )
        .unwrap();

        assert_eq!(decrypted, "hello sm4");
    }

    #[test]
    fn compresses_png_to_jpeg() {
        let rgba = image::RgbaImage::from_pixel(32, 32, image::Rgba([240, 80, 40, 255]));
        let mut source = Vec::new();
        PngEncoder::new(&mut source)
            .write_image(&rgba, 32, 32, image::ExtendedColorType::Rgba8)
            .unwrap();

        let result = compress_image(
            source,
            ImageCompressOptions {
                quality: 75,
                max_width: Some(16),
                max_height: Some(16),
                output_format: "jpeg".to_string(),
            },
        )
        .unwrap();

        assert_eq!(result.extension, "jpg");
        assert_eq!(result.mime, "image/jpeg");
        assert_eq!(result.width, 16);
        assert_eq!(result.height, 16);
        assert!(!result.data.is_empty());
    }

    #[test]
    fn sm4_real_world_case_decrypts() {
        let decrypted = process_sm4(
            "c814862aba65445930e1412c67363322372beb44a21aaa839214b433d259d83a32d2a3da7689737a8fe5deeb09e8e01ca11af1deefdc08cc04e5add0f46736e30f3f1e52fd7f9adc3e41b764eb4c5412",
            Sm4Options {
                action: "decrypt".to_string(),
                mode: "CBC".to_string(),
                padding: "PKCS7Padding".to_string(),
                key: "pigxpigxpigxpigx".to_string(),
                iv: "pigxpigxpigxpigx".to_string(),
                input_format: "hex".to_string(),
                output_format: "string".to_string(),
            },
        )
        .unwrap();

        assert_eq!(
            decrypted,
            r#"{"systemCode":"HOSPITAL","bizCode":"IS_CREATE_USER_CARD_YZM_ZZJ"}"#
        );
    }
}
