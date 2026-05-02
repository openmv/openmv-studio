// Copyright (C) 2026 OpenMV, LLC.
//
// This software is licensed under terms that can be found in the
// LICENSE file in the root directory of this software component.

// OpenMV Protocol Transport Layer

use std::time::{Duration, Instant};
use crate::protocol::*;
use crate::backend::{Backend, NetworkBackend, SerialBackend};
use crate::checksum::{calc_crc16, calc_crc32};

#[derive(Debug, Clone, Copy, PartialEq)]
enum TransportState {
    Sync,
    Header,
    Payload,
}

#[derive(Debug, Clone, Copy)]
pub struct TransportCaps {
    pub crc: bool,
    pub seq: bool,
    pub ack: bool,
    pub events: bool,
    pub max_payload: usize,
}

#[derive(Debug)]
pub enum TransportError {
    Failed,
    Invalid,
    Timeout,
    Busy,
    Checksum,
    Sequence,
    Overflow,
    Fragment,
    IoError(String),
    PayloadTooLarge,
    NotConnected,
    Unknown,
}

impl TransportError {
    pub fn is_recoverable(&self) -> bool {
        matches!(self, Self::Sequence | Self::Checksum | Self::Timeout)
    }

    pub fn is_fatal(&self) -> bool {
        matches!(self, Self::IoError(_) | Self::NotConnected)
    }
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Failed => write!(f, "Command failed"),
            Self::Invalid => write!(f, "Invalid command"),
            Self::Timeout => write!(f, "Timeout"),
            Self::Busy => write!(f, "Busy"),
            Self::Checksum => write!(f, "Checksum error"),
            Self::Sequence => write!(f, "Sequence error"),
            Self::Overflow => write!(f, "Overflow"),
            Self::Fragment => write!(f, "Fragment error"),
            Self::Unknown => write!(f, "Unknown error"),
            Self::IoError(e) => write!(f, "IO: {}", e),
            Self::PayloadTooLarge => write!(f, "Payload too large"),
            Self::NotConnected => write!(f, "Not connected"),
        }
    }
}

pub struct Transport {
    backend: Option<Box<dyn Backend>>,
    timeout: Duration,

    // Protocol state
    pub sequence: u8,
    state: TransportState,
    plength: usize,
    caps: TransportCaps,

    // Buffers
    buf: Vec<u8>,
    pos: usize, // read cursor into buf
    pbuf: Vec<u8>,

    // Events collected during recv_packet
    events: Vec<crate::protocol::Packet>,
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.close();
    }
}

impl Transport {
    pub fn new(address: &str, transport: &str, max_payload: usize) -> Result<Self, TransportError> {
        let backend: Box<dyn Backend> = match transport {
            "serial" => Box::new(SerialBackend::new(address, max_payload)),
            "udp" => Box::new(NetworkBackend::new(address, max_payload)),
            _ => return Err(TransportError::IoError(format!("Unknown transport: {}", transport))),
        };
        let caps = backend.caps();
        Ok(Self {
            backend: Some(backend),
            timeout: Duration::from_millis(1000),
            sequence: 0,
            state: TransportState::Sync,
            plength: 0,
            caps,
            buf: Vec::with_capacity(max_payload * 4),
            pos: 0,
            pbuf: vec![0u8; max_payload + HEADER_SIZE + CRC_SIZE],
            events: Vec::new(),
        })
    }

    pub fn open(&mut self) -> Result<(), TransportError> {
        if let Some(ref mut backend) = self.backend {
            backend.open()?;
        }
        self.buf.clear();
        self.pos = 0;
        self.state = TransportState::Sync;
        Ok(())
    }

    pub fn reset_state(&mut self) -> Result<(), TransportError> {
        if let Some(ref mut backend) = self.backend {
            backend.reset()?;
        }
        self.buf.clear();
        self.pos = 0;
        self.state = TransportState::Sync;
        self.events.clear();
        Ok(())
    }

    pub fn close(&mut self) {
        if let Some(ref mut backend) = self.backend {
            backend.close();
        }
        self.backend = None;
    }

    pub fn is_connected(&self) -> bool {
        match &self.backend {
            Some(backend) => backend.is_connected(),
            None => false,
        }
    }

    pub fn reset_sequence(&mut self) {
        self.sequence = 0;
    }

    pub fn get_caps(&self) -> (bool, bool, bool, bool, usize) {
        (self.caps.crc, self.caps.seq, self.caps.ack, self.caps.events, self.caps.max_payload)
    }

    pub fn set_caps(&mut self, crc: bool, seq: bool, ack: bool, events: bool, max_payload: usize) {
        self.caps = TransportCaps { crc, seq, ack, events, max_payload };
        self.buf.clear();
        self.pos = 0;
        self.pbuf = vec![0u8; max_payload + HEADER_SIZE + CRC_SIZE];
    }

    pub fn reset_caps(&mut self) {
        if let Some(ref backend) = self.backend {
            let c = backend.caps();
            self.set_caps(c.crc, c.seq, c.ack, c.events, c.max_payload);
        }
    }

    fn compute_crc16(&self, data: &[u8]) -> u16 {
        if self.caps.crc { calc_crc16(data) } else { 0 }
    }

    fn compute_crc32(&self, data: &[u8]) -> u32 {
        if self.caps.crc { calc_crc32(data) } else { 0 }
    }

    fn check_crc16(&self, crc: u16, data: &[u8]) -> bool {
        !self.caps.crc || crc == calc_crc16(data)
    }

    fn check_crc32(&self, crc: u32, data: &[u8]) -> bool {
        !self.caps.crc || crc == calc_crc32(data)
    }

    fn check_seq(&self, seq: u8, opcode: u8, flags: PacketFlags) -> bool {
        !self.caps.seq
            || flags.contains(PacketFlags::EVENT)
            || flags.contains(PacketFlags::RTX)
            || seq == self.sequence
            || opcode == Opcode::ProtoSync as u8
    }

    pub fn send_packet(
        &mut self,
        opcode: Opcode,
        channel: u8,
        flags: PacketFlags,
        data: Option<&[u8]>,
    ) -> Result<(), TransportError> {
        if !self.is_connected() {
            return Err(TransportError::NotConnected);
        }
        let length = data.map_or(0, |d| d.len());
        if length > self.caps.max_payload {
            return Err(TransportError::PayloadTooLarge);
        }

        // Header: sync(2) + seq(1) + chan(1) + flags(1) + opcode(1) + length(2) + crc(2)
        self.pbuf[0..2].copy_from_slice(&SYNC_WORD.to_le_bytes());
        self.pbuf[2] = self.sequence;
        self.pbuf[3] = channel;
        self.pbuf[4] = flags.bits();
        self.pbuf[5] = opcode as u8;
        self.pbuf[6..8].copy_from_slice(&(length as u16).to_le_bytes());

        let hdr_crc = self.compute_crc16(&self.pbuf[..HEADER_SIZE - 2]);
        self.pbuf[8..10].copy_from_slice(&hdr_crc.to_le_bytes());

        // Payload + CRC
        if let Some(d) = data {
            self.pbuf[HEADER_SIZE..HEADER_SIZE + length].copy_from_slice(d);
            let p_crc = self.compute_crc32(d);
            self.pbuf[HEADER_SIZE + length..HEADER_SIZE + length + CRC_SIZE]
                .copy_from_slice(&p_crc.to_le_bytes());
        }

        let total = HEADER_SIZE + length + if length > 0 { CRC_SIZE } else { 0 };
        match &mut self.backend {
            Some(backend) => backend.write(&self.pbuf[..total])?,
            None => return Err(TransportError::NotConnected),
        }

        Ok(())
    }

    /// Receive a packet. Caller checks flags to determine its type.
    /// Events are ACK'd and queued to be processed later by caller.
    pub fn recv_packet(&mut self, timeout: Option<Duration>) -> Result<Packet, TransportError> {
        if !self.is_connected() {
            return Err(TransportError::NotConnected);
        }
        let mut fragments: Vec<u8> = Vec::new();
        let idle = timeout.unwrap_or(self.timeout);
        let mut deadline = Instant::now() + idle;

        loop {
            if Instant::now() >= deadline {
                if idle.as_millis() > 10 {
                    log::warn!(
                        "recv_packet: idle timeout after {:?}, buf={} bytes, fragments={}",
                        idle, self.available(), fragments.len()
                    );
                }
                return Err(TransportError::Timeout);
            }

            // Read all available data from backend; reset deadline on any progress.
            let before = self.buf.len();
            match &mut self.backend {
                Some(backend) => backend.read(&mut self.buf)?,
                None => return Err(TransportError::NotConnected),
            }
            if self.buf.len() != before {
                deadline = Instant::now() + idle;
            }

            // Run state machine
            let mut packet = match self.process() {
                Some(p) => p,
                None => continue,
            };

            // Sequence check
            if !self.check_seq(packet.sequence, packet.opcode, packet.flags) {
                log::warn!(
                    "recv_packet: sequence mismatch: got={} expected={} opcode=0x{:02x} flags={:?}",
                    packet.sequence, self.sequence, packet.opcode, packet.flags
                );
                return Err(TransportError::Sequence);
            }

            // Handle retransmission
            if packet.flags.contains(PacketFlags::RTX) && self.sequence != packet.sequence {
                if packet.flags.contains(PacketFlags::ACK_REQ) {
                    self.send_packet(
                        Opcode::from_u8(packet.opcode).unwrap_or(Opcode::ProtoSync),
                        packet.channel,
                        PacketFlags::ACK,
                        None,
                    )?;
                }
                continue;
            }

            // ACK if requested
            if packet.flags.contains(PacketFlags::ACK_REQ) {
                self.send_packet(
                    Opcode::from_u8(packet.opcode).unwrap_or(Opcode::ProtoSync),
                    packet.channel,
                    PacketFlags::ACK,
                    None,
                )?;
            }

            // Events - ACK'd above, buffer and keep waiting
            if packet.flags.contains(PacketFlags::EVENT) {
                self.events.push(packet);
                continue;
            }

            // Advance sequence
            self.sequence = self.sequence.wrapping_add(1);

            // Collect fragments, cap at 10MB. Deadline already resets on
            // backend progress, so no separate per-fragment reset needed.
            if packet.flags.contains(PacketFlags::FRAGMENT) {
                if packet.length > 0 {
                    let p = packet.payload.as_ref().unwrap();
                    if fragments.len() + packet.length as usize > 10 * 1024 * 1024 {
                        log::warn!("Fragment overflow (>10MB), dropping");
                        fragments.clear();
                        continue;
                    }
                    fragments.extend_from_slice(p);
                }
                continue;
            }

            // Last fragment or non-fragmented packet
            if !fragments.is_empty() {
                if packet.length > 0 {
                    fragments.extend_from_slice(packet.payload.as_ref().unwrap());
                }
                packet.payload = Some(fragments);
                packet.length = packet.payload.as_ref().unwrap().len() as u16;
            }

            if packet.flags.contains(PacketFlags::NAK) {
                let p = packet.payload.as_ref().unwrap();
                let raw = u16::from_le_bytes([p[0], p[1]]);
                let status = Status::from_u16(raw);
                let err = match status {
                    Some(Status::Failed) => TransportError::Failed,
                    Some(Status::Invalid) => TransportError::Invalid,
                    Some(Status::Timeout) => TransportError::Timeout,
                    Some(Status::Busy) => TransportError::Busy,
                    Some(Status::Checksum) => TransportError::Checksum,
                    Some(Status::Sequence) => TransportError::Sequence,
                    Some(Status::Overflow) => TransportError::Overflow,
                    Some(Status::Fragment) => TransportError::Fragment,
                    _ => TransportError::Unknown,
                };
                if !matches!(err, TransportError::Busy) {
                    log::warn!(
                        "recv_packet: NAK opcode=0x{:02x} ch={} status={}(0x{:04x}) seq={}",
                        packet.opcode, packet.channel, err, raw, packet.sequence
                    );
                }
                return Err(err);
            }

            return Ok(packet);
        }
    }

    /// Drain buffered events collected during recv_packet.
    pub fn drain_events(&mut self) -> Vec<crate::protocol::Packet> {
        std::mem::take(&mut self.events)
    }

    /// Bytes available to read from pos.
    #[inline]
    fn available(&self) -> usize {
        self.buf.len() - self.pos
    }

    /// Slice of unread data - always contiguous, zero-cost.
    #[inline]
    fn data(&self) -> &[u8] {
        &self.buf[self.pos..]
    }

    /// Advance read cursor by n bytes. Compacts when >64KB consumed.
    #[inline]
    fn consume(&mut self, n: usize) {
        self.pos += n;
        if self.pos > 65536 {
            self.buf.drain(..self.pos);
            self.pos = 0;
        }
    }

    /// Run the protocol state machine. Returns a parsed packet or None.
    fn process(&mut self) -> Option<Packet> {
        loop {
            if self.available() < 2 {
                return None;
            }

            match self.state {
                TransportState::Sync => {
                    let d = self.data();
                    let mut i = 0;
                    while i + 1 < d.len() {
                        if u16::from_le_bytes([d[i], d[i + 1]]) == SYNC_WORD {
                            break;
                        }
                        i += 1;
                    }
                    if i > 0 {
                        self.consume(i);
                    }
                    if self.available() < 2 {
                        return None;
                    }
                    self.state = TransportState::Header;
                }

                TransportState::Header => {
                    if self.available() < HEADER_SIZE {
                        return None;
                    }
                    let d = self.data();

                    let length = u16::from_le_bytes([d[6], d[7]]);
                    let hdr_crc = u16::from_le_bytes([d[8], d[9]]);

                    if length as usize > self.caps.max_payload
                        || !self.check_crc16(hdr_crc, &d[..HEADER_SIZE - 2])
                    {
                        self.consume(1);
                        self.state = TransportState::Sync;
                    } else {
                        self.plength =
                            HEADER_SIZE + length as usize + if length > 0 { CRC_SIZE } else { 0 };
                        self.state = TransportState::Payload;
                    }
                }

                TransportState::Payload => {
                    if self.available() < self.plength {
                        return None;
                    }
                    let d = self.data();

                    let seq = d[2];
                    let chan = d[3];
                    let flags = PacketFlags::from_bits_truncate(d[4]);
                    let opcode = d[5];
                    let length = u16::from_le_bytes([d[6], d[7]]) as usize;

                    let payload = if length > 0 {
                        let payload_data = &d[HEADER_SIZE..HEADER_SIZE + length];
                        let payload_crc = u32::from_le_bytes([
                            d[HEADER_SIZE + length],
                            d[HEADER_SIZE + length + 1],
                            d[HEADER_SIZE + length + 2],
                            d[HEADER_SIZE + length + 3],
                        ]);
                        if !self.check_crc32(payload_crc, payload_data) {
                            self.consume(1);
                            self.state = TransportState::Sync;
                            continue;
                        }
                        Some(payload_data.to_vec())
                    } else {
                        None
                    };

                    self.consume(self.plength);
                    self.state = TransportState::Sync;

                    return Some(Packet {
                        sequence: seq,
                        channel: chan,
                        flags,
                        opcode,
                        length: length as u16,
                        payload,
                    });
                }
            }
        }
    }
}
