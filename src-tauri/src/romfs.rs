// Copyright (C) 2026 OpenMV, LLC.
//
// This software is licensed under terms that can be found in the
// LICENSE file in the root directory of this software component.
//
// ROMFS image encoder/decoder. Mirrors tools/mkromfs.py byte-for-byte
// so images built here are byte-compatible with images built by
// the firmware tooling.

use serde::{Deserialize, Serialize};

pub const ROMFS_HEADER: u32 = 0x14a6b1;
pub const ROMFS_HEADER_ALIGN: usize = 16;
pub const ROMFS_FILEREC_ALIGN: usize = 8;
pub const RECORD_KIND_PADDING: u32 = 1;
pub const RECORD_KIND_DATA: u32 = 2;
pub const RECORD_KIND_FILE: u32 = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RomfsEntry {
    pub name: String,
    pub data: Vec<u8>,
    pub alignment: u32,
}

fn encode_vint(mut value: u32) -> Vec<u8> {
    let mut bytes = vec![(value & 0x7F) as u8];
    value >>= 7;
    while value != 0 {
        bytes.insert(0, 0x80 | ((value & 0x7F) as u8));
        value >>= 7;
    }
    bytes
}

fn vint_len(value: u32) -> usize {
    let mut n = 1usize;
    let mut v = value >> 7;
    while v != 0 {
        n += 1;
        v >>= 7;
    }
    n
}

fn decode_vint(buf: &[u8], pos: &mut usize) -> Result<u32, String> {
    let mut value: u32 = 0;
    loop {
        if *pos >= buf.len() {
            return Err("Truncated vint".into());
        }
        let b = buf[*pos];
        *pos += 1;
        value = (value << 7) | ((b & 0x7F) as u32);
        if b & 0x80 == 0 {
            return Ok(value);
        }
    }
}

fn encode_record(kind: u32, payload: &[u8], align: usize, offset: usize) -> Vec<u8> {
    let kind_vint = if kind == 0 {
        Vec::new()
    } else {
        encode_vint(kind)
    };
    let len_vint = encode_vint(payload.len() as u32);

    let padding = if align != 0 {
        let preamble_offset = offset + kind_vint.len() + len_vint.len();
        ((preamble_offset + (align - 1)) & !(align - 1)) - preamble_offset
    } else {
        0
    };

    let mut out = Vec::with_capacity(kind_vint.len() + padding + len_vint.len() + payload.len());
    out.extend_from_slice(&kind_vint);
    for _ in 0..padding {
        out.push(0x80);
    }
    out.extend_from_slice(&len_vint);
    out.extend_from_slice(payload);
    out
}

fn encoded_record_len(kind: u32, payload_len: usize, align: usize, offset: usize) -> usize {
    let kind_len = if kind == 0 { 0 } else { vint_len(kind) };
    let len_len = vint_len(payload_len as u32);
    let padding = if align != 0 {
        let preamble_offset = offset + kind_len + len_len;
        ((preamble_offset + (align - 1)) & !(align - 1)) - preamble_offset
    } else {
        0
    };
    kind_len + padding + len_len + payload_len
}

fn encode_file(name: &str, data: &[u8], align: u32, offset: usize) -> Vec<u8> {
    let name_rec = encode_record(0, name.as_bytes(), 0, 0);
    let data_offset = offset + 1 + (ROMFS_FILEREC_ALIGN - 1) + name_rec.len();
    let data_rec = encode_record(RECORD_KIND_DATA, data, align as usize, data_offset);

    let mut payload = Vec::with_capacity(name_rec.len() + data_rec.len());
    payload.extend_from_slice(&name_rec);
    payload.extend_from_slice(&data_rec);
    encode_record(RECORD_KIND_FILE, &payload, ROMFS_FILEREC_ALIGN, 0)
}

fn encoded_file_len(name: &str, data_len: usize, align: u32, offset: usize) -> usize {
    let name_rec_len =
        encoded_record_len(0, name.as_bytes().len(), 0, 0);
    let data_offset = offset + 1 + (ROMFS_FILEREC_ALIGN - 1) + name_rec_len;
    let data_rec_len =
        encoded_record_len(RECORD_KIND_DATA, data_len, align as usize, data_offset);
    encoded_record_len(
        RECORD_KIND_FILE,
        name_rec_len + data_rec_len,
        ROMFS_FILEREC_ALIGN,
        0,
    )
}

pub fn build(entries: &[RomfsEntry], partition_size: usize) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    let mut offset = ROMFS_HEADER_ALIGN;
    for entry in entries {
        let rec = encode_file(&entry.name, &entry.data, entry.alignment, offset);
        offset += rec.len();
        body.extend_from_slice(&rec);
    }
    let image = encode_record(ROMFS_HEADER, &body, ROMFS_HEADER_ALIGN, 0);
    if image.len() > partition_size {
        return Err(format!(
            "ROMFS overflow: {} bytes > {} bytes available",
            image.len(),
            partition_size
        ));
    }
    Ok(image)
}

pub fn estimate_size(entries: &[RomfsEntry]) -> usize {
    let mut body_len = 0usize;
    let mut offset = ROMFS_HEADER_ALIGN;
    for entry in entries {
        let rec_len = encoded_file_len(&entry.name, entry.data.len(), entry.alignment, offset);
        offset += rec_len;
        body_len += rec_len;
    }
    encoded_record_len(ROMFS_HEADER, body_len, ROMFS_HEADER_ALIGN, 0)
}

fn recover_alignment(offset: usize) -> u32 {
    if offset == 0 {
        return 4;
    }
    let trailing = offset & offset.wrapping_neg();
    let cap = 16384usize;
    let val = trailing.min(cap) as u32;
    if val < 4 {
        4
    } else {
        val
    }
}

pub fn parse(image: &[u8]) -> Result<Vec<RomfsEntry>, String> {
    let mut pos = 0usize;
    let kind = decode_vint(image, &mut pos)?;
    if kind != ROMFS_HEADER {
        return Err(format!("Bad ROMFS header kind 0x{:x}", kind));
    }
    let body_len = decode_vint(image, &mut pos)? as usize;
    let body_start = pos;
    let body_end = body_start
        .checked_add(body_len)
        .ok_or("ROMFS body length overflow")?;
    if body_end > image.len() {
        return Err("ROMFS body extends past image".into());
    }

    let mut entries = Vec::new();
    let mut p = body_start;

    while p < body_end {
        let mut q = p;
        let rec_kind = decode_vint(image, &mut q)?;

        if rec_kind == RECORD_KIND_PADDING {
            let pad_len = decode_vint(image, &mut q)? as usize;
            p = q + pad_len;
            continue;
        }

        if rec_kind != RECORD_KIND_FILE {
            let len = decode_vint(image, &mut q)? as usize;
            p = q + len;
            continue;
        }

        let payload_len = decode_vint(image, &mut q)? as usize;
        let payload_start = q;
        let payload_end = payload_start + payload_len;
        if payload_end > body_end {
            return Err("File record payload extends past body".into());
        }

        let mut r = payload_start;
        let name_len = decode_vint(image, &mut r)? as usize;
        if r + name_len > payload_end {
            return Err("Name record overflows file record".into());
        }
        let name_bytes = &image[r..r + name_len];
        let name = String::from_utf8(name_bytes.to_vec())
            .map_err(|e| format!("Invalid filename: {}", e))?;
        r += name_len;

        let data_kind = decode_vint(image, &mut r)?;
        if data_kind != RECORD_KIND_DATA {
            return Err(format!("Expected DATA record, got kind {}", data_kind));
        }
        let data_len = decode_vint(image, &mut r)? as usize;
        if r + data_len > payload_end {
            return Err("Data record overflows file record".into());
        }
        let data_payload_offset = r;
        let data = image[r..r + data_len].to_vec();
        let alignment = recover_alignment(data_payload_offset);

        entries.push(RomfsEntry {
            name,
            data,
            alignment,
        });
        p = payload_end;
    }

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vint_roundtrip() {
        for v in [0u32, 1, 127, 128, 255, 1024, 0x14a6b1, 0xffff_ffff] {
            let bytes = encode_vint(v);
            let mut p = 0;
            let decoded = decode_vint(&bytes, &mut p).unwrap();
            assert_eq!(decoded, v);
            assert_eq!(p, bytes.len());
            assert_eq!(vint_len(v), bytes.len());
        }
    }

    #[test]
    fn build_parse_roundtrip() {
        let entries = vec![
            RomfsEntry {
                name: "a.bin".into(),
                data: vec![1, 2, 3, 4, 5],
                alignment: 4,
            },
            RomfsEntry {
                name: "b.tflite".into(),
                data: vec![0xAA; 200],
                alignment: 16,
            },
        ];

        let image = build(&entries, 0x10000).unwrap();
        assert_eq!(estimate_size(&entries), image.len());

        let parsed = parse(&image).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "a.bin");
        assert_eq!(parsed[0].data, vec![1, 2, 3, 4, 5]);
        assert_eq!(parsed[1].name, "b.tflite");
        assert_eq!(parsed[1].data.len(), 200);
        assert!(parsed[1].alignment >= 16);
    }

    #[test]
    fn overflow_rejected() {
        let entries = vec![RomfsEntry {
            name: "big".into(),
            data: vec![0; 1024],
            alignment: 4,
        }];
        let r = build(&entries, 16);
        assert!(r.is_err());
    }
}
