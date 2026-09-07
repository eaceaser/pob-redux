// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Every Lua allocation in the engines goes through the global allocator (mlua
// hands LuaJIT a Rust-backed allocator); the system heap is slower for that
// and slow to give memory back after a scan.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    pob_redux_lib::run()
}
