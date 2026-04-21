// OpenMV Camera -- worker thread driving the serial protocol.
// Owns the transport. Runs the command loop on a dedicated thread.

use std::collections::{HashMap, VecDeque};
use std::sync::mpsc;
use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};

use crate::protocol::*;
use crate::transport::{Transport, TransportError};

const PIXFORMAT_RGB565: u32 = 0x0C030002;
const PIXFORMAT_GRAYSCALE: u32 = 0x08020001;

// Binary channel tags
pub const TAG_FRAME: u8 = 0x01;
pub const TAG_STDOUT: u8 = 0x02;
pub const TAG_MEMORY: u8 = 0x03;
pub const TAG_STATS: u8 = 0x04;
pub const TAG_CHANNELS: u8 = 0x05;
pub const TAG_SOFT_REBOOT: u8 = 0x10;
pub const TAG_DISCONNECTED: u8 = 0x12;
pub const TAG_ERROR: u8 = 0x13;

#[derive(Debug, PartialEq)]
pub enum Command {
    RunScript(String),
    StopScript,
    EnableStreaming { enable: bool, raw: bool },
    SetStreamSource(u32),
    GetMemory,
    GetStats,
    ReadChannel(u8),
    ReadStdout,
    ReadFrame,
    UpdateChannels,
    Reset,
    Bootloader,
    Disconnect,
}

impl Command {
    fn is_priority(&self) -> bool {
        matches!(
            self,
            Command::RunScript(_)
                | Command::StopScript
                | Command::Reset
                | Command::Bootloader
                | Command::Disconnect
        )
    }

    fn is_idempotent(&self) -> bool {
        matches!(
            self,
            Command::GetMemory
                | Command::GetStats
                | Command::ReadChannel(_)
                | Command::ReadStdout
                | Command::ReadFrame
                | Command::UpdateChannels
        )
    }
}

#[derive(Debug, Clone)]
struct ChannelInfo {
    id: u8,
    flags: u8,
}

pub struct Camera {
    transport: Option<Transport>,
    channels: HashMap<String, ChannelInfo>,
    event_counts: HashMap<u8, u32>,
    queue: VecDeque<Command>,
    max_payload: usize,
    pub sysinfo: Option<SystemInfo>,
    pub verinfo: Option<VersionInfo>,
}

impl Drop for Camera {
    fn drop(&mut self) {
        self.disconnect();
    }
}

impl Camera {
    pub fn new() -> Self {
        Self {
            transport: None,
            channels: HashMap::new(),
            event_counts: HashMap::new(),
            queue: VecDeque::new(),
            max_payload: 4096,
            sysinfo: None,
            verinfo: None,
        }
    }

    fn is_connected(&self) -> bool {
        self.transport.as_ref().is_some_and(|t| t.is_connected())
    }

    pub fn connect(&mut self, address: &str, transport: &str) -> Result<(), TransportError> {
        self.disconnect();
        self.transport = Some(Transport::new(address, transport, MIN_PAYLOAD_SIZE)?);
        self.resync()?;
        self.update_channels()?;
        self.cache_info();
        Ok(())
    }

    fn disconnect(&mut self) {
        self.transport = None;
        self.sysinfo = None;
        self.verinfo = None;
        self.channels.clear();
        self.event_counts.clear();
    }

    // -- Protocol primitives --
    fn transport(&mut self) -> Result<&mut Transport, TransportError> {
        self.transport.as_mut().ok_or(TransportError::NotConnected)
    }

    fn resync(&mut self) -> Result<(), TransportError> {
        let t = self.transport()?;
        t.open()?;
        t.reset_caps();
        t.reset_sequence();

        for attempt in 0..3 {
            self.transport()?
                .send_packet(Opcode::ProtoSync, 0, PacketFlags::empty(), None)?;
            match self.transport()?.recv_packet(None) {
                Ok(_) => {
                    self.transport()?.reset_sequence();
                    return self.negotiate_caps();
                }
                Err(_) if attempt < 2 => continue,
                Err(e) => {
                    log::error!("Resync failed after 3 attempts: {}", e);
                    return Err(e);
                }
            }
        }
        Err(TransportError::Timeout)
    }

    fn send_cmd(
        &mut self,
        opcode: Opcode,
        channel: u8,
        data: Option<&[u8]>,
    ) -> Result<Option<Vec<u8>>, TransportError> {
        for attempt in 0..2 {
            let result: Result<Option<Vec<u8>>, TransportError> = (|| {
                self.transport()?
                    .send_packet(opcode, channel, PacketFlags::empty(), data)?;
                if opcode == Opcode::SysReset || opcode == Opcode::SysBoot {
                    return Ok(None);
                }
                Ok(self.transport()?.recv_packet(None)?.payload)
            })();

            match &result {
                Err(e) if e.is_recoverable() && attempt == 0 => {
                    log::warn!("Protocol error, resyncing...");
                    self.resync()?;
                }
                _ => return result,
            }
        }
        Err(TransportError::Timeout)
    }

    fn negotiate_caps(&mut self) -> Result<(), TransportError> {
        let p = self
            .send_cmd(Opcode::ProtoGetCaps, 0, None)?
            .ok_or(TransportError::Timeout)?;
        if p.len() < 6 {
            return Err(TransportError::IoError("Invalid caps".into()));
        }

        self.max_payload = self
            .max_payload
            .min(u16::from_le_bytes([p[4], p[5]]) as usize);

        let t = self.transport()?;
        let crc = t.crc_enabled();
        let seq = t.seq_enabled();
        let mut flags: u32 = 1 << 3; // events always on
        if crc {
            flags |= 1;
        }
        if seq {
            flags |= 1 << 1;
        }
        let mut buf = vec![0u8; 16];
        buf[0..4].copy_from_slice(&flags.to_le_bytes());
        buf[4..6].copy_from_slice(&(self.max_payload as u16).to_le_bytes());
        self.send_cmd(Opcode::ProtoSetCaps, 0, Some(&buf))?;

        let mp = self.max_payload;
        self.transport()?.update_caps(crc, seq, mp);
        Ok(())
    }

    fn update_channels(&mut self) -> Result<(), TransportError> {
        let p = self
            .send_cmd(Opcode::ChannelList, 0, None)?
            .ok_or(TransportError::Timeout)?;
        self.channels.clear();
        for i in 0..p.len() / 16 {
            let ofs = i * 16;
            let id = p[ofs];
            let flags = p[ofs + 1];
            let name_bytes = &p[ofs + 2..ofs + 16];
            let end = name_bytes.iter().position(|&b| b == 0).unwrap_or(14);
            self.channels.insert(
                String::from_utf8_lossy(&name_bytes[..end]).to_string(),
                ChannelInfo { id, flags },
            );
        }
        Ok(())
    }

    fn cache_info(&mut self) {
        if let Ok(Some(p)) = self.send_cmd(Opcode::ProtoVersion, 0, None) {
            if p.len() >= 9 {
                self.verinfo = Some(VersionInfo {
                    protocol: [p[0], p[1], p[2]],
                    bootloader: [p[3], p[4], p[5]],
                    firmware: [p[6], p[7], p[8]],
                });
            }
        }
        if let Ok(Some(p)) = self.send_cmd(Opcode::SysInfo, 0, None) {
            if p.len() >= 76 {
                let u = |o: usize| u32::from_le_bytes([p[o], p[o + 1], p[o + 2], p[o + 3]]);
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

    fn ch(&self, name: &str) -> Result<u8, TransportError> {
        self.channels
            .get(name)
            .map(|ci| ci.id)
            .ok_or_else(|| TransportError::IoError(format!("Channel '{}' not found", name)))
    }

    fn ch_size(&mut self, id: u8) -> Result<u32, TransportError> {
        let p = self
            .send_cmd(Opcode::ChannelSize, id, None)?
            .ok_or(TransportError::Timeout)?;
        Ok(u32::from_le_bytes([p[0], p[1], p[2], p[3]]))
    }

    fn ch_read(
        &mut self,
        id: u8,
        offset: u32,
        length: u32,
    ) -> Result<Vec<u8>, TransportError> {
        let mut req = [0u8; 8];
        req[0..4].copy_from_slice(&offset.to_le_bytes());
        req[4..8].copy_from_slice(&length.to_le_bytes());
        self.send_cmd(Opcode::ChannelRead, id, Some(&req))?
            .ok_or(TransportError::Timeout)
    }

    fn ch_write(&mut self, id: u8, data: &[u8]) -> Result<(), TransportError> {
        let chunk_size = self.max_payload - 8;
        for (i, chunk) in data.chunks(chunk_size).enumerate() {
            let offset = (i * chunk_size) as u32;
            let mut buf = vec![0u8; 8 + chunk.len()];
            buf[0..4].copy_from_slice(&offset.to_le_bytes());
            buf[4..8].copy_from_slice(&(chunk.len() as u32).to_le_bytes());
            buf[8..].copy_from_slice(chunk);
            self.send_cmd(Opcode::ChannelWrite, id, Some(&buf))?;
        }
        Ok(())
    }

    fn ch_ioctl(&mut self, id: u8, send_cmd: u32, args: &[u32]) -> Result<(), TransportError> {
        let mut buf = vec![0u8; 4 + args.len() * 4];
        buf[0..4].copy_from_slice(&send_cmd.to_le_bytes());
        for (i, a) in args.iter().enumerate() {
            buf[4 + i * 4..8 + i * 4].copy_from_slice(&a.to_le_bytes());
        }
        self.send_cmd(Opcode::ChannelIoctl, id, Some(&buf))?;
        Ok(())
    }

    // -- Script and streaming --

    fn exec_script(&mut self, script: &str) -> Result<(), TransportError> {
        let id = self.ch("stdin")?;
        self.ch_ioctl(id, ioctl::STDIN_RESET, &[])?;
        self.ch_write(id, script.as_bytes())?;
        self.ch_ioctl(id, ioctl::STDIN_EXEC, &[])
    }

    fn stop_script(&mut self) -> Result<(), TransportError> {
        let id = self.ch("stdin")?;
        self.ch_ioctl(id, ioctl::STDIN_STOP, &[])
    }

    fn enable_streaming(&mut self, enable: bool, raw: bool) -> Result<(), TransportError> {
        let id = self.ch("stream")?;
        self.ch_ioctl(id, ioctl::STREAM_RAW_CTRL, &[raw as u32])?;
        self.ch_ioctl(id, ioctl::STREAM_CTRL, &[enable as u32])
    }

    fn set_stream_source(&mut self, chip_id: u32) -> Result<(), TransportError> {
        let id = self.ch("stream")?;
        self.ch_ioctl(id, ioctl::STREAM_SOURCE, &[chip_id])
    }

    fn do_reset(&mut self, opcode: Opcode) -> Result<(), TransportError> {
        // Send reset/boot command; ignore response since the camera will hard-reset.
        let _ = self.send_cmd(opcode, 0, None);
        self.disconnect();
        Ok(())
    }

    // -- Data queries --

    fn memory_stats(&mut self) -> Result<Vec<MemEntry>, TransportError> {
        let p = self
            .send_cmd(Opcode::SysMemory, 0, None)?
            .ok_or(TransportError::Timeout)?;
        if p.len() < 4 {
            return Err(TransportError::IoError(
                "Invalid SYS_MEMORY response".into(),
            ));
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

    fn device_stats(&mut self) -> Result<ProtoStats, TransportError> {
        let p = self
            .send_cmd(Opcode::ProtoStats, 0, None)?
            .ok_or(TransportError::Timeout)?;
        if p.len() < 32 {
            return Err(TransportError::IoError(
                "Invalid PROTO_STATS response".into(),
            ));
        }
        let u = |o: usize| u32::from_le_bytes([p[o], p[o + 1], p[o + 2], p[o + 3]]);
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

    fn get_channels(&self) -> Vec<(String, u8, u8)> {
        self.channels
            .iter()
            .map(|(k, ci)| (k.clone(), ci.id, ci.flags))
            .collect()
    }

    // -- Worker command handlers --

    fn do_read_stdout(&mut self, tx: &Channel) -> Result<(), TransportError> {
        let id = self.ch("stdout")?;
        let size = self.ch_size(id)?;
        if size == 0 {
            return Ok(());
        }
        let data = self.ch_read(id, 0, size)?;
        let mut buf = Vec::with_capacity(1 + data.len());
        buf.push(TAG_STDOUT);
        buf.extend_from_slice(&data);
        let _ = tx.send(InvokeResponseBody::Raw(buf));
        Ok(())
    }

    fn do_read_frame(&mut self, tx: &Channel) -> Result<(), TransportError> {
        let id = self.ch("stream")?;
        match self.send_cmd(Opcode::ChannelLock, id, None) {
            Err(TransportError::Busy) => {
                self.enqueue(Command::ReadFrame);
                return Ok(());
            }
            Err(e) => return Err(e),
            Ok(_) => {}
        }
        let result = self.read_frame_locked(id, tx);
        let _ = self.send_cmd(Opcode::ChannelUnlock, id, None);
        result
    }

    fn read_frame_locked(&mut self, id: u8, tx: &Channel) -> Result<(), TransportError> {
        let size = self.ch_size(id)?;
        if size <= 24 {
            return Ok(());
        }

        let data = self.ch_read(id, 0, size)?;
        let width = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        let height = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);
        let format = u32::from_le_bytes([data[8], data[9], data[10], data[11]]);
        let offset = u32::from_le_bytes([data[16], data[17], data[18], data[19]]) as usize;
        let fps = f32::from_le_bytes([data[20], data[21], data[22], data[23]]);

        if offset >= data.len() {
            return Ok(());
        }

        let raw = &data[offset..];
        let pixels = (width as usize).saturating_mul(height as usize);

        match format {
            PIXFORMAT_RGB565 if raw.len() != pixels * 2 => return Ok(()),
            PIXFORMAT_GRAYSCALE if raw.len() != pixels => return Ok(()),
            _ => {}
        }

        // tag + header (w, h, format, fps) + pixel data
        let mut buf = Vec::with_capacity(1 + 16 + raw.len());
        buf.push(TAG_FRAME);
        buf.extend_from_slice(&width.to_le_bytes());
        buf.extend_from_slice(&height.to_le_bytes());
        buf.extend_from_slice(&format.to_le_bytes());
        buf.extend_from_slice(&fps.to_le_bytes());
        buf.extend_from_slice(raw);
        let _ = tx.send(InvokeResponseBody::Raw(buf));
        Ok(())
    }

    fn do_get_memory(&mut self, tx: &Channel) -> Result<(), TransportError> {
        let entries = self.memory_stats()?;
        let mut buf = Vec::with_capacity(1 + 4 + entries.len() * 24);
        buf.push(TAG_MEMORY);
        buf.push(entries.len() as u8);
        buf.extend_from_slice(&[0u8; 3]);
        for e in &entries {
            let mem_type: u8 = if e.mem_type == "gc" { 0 } else { 1 };
            buf.push(mem_type);
            buf.push(0);
            buf.extend_from_slice(&e.flags.to_le_bytes());
            buf.extend_from_slice(&e.total.to_le_bytes());
            buf.extend_from_slice(&e.used.to_le_bytes());
            buf.extend_from_slice(&e.free.to_le_bytes());
            buf.extend_from_slice(&e.persist.to_le_bytes());
            buf.extend_from_slice(&e.peak.to_le_bytes());
        }
        let _ = tx.send(InvokeResponseBody::Raw(buf));
        Ok(())
    }

    fn do_get_stats(&mut self, tx: &Channel) -> Result<(), TransportError> {
        let stats = self.device_stats()?;
        let channels_info = self.get_channels();
        let mut buf = Vec::with_capacity(1 + 36 + channels_info.len() * 20);
        buf.push(TAG_STATS);
        for val in [
            stats.sent,
            stats.received,
            stats.checksum,
            stats.sequence,
            stats.retransmit,
            stats.transport,
            stats.sent_events,
            stats.max_ack_queue_depth,
        ] {
            buf.extend_from_slice(&val.to_le_bytes());
        }
        buf.push(channels_info.len() as u8);
        buf.extend_from_slice(&[0u8; 3]);
        for (name, id, flags) in &channels_info {
            buf.push(*id);
            buf.push(*flags);
            let name_bytes = name.as_bytes();
            let len = name_bytes.len().min(14);
            buf.extend_from_slice(&name_bytes[..len]);
            for _ in len..14 {
                buf.push(0);
            }
            let events = self.event_counts.get(id).copied().unwrap_or(0);
            buf.extend_from_slice(&events.to_le_bytes());
        }
        let _ = tx.send(InvokeResponseBody::Raw(buf));
        Ok(())
    }

    fn do_read_channel(&mut self, id: u8, tx: &Channel) -> Result<(), TransportError> {
        let name = self
            .channels
            .iter()
            .find(|(_, ci)| ci.id == id)
            .map(|(n, _)| n.clone())
            .ok_or_else(|| TransportError::IoError(format!("Channel {} not found", id)))?;

        let size = self.ch_size(id)?;
        if size == 0 {
            return Ok(());
        }
        let data = self.ch_read(id, 0, size)?;

        // Single-channel format: [TAG, name_len, name, data_len, data]
        let mut buf = Vec::with_capacity(1 + 1 + name.len() + 4 + data.len());
        buf.push(TAG_CHANNELS);
        buf.push(name.len() as u8);
        buf.extend_from_slice(name.as_bytes());
        buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
        buf.extend_from_slice(&data);
        let _ = tx.send(InvokeResponseBody::Raw(buf));
        Ok(())
    }

    // -- Worker loop --
    pub fn run(&mut self, rx: mpsc::Receiver<Command>, tx: &Channel, io_interval: Duration) {
        loop {
            while let Ok(send_cmd) = rx.try_recv() {
                self.enqueue(send_cmd);
            }

            if !self.queue.is_empty() {
                let send_cmd = self.queue.pop_front().unwrap();
                if matches!(send_cmd, Command::Disconnect) {
                    break;
                }
                self.process_cmd(send_cmd, tx);
            } else {
                // No commands to process - poll events.
                self.transport().and_then(|t| t.recv_packet(Some(Duration::from_millis(1))));
            }

            // Process collected events during command/events polling.
            self.process_events(tx);

            if !self.is_connected() {
                let _ = tx.send(InvokeResponseBody::Raw(vec![TAG_DISCONNECTED]));
                break;
            }

            if self.queue.is_empty() {
                std::thread::sleep(io_interval);
            }
        }
    }

    fn enqueue(&mut self, send_cmd: Command) {
        if send_cmd.is_idempotent() && self.queue.iter().any(|c| c == &send_cmd) {
            return;
        }
        if send_cmd.is_priority() {
            // User actions go to the front of the queue.
            let pos = self
                .queue
                .iter()
                .position(|c| !c.is_priority())
                .unwrap_or(self.queue.len());
            self.queue.insert(pos, send_cmd);
        } else {
            self.queue.push_back(send_cmd);
        }
    }

    fn process_cmd(&mut self, send_cmd: Command, tx: &Channel) {
        let result = match &send_cmd {
            Command::RunScript(script) => self.exec_script(script),
            Command::StopScript => self.stop_script(),
            Command::EnableStreaming { enable, raw } => self.enable_streaming(*enable, *raw),
            Command::SetStreamSource(chip_id) => self.set_stream_source(*chip_id),
            Command::GetMemory => self.do_get_memory(tx),
            Command::GetStats => self.do_get_stats(tx),
            Command::ReadChannel(id) => self.do_read_channel(*id, tx),
            Command::ReadStdout => self.do_read_stdout(tx),
            Command::ReadFrame => self.do_read_frame(tx),
            Command::UpdateChannels => self.update_channels(),
            Command::Reset => self.do_reset(Opcode::SysReset),
            Command::Bootloader => self.do_reset(Opcode::SysBoot),
            Command::Disconnect => unreachable!(),
        };

        if let Err(e) = result {
            log::warn!("process_cmd({:?}): {}", send_cmd, e);
            if matches!(e, TransportError::IoError(_) | TransportError::NotConnected) {
                self.disconnect();
            }
            let mut buf = vec![TAG_ERROR];
            buf.extend_from_slice(e.to_string().as_bytes());
            let _ = tx.send(InvokeResponseBody::Raw(buf));
        }
    }

    fn process_events(&mut self, tx: &Channel) {
        let events = match self.transport.as_mut() {
            Some(t) => t.drain_events(),
            None => return,
        };

        for packet in events {
            *self.event_counts.entry(packet.channel).or_insert(0) += 1;

            if packet.channel == 0 {
                let payload = match packet.payload.as_ref() {
                    Some(p) if p.len() >= 2 => p,
                    _ => continue,
                };
                let event_type = u16::from_le_bytes([payload[0], payload[1]]);
                if event_type == EventType::ChannelRegistered as u16
                    || event_type == EventType::ChannelUnregistered as u16
                {
                    self.enqueue(Command::UpdateChannels);
                } else if event_type == EventType::SoftReboot as u16 {
                    self.enqueue(Command::UpdateChannels);
                    let _ = tx.send(InvokeResponseBody::Raw(vec![TAG_SOFT_REBOOT]));
                }
            } else {
                let info = self
                    .channels
                    .iter()
                    .find(|(_, ci)| ci.id == packet.channel)
                    .map(|(name, ci)| (name.as_str(), ci.flags));

                match info {
                    Some(("stdout", _)) => self.enqueue(Command::ReadStdout),
                    Some(("stream", _)) => self.enqueue(Command::ReadFrame),
                    Some((_, flags)) if flags & CHANNEL_FLAG_DYNAMIC != 0 => {
                        self.enqueue(Command::ReadChannel(packet.channel));
                    }
                    _ => {}
                }
            }
        }
    }
}
