//! Headless driver for the PoB engine. Useful for smoke tests, benchmarks and
//! poking at bridge methods without the desktop app.
//!
//!   pobctl --pob-root <dir> methods
//!   pobctl --pob-root <dir> call get_build
//!   pobctl --pob-root <dir> call load_build_code '{"code":"..."}'
//!   pobctl --pob-root <dir> stats path/to/build.xml
//!   pobctl --pob-root <dir> bench

use std::path::PathBuf;
use std::time::Instant;

use clap::{Parser, Subcommand};
use pob_engine::{Engine, EngineConfig};
use serde_json::{json, Value};

// Every Lua allocation goes through the global allocator (mlua hands LuaJIT a
// Rust-backed allocator); the system heap is slow for that and slow to give
// memory back.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser)]
#[command(name = "pobctl", about = "Drive the headless Path of Building engine")]
struct Cli {
    /// Directory containing PoB's Launch.lua (a pob-sync output or a PoB2 checkout's src/).
    #[arg(long, env = "POB_REDUX_POB_ROOT")]
    pob_root: PathBuf,
    /// Parent of "Path of Building (PoE2)/" (Builds, Settings.xml). Defaults to a temp dir.
    #[arg(long, env = "POB_REDUX_USER_DIR")]
    user_dir: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// List bridge methods.
    Methods,
    /// Call a bridge method with optional JSON params.
    Call { method: String, params: Option<String> },
    /// Load a build XML file and print its sidebar stats.
    Stats { file: PathBuf },
    /// Boot and time a few full recalculations.
    Bench {
        #[arg(default_value_t = 10)]
        iterations: u32,
    },
    /// Evaluate a raw Lua expression against the live state.
    Eval { code: String },
    /// Node power for a build: PoB's sequential PowerBuilder vs the worker pool.
    Power {
        file: PathBuf,
        /// Power stat (e.g. Life, FullDPS); omit for PoB's default.
        #[arg(long)]
        stat: Option<String>,
        /// Max path distance; omit for the whole tree.
        #[arg(long)]
        depth: Option<f64>,
        /// Worker engines.
        #[arg(long, default_value_t = 4)]
        pool: usize,
        /// Skip the sequential reference run.
        #[arg(long)]
        no_sequential: bool,
        /// After the warm run, allocate the best node and rescan this many times,
        /// printing sync/scan time and each worker's Lua heap.
        #[arg(long, default_value_t = 0)]
        rounds: u32,
    },
    /// Gem DPS scoring for a socket group: sequential vs the worker pool.
    Gems {
        file: PathBuf,
        #[arg(long, default_value_t = 1)]
        group: u32,
        #[arg(long, default_value_t = 4)]
        pool: usize,
    },
}

fn gems_cmd(cfg: EngineConfig, file: PathBuf, group: u32, pool_size: usize) -> Result<Value, pob_engine::Error> {
    use pob_engine::{EngineHandle, EnginePool};
    let engine = EngineHandle::spawn(cfg.clone());
    let pool = EnginePool::new(cfg, pool_size);
    pool.warm();
    engine.wait_ready()?;
    engine.call("load_build_file", json!({ "path": file.to_string_lossy() }))?;
    // sequential: a cold DPS-sorted search scores every candidate in this engine
    let t = Instant::now();
    let seq = engine
        .call("gem_search", json!({ "groupIndex": group, "query": "", "sortByDps": true, "limit": 400 }))?
        .result;
    let seq_ms = t.elapsed().as_secs_f64() * 1000.0;
    // invalidate the cache by touching the build, then fill it from the pool:
    // once cold (includes the worker sync) and once with workers pre-synced,
    // which is the app's steady state
    engine.call("set_level", json!({ "level": 32 }))?;
    let t = Instant::now();
    let _ = pob_engine::pool::gem_dps_fill(&engine, &pool, group)?;
    let fill_cold_ms = t.elapsed().as_secs_f64() * 1000.0;
    engine.call("set_level", json!({ "level": 33 }))?;
    pob_engine::pool::sync_from(&engine, &pool)?;
    let t = Instant::now();
    let fill = pob_engine::pool::gem_dps_fill(&engine, &pool, group)?;
    let fill_ms = t.elapsed().as_secs_f64() * 1000.0;
    eprintln!("pool fill cold (with sync): {fill_cold_ms:.0} ms; pre-synced: {fill_ms:.0} ms");
    let t = Instant::now();
    let par = engine
        .call("gem_search", json!({ "groupIndex": group, "query": "", "sortByDps": true, "limit": 400 }))?
        .result;
    let search_ms = t.elapsed().as_secs_f64() * 1000.0;
    let top = |v: &Value| {
        v.get("gems")
            .and_then(|g| g.as_array())
            .map(|g| g.iter().take(5).map(|r| json!([r.get("name"), r.get("dps")])).collect::<Vec<_>>())
            .unwrap_or_default()
    };
    Ok(json!({
        "sequential_ms": seq_ms,
        "pool_fill_ms": fill_ms,
        "search_after_fill_ms": search_ms,
        "speedup": seq_ms / (fill_ms + search_ms).max(0.001),
        "scored": fill.get("count").cloned().unwrap_or(Value::Null),
        "workers": pool.status().ready,
        "top_sequential": top(&seq),
        "top_pool": top(&par),
    }))
}

/// Per-node power from PoB's sequential builder against the pool's: the count
/// of nodes whose scores differ and a few examples.
fn compare_power(sequential: &Value, parallel: &Value) -> (usize, Vec<Value>) {
    let mut mismatches = 0;
    let mut samples = Vec::new();
    let (Some(a), Some(b)) = (
        sequential.get("nodes").and_then(|n| n.as_object()),
        parallel.get("nodes").and_then(|n| n.as_object()),
    ) else {
        return (0, samples);
    };
    for (id, va) in a {
        match b.get(id) {
            Some(vb) => {
                for k in ["s", "o", "d", "p"] {
                    let x = va.get(k).and_then(|v| v.as_f64());
                    let y = vb.get(k).and_then(|v| v.as_f64());
                    let differs = match (x, y) {
                        (Some(x), Some(y)) => (x - y).abs() > 1e-6,
                        (None, None) => false,
                        _ => true,
                    };
                    if differs {
                        mismatches += 1;
                        if samples.len() < 8 {
                            samples.push(json!({ "id": id, "key": k, "seq": va, "pool": vb }));
                        }
                        break;
                    }
                }
            }
            None => {
                mismatches += 1;
                if samples.len() < 8 {
                    samples.push(json!({ "id": id, "seq": va, "pool": Value::Null }));
                }
            }
        }
    }
    for (id, vb) in b {
        if !a.contains_key(id) {
            mismatches += 1;
            if samples.len() < 8 {
                samples.push(json!({ "id": id, "seq": Value::Null, "pool": vb }));
            }
        }
    }
    (mismatches, samples)
}

fn power_cmd(cfg: EngineConfig, file: PathBuf, stat: Option<String>, depth: Option<f64>, pool_size: usize, no_sequential: bool, rounds: u32) -> Result<Value, pob_engine::Error> {
    use pob_engine::{EngineHandle, EnginePool};
    let t0 = Instant::now();
    let engine = EngineHandle::spawn(cfg.clone());
    let pool = EnginePool::new(cfg, pool_size);
    pool.warm();
    engine.wait_ready()?;
    eprintln!("main engine ready in {} ms", t0.elapsed().as_millis());
    engine.call("load_build_file", json!({ "path": file.to_string_lossy() }))?;

    let mut sequential = Value::Null;
    let mut seq_ms = 0.0;
    if !no_sequential {
        let t = Instant::now();
        sequential = engine.call("tree_power", json!({ "stat": stat, "maxDepth": depth }))?.result;
        seq_ms = t.elapsed().as_secs_f64() * 1000.0;
        eprintln!("sequential PowerBuilder: {seq_ms:.0} ms");
    }

    let t = Instant::now();
    let parallel = pob_engine::pool::power_scan(&engine, &pool, stat.as_deref(), depth)?;
    let par_ms = t.elapsed().as_secs_f64() * 1000.0;
    eprintln!("pool x{}: {par_ms:.0} ms (first run includes sync)", pool.status().ready);
    let t = Instant::now();
    let _ = pob_engine::pool::power_scan(&engine, &pool, stat.as_deref(), depth)?;
    let par2_ms = t.elapsed().as_secs_f64() * 1000.0;
    eprintln!("pool x{}: {par2_ms:.0} ms (warm)", pool.status().ready);

    let count = |v: &Value| v.get("nodes").and_then(|n| n.as_object()).map(|m| m.len()).unwrap_or(0);
    let (mut mismatches, mut samples) = compare_power(&sequential, &parallel);

    // Each round allocates the best node and rescans, which takes the tree-swap
    // sync path; the sequential builder checks it every round unless skipped.
    let heap = "collectgarbage('collect'); return math.floor(collectgarbage('count') / 1024)";
    for round in 1..=rounds {
        let best = engine
            .call("tree_power_result", Value::Null)?
            .result
            .get("report")
            .and_then(|r| r.as_array())
            .and_then(|list| list.iter().find(|r| r.get("allocated") != Some(&Value::Bool(true))))
            .and_then(|r| r.get("id").cloned());
        if let Some(id) = best {
            engine.call("alloc_node", json!({ "id": id }))?;
        }
        let t = Instant::now();
        let scanned = pob_engine::pool::power_scan(&engine, &pool, stat.as_deref(), depth)?;
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let mut check = String::new();
        if !no_sequential {
            let seq = engine.call("tree_power", json!({ "stat": stat, "maxDepth": depth }))?.result;
            let (m, s) = compare_power(&seq, &scanned);
            mismatches += m;
            if samples.len() < 8 {
                samples.extend(s);
            }
            check = format!("; mismatches {m}");
        }
        let heaps: Vec<String> = pool.eval_all(heap)?.iter().map(|v| v.to_string()).collect();
        let main_mb = engine.eval(heap)?;
        eprintln!("round {round}: scan {ms:.0} ms{check}; main heap {main_mb} MB; worker heaps MB [{}]", heaps.join(" "));
    }
    Ok(json!({
        "nodes": count(&parallel),
        "sequential_ms": if no_sequential { Value::Null } else { json!(seq_ms) },
        "pool_first_ms": par_ms,
        "pool_warm_ms": par2_ms,
        "speedup_warm": if no_sequential || par2_ms == 0.0 { Value::Null } else { json!(seq_ms / par2_ms) },
        "workers": pool.status().ready,
        "mismatches": if no_sequential { Value::Null } else { json!(mismatches) },
        "mismatch_samples": samples,
        "max": parallel.get("max").cloned().unwrap_or(Value::Null),
        "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
    }))
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let cli = Cli::parse();
    let user_dir = cli
        .user_dir
        .unwrap_or_else(|| std::env::temp_dir().join("pob-redux-cli"));

    let pooled: Option<Result<Value, pob_engine::Error>> = match &cli.cmd {
        Cmd::Power { file, stat, depth, pool, no_sequential, rounds } => {
            let cfg = EngineConfig { pob_root: cli.pob_root.clone(), user_dir: user_dir.clone() };
            Some(power_cmd(cfg, file.clone(), stat.clone(), *depth, *pool, *no_sequential, *rounds))
        }
        Cmd::Gems { file, group, pool } => {
            let cfg = EngineConfig { pob_root: cli.pob_root.clone(), user_dir: user_dir.clone() };
            Some(gems_cmd(cfg, file.clone(), *group, *pool))
        }
        _ => None,
    };
    if let Some(out) = pooled {
        match out {
            Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
            Err(e) => {
                eprintln!("error: {e}");
                std::process::exit(2);
            }
        }
        return;
    }

    let t0 = Instant::now();
    let engine = match Engine::boot(EngineConfig { pob_root: cli.pob_root, user_dir }) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("boot failed: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("booted in {} ms", t0.elapsed().as_millis());

    let out: Result<Value, pob_engine::Error> = match cli.cmd {
        Cmd::Methods => engine.method_names().map(|m| json!(m)),
        Cmd::Call { method, params } => {
            let params: Value = match params {
                Some(p) => serde_json::from_str(&p).expect("params must be JSON"),
                None => Value::Null,
            };
            let t = Instant::now();
            let r = engine.call(&method, &params);
            eprintln!("{method}: {:.2} ms", t.elapsed().as_secs_f64() * 1000.0);
            r
        }
        Cmd::Stats { file } => {
            let xml = std::fs::read_to_string(&file).expect("read build file");
            let name = file.file_stem().map(|s| s.to_string_lossy().to_string());
            let t = Instant::now();
            engine
                .call("load_build_xml", &json!({ "xml": xml, "name": name }))
                .and_then(|_| {
                    eprintln!("load+calc: {:.1} ms", t.elapsed().as_secs_f64() * 1000.0);
                    engine.call("get_sidebar", &Value::Null)
                })
                .inspect(|side| {
                    if let Some(rows) = side.get("rows").and_then(|r| r.as_array()) {
                        for row in rows {
                            let lhs = row.get("lhs").and_then(|v| v.as_str()).unwrap_or("");
                            let rhs = row.get("rhs").and_then(|v| v.as_str()).unwrap_or("");
                            if !lhs.is_empty() || !rhs.is_empty() {
                                println!("{:<40} {}", strip(lhs), strip(rhs));
                            }
                        }
                    }
                })
        }
        Cmd::Bench { iterations } => engine
            .call("new_build", &json!({ "name": "bench" }))
            .and_then(|_| {
                let mut times = Vec::new();
                for _ in 0..iterations {
                    let t = Instant::now();
                    engine.call("refresh", &Value::Null)?;
                    times.push(t.elapsed().as_secs_f64() * 1000.0);
                }
                let avg = times.iter().sum::<f64>() / times.len().max(1) as f64;
                let min = times.iter().cloned().fold(f64::MAX, f64::min);
                Ok(json!({ "iterations": iterations, "avg_ms": avg, "min_ms": min, "boot_ms": engine.boot_ms }))
            }),
        Cmd::Eval { code } => engine.eval(&code),
        Cmd::Power { .. } | Cmd::Gems { .. } => unreachable!("handled above"),
    };

    match out {
        Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(2);
        }
    }
}

/// Drop PoB colour escapes (^7, ^xRRGGBB) for terminal output.
fn strip(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'^' && i + 1 < b.len() {
            if b[i + 1] == b'x' && i + 7 < b.len() {
                i += 8;
                continue;
            }
            if b[i + 1].is_ascii_digit() {
                i += 2;
                continue;
            }
        }
        out.push(b[i] as char);
        i += 1;
    }
    out
}
