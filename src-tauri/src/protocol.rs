// OpenMV Protocol V2
// Ported from protocol/omv_protocol.h

use bitflags::bitflags;
use serde::Serialize;

/***************************************************************************
* Protocol Constants
***************************************************************************/

pub const SYNC_WORD: u16 = 0xD5AA;
pub const HEADER_SIZE: usize = 10;
pub const CRC_SIZE: usize = 4;
pub const MIN_PAYLOAD_SIZE: usize = 52; // 64 - 10 - 2

/***************************************************************************
* Packet Flags
***************************************************************************/

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

/***************************************************************************
* System Events
***************************************************************************/

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum EventType {
    ChannelRegistered = 0x00,
    ChannelUnregistered = 0x01,
    SoftReboot = 0x02,
}

/***************************************************************************
* Status Codes
***************************************************************************/

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

/***************************************************************************
* Protocol Opcodes
***************************************************************************/

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
    SysMemory = 0x14,
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
            0x14 => Some(Self::SysMemory),
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

/***************************************************************************
* Packet Structure
***************************************************************************/

#[derive(Debug, Clone)]
pub struct Packet {
    pub sequence: u8,
    pub channel: u8,
    pub flags: PacketFlags,
    pub opcode: u8,
    pub length: u16,
    pub payload: Option<Vec<u8>>,
}

/***************************************************************************
* Channel IOCTL Commands
***************************************************************************/

// Channel flags (from omv_protocol_channel.h)
pub const CHANNEL_FLAG_DYNAMIC: u8 = 1 << 5;

pub mod ioctl {
    // stdin
    pub const STDIN_STOP: u32 = 0x01;
    pub const STDIN_EXEC: u32 = 0x02;
    pub const STDIN_RESET: u32 = 0x03;
    // stream
    pub const STREAM_CTRL: u32 = 0x00;
    pub const STREAM_RAW_CTRL: u32 = 0x01;
    pub const STREAM_RAW_CFG: u32 = 0x02;
    pub const STREAM_SOURCE: u32 = 0x03;
    // profile
    pub const PROFILE_MODE: u32 = 0x00;
    pub const PROFILE_SET_EVENT: u32 = 0x01;
    pub const PROFILE_RESET: u32 = 0x02;
}

/***************************************************************************
* Response Structs
***************************************************************************/

#[derive(Debug, Clone, Serialize)]
pub struct VersionInfo {
    pub protocol: [u8; 3],
    pub bootloader: [u8; 3],
    pub firmware: [u8; 3],
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemInfo {
    pub cpu_id: u32,
    pub device_id: [u32; 3],
    pub usb_vid: u16,
    pub usb_pid: u16,
    pub chip_ids: [u32; 3],
    // Capabilities
    pub gpu_present: bool,
    pub npu_present: bool,
    pub isp_present: bool,
    pub venc_present: bool,
    pub jpeg_present: bool,
    pub dram_present: bool,
    pub crc_present: bool,
    pub pmu_present: bool,
    pub pmu_eventcnt: u8,
    pub wifi_present: bool,
    pub bt_present: bool,
    pub sd_present: bool,
    pub eth_present: bool,
    pub usb_highspeed: bool,
    pub multicore_present: bool,
    // Memory
    pub flash_size_kb: u32,
    pub ram_size_kb: u32,
    pub framebuffer_size_kb: u32,
    pub stream_buffer_size_kb: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProtoStats {
    pub sent: u32,
    pub received: u32,
    pub checksum: u32,
    pub sequence: u32,
    pub retransmit: u32,
    pub transport: u32,
    pub sent_events: u32,
    pub max_ack_queue_depth: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemEntry {
    pub mem_type: String,
    pub flags: u16,
    pub total: u32,
    pub used: u32,
    pub free: u32,
    pub persist: u32,
    pub peak: u32,
}
