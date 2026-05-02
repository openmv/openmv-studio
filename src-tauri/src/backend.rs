// Copyright (C) 2026 OpenMV, LLC.
//
// This software is licensed under terms that can be found in the
// LICENSE file in the root directory of this software component.

// Transport backends (serial, network)

use std::io::{Read, Write};
use std::net::UdpSocket;
use std::time::Duration;
use crate::transport::{TransportCaps, TransportError};

pub trait Backend: Send {
    fn caps(&self) -> TransportCaps;
    fn open(&mut self) -> Result<(), TransportError>;
    fn close(&mut self);
    fn reset(&mut self) -> Result<(), TransportError>;
    fn read(&mut self, buf: &mut Vec<u8>) -> Result<(), TransportError>;
    fn write(&mut self, data: &[u8]) -> Result<(), TransportError>;
    fn is_connected(&self) -> bool;
}

pub struct SerialBackend {
    name: String,
    caps: TransportCaps,
    port: Option<Box<dyn serialport::SerialPort>>,
    read_buf: Vec<u8>,
}

impl SerialBackend {
    pub fn new(name: &str, max_payload: usize) -> Self {
        Self {
            name: name.to_string(),
            port: None,
            read_buf: vec![0u8; 16384],
            caps: TransportCaps { crc: true, seq: true, ack: true, events: true, max_payload },
        }
    }
}

impl Backend for SerialBackend {
    fn caps(&self) -> TransportCaps {
        self.caps
    }

    fn open(&mut self) -> Result<(), TransportError> {
        self.close();
        let mut port = serialport::new(&self.name, 921600)
            .timeout(Duration::from_secs(1))
            .open()
            .map_err(|e| TransportError::IoError(e.to_string()))?;
        let _ = port.clear(serialport::ClearBuffer::All);
        std::thread::sleep(Duration::from_millis(100));
        let _ = port.clear(serialport::ClearBuffer::All);
        let _ = port.set_timeout(Duration::from_micros(100));
        self.port = Some(port);
        Ok(())
    }

    fn close(&mut self) {
        if let Some(ref mut port) = self.port {
            let _ = port.clear(serialport::ClearBuffer::All);
        }
        self.port = None;
    }

    fn reset(&mut self) -> Result<(), TransportError> {
        let port = self.port.as_mut().ok_or(TransportError::NotConnected)?;
        port.clear(serialport::ClearBuffer::All)
            .map_err(|e| TransportError::IoError(e.to_string()))
    }

    /// Blocking read with a short timeout. bytes_to_read()
    /// has known issues on Windows for USB CDC devices.
    fn read(&mut self, buf: &mut Vec<u8>) -> Result<(), TransportError> {
        let port = self.port.as_mut().ok_or(TransportError::NotConnected)?;
        loop {
            match port.read(&mut self.read_buf) {
                Ok(n) if n > 0 => {
                    buf.extend_from_slice(&self.read_buf[..n]);
                }
                Ok(_) => break,
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => break,
                Err(e) => {
                    return Err(TransportError::IoError(e.to_string()));
                }
            }
        }
        Ok(())
    }

    fn write(&mut self, data: &[u8]) -> Result<(), TransportError> {
        let port = self.port.as_mut().ok_or(TransportError::NotConnected)?;
        port.write_all(data)
            .map_err(|e| TransportError::IoError(e.to_string()))
    }

    fn is_connected(&self) -> bool {
        match &self.port {
            Some(port) => match port.bytes_to_read() {
                Ok(_) => true,
                Err(e) => {
                    log::warn!("is_connected: bytes_to_read failed: {}", e);
                    false
                }
            },
            None => false,
        }
    }
}

pub struct NetworkBackend {
    caps: TransportCaps,
    address: String,
    socket: Option<UdpSocket>,
    read_buf: Vec<u8>,
}

impl NetworkBackend {
    pub fn new(address: &str, max_payload: usize) -> Self {
        Self {
            address: address.to_string(),
            socket: None,
            read_buf: vec![0u8; 16384],
            caps: TransportCaps { crc: true, seq: true, ack: false, events: true, max_payload },
        }
    }
}

impl Backend for NetworkBackend {
    fn caps(&self) -> TransportCaps {
        self.caps
    }

    fn open(&mut self) -> Result<(), TransportError> {
        use std::net::ToSocketAddrs;

        self.close();
        let addr = self
            .address
            .to_socket_addrs()
            .map_err(|e| TransportError::IoError(format!("Resolve {}: {}", self.address, e)))?
            .next()
            .ok_or_else(|| {
                TransportError::IoError(format!("Could not resolve {}", self.address))
            })?;
        let socket = UdpSocket::bind("0.0.0.0:0")
            .map_err(|e| TransportError::IoError(e.to_string()))?;
        socket
            .connect(addr)
            .map_err(|e| TransportError::IoError(e.to_string()))?;
        socket
            .set_read_timeout(Some(Duration::from_millis(1)))
            .map_err(|e| TransportError::IoError(e.to_string()))?;
        self.socket = Some(socket);
        Ok(())
    }

    fn close(&mut self) {
        self.socket = None;
    }

    fn reset(&mut self) -> Result<(), TransportError> {
        Ok(())
    }

    fn read(&mut self, buf: &mut Vec<u8>) -> Result<(), TransportError> {
        let socket = self.socket.as_ref().ok_or(TransportError::NotConnected)?;
        loop {
            match socket.recv(&mut self.read_buf) {
                Ok(n) => {
                    buf.extend_from_slice(&self.read_buf[..n]);
                }
                Err(ref e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut =>
                {
                    break;
                }
                Err(e) => {
                    return Err(TransportError::IoError(e.to_string()));
                }
            }
        }
        Ok(())
    }

    fn write(&mut self, data: &[u8]) -> Result<(), TransportError> {
        let socket = self.socket.as_ref().ok_or(TransportError::NotConnected)?;
        socket
            .send(data)
            .map_err(|e| TransportError::IoError(e.to_string()))?;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.socket.is_some()
    }
}
