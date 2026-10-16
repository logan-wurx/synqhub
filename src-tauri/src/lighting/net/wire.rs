//! The ways a message reaches a Wi-Fi light, with std sockets only: HTTP/1.1 over TCP (Hue v1, Nanoleaf, Elgato,
//! Twinkly), JSON over UDP (WiZ), JSON lines over TCP (Yeelight) and LIFX frames over UDP. Short timeouts everywhere:
//! a light that doesn't answer is reported, never waited on. Nothing here decides what may be sent (guard.rs does).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, UdpSocket};
use std::time::Duration;

pub const CONNECT: Duration = Duration::from_millis(2000);
pub const ANSWER: Duration = Duration::from_millis(2500);
/// The most of an answer read (a Hue bridge's light list is a few KB).
const MOST: u64 = 1 << 20;

fn addr(host: &str, port: u16) -> Result<SocketAddr, String> {
    format!("{host}:{port}").parse().map_err(|_| format!("{host} isn't an address SYNQ found."))
}

/// An HTTP request; the status and the body (chunked bodies are joined).
pub fn http(host: &str, port: u16, method: &str, path: &str, headers: &[(&str, String)], body: Option<&str>) -> Result<(u16, String), String> {
    let mut s = TcpStream::connect_timeout(&addr(host, port)?, CONNECT).map_err(|e| format!("The light didn't answer ({e})."))?;
    s.set_read_timeout(Some(ANSWER)).ok();
    s.set_write_timeout(Some(ANSWER)).ok();
    let body = body.unwrap_or("");
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nAccept: application/json\r\n");
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    if !body.is_empty() || method != "GET" {
        req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
    }
    req.push_str("\r\n");
    req.push_str(body);
    s.write_all(req.as_bytes()).map_err(|e| format!("The light didn't take the request ({e})."))?;
    let mut raw = Vec::new();
    let _ = s.take(MOST).read_to_end(&mut raw);
    parse_response(&raw)
}

/// Status and body of a raw HTTP/1.1 response.
pub fn parse_response(raw: &[u8]) -> Result<(u16, String), String> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("The light sent no answer.")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status = head.split_whitespace().nth(1).and_then(|c| c.parse::<u16>().ok()).ok_or("The light's answer isn't HTTP.")?;
    let body = &raw[split + 4..];
    let chunked = head.lines().any(|l| l.to_ascii_lowercase().starts_with("transfer-encoding:") && l.to_ascii_lowercase().contains("chunked"));
    let body = if chunked { unchunk(body) } else { body.to_vec() };
    Ok((status, String::from_utf8_lossy(&body).into_owned()))
}

fn unchunk(mut b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(eol) = b.windows(2).position(|w| w == b"\r\n") {
        let size = usize::from_str_radix(String::from_utf8_lossy(&b[..eol]).split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        if size == 0 || eol + 2 + size > b.len() {
            break;
        }
        out.extend_from_slice(&b[eol + 2..eol + 2 + size]);
        b = &b[(eol + 4 + size).min(b.len())..];
    }
    out
}

/// One datagram to a light and, when `wait`, the first answer from it (WiZ's JSON, LIFX's frames). The socket is
/// connected to the light (an ephemeral port that takes datagrams from that light only): nothing listens, so Windows
/// Firewall sees an outgoing exchange and has nothing to ask about.
pub fn udp(host: &str, port: u16, payload: &[u8], wait: Option<&dyn Fn(&[u8]) -> bool>) -> Result<Option<Vec<u8>>, String> {
    let to = addr(host, port)?;
    let s = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    s.connect(to).map_err(|e| format!("The light can't be reached ({e})."))?;
    s.set_read_timeout(Some(Duration::from_millis(1200))).ok();
    s.send(payload).map_err(|e| format!("The light didn't take the message ({e})."))?;
    let Some(want) = wait else { return Ok(None) };
    let mut buf = [0u8; 2048];
    let end = std::time::Instant::now() + Duration::from_millis(1200);
    while std::time::Instant::now() < end {
        match s.recv(&mut buf) {
            Ok(n) if want(&buf[..n]) => return Ok(Some(buf[..n].to_vec())),
            Ok(_) => continue,
            Err(_) => break,
        }
    }
    Err("The light didn't answer.".into())
}

/// One JSON line to a Yeelight light and its answer (the line with the same `id`).
pub fn tcp_line(host: &str, port: u16, line: &str, id: u64) -> Result<String, String> {
    let mut s = TcpStream::connect_timeout(&addr(host, port)?, CONNECT).map_err(|e| format!("The light didn't answer ({e}). Is LAN Control on?"))?;
    s.set_read_timeout(Some(ANSWER)).ok();
    s.write_all(format!("{line}\r\n").as_bytes()).map_err(|e| e.to_string())?;
    let mut r = BufReader::new(s);
    let mut text = String::new();
    for _ in 0..8 {
        text.clear();
        if r.read_line(&mut text).map_err(|e| e.to_string())? == 0 {
            break;
        }
        let v: serde_json::Value = serde_json::from_str(text.trim()).unwrap_or_default();
        if v.get("id").and_then(serde_json::Value::as_u64) == Some(id) {
            return Ok(text.trim().to_string());
        }
    }
    Err("The light didn't answer.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_parse_plain_and_chunked() {
        assert_eq!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap(), (200, "{}".into()));
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n[{\"a\r\n4\r\n\":1}\r\n1\r\n]\r\n0\r\n\r\n";
        assert_eq!(parse_response(chunked).unwrap(), (200, "[{\"a\":1}]".into()));
        assert!(parse_response(b"garbage").is_err());
    }
}
