//! The relay, headless.
//!
//! > **Relay mode** — the identical binary on a small server as an always-on,
//! > always-seeding peer. — docs/ARCHITECTURE.md section 5.1
//!
//! "Identical binary" is the intent and this is the interim: the same relay
//! module the application embeds, with a `main` around it instead of a window.
//! When the desktop binary grows a headless flag this becomes that flag.
//!
//! It is also what `tests/sync-interop.test.ts` spawns, so the real frontend
//! client can be pointed at the real relay and the two implementations can be
//! caught disagreeing — which is the whole reason D-26 chose an existing wire
//! format over one of our own.
//!
//! `PORT` and `HOST` from the environment, matching what `y-websocket`'s own
//! server reads, so the two are interchangeable in a harness.
//!
//! `RELAY_SECRET` is ours, and it is optional because the default `HOST` is
//! loopback: a relay only this machine can reach needs no secret, and the
//! interop harness would have to learn one for no gain. Set `HOST` to anything
//! wider without setting it and the process refuses to start rather than
//! putting a read-write board on the network — see [`guard`].

use std::net::SocketAddr;

use schizoboard_lib::sync::Relay;

fn main() {
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("PORT").unwrap_or_else(|_| "1234".to_string());
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .expect("HOST and PORT should be an address");
    let secret = guard(&addr, std::env::var("RELAY_SECRET").ok());

    // Built by hand rather than with `#[tokio::main]`: the macro lives behind
    // tokio's `macros` feature, which the lock file cannot currently resolve.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("a tokio runtime");

    runtime.block_on(async move {
        let relay = Relay::start_guarded(addr, secret)
            .await
            .expect("the relay should bind");
        // The line the harness waits for, and the one a human wants when they
        // asked for port zero.
        println!("relay listening on {}", relay.addr());
        // Nothing to do but hold the handle: dropping it stops the relay.
        std::future::pending::<()>().await;
    });
}

/// The secret to run with, or a refusal to run at all.
///
/// The rule is one line: **a relay reachable from another machine must have a
/// secret**. The relay has no other authentication — every socket that gets in
/// can read and write the whole board — so a wide bind without one is a
/// read-write corkboard offered to the network for anybody who guesses a board
/// name.
///
/// Refusing to start is deliberately louder than binding loopback instead.
/// Silently narrowing the bind would give somebody who asked for a LAN relay a
/// process that looks healthy, prints an address, and can never be reached; the
/// mistake would surface an hour later as "discovery is broken".
fn guard(addr: &SocketAddr, secret: Option<String>) -> Option<String> {
    if secret.is_some() || addr.ip().is_loopback() {
        return secret;
    }
    eprintln!(
        "refusing to bind {} without RELAY_SECRET: the relay has no other \
         authentication, so this would be a read-write board offered to the \
         whole network. Set RELAY_SECRET, or bind 127.0.0.1.",
        addr.ip()
    );
    std::process::exit(2);
}
