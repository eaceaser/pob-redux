//! A pool of extra PoB engines for embarrassingly parallel calc work (node
//! power, gem DPS scoring). Each worker is a full, independent Lua state
//! (~120 MB live); they boot lazily on first use and are synced to the main
//! engine's build by XML before a scatter.

use std::sync::Mutex;
use std::time::Instant;

use serde_json::Value;

use crate::pool_sync::{plan, SyncPlan};
use crate::{EngineConfig, EngineHandle, EngineState, Error, Result};

pub struct EnginePool {
    cfg: EngineConfig,
    size: usize,
    workers: Mutex<Vec<EngineHandle>>,
    /// The build every worker holds, as saved XML. Held for the whole of a
    /// sync so a second caller with the same build waits and then skips.
    synced_xml: Mutex<Option<String>>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PoolStatus {
    pub size: usize,
    pub spawned: usize,
    pub ready: usize,
}

impl EnginePool {
    pub fn new(cfg: EngineConfig, size: usize) -> Self {
        Self { cfg, size: size.max(1), workers: Mutex::new(Vec::new()), synced_xml: Mutex::new(None) }
    }

    pub fn size(&self) -> usize {
        self.size
    }

    /// Spawn every worker now; boots run concurrently on their own threads.
    pub fn warm(&self) {
        let mut ws = self.workers.lock().unwrap();
        while ws.len() < self.size {
            ws.push(EngineHandle::spawn(self.cfg.clone()));
        }
    }

    pub fn status(&self) -> PoolStatus {
        let ws = self.workers.lock().unwrap();
        let ready = ws.iter().filter(|w| w.status().state == EngineState::Ready).count();
        PoolStatus { size: self.size, spawned: ws.len(), ready }
    }

    /// Every worker, booted. A worker that failed or stopped is replaced
    /// with a fresh one rather than failing every scan from then on; the
    /// replacement holds no build, so the caller is told to load one.
    fn workers(&self) -> Result<(Vec<EngineHandle>, bool)> {
        self.warm();
        let mut respawned = false;
        let ws = {
            let mut ws = self.workers.lock().unwrap();
            for w in ws.iter_mut() {
                if matches!(w.status().state, EngineState::Error | EngineState::Stopped) {
                    log::warn!("pool: replacing a worker that {}", w.status().message.unwrap_or_else(|| "stopped".into()));
                    *w = EngineHandle::spawn(self.cfg.clone());
                    respawned = true;
                }
            }
            ws.clone()
        };
        for w in &ws {
            w.wait_ready()?;
        }
        Ok((ws, respawned))
    }

    /// Bring every worker to `xml`. A build that differs from what they hold
    /// only in its `<Tree>` section is applied as a tree swap, which is a
    /// fraction of a full load in both time and garbage.
    pub fn sync(&self, xml: &str) -> Result<()> {
        let mut held = self.synced_xml.lock().unwrap();
        let (ws, respawned) = self.workers()?;
        if respawned {
            *held = None;
        }
        let (method, params, what) = match plan(held.as_deref(), xml) {
            SyncPlan::Nothing => return Ok(()),
            SyncPlan::Tree(tree) => ("sync_tree", serde_json::json!({ "xml": tree }), "tree"),
            SyncPlan::Full => ("load_build_xml", serde_json::json!({ "xml": xml, "name": "pool" }), "build"),
        };
        let t0 = Instant::now();
        let results: Vec<Result<Value>> = std::thread::scope(|s| {
            let handles: Vec<_> = ws
                .iter()
                .map(|w| {
                    let params = params.clone();
                    s.spawn(move || {
                        w.call(method, params)?;
                        w.call("mem", Value::Null).map(|o| o.result)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err(Error::NotRunning("worker panicked".into())))).collect()
        });
        let mut heaps = Vec::with_capacity(results.len());
        for r in results {
            match r {
                Ok(v) => heaps.push(v.get("mb").and_then(Value::as_u64).unwrap_or(0)),
                Err(e) => {
                    // a worker whose state is now unknown must take a full load next time
                    *held = None;
                    return Err(e);
                }
            }
        }
        *held = Some(xml.to_string());
        log::info!("pool: synced {} to {} workers in {} ms; heaps MB {:?}", what, ws.len(), t0.elapsed().as_millis(), heaps);
        Ok(())
    }

    /// Evaluate `code` on every worker, in worker order.
    pub fn eval_all(&self, code: &str) -> Result<Vec<Value>> {
        self.workers()?.0.iter().map(|w| w.eval(code)).collect()
    }

    /// Full garbage collection on every booted worker, for the idle moment
    /// after a scan. Each worker's garbage is what keeps the process large
    /// once the optimiser stops, and the allocator only returns memory that
    /// Lua has freed.
    pub fn trim(&self) {
        let ws: Vec<EngineHandle> =
            self.workers.lock().unwrap().iter().filter(|w| w.status().state == EngineState::Ready).cloned().collect();
        if ws.is_empty() {
            return;
        }
        let t0 = Instant::now();
        let heaps: Vec<u64> = std::thread::scope(|s| {
            let handles: Vec<_> = ws.iter().map(|w| s.spawn(move || w.call("gc", Value::Null))).collect();
            handles
                .into_iter()
                .map(|h| h.join().ok().and_then(|r| r.ok()).and_then(|o| o.result.get("mb").and_then(Value::as_u64)).unwrap_or(0))
                .collect()
        });
        log::info!("pool: trimmed {} workers in {} ms; live heaps MB {:?}", ws.len(), t0.elapsed().as_millis(), heaps);
    }

    /// Run `method` once per chunk across the workers and return the results
    /// in chunk order. Workers pull chunks from a shared queue, so uneven
    /// chunk costs don't leave anyone idle.
    pub fn scatter(&self, method: &str, chunks: Vec<Value>) -> Result<Vec<Value>> {
        let (ws, respawned) = self.workers()?;
        if respawned {
            *self.synced_xml.lock().unwrap() = None;
            return Err(Error::NotRunning("a worker was replaced since the last sync".into()));
        }
        if ws.is_empty() {
            return Err(Error::NotRunning("pool has no workers".into()));
        }
        let n = chunks.len();
        let queue = Mutex::new(chunks.into_iter().enumerate().collect::<std::collections::VecDeque<_>>());
        let results: Mutex<Vec<Option<Result<Value>>>> = Mutex::new((0..n).map(|_| None).collect());
        std::thread::scope(|s| {
            for w in ws.iter().take(n.max(1)) {
                let queue = &queue;
                let results = &results;
                s.spawn(move || loop {
                    let next = queue.lock().unwrap().pop_front();
                    let Some((i, params)) = next else { break };
                    let r = w.call(method, params).map(|o| o.result);
                    results.lock().unwrap()[i] = Some(r);
                });
            }
        });
        results
            .into_inner()
            .unwrap()
            .into_iter()
            .map(|r| r.unwrap_or_else(|| Err(Error::NotRunning("chunk was not run".into()))))
            .collect()
    }
}

fn chunk_ranges(len: usize, chunk: usize) -> Vec<(usize, usize)> {
    let chunk = chunk.max(1);
    (0..len).step_by(chunk).map(|a| (a, (a + chunk).min(len))).collect()
}

/// Load the main engine's current build into the pool.
pub fn sync_from(engine: &EngineHandle, pool: &EnginePool) -> Result<()> {
    let xml = engine.call("save_build_xml", Value::Null)?.result;
    let xml = xml
        .get("xml")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::Other("save_build_xml returned no xml".into()))?;
    pool.sync(xml)
}

/// Node power for the main engine's build, scored across the pool with the
/// same per-node calc PoB's PowerBuilder runs, written back into the main
/// engine so `tree_power_result` and the power report are unchanged.
pub fn power_scan(engine: &EngineHandle, pool: &EnginePool, stat: Option<&str>, max_depth: Option<f64>) -> Result<Value> {
    let part = engine
        .call("tree_power_partition", serde_json::json!({ "stat": stat, "maxDepth": max_depth }))?
        .result;
    let ids = part.get("ids").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let dists = part.get("dists").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let paths = part.get("paths").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let stat_name = part.get("stat").cloned().unwrap_or(Value::Null);
    let mut nodes: Vec<Value> = Vec::with_capacity(ids.len());
    if !ids.is_empty() {
        sync_from(engine, pool)?;
        // small chunks keep the queue balanced; the modKey-sorted order keeps
        // identical nodes together so a worker's calc cache still dedupes
        let chunks: Vec<Value> = chunk_ranges(ids.len(), 24)
            .into_iter()
            .map(|(a, b)| {
                serde_json::json!({
                    "ids": &ids[a..b],
                    "dists": &dists[a..b],
                    "paths": paths.get(a..b).unwrap_or(&[]),
                    "stat": stat_name,
                })
            })
            .collect();
        for r in pool.scatter("score_nodes", chunks)? {
            if let Some(list) = r.get("nodes").and_then(|v| v.as_array()) {
                nodes.extend(list.iter().cloned());
            }
        }
    }
    let applied = engine.call("tree_power_apply", serde_json::json!({ "nodes": nodes }))?.result;
    if let Ok(m) = engine.call("mem", Value::Null) {
        log::info!("power scan: main engine heap {} MB", m.result.get("mb").and_then(Value::as_u64).unwrap_or(0));
    }
    Ok(applied)
}

/// Fill the main engine's gem DPS cache for a socket group across the pool.
/// Returns `{"cached": true}` when it was already warm.
pub fn gem_dps_fill(engine: &EngineHandle, pool: &EnginePool, group_index: u32) -> Result<Value> {
    let cands = engine
        .call("gem_dps_candidates", serde_json::json!({ "groupIndex": group_index }))?
        .result;
    if cands.get("cached").and_then(|v| v.as_bool()) == Some(true) {
        return Ok(serde_json::json!({ "cached": true }));
    }
    let gem_ids = cands.get("gemIds").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let key = cands.get("key").cloned().unwrap_or(Value::Null);
    let dps_field = cands.get("dpsField").cloned().unwrap_or(Value::Null);
    sync_from(engine, pool)?;
    let chunks: Vec<Value> = chunk_ranges(gem_ids.len(), 12)
        .into_iter()
        .map(|(a, b)| serde_json::json!({ "groupIndex": group_index, "gemIds": &gem_ids[a..b], "dpsField": dps_field }))
        .collect();
    let mut dps = serde_json::Map::new();
    let mut base = Value::Null;
    for r in pool.scatter("score_gems", chunks)? {
        if base.is_null() {
            base = r.get("base").cloned().unwrap_or(Value::Null);
        }
        if let Some(m) = r.get("dps").and_then(|v| v.as_object()) {
            for (k, v) in m {
                dps.insert(k.clone(), v.clone());
            }
        }
    }
    Ok(engine
        .call("gem_dps_apply", serde_json::json!({ "key": key, "base": base, "dps": Value::Object(dps) }))?
        .result)
}
