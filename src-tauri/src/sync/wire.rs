//! The y-websocket frame, in Rust.
//!
//! The other half of `src/crdt/sync/protocol.ts`, and the reason D-26 wrote the
//! format down: these two have to agree byte for byte, and only one of them can
//! be checked by a type system at a time.
//!
//! ```text
//! [ messageType : varUint ][ payload ]
//! ```
//!
//! Written by hand rather than borrowed from `yrs`'s own encoding module. Forty
//! lines of LEB128 is not worth a dependency on somebody else's cursor type,
//! and — more to the point — a malformed frame from the network has to be a
//! `Result` rather than a panic. A relay that can be killed by a peer sending
//! ten continuation bytes is a relay with a denial of service in it.

/// Message types. `y-websocket`'s numbering, which is not ours to change.
pub const MSG_SYNC: u64 = 0;
pub const MSG_AWARENESS: u64 = 1;
pub const MSG_AUTH: u64 = 2;
pub const MSG_QUERY_AWARENESS: u64 = 3;

/// Asset transfer, which is ours. Four is the first number y-websocket has not
/// spent, and a stock server drops a type it does not know — so a board hosted
/// on one syncs its document and simply never trades bytes, rather than
/// breaking (D-28).
///
/// ```text
/// [ MSG_ASSET ][ from : varUint ][ to : varUint ][ opaque tail ]
/// ```
///
/// The tail is HAVE / WANT / DATA / DONE / NACK and is encoded only in
/// `crdt/sync/assets.ts`. Nothing in Rust parses it: the relay routes on the two
/// ids and forwards the rest untouched, which is what keeps the surface these
/// two files have to agree on by hand down to one constant.
pub const MSG_ASSET: u64 = 4;

/// Sync sub-messages, from the y-protocols sync protocol.
pub const SYNC_STEP1: u64 = 0;
pub const SYNC_STEP2: u64 = 1;
pub const SYNC_UPDATE: u64 = 2;

/// The only `AUTH` sub-type either side sends.
pub const PERMISSION_DENIED: u64 = 0;

#[derive(Debug, PartialEq, Eq)]
pub enum WireError {
    /// The frame ended in the middle of a value.
    Truncated,
    /// A varint with more continuation bytes than a u64 can hold. Malicious or
    /// broken; either way it is not a length we are going to allocate.
    Overlong,
    /// A string that was not UTF-8.
    NotText,
}

pub fn write_var_uint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            return;
        }
    }
}

pub fn write_var_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    write_var_uint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

pub fn write_var_string(out: &mut Vec<u8>, text: &str) {
    write_var_bytes(out, text.as_bytes());
}

/// A frame being read, and how far through it we are.
pub struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Reader { bytes, at: 0 }
    }

    pub fn is_empty(&self) -> bool {
        self.at >= self.bytes.len()
    }

    pub fn var_uint(&mut self) -> Result<u64, WireError> {
        let mut value: u64 = 0;
        let mut shift = 0;
        loop {
            let byte = *self.bytes.get(self.at).ok_or(WireError::Truncated)?;
            self.at += 1;
            // Ten groups of seven bits is seventy, so the tenth may only carry
            // the single bit that is left. Anything more is not a u64.
            if shift > 63 {
                return Err(WireError::Overlong);
            }
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
            shift += 7;
        }
    }

    pub fn var_bytes(&mut self) -> Result<&'a [u8], WireError> {
        let len = usize::try_from(self.var_uint()?).map_err(|_| WireError::Overlong)?;
        let end = self.at.checked_add(len).ok_or(WireError::Overlong)?;
        let slice = self.bytes.get(self.at..end).ok_or(WireError::Truncated)?;
        self.at = end;
        Ok(slice)
    }

    /// Everything not yet read, as it lies.
    ///
    /// For a payload this side is forwarding rather than understanding: an asset
    /// sub-message is length-prefixed by the WebSocket frame that carries it and
    /// by nothing else, so there is no length to trust and none needed.
    pub fn rest(&self) -> &'a [u8] {
        self.bytes.get(self.at..).unwrap_or(&[])
    }

    pub fn var_string(&mut self) -> Result<String, WireError> {
        let bytes = self.var_bytes()?;
        String::from_utf8(bytes.to_vec()).map_err(|_| WireError::NotText)
    }
}

/// `[MSG_AUTH][PERMISSION_DENIED][reason]` — a refusal a human can read.
pub fn permission_denied(reason: &str) -> Vec<u8> {
    let mut out = Vec::new();
    write_var_uint(&mut out, MSG_AUTH);
    write_var_uint(&mut out, PERMISSION_DENIED);
    write_var_string(&mut out, reason);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(value: u64) -> u64 {
        let mut out = Vec::new();
        write_var_uint(&mut out, value);
        Reader::new(&out).var_uint().expect("should read back")
    }

    #[test]
    fn var_uints_survive_the_round_trip() {
        for value in [0, 1, 127, 128, 255, 256, 16383, 16384, u32::MAX as u64, u64::MAX] {
            assert_eq!(round_trip(value), value, "value {value}");
        }
    }

    #[test]
    fn small_values_take_one_byte() {
        // The framing is a byte of overhead per message, not four. It matters:
        // an awareness update is a handful of bytes and goes out constantly.
        let mut out = Vec::new();
        write_var_uint(&mut out, 3);
        assert_eq!(out, vec![3]);
    }

    #[test]
    fn matches_the_encoding_lib0_produces() {
        // Checked against `lib0/encoding`'s `writeVarUint`, which is what the
        // frontend and every other y-websocket peer emit. If this drifts, two
        // implementations stop understanding each other and every test that
        // uses only one of them still passes.
        let cases: [(u64, &[u8]); 4] = [
            (0, &[0x00]),
            (127, &[0x7f]),
            (128, &[0x80, 0x01]),
            (300, &[0xac, 0x02]),
        ];
        for (value, expected) in cases {
            let mut out = Vec::new();
            write_var_uint(&mut out, value);
            assert_eq!(out, expected, "value {value}");
        }
    }

    #[test]
    fn a_truncated_frame_is_an_error_not_a_panic() {
        assert_eq!(Reader::new(&[]).var_uint(), Err(WireError::Truncated));
        // A continuation bit with nothing after it.
        assert_eq!(Reader::new(&[0x80]).var_uint(), Err(WireError::Truncated));
        // A length that runs off the end.
        assert_eq!(
            Reader::new(&[0x05, 0x01, 0x02]).var_bytes(),
            Err(WireError::Truncated)
        );
    }

    #[test]
    fn an_overlong_varint_is_refused() {
        // Eleven continuation bytes. Left to shift, this would panic in debug
        // and silently wrap in release — from a frame anybody can send.
        let overlong = [0xff_u8; 11];
        assert_eq!(Reader::new(&overlong).var_uint(), Err(WireError::Overlong));
    }

    #[test]
    fn byte_arrays_and_strings_round_trip() {
        let mut out = Vec::new();
        write_var_bytes(&mut out, &[1, 2, 3]);
        write_var_string(&mut out, "a board");

        let mut reader = Reader::new(&out);
        assert_eq!(reader.var_bytes(), Ok(&[1u8, 2, 3][..]));
        assert_eq!(reader.var_string().as_deref(), Ok("a board"));
        assert!(reader.is_empty());
    }

    #[test]
    fn a_refusal_says_why() {
        let frame = permission_denied("not your board");
        let mut reader = Reader::new(&frame);
        assert_eq!(reader.var_uint(), Ok(MSG_AUTH));
        assert_eq!(reader.var_uint(), Ok(PERMISSION_DENIED));
        assert_eq!(reader.var_string().as_deref(), Ok("not your board"));
    }
}
