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
                let usb_id = u32::from_le_bytes([p[16], p[17], p[18], p[19]]);
                let caps = u32::from_le_bytes([p[40], p[41], p[42], p[43]]);
                self.sysinfo = Some(SystemInfo {
                    cpu_id: u32::from_le_bytes([p[0], p[1], p[2], p[3]]),
                    usb_vid: (usb_id >> 16) as u16,
                    usb_pid: usb_id as u16,
                    flash_size_kb: u32::from_le_bytes([p[48], p[49], p[50], p[51]]),
                    ram_size_kb: u32::from_le_bytes([p[52], p[53], p[54], p[55]]),
                    npu_present: caps & (1 << 1) != 0,
                    pmu_present: caps & (1 << 7) != 0,
                    pmu_eventcnt: ((caps >> 8) & 0xFF) as u8,
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

        if width == 0 || height == 0 || width > 4096 || height > 4096 || offset >= data.len() {
            return Ok(None);
        }

        let raw = &data[offset..];
        let pixels = (width as usize).saturating_mul(height as usize);

        Ok(Some(match format {
            PIXFORMAT_JPEG => FrameInfo {
                width,
                height,
                format_str: "JPEG".into(),
                data: raw.to_vec(),
                is_jpeg: true,
            },
            PIXFORMAT_RGB565 => {
                let mut rgba = vec![255u8; pixels * 4];
                for i in 0..pixels {
                    if i * 2 + 1 >= raw.len() {
                        break;
                    }
                    let px = u16::from_le_bytes([raw[i * 2], raw[i * 2 + 1]]);
                    rgba[i * 4] = (((px >> 11) & 0x1F) as u32 * 255 / 31) as u8;
                    rgba[i * 4 + 1] = (((px >> 5) & 0x3F) as u32 * 255 / 63) as u8;
                    rgba[i * 4 + 2] = ((px & 0x1F) as u32 * 255 / 31) as u8;
                }
                FrameInfo {
                    width,
                    height,
                    format_str: "RGB565".into(),
                    data: rgba,
                    is_jpeg: false,
                }
            }
            PIXFORMAT_GRAYSCALE => {
                let mut rgba = vec![255u8; pixels * 4];
                for i in 0..pixels {
                    if i >= raw.len() {
                        break;
                    }
                    let g = raw[i];
                    rgba[i * 4] = g;
                    rgba[i * 4 + 1] = g;
                    rgba[i * 4 + 2] = g;
                }
                FrameInfo {
                    width,
                    height,
                    format_str: "GRAY".into(),
                    data: rgba,
                    is_jpeg: false,
                }
            }
            _ => FrameInfo {
                width,
                height,
                format_str: format!("0x{:08X}", format),
                data: raw.to_vec(),
                is_jpeg: false,
            },
        }))
    }

    pub fn poll(&mut self) -> PollResult {
        let mut need_resync = false;

        let status = match self.poll_status(false) {
            Ok(s) => s,
            Err(_) => {
                need_resync = true;
                HashMap::new()
            }
        };

        let script_running = status.get("stdin").copied().unwrap_or(false);

        let stdout = if !need_resync && status.get("stdout").copied().unwrap_or(false) {
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

        PollResult { stdout, frame, script_running }
    }

    fn poll_status(&mut self, resync: bool) -> Result<HashMap<String, bool>, ProtocolError> {
        let p = self
            .cmd(Opcode::ChannelPoll, 0, None, resync)?
            .ok_or(ProtocolError::Timeout)?;
        let flags = u32::from_le_bytes([p[0], p[1], p[2], p[3]]);
        Ok(self
            .channels
            .iter()
            .map(|(name, &id)| (name.clone(), flags & (1 << id) != 0))
            .collect())
    }
}
