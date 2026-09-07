use std::path::Path;
use std::time::SystemTime;

/// Newest modification time under a directory, ignoring anything that is not
/// a regular file.
fn newest(dir: &Path) -> Option<SystemTime> {
    let mut best: Option<SystemTime> = None;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(m) = e.metadata().and_then(|m| m.modified()) {
                if best.is_none_or(|b| m > b) {
                    best = Some(m);
                }
            }
        }
    }
    best
}

fn main() {
    // A release build embeds `dist/`, and only `bun run build` refreshes it.
    // A `cargo build --release` on its own ships whatever frontend happens to
    // be there, which once meant a three-day-old panel. Refuse a stale one.
    if std::env::var("CARGO_FEATURE_CUSTOM_PROTOCOL").is_ok() && std::env::var("POB_REDUX_ALLOW_STALE_DIST").is_err() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let dist = root.join("dist").join("index.html");
        let src = newest(&root.join("src"));
        match (std::fs::metadata(&dist).and_then(|m| m.modified()).ok(), src) {
            (None, _) => panic!("dist/ is missing: run `bun run build` before a release build, or use `bun run tauri build`"),
            (Some(d), Some(s)) if s > d => {
                let msg = "dist/ is older than src/: run `bun run build` before a release build, or use `bun run tauri build` \
                           (set POB_REDUX_ALLOW_STALE_DIST=1 to build anyway)";
                // A debug build with the default features is a test or CLI
                // build; warn there, refuse only what would ship.
                if std::env::var("PROFILE").as_deref() == Ok("release") {
                    panic!("{msg}");
                }
                println!("cargo:warning={msg}");
            }
            _ => {}
        }
        println!("cargo:rerun-if-changed=../dist/index.html");
        println!("cargo:rerun-if-env-changed=POB_REDUX_ALLOW_STALE_DIST");
    }
    tauri_build::build()
}
