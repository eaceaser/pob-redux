//! Vendors the parts of a PathOfBuilding-PoE2 checkout that the headless
//! engine needs into `src-tauri/resources/pob`, mirroring the file set of an
//! installed PoB release (see upstream `manifest.cfg`).
//!
//!   cargo run -p pob-sync -- [--source <checkout>] [--dest <dir>] [--clean] [--tree-assets]

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use clap::Parser;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

mod assets;

#[derive(Parser)]
#[command(name = "pob-sync", about = "Vendor Path of Building (PoE2) into app resources")]
struct Cli {
    /// PathOfBuilding-PoE2 checkout root. Defaults to `source_path` in pob-sync.toml.
    #[arg(long, env = "POB_SOURCE")]
    source: Option<PathBuf>,
    /// Output directory. Defaults to <workspace>/src-tauri/resources/pob.
    #[arg(long)]
    dest: Option<PathBuf>,
    /// Delete the destination first.
    #[arg(long)]
    clean: bool,
    /// Decode the latest tree's sprite sheets into WebP (TreeData/<ver>/web/).
    #[arg(long)]
    tree_assets: bool,
    /// Proceed even if the checkout's HEAD differs from the pinned commit.
    #[arg(long)]
    allow_commit_mismatch: bool,
    /// Print DDS header details for the latest tree's sheets and exit.
    #[arg(long)]
    inspect_assets: bool,
}

#[derive(Deserialize, Default)]
struct SyncToml {
    source_path: Option<String>,
    commit: Option<String>,
}

#[derive(Serialize)]
struct SyncInfo {
    upstream_commit: String,
    upstream_commit_date: String,
    upstream_version: String,
    pinned_commit: Option<String>,
    synced_at_unix: u64,
    files: usize,
    bytes: u64,
    tree_assets: bool,
}

const EXCLUDE_FILES: &[&str] = &[
    "HeadlessWrapper.lua",
    "LaunchInstall.lua",
    "Settings.xml",
    "_SimpleGraphic.def.lua",
    "luacov.stats.out",
    "poe_api_response.json",
];
const EXCLUDE_DIRS: &[&str] = &["Export", "TreeData", "Builds"];
const ROOT_FILES: &[&str] = &["changelog.txt", "LICENSE.md", "help.txt"];

fn main() -> Result<()> {
    let cli = Cli::parse();
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .context("locate workspace root")?;

    let toml_cfg: SyncToml = fs::read_to_string(workspace.join("pob-sync.toml"))
        .ok()
        .and_then(|s| toml::from_str(&s).ok())
        .unwrap_or_default();

    let source = match cli.source {
        Some(s) => s,
        None => {
            let rel = toml_cfg
                .source_path
                .as_deref()
                .context("no --source given and pob-sync.toml has no source_path")?;
            workspace.join(rel)
        }
    };
    let source = source
        .canonicalize()
        .with_context(|| format!("source {} not found", source.display()))?;
    let src = source.join("src");
    if !src.join("Launch.lua").is_file() {
        bail!("{} does not look like a PathOfBuilding-PoE2 checkout (no src/Launch.lua)", source.display());
    }
    let dest = cli
        .dest
        .unwrap_or_else(|| workspace.join("src-tauri/resources/pob"));

    if cli.inspect_assets {
        let tree_root = src.join("TreeData");
        let latest = latest_tree_version(&tree_root).context("no TreeData version")?;
        return assets::inspect(&tree_root.join(latest));
    }

    let head = git(&source, &["rev-parse", "HEAD"]).unwrap_or_else(|_| "unknown".into());
    let head_date = git(&source, &["log", "-1", "--format=%cI"]).unwrap_or_default();
    if let Some(pinned) = &toml_cfg.commit {
        if pinned != &head {
            let msg = format!("checkout HEAD {head} differs from pinned commit {pinned}");
            if cli.allow_commit_mismatch {
                eprintln!("warning: {msg}");
            } else {
                bail!("{msg} (pass --allow-commit-mismatch, or update pob-sync.toml)");
            }
        }
    }
    let version = read_version(&source.join("manifest.xml")).unwrap_or_else(|| "unknown".into());

    if cli.clean && dest.exists() {
        fs::remove_dir_all(&dest).context("clean destination")?;
    }
    fs::create_dir_all(&dest)?;

    let mut wanted: HashSet<PathBuf> = HashSet::new();
    let mut stats = (0usize, 0u64);

    // Program files (src/ minus exclusions).
    for entry in WalkDir::new(&src).into_iter().filter_entry(|e| {
        if e.depth() == 1 && e.file_type().is_dir() {
            let name = e.file_name().to_string_lossy();
            return !EXCLUDE_DIRS.contains(&name.as_ref());
        }
        true
    }) {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if EXCLUDE_FILES.contains(&name.as_ref()) || name.ends_with(".bin") {
            continue;
        }
        let rel = entry.path().strip_prefix(&src)?.to_path_buf();
        copy_one(entry.path(), &dest.join(&rel), &mut stats)?;
        wanted.insert(rel);
    }

    // Tree data: Lua tables for the engine, JSON for the renderer.
    let tree_root = src.join("TreeData");
    let latest = latest_tree_version(&tree_root);
    for entry in WalkDir::new(&tree_root) {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(&src)?.to_path_buf();
        let name = entry.file_name().to_string_lossy();
        // Connector art (*.png) is not copied: the renderer strokes lines and arcs.
        let keep = name.ends_with(".lua") || name == "tree.json";
        if keep {
            copy_one(entry.path(), &dest.join(&rel), &mut stats)?;
            wanted.insert(rel);
        }
    }

    let web_rel = latest.as_ref().map(|v| Path::new("TreeData").join(v).join("web"));
    if cli.tree_assets {
        let latest = latest.as_ref().context("no TreeData/<major>_<minor> directory found")?;
        let a = assets::build(&tree_root.join(latest), &dest.join("TreeData").join(latest), latest)?;
        println!(
            "tree assets: {} sheets, {} layers -> {} files, {:.1} MB",
            a.sheets,
            a.layers,
            a.files,
            a.bytes as f64 / 1_048_576.0
        );
        for s in &a.skipped {
            eprintln!("  skipped {s}");
        }
    }
    let has_web = web_rel
        .as_ref()
        .map(|w| dest.join(w).join("manifest.json").is_file())
        .unwrap_or(false);

    // Pure-Lua libraries from the runtime (json, xml, base64, sha1, ...).
    let rt_lua = source.join("runtime/lua");
    for entry in WalkDir::new(&rt_lua) {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.file_name().to_string_lossy() == "lua-profiler.lua" {
            continue;
        }
        let rel = Path::new("lua").join(entry.path().strip_prefix(&rt_lua)?);
        copy_one(entry.path(), &dest.join(&rel), &mut stats)?;
        wanted.insert(rel);
    }

    for f in ROOT_FILES {
        let p = source.join(f);
        if p.is_file() {
            copy_one(&p, &dest.join(f), &mut stats)?;
            wanted.insert(PathBuf::from(f));
        }
    }

    // A release-style manifest: Launch.lua treats a manifest without branch and
    // platform as a dev checkout and changes user-path and update behaviour.
    let manifest = format!(
        "<?xml version='1.0' encoding='UTF-8'?>\n<PoBVersion>\n\t<Version number=\"{version}\" branch=\"release\" platform=\"win32\" />\n</PoBVersion>\n"
    );
    fs::write(dest.join("manifest.xml"), manifest)?;
    wanted.insert(PathBuf::from("manifest.xml"));

    let info = SyncInfo {
        upstream_commit: head.clone(),
        upstream_commit_date: head_date,
        upstream_version: version.clone(),
        pinned_commit: toml_cfg.commit.clone(),
        synced_at_unix: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        files: stats.0,
        bytes: stats.1,
        tree_assets: has_web,
    };
    fs::write(dest.join("SYNC.json"), serde_json::to_string_pretty(&info)?)?;
    wanted.insert(PathBuf::from("SYNC.json"));

    // Remove stale files from previous syncs.
    let mut removed = 0;
    for entry in WalkDir::new(&dest).contents_first(true) {
        let entry = entry?;
        let rel = entry.path().strip_prefix(&dest)?.to_path_buf();
        if rel.as_os_str().is_empty() {
            continue;
        }
        // Decoded tree assets are regenerated only with --tree-assets; keep them otherwise.
        if web_rel.as_ref().map(|w| rel.starts_with(w)).unwrap_or(false) {
            continue;
        }
        if entry.file_type().is_file() && !wanted.contains(&rel) {
            fs::remove_file(entry.path())?;
            removed += 1;
        } else if entry.file_type().is_dir() && fs::read_dir(entry.path())?.next().is_none() {
            let _ = fs::remove_dir(entry.path());
        }
    }

    println!(
        "synced PoB {version} @ {} -> {}\n  {} files, {:.1} MB copied, {} stale removed",
        &head[..head.len().min(10)],
        dest.display(),
        stats.0,
        stats.1 as f64 / 1_048_576.0,
        removed
    );
    Ok(())
}

fn copy_one(from: &Path, to: &Path, stats: &mut (usize, u64)) -> Result<()> {
    let src_md = fs::metadata(from)?;
    if let Ok(dst_md) = fs::metadata(to) {
        let same_len = dst_md.len() == src_md.len();
        let newer = match (src_md.modified(), dst_md.modified()) {
            (Ok(s), Ok(d)) => s > d,
            _ => true,
        };
        if same_len && !newer {
            return Ok(());
        }
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(from, to).with_context(|| format!("copy {}", from.display()))?;
    stats.0 += 1;
    stats.1 += src_md.len();
    Ok(())
}

fn git(repo: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git").arg("-C").arg(repo).args(args).output()?;
    if !out.status.success() {
        bail!("git {:?} failed", args);
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn read_version(manifest: &Path) -> Option<String> {
    let text = fs::read_to_string(manifest).ok()?;
    let i = text.find("<Version number=\"")?;
    let rest = &text[i + "<Version number=\"".len()..];
    let j = rest.find('"')?;
    Some(rest[..j].to_string())
}

/// Highest "<major>_<minor>" directory under TreeData.
fn latest_tree_version(tree_root: &Path) -> Option<String> {
    let mut best: Option<((u32, u32), String)> = None;
    for e in fs::read_dir(tree_root).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let mut parts = name.split('_');
        if let (Some(a), Some(b)) = (parts.next(), parts.next()) {
            if let (Ok(a), Ok(b)) = (a.parse::<u32>(), b.parse::<u32>()) {
                if best.as_ref().map(|(k, _)| (a, b) > *k).unwrap_or(true) {
                    best = Some(((a, b), name.clone()));
                }
            }
        }
    }
    best.map(|(_, n)| n)
}
