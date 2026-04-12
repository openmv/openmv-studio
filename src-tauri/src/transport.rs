// OpenMV Protocol Transport Layer

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use crc::{Algorithm, Crc, Table};

use crate::protocol::*;

const OPENMV_CRC16: Algorithm<u16> = Algorithm {
    width: 16,
    poly: 0xF94F,
    init: 0xFFFF,
    refin: false,
    refout: false,
    xorout: 0x0000,
    check: 0x0000,
    residue: 0x0000,
};

const OPENMV_CRC32: Algorithm<u32> = Algorithm {
    width: 32,
    poly: 0xFA567D89,
    init: 0xFFFFFFFF,
    refin: false,
    refout: false,
    xorout: 0x00000000,
    check: 0x00000000,
    residue: 0x00000000,
};

const CRC16: Crc<u16, Table<16>> = Crc::<u16, Table<16>>::new(&OPENMV_CRC16);
const CRC32: Crc<u32, Table<16>> = Crc::<u32, Table<16>>::new(&OPENMV_CRC32);

#[derive(Debug)]
pub enum TransportError {
    Timeout,
    Checksum,
    Sequence,
    Nak(Status),
    IoError(String),
    PayloadTooLarge,
    NotConnected,
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Timeout => write!(f, "Timeout"),
            Self::Checksum => write!(f, "Checksum error"),
            Self::Sequence => write!(f, "Sequence error"),
            Self::Nak(s) => write!(f, "NAK: {:?}", s),
            Self::IoError(e) => write!(f, "IO: {}", e),
            Self::PayloadTooLarge => write!(f, "Payload too large"),
            Self::NotConnected => write!(f, "Not connected"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ParseState {
    Sync,
    Header,
    Payload,
}

pub struct Transport {
    serial: Option<Box<dyn serialport::SerialPort>>,
    baudrate: u32,
    port: String,
    timeout: Duration,
    pub max_payload: usize,

    // Protocol state
    pub sequence: u8,
    state: ParseState,
    plength: usize,
    crc_enabled: bool,
    seq_enabled: bool,

    // Buffers
    buf: Vec<u8>,
    pos: usize, // read cursor into buf
    pbuf: Vec<u8>,

    // Read buffer for serial
    read_buf: Vec<u8>,

    // Set when a CHANNEL_REGISTERED event is received
    pub pending_channel: bool,
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.close();
    }
}

impl Transport {
    pub fn new(
        port: &str,
        baudrate: u32,
        crc: bool,
        seq: bool,
        max_payload: usize,
        timeout: Duration,
    ) -> Result<Self, TransportError> {
        let mut t = Self {
            serial: None,
            baudrate,
            port: port.to_string(),
            timeout,
            max_payload,
            sequence: 0,
            state: ParseState::Sync,
            plength: 0,
            crc_enabled: crc,
            seq_enabled: seq,
            buf: Vec::with_capacity(max_payload * 4),
            pos: 0,
            pbuf: vec![0u8; max_payload + HEADER_SIZE + CRC_SIZE],
            read_buf: vec![0u8; 16384],
            pending_channel: false,
        };
        t.open()?;
        Ok(t)
    }

    pub fn open(&mut self) -> Result<(), TransportError> {
        self.close();
        let mut serial = serialport::new(&self.port, self.baudrate)
            .timeout(self.timeout)
            .open()
            .map_err(|e| TransportError::IoError(e.to_string()))?;
        let _ = serial.clear(serialport::ClearBuffer::All);
        std::thread::sleep(Duration::from_millis(100));
        let _ = serial.clear(serialport::ClearBuffer::All);
        self.serial = Some(serial);
        self.buf.clear();
        self.pos = 0;
        self.state = ParseState::Sync;
        Ok(())
    }

    pub fn close(&mut self) {
        if let Some(ref mut s) = self.serial {
            let _ = s.flush();
        }
        self.serial = None;
    }

    pub fn is_connected(&self) -> bool {
        self.serial
            .as_ref()
            .is_some_and(|s| s.bytes_to_read().is_ok())
    }

    pub fn reset_sequence(&mut self) {
        self.sequence = 0;
    }

    pub fn update_caps(&mut self, crc: bool, seq: bool, max_payload: usize) {
        self.crc_enabled = crc;
        self.seq_enabled = seq;
        self.max_payload = max_payload;
        self.buf.clear();
        self.pos = 0;
        self.pbuf = vec![0u8; max_payload + HEADER_SIZE + CRC_SIZE];
    }

    fn calc_crc16(&self, data: &[u8]) -> u16 {
        if self.crc_enabled {
            CRC16.checksum(data)
        } else {
            0
        }
    }

    fn calc_crc32(&self, data: &[u8]) -> u32 {
        if self.crc_enabled {
            CRC32.checksum(data)
        } else {
            0
        }
    }

    fn check_crc16(&self, crc: u16, data: &[u8]) -> bool {
        !self.crc_enabled || crc == CRC16.checksum(data)
    }

    fn check_crc32(&self, crc: u32, data: &[u8]) -> bool {
        !self.crc_enabled || crc == CRC32.checksum(data)
    }

    fn check_seq(&self, seq: u8, opcode: u8, flags: PacketFlags) -> bool {
        !self.seq_enabled
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
        if length > self.max_payload {
            return Err(TransportError::PayloadTooLarge);
        }

        // Header: sync(2) + seq(1) + chan(1) + flags(1) + opcode(1) + length(2) + crc(2)
        self.pbuf[0..2].copy_from_slice(&SYNC_WORD.to_le_bytes());
        self.pbuf[2] = self.sequence;
        self.pbuf[3] = channel;
        self.pbuf[4] = flags.bits();
        self.pbuf[5] = opcode as u8;
        self.pbuf[6..8].copy_from_slice(&(length as u16).to_le_bytes());

        let hdr_crc = self.calc_crc16(&self.pbuf[..HEADER_SIZE - 2]);
        self.pbuf[8..10].copy_from_slice(&hdr_crc.to_le_bytes());

        // Payload + CRC
        if let Some(d) = data {
            self.pbuf[HEADER_SIZE..HEADER_SIZE + length].copy_from_slice(d);
            let p_crc = self.calc_crc32(d);
            self.pbuf[HEADER_SIZE + length..HEADER_SIZE + length + CRC_SIZE]
                .copy_from_slice(&p_crc.to_le_bytes());
        }

        let total = HEADER_SIZE + length + if length > 0 { CRC_SIZE } else { 0 };
        let serial = self.serial.as_mut().ok_or(TransportError::NotConnected)?;
        serial
            .write_all(&self.pbuf[..total])
            .map_err(|e| TransportError::IoError(e.to_string()))?;

        Ok(())
    }

    /// Receive a packet. Returns Ok(Some(payload)) for data, Ok(None) for ACK, Err for failures.
    pub fn recv_packet(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        if !self.is_connected() {
            return Err(TransportError::NotConnected);
        }
        let mut fragments: Vec<u8> = Vec::new();
        let mut deadline = Instant::now() + self.timeout;

        loop {
            if Instant::now() >= deadline {
                return Err(TransportError::Timeout);
            }

            // Read all available serial data
            let serial = self.serial.as_mut().ok_or(TransportError::NotConnected)?;
            loop {
                match serial.bytes_to_read() {
                    Ok(n) if n > 0 => {
                        let to_read = (n as usize).min(self.read_buf.len());
                        match serial.read(&mut self.read_buf[..to_read]) {
                            Ok(n) => {
                                self.buf.extend_from_slice(&self.read_buf[..n]);
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => break,
                            Err(e) => return Err(TransportError::IoError(e.to_string())),
                        }
                    }
                    Ok(_) => break,
                    Err(e) => return Err(TransportError::IoError(e.to_string())),
                }
            }

            if self.available() == 0 {
                std::thread::sleep(Duration::from_micros(100));
                continue;
            }

            // Run state machine
            let packet = match self.process() {
                Some(p) => p,
                None => {
                    std::thread::sleep(Duration::from_micros(100));
                    continue;
                }
            };

            // Sequence check: CRC-valid packet with wrong sequence means
            // the device is out of sync (e.g. after soft-reset). Return
            // error immediately instead of scanning until timeout.
            if !self.check_seq(packet.sequence, packet.opcode, packet.flags) {
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

            // Events -- set flags inline, reset deadline
            if packet.flags.contains(PacketFlags::EVENT) {
                if packet.channel == 0 {
                    let event = packet.payload.as_ref()
                        .filter(|p| p.len() >= 2)
                        .map(|p| u16::from_le_bytes([p[0], p[1]]));
                    if event == Some(EventType::ChannelRegistered as u16) {
                        self.pending_channel = true;
                    }
                }
                deadline = Instant::now() + self.timeout;
                continue;
            }

            // Advance sequence
            self.sequence = self.sequence.wrapping_add(1);

            // Collect fragments -- reset deadline per fragment, cap at 10MB
            if packet.flags.contains(PacketFlags::FRAGMENT) {
                if let Some(ref p) = packet.payload {
                    if fragments.len() + p.len() > 10 * 1024 * 1024 {
                        log::warn!("Fragment overflow (>10MB), dropping");
                        fragments.clear();
                        continue;
                    }
                    fragments.extend_from_slice(p);
                }
                deadline = Instant::now() + self.timeout;
                continue;
            }

            // Handle NAK
            if packet.flags.contains(PacketFlags::NAK) {
                if let Some(ref p) = packet.payload {
                    if p.len() >= 2 {
                        let status_val = u16::from_le_bytes([p[0], p[1]]);
                        let status = Status::from_u16(status_val).unwrap_or(Status::Unknown);
                        return match status {
                            Status::Busy => Err(TransportError::Nak(Status::Busy)),
                            Status::Failed => Err(TransportError::Nak(Status::Failed)),
                            Status::Checksum => Err(TransportError::Checksum),
                            Status::Sequence => Err(TransportError::Sequence),
                            Status::Timeout => Err(TransportError::Timeout),
                            _ => Err(TransportError::Nak(status)),
                        };
                    }
                }
                return Ok(None);
            }

            // Assemble final payload
            if !fragments.is_empty() {
                if let Some(ref p) = packet.payload {
                    fragments.extend_from_slice(p);
                }
                return Ok(Some(fragments));
            }

            return Ok(packet.payload);
        }
    }

    /// Bytes available to read from pos.
    #[inline]
    fn available(&self) -> usize {
        self.buf.len() - self.pos
    }

    /// Slice of unread data -- always contiguous, zero-cost.
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
                ParseState::Sync => {
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
                    self.state = ParseState::Header;
                }

                ParseState::Header => {
                    if self.available() < HEADER_SIZE {
                        return None;
                    }
                    let d = self.data();

                    let length = u16::from_le_bytes([d[6], d[7]]);
                    let hdr_crc = u16::from_le_bytes([d[8], d[9]]);

                    if length as usize > self.max_payload
                        || !self.check_crc16(hdr_crc, &d[..HEADER_SIZE - 2])
                    {
                        self.consume(1);
                        self.state = ParseState::Sync;
                    } else {
                        self.plength =
                            HEADER_SIZE + length as usize + if length > 0 { CRC_SIZE } else { 0 };
                        self.state = ParseState::Payload;
                    }
                }

                ParseState::Payload => {
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
                            self.state = ParseState::Sync;
                            continue;
                        }
                        Some(payload_data.to_vec())
                    } else {
                        None
                    };

                    self.consume(self.plength);
                    self.state = ParseState::Sync;

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
