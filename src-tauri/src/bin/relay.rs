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

use std::net::SocketAddr;

use schizoboard_lib::sync::Relay;

fn main() {
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("PORT").unwrap_or_else(|_| "1234".to_string());
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .expect("HOST and PORT should be an address");

    // Built by hand rather than with `#[tokio::main]`: the macro lives behind
    // tokio's `macros` feature, which the lock file cannot currently resolve.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("a tokio runtime");

    runtime.block_on(async move {
        let relay = Relay::start(addr).await.expect("the relay should bind");
        // The line the harness waits for, and the one a human wants when they
        // asked for port zero.
        println!("relay listening on {}", relay.addr());
        // Nothing to do but hold the handle: dropping it stops the relay.
        std::future::pending::<()>().await;
    });
}
