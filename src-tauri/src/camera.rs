// OpenMV Camera -- direct port of openmv-python/src/openmv/camera.py
// Single struct owning the transport. No threads, no command queues.

use std::collections::HashMap;
use std::time::Duration;

use crate::protocol::*;
use crate::transport::{ProtocolError, Transport};

pub struct Camera {
    transport: Option<Transport>,
    channels: HashMap<String, u8>,
    max_payload: usize,
    pub sysinfo: Option<SystemInfo>,
    pub verinfo: Option<VersionInfo>,
}

impl Camera {
    pub fn new() -> Self {
        Self {
            transport: None,
            channels: HashMap::new(),
            max_payload: 4096,
            sysinfo: None,
            verinfo: None,
        }
    }

    pub fn is_connected(&self) -> bool {
        self.transport.is_some()
    }

    pub fn connect(&mut self, port: &str, baudrate: u32) -> Result<(), ProtocolError> {
        self.disconnect();

        let serial = serialport::new(port, baudrate)
            .timeout(Duration::from_secs(1))
            .open()
            .map_err(|e| ProtocolError::IoError(e.to_string()))?;

        self.transport = Some(Transport::new(
            serial,
            true,
            true,
            MIN_PAYLOAD_SIZE,
            Duration::from_secs(1),
        ));

        self.resync()?;
        self.update_channels()?;
        self.cache_info();
        Ok(())
    }

    pub fn disconnect(&mut self) {
        self.transport = None;
        self.channels.clear();
        self.sysinfo = None;
        self.verinfo = None;
    }

    // -- Protocol primitives --

    fn transport(&mut self) -> Result<&mut Transport, ProtocolError> {
        self.transport.as_mut().ok_or(ProtocolError::NotConnected)
    }

    fn cmd(
        &mut self,
        opcode: Opcode,
        channel: u8,
        data: Option<&[u8]>,
        resync: bool,
    ) -> Result<Option<Vec<u8>>, ProtocolError> {
        self.transport()?
            .send_packet(opcode, channel, PacketFlags::empty(), data)?;
        match self.transport()?.recv_packet() {
            Ok(r) => Ok(r),
            Err(ProtocolError::Checksum | ProtocolError::Sequence | ProtocolError::Timeout)
                if resync =>
            {
                log::warn!("Protocol error, resyncing...");
                self.resync()?;
                self.transport()?
                    .send_packet(opcode, channel, PacketFlags::empty(), data)?;
                self.transport()?.recv_packet()
            }
            Err(e) => Err(e),
        }
    }

    fn resync(&mut self) -> Result<(), ProtocolError> {
        let t = self.transport()?;
        t.update_caps(true, true, MIN_PAYLOAD_SIZE);
        t.reset_sequence();

        for attempt in 0..3 {
            self.transport()?
                .send_packet(Opcode::ProtoSync, 0, PacketFlags::empty(), None)?;
            match self.transport()?.recv_packet() {
                Ok(_) => {
                    self.transport()?.reset_sequence();
                    return self.negotiate_caps();
                }
                Err(_) if attempt < 2 => continue,
                Err(e) => return Err(e),
            }
        }
        Err(ProtocolError::Timeout)
    }

    fn negotiate_caps(&mut self) -> Result<(), ProtocolError> {
        let p = self
            .cmd(Opcode::ProtoGetCaps, 0, None, false)?
            .ok_or(ProtocolError::Timeout)?;
        if p.len() < 6 {
            return Err(ProtocolError::IoError("Invalid caps".into()));
        }

        self.max_payload = self
            .max_payload
            .min(u16::from_le_bytes([p[4], p[5]]) as usize);

        let flags: u32 = 1 | (1 << 1) | (1 << 2) | (1 << 3); // crc + seq + ack + events
        let mut buf = vec![0u8; 16];
        buf[0..4].copy_from_slice(&flags.to_le_bytes());
        buf[4..6].copy_from_slice(&(self.max_payload as u16).to_le_bytes());
        self.cmd(Opcode::ProtoSetCaps, 0, Some(&buf), false)?;

        let mp = self.max_payload;
        self.transport()?.update_caps(true, true, mp);
        Ok(())
    }

    fn update_channels(&mut self) -> Result<(), ProtocolError> {
        let p = self
            .cmd(Opcode::ChannelList, 0, None, true)?
            .ok_or(ProtocolError::Timeout)?;
        self.channels.clear();
        for i in 0..p.len() / 16 {
            let ofs = i * 16;
            let id = p[ofs];
            let name_bytes = &p[ofs + 2..ofs + 16];
            let end = name_bytes.iter().position(|&b| b == 0).unwrap_or(14);
            self.channels
                .insert(String::from_utf8_lossy(&name_bytes[..end]).to_string(), id);
        }
        Ok(())
    }

    fn cache_info(&mut self) {
        if let Ok(Some(p)) = self.cmd(Opcode::ProtoVersion, 0, None, true) {
            if p.len() >= 9 {
                self.verinfo = Some(VersionInfo {
                    protocol: [p[0], p[1], p[2]],
                    bootloader: [p[3], p[4], p[5]],
                    firmware: [p[6], p[7], p[8]],
                });
            }
        }
        if let Ok(Some(p)) = self.cmd(Opcode::SysInfo, 0, None, true) {
            if p.len() >= 76 {
                let u = |o: usize| u32::from_le_bytes([p[o], p[o+1], p[o+2], p[o+3]]);
                let usb_id = u(16);
                let caps = u(40);
                self.sysinfo = Some(SystemInfo {
                    cpu_id: u(0),
                    device_id: [u(4), u(8), u(12)],
                    usb_vid: (usb_id >> 16) as u16,
                    usb_pid: usb_id as u16,
                    chip_ids: [u(20), u(24), u(28)],
                    gpu_present: caps & (1 << 0) != 0,
                    npu_present: caps & (1 << 1) != 0,
                    isp_present: caps & (1 << 2) != 0,
                    venc_present: caps & (1 << 3) != 0,
                    jpeg_present: caps & (1 << 4) != 0,
                    dram_present: caps & (1 << 5) != 0,
                    crc_present: caps & (1 << 6) != 0,
                    pmu_present: caps & (1 << 7) != 0,
                    pmu_eventcnt: ((caps >> 8) & 0xFF) as u8,
                    wifi_present: caps & (1 << 16) != 0,
                    bt_present: caps & (1 << 17) != 0,
                    sd_present: caps & (1 << 18) != 0,
                    eth_present: caps & (1 << 19) != 0,
                    usb_highspeed: caps & (1 << 20) != 0,
                    multicore_present: caps & (1 << 21) != 0,
                    flash_size_kb: u(48),
                    ram_size_kb: u(52),
                    framebuffer_size_kb: u(56),
                    stream_buffer_size_kb: u(60),
                });
            }
        }
    }

    // -- Channel helpers --

    fn ch(&self, name: &str) -> Result<u8, ProtocolError> {
        self.channels
            .get(name)
            .copied()
            .ok_or_else(|| ProtocolError::IoError(format!("Channel '{}' not found", name)))
    }

    fn ch_size(&mut self, id: u8, resync: bool) -> Result<u32, ProtocolError> {
        let p = self
            .cmd(Opcode::ChannelSize, id, None, resync)?
            .ok_or(ProtocolError::Timeout)?;
        Ok(u32::from_le_bytes([p[0], p[1], p[2], p[3]]))
    }

    fn ch_read(
        &mut self,
        id: u8,
        offset: u32,
        length: u32,
        resync: bool,
    ) -> Result<Vec<u8>, ProtocolError> {
        let mut req = [0u8; 8];
        req[0..4].copy_from_slice(&offset.to_le_bytes());
        req[4..8].copy_from_slice(&length.to_le_bytes());
        self.cmd(Opcode::ChannelRead, id, Some(&req), resync)?
            .ok_or(ProtocolError::Timeout)
    }

    fn ch_write(&mut self, id: u8, data: &[u8]) -> Result<(), ProtocolError> {
        let chunk_size = self.max_payload - 8;
        for (i, chunk) in data.chunks(chunk_size).enumerate() {
            let offset = (i * chunk_size) as u32;
            let mut buf = vec![0u8; 8 + chunk.len()];
            buf[0..4].copy_from_slice(&offset.to_le_bytes());
            buf[4..8].copy_from_slice(&(chunk.len() as u32).to_le_bytes());
            buf[8..].copy_from_slice(chunk);
            self.cmd(Opcode::ChannelWrite, id, Some(&buf), true)?;
        }
        Ok(())
    }

    fn ch_ioctl(&mut self, id: u8, cmd: u32, args: &[u32]) -> Result<(), ProtocolError> {
        let mut buf = vec![0u8; 4 + args.len() * 4];
        buf[0..4].copy_from_slice(&cmd.to_le_bytes());
        for (i, a) in args.iter().enumerate() {
            buf[4 + i * 4..8 + i * 4].copy_from_slice(&a.to_le_bytes());
        }
        self.cmd(Opcode::ChannelIoctl, id, Some(&buf), true)?;
        Ok(())
    }

    // -- Public operations --

    pub fn memory_stats(&mut self) -> Result<Vec<MemEntry>, ProtocolError> {
        let p = self
            .cmd(Opcode::SysMemory, 0, None, true)?
            .ok_or(ProtocolError::Timeout)?;
        if p.len() < 4 {
            return Err(ProtocolError::IoError("Invalid SYS_MEMORY response".into()));
        }
        let count = p[0] as usize;
        let mut entries = Vec::with_capacity(count);
        for i in 0..count {
            let o = 4 + i * 24;
            if o + 24 > p.len() {
                break;
            }
            entries.push(MemEntry {
                mem_type: if p[o] == 0 { "gc".into() } else { "uma".into() },
                flags: u16::from_le_bytes([p[o + 2], p[o + 3]]),
                total: u32::from_le_bytes([p[o + 4], p[o + 5], p[o + 6], p[o + 7]]),
                used: u32::from_le_bytes([p[o + 8], p[o + 9], p[o + 10], p[o + 11]]),
                free: u32::from_le_bytes([p[o + 12], p[o + 13], p[o + 14], p[o + 15]]),
                persist: u32::from_le_bytes([p[o + 16], p[o + 17], p[o + 18], p[o + 19]]),
                peak: u32::from_le_bytes([p[o + 20], p[o + 21], p[o + 22], p[o + 23]]),
            });
        }
        Ok(entries)
    }

    pub fn device_stats(&mut self) -> Result<ProtoStats, ProtocolError> {
        let p = self
            .cmd(Opcode::ProtoStats, 0, None, true)?
            .ok_or(ProtocolError::Timeout)?;
        if p.len() < 32 {
            return Err(ProtocolError::IoError("Invalid PROTO_STATS response".into()));
        }
        let u = |o: usize| u32::from_le_bytes([p[o], p[o+1], p[o+2], p[o+3]]);
        Ok(ProtoStats {
            sent: u(0),
            received: u(4),
            checksum: u(8),
            sequence: u(12),
            retransmit: u(16),
            transport: u(20),
            sent_events: u(24),
            max_ack_queue_depth: u(28),
        })
    }

    pub fn get_channels(&self) -> Vec<(String, u8)> {
        self.channels.iter().map(|(k, &v)| (k.clone(), v)).collect()
    }

    pub fn exec_script(&mut self, script: &str) -> Result<(), ProtocolError> {
        let id = self.ch("stdin")?;
        self.ch_ioctl(id, ioctl::STDIN_RESET, &[])?;
        self.ch_write(id, script.as_bytes())?;
        self.ch_ioctl(id, ioctl::STDIN_EXEC, &[])
    }

    pub fn stop_script(&mut self) -> Result<(), ProtocolError> {
        let id = self.ch("stdin")?;
        self.ch_ioctl(id, ioctl::STDIN_STOP, &[])
    }

    pub fn enable_streaming(&mut self, enable: bool) -> Result<(), ProtocolError> {
        let id = self.ch("stream")?;
        self.ch_ioctl(id, ioctl::STREAM_RAW_CTRL, &[0])?;
        self.ch_ioctl(id, ioctl::STREAM_CTRL, &[enable as u32])
    }

    pub fn set_stream_source(&mut self, chip_id: u32) -> Result<(), ProtocolError> {
        let id = self.ch("stream")?;
        self.ch_ioctl(id, ioctl::STREAM_SOURCE, &[chip_id])
    }

    pub fn read_stdout(&mut self, resync: bool) -> Result<Option<String>, ProtocolError> {
        let id = self.ch("stdout")?;
        let size = self.ch_size(id, resync)?;
        if size == 0 {
            return Ok(None);
        }
        let data = self.ch_read(id, 0, size, resync)?;
        Ok(Some(String::from_utf8_lossy(&data).to_string()))
    }

    pub fn read_frame(&mut self) -> Result<Option<FrameInfo>, ProtocolError> {
        let id = self.ch("stream")?;

        match self.cmd(Opcode::ChannelLock, id, None, false) {
            Ok(_) => {}
            Err(ProtocolError::Nak(Status::Busy)) => return Ok(None),
            Err(_) => return Ok(None),
        }

        let result = self.read_frame_locked(id);
        let _ = self.cmd(Opcode::ChannelUnlock, id, None, false);
        result
    }

    fn read_frame_locked(&mut self, id: u8) -> Result<Option<FrameInfo>, ProtocolError> {
        let size = self.ch_size(id, false)?;
        if size <= 20 {
            return Ok(None);
        }

        let data = self.ch_read(id, 0, size, false)?;
        if data.len() < 20 {
            return Ok(None);
        }

        let width = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        let height = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);
        let format = u32::from_le_bytes([data[8], data[9], data[10], data[11]]);
        let offset = u32::from_le_bytes([data[16], data[17], data[18], data[19]]) as usize;
        let raw = &data[offset..];
        let pixels = (width as usize).saturating_mul(height as usize);

        Ok(Some(match format {
            PIXFORMAT_JPEG => {
                use std::io::Cursor;
                let reader = image::ImageReader::with_format(
                    Cursor::new(raw),
                    image::ImageFormat::Jpeg,
                );
                let img = reader.decode().map_err(|e| {
                    ProtocolError::IoError(format!("JPEG decode: {}", e))
                })?;
                let rgba = img.to_rgba8();
                FrameInfo {
                    width: rgba.width(),
                    height: rgba.height(),
                    format: PIXFORMAT_JPEG,
                    data: rgba.into_raw(),
                }
            }
            PIXFORMAT_RGB565 => {
                if raw.len() != pixels * 2 {
                    return Ok(None);
                }
                let mut rgba = vec![255u8; pixels * 4];
                for i in 0..pixels {
                    let px = u16::from_le_bytes([raw[i * 2], raw[i * 2 + 1]]);
                    rgba[i * 4] = (((px >> 11) & 0x1F) as u32 * 255 / 31) as u8;
                    rgba[i * 4 + 1] = (((px >> 5) & 0x3F) as u32 * 255 / 63) as u8;
                    rgba[i * 4 + 2] = ((px & 0x1F) as u32 * 255 / 31) as u8;
                }
                FrameInfo {
                    width,
                    height,
                    format: PIXFORMAT_RGB565,
                    data: rgba,
                }
            }
            PIXFORMAT_GRAYSCALE => {
                if raw.len() != pixels {
                    return Ok(None);
                }
                let mut rgba = vec![255u8; pixels * 4];
                for i in 0..pixels {
                    let g = raw[i];
                    rgba[i * 4] = g;
                    rgba[i * 4 + 1] = g;
                    rgba[i * 4 + 2] = g;
                }
                FrameInfo {
                    width,
                    height,
                    format: PIXFORMAT_GRAYSCALE,
                    data: rgba,
                }
            }
            _ => FrameInfo {
                width,
                height,
                format,
                data: raw.to_vec(),
            },
        }))
    }

    fn ch_active(&self, poll_flags: u32, name: &str) -> bool {
        self.channels.get(name).map_or(false, |&id| poll_flags & (1 << id) != 0)
    }

    pub fn poll(&mut self) -> PollResult {
        let mut need_resync = false;

        let poll_flags = match self.poll_status(false) {
            Ok(f) => f,
            Err(_) => {
                need_resync = true;
                0
            }
        };

        let script_running = self.ch_active(poll_flags, "stdin");

        let stdout = if !need_resync && self.ch_active(poll_flags, "stdout") {
            match self.read_stdout(false) {
                Ok(s) => s,
                Err(_) => {
                    need_resync = true;
                    None
                }
            }
        } else {
            None
        };

        let frame = if !need_resync {
            match self.read_frame() {
                Ok(f) => f,
                Err(e) => {
                    log::warn!("read_frame: {}", e);
                    need_resync = true;
                    None
                }
            }
        } else {
            None
        };

        if need_resync {
            let _ = self.resync();
        }

        PollResult {
            stdout,
            frame,
            script_running,
        }
    }

    fn poll_status(&mut self, resync: bool) -> Result<u32, ProtocolError> {
        let p = self
            .cmd(Opcode::ChannelPoll, 0, None, resync)?
            .ok_or(ProtocolError::Timeout)?;
        Ok(u32::from_le_bytes([p[0], p[1], p[2], p[3]]))
    }
}
