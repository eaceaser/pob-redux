// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Every Lua allocation in the engines goes through the global allocator (mlua
// hands LuaJIT a Rust-backed allocator); the system heap is slower for that
// and slow to give memory back after a scan.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    // WebKitGTK's DMA-BUF path fails on a bundled WebKit whose Mesa disagrees
    // with the host's (a black window on Fedora and openSUSE AppImages).
    // POB_REDUX_GPU=1 opts back in.
    #[cfg(target_os = "linux")]
    if std::env::var_os("POB_REDUX_GPU").is_none() && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    pob_redux_lib::run()
}
