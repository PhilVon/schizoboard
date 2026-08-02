//! Finding the other machine, without anybody typing an address.
//!
//! > **LAN mode** — any peer hosts, advertised over mDNS; peers discover and
//! > connect directly. Zero infrastructure, works with no internet.
//! > — docs/ARCHITECTURE.md section 5.1
//!
//! Two halves, both against the same multicast daemon:
//!
//!   - **Advertise.** A board this client is hosting is registered as a
//!     `_schizoboard._tcp.local.` service, carrying the board name and a
//!     fingerprint of its secret. The port is whatever the operating system
//!     gave the relay, which is exactly why the advertisement has to happen
//!     here and not in a config file.
//!   - **Browse.** Everything else advertising that service type on the
//!     network is resolved to an address, filtered down to the boards this
//!     client could actually join, and handed up.
//!
//! ## What is on the wire, and what is not
//!
//! mDNS is broadcast to the whole network in the clear, so the advertisement is
//! written on the assumption that everyone can read it — because they can. It
//! says: there is a board called `demo` on this machine at this port, and the
//! people invited to it can recognise it by these eight hex characters. It does
//! not say the secret, and there is nothing in it worth having without one:
//! `sync/mod.rs` refuses a socket that cannot present the real thing.
//!
//! ## Why a thread and not the runtime
//!
//! `mdns-sd`'s daemon is a thread with channels, and its `async` feature only
//! wraps the same channels. A browse loop outlives any one Tauri command and
//! must not be tied to whichever runtime happened to start it, so it is spawned
//! as a plain thread and stopped by dropping the handle — the same shape as
//! [`super::Relay`], and for the same reason.

use std::collections::HashMap;
use std::net::IpAddr;

use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent, ServiceInfo};

/// The service type, in DNS-SD's spelling.
///
/// `_schizoboard` is fifteen characters, and RFC 6763 section 7 caps a service
/// name at fifteen — so this is at the limit and cannot gain a suffix. Anything
/// that needs distinguishing goes in a TXT record, which is where the version
/// below lives for exactly that reason.
pub const SERVICE_TYPE: &str = "_schizoboard._tcp.local.";

/// TXT keys. Short, because a TXT record is a handful of bytes in a multicast
/// packet and every one of these is repeated in every announcement.
const KEY_BOARD: &str = "board";
const KEY_FINGERPRINT: &str = "fp";
const KEY_VERSION: &str = "v";

/// What this application understands.
///
/// A peer advertising anything else is skipped rather than guessed at: the
/// alternative is dialling a future version of ourselves, being refused for a
/// reason we have no words for, and retrying forever.
const VERSION: &str = "1";

/// A board somebody on this network is hosting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    /// The DNS-SD instance name, which is stable for as long as the peer is up
    /// and is what a `ServiceRemoved` names. The identity for deduplication.
    pub instance: String,
    pub board: String,
    pub fingerprint: String,
    pub address: IpAddr,
    pub port: u16,
}

impl Peer {
    /// Where to dial, without the secret — which is the caller's to add,
    /// because this module deliberately never holds one.
    pub fn url(&self) -> String {
        match self.address {
            // A bracketed literal, or the colons in the address are read as the
            // port separator and the URL silently means something else.
            IpAddr::V6(v6) => format!("ws://[{v6}]:{}/{}", self.port, self.board),
            IpAddr::V4(v4) => format!("ws://{v4}:{}/{}", self.port, self.board),
        }
    }
}

/// Whether a resolved service is a board this client could join.
///
/// Three questions, and the order does not matter because all three must hold:
/// is it a version we speak, is it the board we are on, and is it *our* board
/// rather than somebody else's board of the same name? The last is what the
/// fingerprint is for, and it is why "demo" being the most obvious board name
/// in the world is not a problem.
///
/// Split out from the browse loop so it can be tested without a network, since
/// it is the part with the actual decision in it.
pub fn is_joinable(peer: &Peer, board: &str, fingerprint: &str) -> bool {
    peer.board == board && peer.fingerprint == fingerprint
}

/// What an announcement says, in this application's own terms.
///
/// `mdns_sd::ResolvedService` is `#[non_exhaustive]`, so one cannot be built
/// outside its own crate — which means anything taking one as an argument can
/// only ever be tested against announcements the daemon itself produced. That
/// is precisely the wrong direction: the announcements worth being sure about
/// are the ones *other* software puts on the network, which by definition are
/// not ones we would have made.
///
/// So the daemon's type is flattened at the edge by [`announced`], which is six
/// field reads and no decisions, and everything with a judgement in it works on
/// this instead.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Announcement {
    fullname: String,
    port: u16,
    addresses: Vec<IpAddr>,
    version: Option<String>,
    board: Option<String>,
    fingerprint: Option<String>,
}

fn announced(service: &ResolvedService) -> Announcement {
    let text = |key: &str| service.get_property_val_str(key).map(str::to_string);
    Announcement {
        fullname: service.get_fullname().to_string(),
        port: service.get_port(),
        addresses: service
            .get_addresses()
            .iter()
            .map(mdns_sd::ScopedIp::to_ip_addr)
            .collect(),
        version: text(KEY_VERSION),
        board: text(KEY_BOARD),
        fingerprint: text(KEY_FINGERPRINT),
    }
}

/// Read an announcement into a [`Peer`], or refuse it.
///
/// `None` for anything that is not a board this version can dial: a missing or
/// unknown protocol version, no board name, no fingerprint, or no address this
/// application could put in a URL. Every one of these is somebody else's
/// software or a future ours, and none is an error worth reporting to a user
/// who did not ask for it.
fn read_peer(announcement: &Announcement) -> Option<Peer> {
    if announcement.version.as_deref()? != VERSION {
        return None;
    }
    Some(Peer {
        instance: announcement.fullname.clone(),
        board: announcement.board.clone()?,
        fingerprint: announcement.fingerprint.clone()?,
        address: dialable(&announcement.addresses)?,
        port: announcement.port,
    })
}

/// The one address out of a peer's several that can be put in a URL.
///
/// IPv4 first, because on the networks LAN mode is for it is the one that is
/// always there. The IPv6 fallback deliberately skips link-local addresses:
/// `fe80::/10` is only meaningful together with a zone index naming the
/// interface it was seen on, that index is a number local to *this* machine,
/// and a webview handed `ws://[fe80::1%14]:…` has nowhere to put it. A peer
/// that advertises nothing else is not reachable from here, and saying so by
/// returning `None` beats emitting an address that cannot be dialled.
fn dialable(addresses: &[IpAddr]) -> Option<IpAddr> {
    addresses
        .iter()
        .find(|ip| ip.is_ipv4())
        .or_else(|| addresses.iter().find(|ip| !is_link_local(ip)))
        .copied()
}

/// `fe80::/10`, spelled out.
///
/// `Ipv6Addr::is_unicast_link_local` says this and is still unstable, and a
/// two-line mask is not worth waiting for or pulling a crate in for.
fn is_link_local(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
        IpAddr::V4(_) => false,
    }
}

/// The advertisement for a board this client is hosting.
fn advertisement(
    instance: &str,
    board: &str,
    fingerprint: &str,
    port: u16,
) -> Result<ServiceInfo, String> {
    let properties: HashMap<String, String> = HashMap::from([
        (KEY_VERSION.to_string(), VERSION.to_string()),
        (KEY_BOARD.to_string(), board.to_string()),
        (KEY_FINGERPRINT.to_string(), fingerprint.to_string()),
    ]);
    // The empty address and `enable_addr_auto` together mean "whatever
    // interfaces this machine turns out to have, including ones it grows
    // later" — which on a laptop that moves between a dock and wifi is not a
    // hypothetical.
    let info = ServiceInfo::new(
        SERVICE_TYPE,
        instance,
        // A host name of our own rather than the machine's, which on Windows is
        // whatever the user called their PC and on a shared network is more
        // identifying than anybody agreed to.
        &format!("{instance}.local."),
        "",
        port,
        properties,
    )
    .map_err(|error| format!("the advertisement would not build: {error}"))?
    .enable_addr_auto();
    Ok(info)
}

/// A running advertisement and browse. Dropping it stops both.
pub struct Discovery {
    daemon: ServiceDaemon,
    /// The full DNS-SD name we registered under, so the browse loop can ignore
    /// our own announcement and `Drop` can withdraw it.
    registered: Option<String>,
}

impl Discovery {
    /// Advertise `board` on `port`, and call `found` for every *other* board on
    /// the network that matches `fingerprint`.
    ///
    /// `instance` must be unique on the network — two windows on one machine
    /// hosting boards of the same name is the ordinary development case, and
    /// DNS-SD would otherwise treat the second as a correction of the first.
    ///
    /// The callback runs on the browse thread, so it must not block. Both
    /// callers hand it straight to a Tauri `emit`, which is a channel send.
    pub fn start(
        instance: String,
        board: String,
        fingerprint: String,
        port: u16,
        found: impl Fn(Peer) + Send + 'static,
    ) -> Result<Discovery, String> {
        let daemon = ServiceDaemon::new().map_err(|error| format!("no mDNS daemon: {error}"))?;
        let info = advertisement(&instance, &board, &fingerprint, port)?;
        let fullname = info.get_fullname().to_string();
        daemon
            .register(info)
            .map_err(|error| format!("the board could not be advertised: {error}"))?;

        let events = daemon
            .browse(SERVICE_TYPE)
            .map_err(|error| format!("nothing could be browsed for: {error}"))?;
        let ours = fullname.clone();
        std::thread::spawn(move || {
            // Ends when the daemon is dropped and the channel closes, which is
            // the only stop signal this loop needs.
            while let Ok(event) = events.recv() {
                let ServiceEvent::ServiceResolved(service) = event else {
                    continue;
                };
                // Our own announcement comes back to us like anybody else's,
                // and dialling it would be this window connecting to its own
                // relay a second time.
                if service.get_fullname() == ours {
                    continue;
                }
                let Some(peer) = read_peer(&announced(&service)) else {
                    continue;
                };
                if is_joinable(&peer, &board, &fingerprint) {
                    found(peer);
                }
            }
        });

        Ok(Discovery {
            daemon,
            registered: Some(fullname),
        })
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        if let Some(fullname) = self.registered.take() {
            // Best effort, and worth doing: an explicit unregister sends the
            // goodbye packet that takes this board off everyone else's list
            // now, rather than when the record's time to live runs out.
            let _ = self.daemon.unregister(&fullname);
        }
        let _ = self.daemon.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn peer(board: &str, fingerprint: &str) -> Peer {
        Peer {
            instance: "x._schizoboard._tcp.local.".to_string(),
            board: board.to_string(),
            fingerprint: fingerprint.to_string(),
            address: IpAddr::V4(Ipv4Addr::new(192, 168, 1, 9)),
            port: 4321,
        }
    }

    #[test]
    fn a_url_is_dialable() {
        assert_eq!(peer("demo", "abcd1234").url(), "ws://192.168.1.9:4321/demo");
    }

    #[test]
    fn an_ipv6_address_is_bracketed() {
        let mut it = peer("demo", "abcd1234");
        it.address = IpAddr::V6(Ipv6Addr::LOCALHOST);
        // Unbracketed, the colons in the address swallow the port and the URL
        // parses as something else entirely rather than failing.
        assert_eq!(it.url(), "ws://[::1]:4321/demo");
    }

    #[test]
    fn the_same_board_with_the_same_secret_is_joinable() {
        assert!(is_joinable(&peer("demo", "abcd1234"), "demo", "abcd1234"));
    }

    #[test]
    fn a_board_of_the_same_name_is_not_the_same_board() {
        // "demo" is the most obvious board name there is, and two unrelated
        // people on one office network will both use it.
        assert!(!is_joinable(&peer("demo", "abcd1234"), "demo", "99998888"));
    }

    #[test]
    fn another_board_on_the_same_machine_is_not_ours() {
        assert!(!is_joinable(&peer("other", "abcd1234"), "demo", "abcd1234"));
    }

    #[test]
    fn an_advertisement_carries_the_board_and_the_fingerprint_and_not_the_secret() {
        let secret = super::super::secret::generate();
        let fingerprint = super::super::secret::fingerprint(&secret);
        let info = advertisement("peer-1", "demo", &fingerprint, 4321).expect("should build");

        assert_eq!(info.get_property_val_str(KEY_BOARD), Some("demo"));
        assert_eq!(
            info.get_property_val_str(KEY_FINGERPRINT),
            Some(&*fingerprint)
        );
        assert_eq!(info.get_property_val_str(KEY_VERSION), Some(VERSION));
        assert_eq!(info.get_port(), 4321);

        // The whole record, in the clear, on every interface. Nothing in it may
        // be the secret or any part of it.
        let announced = format!("{info:?}");
        assert!(!announced.contains(&secret), "the secret is on the wire");
    }

    const HERE: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 9));

    /// An announcement as the browse loop is handed it, from a peer that is
    /// doing everything right.
    fn announcement(addresses: &[IpAddr]) -> Announcement {
        Announcement {
            fullname: "peer._schizoboard._tcp.local.".to_string(),
            port: 4321,
            addresses: addresses.to_vec(),
            version: Some(VERSION.to_string()),
            board: Some("demo".to_string()),
            fingerprint: Some("abcd1234".to_string()),
        }
    }

    fn v6(text: &str) -> IpAddr {
        IpAddr::V6(text.parse().expect("an address"))
    }

    #[test]
    fn a_peer_speaking_another_version_is_not_read() {
        // Dialling a future version of ourselves ends in a refusal we have no
        // words for, and a retry loop around it.
        let mut future = announcement(&[HERE]);
        future.version = Some("2".to_string());
        assert_eq!(read_peer(&future), None);

        // Somebody else's `_schizoboard._tcp`, or a version so old it did not
        // say. Same treatment.
        let mut silent = announcement(&[HERE]);
        silent.version = None;
        assert_eq!(read_peer(&silent), None);
    }

    #[test]
    fn a_peer_missing_what_it_needs_is_not_read() {
        let mut nameless = announcement(&[HERE]);
        nameless.board = None;
        assert_eq!(read_peer(&nameless), None);

        // No fingerprint means no way to tell this board from anybody else's
        // board of the same name — which is the question the fingerprint exists
        // to answer, so an announcement without one cannot be acted on.
        let mut anonymous = announcement(&[HERE]);
        anonymous.fingerprint = None;
        assert_eq!(read_peer(&anonymous), None);
    }

    #[test]
    fn an_announcement_reads_back_as_the_peer_it_describes() {
        let read = read_peer(&announcement(&[HERE])).expect("should read");
        assert_eq!(read.board, "demo");
        assert_eq!(read.fingerprint, "abcd1234");
        assert_eq!(read.port, 4321);
        assert_eq!(read.address, HERE);
        assert_eq!(read.url(), "ws://192.168.1.9:4321/demo");
    }

    #[test]
    fn ipv4_wins_when_a_peer_has_both() {
        let read = read_peer(&announcement(&[v6("2001:db8::1"), HERE])).expect("should read");
        assert_eq!(read.address, HERE);
    }

    #[test]
    fn a_routable_v6_address_will_do_when_there_is_no_v4() {
        let read = read_peer(&announcement(&[v6("2001:db8::1")])).expect("should read");
        assert_eq!(read.address, v6("2001:db8::1"));
        assert_eq!(read.url(), "ws://[2001:db8::1]:4321/demo");
    }

    #[test]
    fn a_link_local_v6_address_is_no_address_at_all() {
        // `fe80::` means nothing without a zone index naming the interface it
        // was seen on, and that index is a number local to this machine which
        // the webview has nowhere to put. The whole `fe80::/10` block, not just
        // the obvious `fe80:`.
        for link_local in ["fe80::1", "fe81::1", "feba::1", "febf:ffff::1"] {
            assert_eq!(
                read_peer(&announcement(&[v6(link_local)])),
                None,
                "{link_local}"
            );
        }
        // And the addresses either side of the block are not link-local.
        assert!(read_peer(&announcement(&[v6("fe7f:ffff::1")])).is_some());
        assert!(read_peer(&announcement(&[v6("fec0::1")])).is_some());
    }

    #[test]
    fn a_peer_with_no_address_is_not_read() {
        assert_eq!(read_peer(&announcement(&[])), None);
    }

    /// Two boards on this machine, over the real multicast daemon.
    ///
    /// Everything above tests the decisions with the network taken out, which
    /// is worth exactly nothing if the announcement never leaves the building.
    /// This is the one that would fail if the service type were malformed, if
    /// `enable_addr_auto` gave no addresses, or if the browse loop filtered out
    /// everything including the peers it wants.
    ///
    /// It is a real network test and it says so: it needs a machine with an
    /// interface and permission to send to `224.0.0.251:5353`. On a host where
    /// that is firewalled it will fail rather than hang — the wait below is
    /// bounded — and the failure is honest, because on such a host LAN mode
    /// genuinely does not work.
    #[test]
    fn two_boards_on_one_machine_find_each_other() {
        let (found, discovered) = std::sync::mpsc::channel();
        let fingerprint = "abcd1234";

        let _first = Discovery::start(
            "schizoboard-test-first".to_string(),
            "testboard".to_string(),
            fingerprint.to_string(),
            4321,
            move |peer| {
                let _ = found.send(peer);
            },
        )
        .expect("the first board should advertise");

        let _second = Discovery::start(
            "schizoboard-test-second".to_string(),
            "testboard".to_string(),
            fingerprint.to_string(),
            4322,
            |_| {},
        )
        .expect("the second board should advertise");

        let peer = discovered
            .recv_timeout(std::time::Duration::from_secs(20))
            .expect("the first board should have found the second");

        assert_eq!(peer.board, "testboard");
        assert_eq!(peer.fingerprint, fingerprint);
        assert_eq!(peer.port, 4322);
        // And it is the *other* one — the browse loop must skip our own
        // announcement, which comes back to us like everybody else's.
        assert!(
            peer.instance.starts_with("schizoboard-test-second."),
            "{}",
            peer.instance
        );
    }

    /// The same two boards, with different secrets.
    ///
    /// This is the half that makes the fingerprint worth carrying: both are
    /// called `sharedname`, both are on this machine, and neither should be
    /// offered to the other. Without it, two unrelated people on one office
    /// network who both called their board "demo" would be dialling each other
    /// all afternoon and being refused.
    #[test]
    fn a_board_with_another_secret_is_not_offered() {
        let (found, discovered) = std::sync::mpsc::channel();

        let _mine = Discovery::start(
            "schizoboard-test-mine".to_string(),
            "sharedname".to_string(),
            "11112222".to_string(),
            4323,
            move |peer| {
                let _ = found.send(peer);
            },
        )
        .expect("my board should advertise");

        let _theirs = Discovery::start(
            "schizoboard-test-theirs".to_string(),
            "sharedname".to_string(),
            "99998888".to_string(),
            4324,
            |_| {},
        )
        .expect("their board should advertise");

        // Long enough that the announcement has certainly been and gone: the
        // test above sees one in a fraction of this.
        let seen = discovered.recv_timeout(std::time::Duration::from_secs(10));
        assert!(seen.is_err(), "somebody else's board was offered: {seen:?}");
    }
}
