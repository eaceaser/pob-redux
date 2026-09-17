//! `pob://` and `pob2://` links: the schemes Path of Building registers for the
//! "Open in PoB" buttons on build sites, for Path of Exile 1 and 2. A link names
//! a site and a build id, and maps to that site's ordinary share link.
//!
//! On Windows and Linux a clicked link starts a new process. A running instance
//! listens on loopback, and the new process hands it the link and exits, so the
//! build opens in the window already on screen. Several instances can still run
//! side by side; links go to the one started last.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

use crate::game::Game;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Link {
    pub game: Game,
    /// The site's share link, which the importer already understands.
    pub url: String,
}

/// PoB's site ids for each game (Modules/BuildSiteTools.lua) and their share link prefixes.
const SITES_POE1: &[(&str, &str)] = &[
    ("maxroll", "https://maxroll.gg/poe/pob/"),
    ("pobcodes", "https://pob.codes/b/"),
    ("pobbin", "https://pobb.in/"),
    ("poeninja", "https://poe.ninja/poe1/pob/"),
    ("pastebin", "https://pastebin.com/"),
    ("pastebinproxy", "https://pastebin.com/"),
    ("rentry", "https://rentry.co/"),
    ("poedb", "https://poedb.tw/pob/"),
];
const SITES_POE2: &[(&str, &str)] = &[
    ("maxroll", "https://maxroll.gg/poe2/pob/"),
    ("pobbin", "https://pobb.in/"),
    ("poeninja", "https://poe.ninja/poe2/pob/"),
    ("poe2db", "https://poe2db.tw/pob/"),
    ("pastebin", "https://pastebin.com/"),
    ("pastebinproxy", "https://pastebin.com/"),
    ("rentry", "https://rentry.co/"),
];

pub fn parse(raw: &str) -> Option<Link> {
    let (scheme, rest) = raw.trim().split_once(':')?;
    let (game, sites) = match scheme.to_ascii_lowercase().as_str() {
        "pob" => (Game::Poe1, SITES_POE1),
        "pob2" => (Game::Poe2, SITES_POE2),
        _ => return None,
    };
    let rest = rest.trim_start_matches(['/', '\\']);
    let (site, id) = rest.split_once(['/', '\\'])?;
    // browsers and shells can add a trailing slash
    let id = id.trim_matches(['/', '\\']);
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~')) {
        return None;
    }
    let (_, prefix) = sites.iter().find(|(s, _)| s.eq_ignore_ascii_case(site))?;
    Some(Link { game, url: format!("{prefix}{id}") })
}

/// The first link on this process's command line.
pub fn from_args() -> Option<Link> {
    std::env::args().skip(1).find_map(|a| parse(&a))
}

fn handoff_file() -> PathBuf {
    std::env::temp_dir().join("pob-redux-links.json")
}

/// Give `link` to a running instance. True when one accepted it.
pub fn hand_off(raw: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(handoff_file()) else { return false };
    let Ok(info) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
    let (Some(port), Some(token)) = (info.get("port").and_then(|v| v.as_u64()), info.get("token").and_then(|v| v.as_str())) else {
        return false;
    };
    let addr = SocketAddr::from(([127, 0, 0, 1], port as u16));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    if writeln!(stream, "{token}\n{}", raw.trim()).is_err() {
        return false;
    }
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).is_ok() && reply.trim() == "ok"
}

/// Accept links from later processes, passing each parsed one to `deliver`.
/// The token in the hand-off file keeps other local programs from injecting links.
pub fn listen(deliver: impl Fn(Link) + Send + 'static) {
    let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) else { return };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else { return };
    let mut bytes = [0u8; 24];
    if getrandom::fill(&mut bytes).is_err() {
        return;
    }
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let path = handoff_file();
    if std::fs::write(&path, serde_json::json!({ "port": port, "token": token }).to_string()).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let (mut given, mut raw) = (String::new(), String::new());
            {
                let mut reader = BufReader::new((&stream).take(4096));
                if reader.read_line(&mut given).is_err() || reader.read_line(&mut raw).is_err() {
                    continue;
                }
            }
            if given.trim() != token {
                continue;
            }
            let Some(link) = parse(&raw) else { continue };
            let _ = stream.write_all(b"ok\n");
            deliver(link);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{parse, Link};
    use crate::game::Game;

    #[test]
    fn links() {
        assert_eq!(parse("pob://pobbin/abc123"), Some(Link { game: Game::Poe1, url: "https://pobb.in/abc123".into() }));
        assert_eq!(parse("pob://PoeNinja/xyz/"), Some(Link { game: Game::Poe1, url: "https://poe.ninja/poe1/pob/xyz".into() }));
        assert_eq!(parse("pob2://poeninja/xyz"), Some(Link { game: Game::Poe2, url: "https://poe.ninja/poe2/pob/xyz".into() }));
        assert_eq!(parse("pob2://maxroll/g312000h"), Some(Link { game: Game::Poe2, url: "https://maxroll.gg/poe2/pob/g312000h".into() }));
        assert_eq!(parse(r"pob:\\poedb\abc"), Some(Link { game: Game::Poe1, url: "https://poedb.tw/pob/abc".into() }));
        assert_eq!(parse("pob2://poedb/abc"), None);
        assert_eq!(parse("pob://pobbin/a b"), None);
        assert_eq!(parse("pob://pobbin/"), None);
        assert_eq!(parse("https://pobb.in/abc"), None);
    }
}
