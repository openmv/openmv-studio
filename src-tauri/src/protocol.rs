// OpenMV Protocol V2 Constants
// Ported from openmv-python/src/openmv/constants.py

use bitflags::bitflags;

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct PacketFlags: u8 {
        const ACK      = 1 << 0;
        const NAK      = 1 << 1;
        const RTX      = 1 << 2;
        const ACK_REQ  = 1 << 3;
        const FRAGMENT = 1 << 4;
        const EVENT    = 1 << 5;
    }
}

pub const SYNC_WORD: u16 = 0xD5AA;
pub const HEADER_SIZE: usize = 10;
pub const CRC_SIZE: usize = 4;
pub const MIN_PAYLOAD_SIZE: usize = 52; // 64 - 10 - 2

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Opcode {
    // Protocol
    ProtoSync = 0x00,
    ProtoGetCaps = 0x01,
    ProtoSetCaps = 0x02,
    ProtoStats = 0x03,
    ProtoVersion = 0x04,
    // System
    SysReset = 0x10,
    SysBoot = 0x11,
    SysInfo = 0x12,
    SysEvent = 0x13,
    // Channel
    ChannelList = 0x20,
    ChannelPoll = 0x21,
    ChannelLock = 0x22,
    ChannelUnlock = 0x23,
    ChannelShape = 0x24,
    ChannelSize = 0x25,
    ChannelRead = 0x26,
    ChannelWrite = 0x27,
    ChannelIoctl = 0x28,
    ChannelEvent = 0x29,
}

impl Opcode {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0x00 => Some(Self::ProtoSync),
            0x01 => Some(Self::ProtoGetCaps),
            0x02 => Some(Self::ProtoSetCaps),
            0x03 => Some(Self::ProtoStats),
            0x04 => Some(Self::ProtoVersion),
            0x10 => Some(Self::SysReset),
            0x11 => Some(Self::SysBoot),
            0x12 => Some(Self::SysInfo),
            0x13 => Some(Self::SysEvent),
            0x20 => Some(Self::ChannelList),
            0x21 => Some(Self::ChannelPoll),
            0x22 => Some(Self::ChannelLock),
            0x23 => Some(Self::ChannelUnlock),
            0x24 => Some(Self::ChannelShape),
            0x25 => Some(Self::ChannelSize),
            0x26 => Some(Self::ChannelRead),
            0x27 => Some(Self::ChannelWrite),
            0x28 => Some(Self::ChannelIoctl),
            0x29 => Some(Self::ChannelEvent),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum Status {
    Success = 0x00,
    Failed = 0x01,
    Invalid = 0x02,
    Timeout = 0x03,
    Busy = 0x04,
    Checksum = 0x05,
    Sequence = 0x06,
    Overflow = 0x07,
    Fragment = 0x08,
    Unknown = 0x09,
}

impl Status {
    pub fn from_u16(v: u16) -> Option<Self> {
        match v {
            0x00 => Some(Self::Success),
            0x01 => Some(Self::Failed),
            0x02 => Some(Self::Invalid),
            0x03 => Some(Self::Timeout),
            0x04 => Some(Self::Busy),
            0x05 => Some(Self::Checksum),
            0x06 => Some(Self::Sequence),
            0x07 => Some(Self::Overflow),
            0x08 => Some(Self::Fragment),
            0x09 => Some(Self::Unknown),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum EventType {
    ChannelRegistered = 0x00,
    ChannelUnregistered = 0x01,
    SoftReboot = 0x02,
}

// Channel IOCTL commands
pub mod ioctl {
    // stdin
    pub const STDIN_STOP: u32 = 0x01;
    pub const STDIN_EXEC: u32 = 0x02;
    pub const STDIN_RESET: u32 = 0x03;
    // stream
    pub const STREAM_CTRL: u32 = 0x00;
    pub const STREAM_RAW_CTRL: u32 = 0x01;
    pub const STREAM_RAW_CFG: u32 = 0x02;
    // profile
    pub const PROFILE_MODE: u32 = 0x00;
    pub const PROFILE_SET_EVENT: u32 = 0x01;
    pub const PROFILE_RESET: u32 = 0x02;
}

// Pixel format constants
pub const PIXFORMAT_JPEG: u32 = 0x06060000;
pub const PIXFORMAT_RGB565: u32 = 0x0C030002;
pub const PIXFORMAT_GRAYSCALE: u32 = 0x08020001;

// Protocol-level response structs

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SystemInfo {
    pub cpu_id: u32,
    pub usb_vid: u16,
    pub usb_pid: u16,
    pub flash_size_kb: u32,
    pub ram_size_kb: u32,
    pub npu_present: bool,
    pub pmu_present: bool,
    pub pmu_eventcnt: u8,
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionInfo {
    pub protocol: [u8; 3],
    pub bootloader: [u8; 3],
    pub firmware: [u8; 3],
}

#[derive(Debug, Clone, Serialize)]
pub struct FrameInfo {
    pub width: u32,
    pub height: u32,
    pub format_str: String,
    pub data: Vec<u8>,
    pub is_jpeg: bool,
}

#[derive(Debug, Clone)]
pub struct PollResult {
    pub stdout: Option<String>,
    pub frame: Option<FrameInfo>,
    pub script_running: bool,
}
