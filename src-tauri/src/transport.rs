// OpenMV Protocol Transport Layer

use std::io::{Read, Write};
use std::net::UdpSocket;
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
    Failed,
    Invalid,
    Timeout,
    Busy,
    Checksum,
    Sequence,
    Overflow,
    Fragment,
    Unknown,
    IoError(String),
    PayloadTooLarge,
    NotConnected,
}

impl TransportError {
    pub fn is_recoverable(&self) -> bool {
        matches!(self, Self::Sequence | Self::Checksum | Self::Timeout)
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

#[derive(Debug, Clone, Copy, PartialEq)]
enum ParseState {
    Sync,
    Header,
    Payload,
}

enum Backend {
    Serial(Box<dyn serialport::SerialPort>),
    Udp(UdpSocket),
}

pub struct Transport {
    backend: Option<Backend>,
    port: String,
    timeout: Duration,
    pub max_payload: usize,

    // Protocol state
    pub sequence: u8,
    state: ParseState,
    plength: usize,
    crc_enabled: bool,
    seq_enabled: bool,
    init_crc: bool,
    init_seq: bool,
    init_max_payload: usize,

    // Buffers
    buf: Vec<u8>,
    pos: usize, // read cursor into buf
    pbuf: Vec<u8>,

    // Read buffer
    read_buf: Vec<u8>,

    // Events collected during recv_packet
    events: Vec<crate::protocol::Packet>,
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.close();
    }
}

impl Transport {
    fn create_serial(port: &str) -> Result<Backend, TransportError> {
        let serial = serialport::new(port, 921600)
            .timeout(Duration::from_secs(1))
            .open()
            .map_err(|e| TransportError::IoError(e.to_string()))?;
        let _ = serial.clear(serialport::ClearBuffer::All);
        std::thread::sleep(Duration::from_millis(100));
        let _ = serial.clear(serialport::ClearBuffer::All);
        Ok(Backend::Serial(serial))
    }

    fn create_udp(address: &str) -> Result<Backend, TransportError> {
        use std::net::ToSocketAddrs;
        let addr = address
            .to_socket_addrs()
            .map_err(|e| TransportError::IoError(format!("Resolve {}: {}", address, e)))?
            .next()
            .ok_or_else(|| TransportError::IoError(format!("Could not resolve {}", address)))?;
        let sock = UdpSocket::bind("0.0.0.0:0")
            .map_err(|e| TransportError::IoError(e.to_string()))?;
        sock.connect(addr)
            .map_err(|e| TransportError::IoError(e.to_string()))?;
        sock.set_read_timeout(Some(Duration::from_millis(1)))
            .map_err(|e| TransportError::IoError(e.to_string()))?;
        Ok(Backend::Udp(sock))
    }

    pub fn new(address: &str, transport: &str, max_payload: usize) -> Result<Self, TransportError> {
        let (backend, crc, seq, timeout) = match transport {
            "udp" => (
                Self::create_udp(address)?,
                true,
                true,
                Duration::from_secs(3),
            ),
            _ => (
                Self::create_serial(address)?,
                true,
                true,
                Duration::from_secs(1),
            ),
        };
        Ok(Self {
            backend: Some(backend),
            port: address.to_string(),
            timeout,
            max_payload,
            sequence: 0,
            state: ParseState::Sync,
            plength: 0,
            crc_enabled: crc,
            seq_enabled: seq,
            init_crc: crc,
            init_seq: seq,
            init_max_payload: max_payload,
            buf: Vec::with_capacity(max_payload * 4),
            pos: 0,
            pbuf: vec![0u8; max_payload + HEADER_SIZE + CRC_SIZE],
            read_buf: vec![0u8; 16384],
            events: Vec::new(),
        })
    }

    pub fn open(&mut self) -> Result<(), TransportError> {
        if let Some(Backend::Udp(ref sock)) = self.backend {
            // UDP: drain pending datagrams, reset state
            let mut trash = [0u8; 4096];
            loop {
                match sock.recv(&mut trash) {
                    Err(ref e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::TimedOut =>
                    {
                        break;
                    }
                    Err(e) => return Err(TransportError::IoError(e.to_string())),
                    _ => continue,
                }
            }
            self.buf.clear();
            self.pos = 0;
            self.state = ParseState::Sync;
            return Ok(());
        }

        // Serial path
        self.close();
        self.backend = Some(Self::create_serial(&self.port)?);
        self.buf.clear();
        self.pos = 0;
        self.state = ParseState::Sync;
        Ok(())
    }

    pub fn close(&mut self) {
        match &mut self.backend {
            Some(Backend::Serial(s)) => {
                let _ = s.flush();
            }
            Some(Backend::Udp(_)) => {}
            None => {}
        }
        self.backend = None;
    }

    pub fn is_connected(&self) -> bool {
        match &self.backend {
            Some(Backend::Serial(s)) => match s.bytes_to_read() {
                Ok(_) => true,
                Err(e) => {
                    log::warn!("is_connected: bytes_to_read failed: {}", e);
                    false
                }
            },
            Some(Backend::Udp(_)) => true,
            None => false,
        }
    }

    pub fn reset_sequence(&mut self) {
        self.sequence = 0;
    }

    pub fn crc_enabled(&self) -> bool {
        self.crc_enabled
    }

    pub fn seq_enabled(&self) -> bool {
        self.seq_enabled
    }

    pub fn reset_caps(&mut self) {
        self.update_caps(self.init_crc, self.init_seq, self.init_max_payload);
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

    /// Read all available bytes from the backend into the internal buffer.
    fn read_available(&mut self) -> Result<(), TransportError> {
        match &mut self.backend {
            Some(Backend::Serial(serial)) => loop {
                match serial.bytes_to_read() {
                    Ok(n) if n > 0 => {
                        let to_read = (n as usize).min(self.read_buf.len());
                        match serial.read(&mut self.read_buf[..to_read]) {
                            Ok(n) => {
                                self.buf.extend_from_slice(&self.read_buf[..n]);
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => break,
                            Err(e) => {
                                log::warn!("read_available: serial read failed: {}", e);
                                return Err(TransportError::IoError(e.to_string()));
                            }
                        }
                    }
                    Ok(_) => break,
                    Err(e) => {
                        log::warn!("read_available: bytes_to_read failed: {}", e);
                        return Err(TransportError::IoError(e.to_string()));
                    }
                }
            },
            Some(Backend::Udp(sock)) => loop {
                match sock.recv(&mut self.read_buf) {
                    Ok(n) => {
                        self.buf.extend_from_slice(&self.read_buf[..n]);
                    }
                    Err(ref e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::TimedOut =>
                    {
                        break;
                    }
                    Err(e) => {
                        log::warn!("read_available: udp recv failed: {}", e);
                        return Err(TransportError::IoError(e.to_string()));
                    }
                }
            },
            None => return Err(TransportError::NotConnected),
        }
        Ok(())
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
        match &mut self.backend {
            Some(Backend::Serial(s)) => {
                s.write_all(&self.pbuf[..total])
                    .map_err(|e| TransportError::IoError(e.to_string()))?;
            }
            Some(Backend::Udp(sock)) => {
                sock.send(&self.pbuf[..total])
                    .map_err(|e| TransportError::IoError(e.to_string()))?;
            }
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
        let mut deadline = Instant::now() + timeout.unwrap_or(self.timeout);

        loop {
            if Instant::now() >= deadline {
                return Err(TransportError::Timeout);
            }

            // Read all available data from backend
            self.read_available()?;

            if self.available() == 0 {
                std::thread::sleep(Duration::from_micros(100));
                continue;
            }

            // Run state machine
            let mut packet = match self.process() {
                Some(p) => p,
                None => {
                    std::thread::sleep(Duration::from_micros(100));
                    continue;
                }
            };

            // Sequence check
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

            // Events - ACK'd above, buffer and keep waiting
            if packet.flags.contains(PacketFlags::EVENT) {
                self.events.push(packet);
                continue;
            }

            // Advance sequence
            self.sequence = self.sequence.wrapping_add(1);

            // Collect fragments - reset deadline per fragment, cap at 10MB
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
                deadline = Instant::now() + self.timeout;
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
                let status = Status::from_u16(u16::from_le_bytes([p[0], p[1]]));
                return Err(match status {
                    Some(Status::Failed) => TransportError::Failed,
                    Some(Status::Invalid) => TransportError::Invalid,
                    Some(Status::Timeout) => TransportError::Timeout,
                    Some(Status::Busy) => TransportError::Busy,
                    Some(Status::Checksum) => TransportError::Checksum,
                    Some(Status::Sequence) => TransportError::Sequence,
                    Some(Status::Overflow) => TransportError::Overflow,
                    Some(Status::Fragment) => TransportError::Fragment,
                    _ => TransportError::Unknown,
                });
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
