//! A pool of extra PoB engines for embarrassingly parallel calc work (node
//! power, gem DPS scoring). Each worker is a full, independent Lua state
//! (~120 MB live); they boot lazily on first use and are synced to the main
//! engine's build by XML before a scatter.

use std::sync::Mutex;
use std::time::Instant;

use serde_json::Value;

use crate::{EngineConfig, EngineHandle, EngineState, Error, Result};

pub struct EnginePool {
    cfg: EngineConfig,
    size: usize,
    workers: Mutex<Vec<EngineHandle>>,
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

    fn workers(&self) -> Result<Vec<EngineHandle>> {
        self.warm();
        let ws = self.workers.lock().unwrap().clone();
        for w in &ws {
            w.wait_ready()?;
        }
        Ok(ws)
    }

    /// Load `xml` into every worker unless it is what they already hold.
    pub fn sync(&self, xml: &str) -> Result<()> {
        if self.synced_xml.lock().unwrap().as_deref() == Some(xml) {
            return Ok(());
        }
        let ws = self.workers()?;
        let t0 = Instant::now();
        let params = serde_json::json!({ "xml": xml, "name": "pool" });
        let results: Vec<Result<()>> = std::thread::scope(|s| {
            let handles: Vec<_> = ws
                .iter()
                .map(|w| {
                    let params = params.clone();
                    s.spawn(move || w.call("load_build_xml", params).map(|_| ()))
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err(Error::NotRunning("worker panicked".into())))).collect()
        });
        for r in results {
            r?;
        }
        *self.synced_xml.lock().unwrap() = Some(xml.to_string());
        log::info!("pool: synced {} workers in {} ms", ws.len(), t0.elapsed().as_millis());
        Ok(())
    }

    /// Run `method` once per chunk across the workers and return the results
    /// in chunk order. Workers pull chunks from a shared queue, so uneven
    /// chunk costs don't leave anyone idle.
    pub fn scatter(&self, method: &str, chunks: Vec<Value>) -> Result<Vec<Value>> {
        let ws = self.workers()?;
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
    Ok(engine.call("tree_power_apply", serde_json::json!({ "nodes": nodes }))?.result)
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
