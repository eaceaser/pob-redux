//! Evaluates PoB's `return { ... }` Lua data files (tree.lua, sprites.lua)
//! into JSON for the web renderer. The PoE1 repository ships its tree data
//! only as Lua tables; the PoE2 fork also carries the JSON the tables came from.

use std::path::Path;

use anyhow::{bail, Context, Result};
use mlua::{Lua, Value as LuaValue};
use serde_json::{Map, Number, Value};

pub fn eval_file(path: &Path) -> Result<Value> {
    let src = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let lua = Lua::new();
    let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let v: LuaValue = lua
        .load(&src)
        .set_name(name)
        .eval()
        .with_context(|| format!("evaluate {}", path.display()))?;
    to_json(v)
}

fn key_int(k: &LuaValue) -> Option<i64> {
    match k {
        LuaValue::Integer(i) => Some(*i),
        LuaValue::Number(n) if n.fract() == 0.0 => Some(*n as i64),
        _ => None,
    }
}

/// A table keyed exactly 1..n is a list; an empty table is an empty list,
/// which is the only way PoB's data files use one.
fn to_json(v: LuaValue) -> Result<Value> {
    Ok(match v {
        LuaValue::Nil => Value::Null,
        LuaValue::Boolean(b) => Value::Bool(b),
        LuaValue::Integer(i) => Value::from(i),
        LuaValue::Number(n) => {
            if n.fract() == 0.0 && n.abs() < 9.0e15 {
                Value::from(n as i64)
            } else {
                Number::from_f64(n).map(Value::Number).unwrap_or(Value::Null)
            }
        }
        LuaValue::String(s) => Value::String(s.to_str()?.to_string()),
        LuaValue::Table(t) => {
            let mut entries: Vec<(LuaValue, LuaValue)> = Vec::new();
            for pair in t.pairs::<LuaValue, LuaValue>() {
                entries.push(pair?);
            }
            let mut ints: Vec<i64> = entries.iter().filter_map(|(k, _)| key_int(k)).collect();
            let is_list = ints.len() == entries.len() && {
                ints.sort_unstable();
                ints.iter().enumerate().all(|(i, k)| *k == i as i64 + 1)
            };
            if is_list {
                entries.sort_by_key(|(k, _)| key_int(k).unwrap_or(0));
                Value::Array(entries.into_iter().map(|(_, v)| to_json(v)).collect::<Result<_>>()?)
            } else {
                let mut m = Map::new();
                for (k, v) in entries {
                    let key = match k {
                        LuaValue::String(s) => s.to_str()?.to_string(),
                        LuaValue::Integer(i) => i.to_string(),
                        LuaValue::Number(n) => n.to_string(),
                        other => bail!("unsupported table key {other:?}"),
                    };
                    m.insert(key, to_json(v)?);
                }
                Value::Object(m)
            }
        }
        other => bail!("unsupported Lua value {other:?}"),
    })
}
