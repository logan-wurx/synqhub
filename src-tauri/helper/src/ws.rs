//! The smallest WebSocket server the bridge needs (RFC 6455): the opening handshake with a check on
//! the request's headers, text messages both ways, ping / pong and close. No extensions, no binary
//! messages, client frames must be masked, and a message is capped at `MAX_MESSAGE` bytes.

use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;

/// A request or message bigger than this closes the connection.
pub const MAX_MESSAGE: usize = 256 * 1024;
const MAX_HEADER: usize = 8 * 1024;
const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// The opening request, headers in lower case.
#[derive(Debug, Default, Clone)]
pub struct Request {
    pub path: String,
    pub headers: HashMap<String, String>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Sec-WebSocket-Accept for a Sec-WebSocket-Key.
pub fn accept_key(key: &str) -> String {
    let mut h = Sha1::new();
    h.update(key.trim().as_bytes());
    h.update(GUID.as_bytes());
    base64(&h.finalize())
}

/// Parses the request head (everything before the blank line).
pub fn parse_request(head: &str) -> Option<Request> {
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    if first.next()? != "GET" {
        return None;
    }
    let path = first.next()?.to_string();
    if !first.next()?.starts_with("HTTP/1.1") {
        return None;
    }
    let mut headers = HashMap::new();
    for l in lines.filter(|l| !l.is_empty()) {
        let (k, v) = l.split_once(':')?;
        headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
    }
    Some(Request { path, headers })
}

fn reply(stream: &mut TcpStream, status: &str) {
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    let _ = stream.flush();
}

/// Reads the opening request and answers it. `check` sees the request first and may refuse it with an
/// HTTP status line (e.g. "403 Forbidden"); then nothing else is read or written.
pub fn handshake(stream: &mut TcpStream, check: impl FnOnce(&Request) -> Result<(), &'static str>) -> Result<Request, String> {
    let mut buf = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        if buf.len() >= MAX_HEADER {
            reply(stream, "431 Request Header Fields Too Large");
            return Err("request head too large".into());
        }
        match stream.read(&mut byte) {
            Ok(1) => buf.push(byte[0]),
            _ => return Err("connection closed during the handshake".into()),
        }
    }
    let head = String::from_utf8_lossy(&buf[..buf.len() - 4]).into_owned();
    let Some(req) = parse_request(&head) else {
        reply(stream, "400 Bad Request");
        return Err("not a GET request".into());
    };
    let upgrade = req.header("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket"));
    let connection = req.header("connection").is_some_and(|c| c.split(',').any(|t| t.trim().eq_ignore_ascii_case("upgrade")));
    let version = req.header("sec-websocket-version") == Some("13");
    let Some(key) = req.header("sec-websocket-key").filter(|k| !k.is_empty()) else {
        reply(stream, "400 Bad Request");
        return Err("no Sec-WebSocket-Key".into());
    };
    if !(upgrade && connection && version) {
        reply(stream, "400 Bad Request");
        return Err("not a WebSocket upgrade".into());
    }
    if let Err(status) = check(&req) {
        reply(stream, status);
        return Err(format!("refused: {status}"));
    }
    let accept = accept_key(key);
    write!(stream, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    Ok(req)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Message {
    Text(String),
    Close,
}

fn read_exact(r: &mut impl Read, n: usize) -> Result<Vec<u8>, String> {
    let mut v = vec![0u8; n];
    r.read_exact(&mut v).map_err(|e| e.to_string())?;
    Ok(v)
}

/// Reads the next text message (answering pings on `w`). Close, a protocol error or a closed socket
/// end it: the caller closes the connection.
pub fn read_message(r: &mut impl Read, w: &mut impl FnMut(u8, &[u8]) -> Result<(), String>) -> Result<Message, String> {
    let mut message: Vec<u8> = Vec::new();
    let mut in_text = false;
    loop {
        let h = read_exact(r, 2)?;
        let fin = h[0] & 0x80 != 0;
        if h[0] & 0x70 != 0 {
            return Err("reserved bits set".into());
        }
        let opcode = h[0] & 0x0f;
        if h[1] & 0x80 == 0 {
            return Err("client frames must be masked".into());
        }
        let len = match h[1] & 0x7f {
            126 => u16::from_be_bytes(read_exact(r, 2)?.try_into().unwrap()) as u64,
            127 => u64::from_be_bytes(read_exact(r, 8)?.try_into().unwrap()),
            n => u64::from(n),
        };
        if len as usize > MAX_MESSAGE || message.len() + len as usize > MAX_MESSAGE {
            return Err("message too large".into());
        }
        let mask = read_exact(r, 4)?;
        let mut payload = read_exact(r, len as usize)?;
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }
        match opcode {
            0x0 if in_text => message.extend_from_slice(&payload),
            0x1 if !in_text => {
                message = payload;
                in_text = true;
            }
            0x8 => return Ok(Message::Close),
            0x9 => {
                if !fin || payload.len() > 125 {
                    return Err("bad ping".into());
                }
                w(0xA, &payload)?;
                continue;
            }
            0xA => continue,
            _ => return Err(format!("unexpected opcode {opcode}")),
        }
        if fin {
            return String::from_utf8(message).map(Message::Text).map_err(|_| "text message isn't UTF-8".into());
        }
    }
}

/// One unmasked server frame.
pub fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(payload.len() + 10);
    f.push(0x80 | opcode);
    match payload.len() {
        n if n < 126 => f.push(n as u8),
        n if n <= u16::MAX as usize => {
            f.push(126);
            f.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            f.push(127);
            f.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    f.extend_from_slice(payload);
    f
}

/// A client frame (masked), for the tests' client.
#[cfg(test)]
pub fn client_frame(opcode: u8, fin: bool, payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
    let mut f = Vec::new();
    f.push(if fin { 0x80 } else { 0 } | opcode);
    match payload.len() {
        n if n < 126 => f.push(0x80 | n as u8),
        n if n <= u16::MAX as usize => {
            f.push(0x80 | 126);
            f.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            f.push(0x80 | 127);
            f.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    f.extend_from_slice(&mask);
    f.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    f
}

/// Reads one server frame (for the tests' client): (opcode, payload).
#[cfg(test)]
pub fn read_server_frame(r: &mut impl Read) -> Result<(u8, Vec<u8>), String> {
    let h = read_exact(r, 2)?;
    let len = match h[1] & 0x7f {
        126 => u16::from_be_bytes(read_exact(r, 2)?.try_into().unwrap()) as usize,
        127 => u64::from_be_bytes(read_exact(r, 8)?.try_into().unwrap()) as usize,
        n => n as usize,
    };
    Ok((h[0] & 0x0f, read_exact(r, len)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc_6455_accept_key() {
        // The example in RFC 6455 section 1.3.
        assert_eq!(accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn base64_vectors() {
        for (i, o) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")] {
            assert_eq!(base64(i.as_bytes()), o);
        }
    }

    #[test]
    fn parses_a_request() {
        let r = parse_request("GET /bridge HTTP/1.1\r\nHost: 127.0.0.1:17860\r\nOrigin: https://synqhub.app\r\nUpgrade: websocket").unwrap();
        assert_eq!(r.path, "/bridge");
        assert_eq!(r.header("origin"), Some("https://synqhub.app"));
        assert!(parse_request("POST / HTTP/1.1").is_none());
    }

    #[test]
    fn reads_fragmented_masked_text_and_answers_pings() {
        let mut wire = Vec::new();
        wire.extend(client_frame(0x1, false, b"hel", [1, 2, 3, 4]));
        wire.extend(client_frame(0x9, true, b"p", [9, 9, 9, 9]));
        wire.extend(client_frame(0x0, true, b"lo", [5, 6, 7, 8]));
        let big = "x".repeat(70_000);
        wire.extend(client_frame(0x1, true, big.as_bytes(), [7, 7, 7, 7]));
        wire.extend(client_frame(0x8, true, b"", [0, 0, 0, 0]));
        let mut r = std::io::Cursor::new(wire);
        let mut pongs = Vec::new();
        let mut w = |op: u8, p: &[u8]| {
            pongs.push((op, p.to_vec()));
            Ok(())
        };
        assert_eq!(read_message(&mut r, &mut w).unwrap(), Message::Text("hello".into()));
        assert_eq!(read_message(&mut r, &mut w).unwrap(), Message::Text(big));
        assert_eq!(read_message(&mut r, &mut w).unwrap(), Message::Close);
        assert_eq!(pongs, vec![(0xA, b"p".to_vec())]);
    }

    #[test]
    fn refuses_unmasked_binary_and_huge() {
        let mut w = |_: u8, _: &[u8]| Ok(());
        let unmasked = vec![0x81, 0x02, b'h', b'i'];
        assert!(read_message(&mut std::io::Cursor::new(unmasked), &mut w).is_err());
        let binary = client_frame(0x2, true, b"hi", [1, 1, 1, 1]);
        assert!(read_message(&mut std::io::Cursor::new(binary), &mut w).is_err());
        let mut huge = vec![0x81, 0x80 | 127];
        huge.extend_from_slice(&((MAX_MESSAGE as u64) + 1).to_be_bytes());
        assert!(read_message(&mut std::io::Cursor::new(huge), &mut w).is_err());
    }

    #[test]
    fn server_frames() {
        assert_eq!(frame(0x1, b"hi"), vec![0x81, 2, b'h', b'i']);
        let long = frame(0x1, &[0u8; 300]);
        assert_eq!(&long[..4], &[0x81, 126, 1, 44]);
        assert_eq!(read_server_frame(&mut std::io::Cursor::new(long)).unwrap().1.len(), 300);
    }
}
