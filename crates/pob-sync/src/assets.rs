//! Decodes PoB's passive-tree sprite sheets into WebP for the web renderer.
//!
//! Each `<name>_<w>_<h>_<format>.dds.zst` is a zstd-compressed DDS array
//! texture: one named asset per layer, all layers the same size. tree.json's
//! `ddsCoords[file][name]` gives the 1-based layer of every asset. Small
//! layers are packed into one atlas per sheet; large ones (backgrounds) get a
//! file per layer, downscaled. `web/manifest.json` maps asset names to rects.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use image::imageops::FilterType;
use image::RgbaImage;
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct AssetRect {
    pub file: String,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    /// Native layer size before any downscaling.
    pub ow: u32,
    pub oh: u32,
}

#[derive(Serialize, Default)]
pub struct Manifest {
    pub version: String,
    pub assets: BTreeMap<String, AssetRect>,
    /// Greyscale icon variants from the `skills-disabled_*` sheets.
    pub disabled: BTreeMap<String, AssetRect>,
}

#[derive(Default)]
pub struct AssetStats {
    pub sheets: usize,
    pub layers: usize,
    pub files: usize,
    pub bytes: u64,
    pub skipped: Vec<String>,
}

pub fn build(src_tree: &Path, dest_tree: &Path, version: &str) -> Result<AssetStats> {
    let tree: serde_json::Value =
        serde_json::from_slice(&fs::read(src_tree.join("tree.json")).context("read tree.json")?)?;
    let web = dest_tree.join("web");
    if web.exists() {
        fs::remove_dir_all(&web)?;
    }
    fs::create_dir_all(&web)?;

    let mut manifest = Manifest { version: version.to_string(), ..Default::default() };
    let mut stats = AssetStats::default();

    if let Some(coords) = tree.get("ddsCoords").and_then(|v| v.as_object()) {
        for (file, names) in coords {
            let path = src_tree.join(file);
            if !path.is_file() {
                stats.skipped.push(format!("{file}: missing"));
                continue;
            }
            match decode_sheet(&path, file, names, version, &web) {
                Ok((rects, disabled, layers, files, bytes)) => {
                    stats.sheets += 1;
                    stats.layers += layers;
                    stats.files += files;
                    stats.bytes += bytes;
                    let target = if disabled { &mut manifest.disabled } else { &mut manifest.assets };
                    target.extend(rects);
                }
                Err(e) => stats.skipped.push(format!("{file}: {e:#}")),
            }
        }
    }

    // tree.json "assets" (connector line/arc PNGs) are intentionally not
    // shipped; the renderer strokes connectors itself.

    let src_root = src_tree.parent().and_then(Path::parent).unwrap_or(src_tree);
    copy_standalone(src_root, &web, version, &ring_entries(), &mut manifest, &mut stats)?;
    fs::write(web.join("manifest.json"), serde_json::to_vec_pretty(&manifest)?)?;
    Ok(stats)
}

/// Prints the DDS header of every sheet next to the data actually present.
pub fn inspect(src_tree: &Path) -> Result<()> {
    let mut files: Vec<_> = fs::read_dir(src_tree)?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".dds.zst"))
        .collect();
    files.sort_by_key(|e| e.file_name());
    for e in files {
        let raw = zstd::decode_all(&fs::read(e.path())?[..])?;
        let dds = image_dds::ddsfile::Dds::read(&raw[..])?;
        let (w, h) = (dds.get_width(), dds.get_height());
        let layers = dds.get_num_array_layers();
        let mips = dds.get_num_mipmap_levels();
        let fmt = dds
            .get_dxgi_format()
            .map(|f| format!("{f:?}"))
            .or_else(|| dds.get_d3d_format().map(|f| format!("{f:?}")))
            .unwrap_or_else(|| "?".into());
        let data = dds.data.len();
        println!(
            "{:<48} {:>5}x{:<5} layers={:<4} mips={:<3} fmt={:<14} data={:>10} bytes  per-layer={}",
            e.file_name().to_string_lossy(),
            w,
            h,
            layers,
            mips,
            fmt,
            data,
            if layers > 0 { data / layers as usize } else { 0 }
        );
    }
    Ok(())
}

/// Icons stay lossless; large soft art (class plates, mastery effects) is lossy.
fn save_webp(img: &RgbaImage, out: &Path, lossless: bool) -> Result<()> {
    let enc = webp::Encoder::from_rgba(img.as_raw(), img.width(), img.height());
    let mem = if lossless { enc.encode_lossless() } else { enc.encode(82.0) };
    fs::write(out, &*mem).with_context(|| format!("write {}", out.display()))?;
    Ok(())
}

/// Mip 0 of one array layer as an RGBA image.
fn decode_layer(dds: &image_dds::ddsfile::Dds, layer: u32) -> Result<RgbaImage> {
    let surface = image_dds::Surface::from_dds(dds)?;
    let rgba = surface.decode_layers_mipmaps_rgba8(layer..layer + 1, 0..1)?;
    Ok(rgba.into_image()?)
}

type SheetOut = (BTreeMap<String, AssetRect>, bool, usize, usize, u64);

fn decode_sheet(
    path: &Path,
    file: &str,
    names: &serde_json::Value,
    version: &str,
    web: &Path,
) -> Result<SheetOut> {
    let base = file.strip_suffix(".dds.zst").unwrap_or(file);
    let disabled = base.starts_with("skills-disabled");
    let raw = zstd::decode_all(&fs::read(path)?[..]).context("zstd")?;
    let dds = image_dds::ddsfile::Dds::read(&raw[..]).context("dds header")?;
    let layers = dds.get_num_array_layers();
    let (w, h) = (dds.get_width(), dds.get_height());

    let mut wanted: BTreeMap<u32, Vec<String>> = BTreeMap::new();
    for (name, idx) in names.as_object().into_iter().flatten() {
        if let Some(i) = idx.as_u64() {
            if i >= 1 && (i as u32) <= layers {
                wanted.entry(i as u32 - 1).or_default().push(name.clone());
            }
        }
    }

    let mut rects = BTreeMap::new();
    let mut decoded = 0usize;
    let mut files = 0usize;
    let mut bytes = 0u64;

    if w.max(h) <= 256 {
        let cols = (layers as f64).sqrt().ceil().max(1.0) as u32;
        let rows = layers.div_ceil(cols);
        let mut atlas = RgbaImage::new(cols * w, rows * h);
        for (layer, layer_names) in &wanted {
            let img = decode_layer(&dds, *layer).with_context(|| format!("layer {layer}"))?;
            let (cx, cy) = ((layer % cols) * w, (layer / cols) * h);
            image::imageops::replace(&mut atlas, &img, cx as i64, cy as i64);
            decoded += 1;
            let file = format!("TreeData/{version}/web/{base}.webp");
            for name in layer_names {
                rects.insert(name.clone(), AssetRect { file: file.clone(), x: cx, y: cy, w, h, ow: w, oh: h });
            }
        }
        let out = web.join(format!("{base}.webp"));
        save_webp(&atlas, &out, true)?;
        files += 1;
        bytes += fs::metadata(&out)?.len();
    } else {
        let dir = web.join(base);
        fs::create_dir_all(&dir)?;
        // Backgrounds are drawn large but soft; many-layer sheets get a tighter cap.
        let max_dim: u32 = if layers > 16 { 512 } else { 1024 };
        for (layer, layer_names) in &wanted {
            let mut img = decode_layer(&dds, *layer).with_context(|| format!("layer {layer}"))?;
            let (ow, oh) = (img.width(), img.height());
            if ow.max(oh) > max_dim {
                let s = max_dim as f64 / ow.max(oh) as f64;
                let nw = ((ow as f64 * s).round() as u32).max(1);
                let nh = ((oh as f64 * s).round() as u32).max(1);
                img = image::imageops::resize(&img, nw, nh, FilterType::Triangle);
            }
            let out = dir.join(format!("{layer}.webp"));
            save_webp(&img, &out, false)?;
            decoded += 1;
            files += 1;
            bytes += fs::metadata(&out)?.len();
            let file = format!("TreeData/{version}/web/{base}/{layer}.webp");
            for name in layer_names {
                rects.insert(
                    name.clone(),
                    AssetRect { file: file.clone(), x: 0, y: 0, w: img.width(), h: img.height(), ow, oh },
                );
            }
        }
    }

    Ok((rects, disabled, decoded, files, bytes))
}

/// PoE1's sheets are plain PNG/JPG/WebP atlases whose rects are listed in
/// `sprites.lua`, so the manifest is a transcription: copy each sheet as it is
/// and key every rect by the icon path or asset name PoB uses. The `*Inactive`
/// sections are the greyscale icon variants.
pub fn build_sprites(src_tree: &Path, dest_tree: &Path, version: &str) -> Result<AssetStats> {
    let sprites = crate::lua_json::eval_file(&src_tree.join("sprites.lua"))?;
    let web = dest_tree.join("web");
    if web.exists() {
        fs::remove_dir_all(&web)?;
    }
    fs::create_dir_all(&web)?;

    let mut manifest = Manifest { version: version.to_string(), ..Default::default() };
    let mut stats = AssetStats::default();
    let Some(sections) = sprites.get("sprites").and_then(|v| v.as_object()) else {
        anyhow::bail!("sprites.lua has no sprites table");
    };
    let mut copied: BTreeMap<String, u64> = BTreeMap::new();
    // A bloodline sheet repeats the ascendancy frame names with its own art.
    // PoB registers them as "<Ascendancy><Asset>" (PassiveTree.lua
    // bloodlineSpriteTypes); one sheet can serve several ascendancies.
    let bloodline_prefixes = |section: &str| -> Vec<&'static str> {
        match section {
            "trialmasterBloodline" => vec!["Trialmaster"],
            "oshabiBloodline" => vec!["Oshabi"],
            "olrothBloodline" => vec!["Olroth"],
            "lyciaBloodline" => vec!["Lycia"],
            "kingInTheMistsBloodline" => vec!["KingInTheMists"],
            "farrulBloodline" => vec!["Farrul"],
            "deliriousBloodline" => vec!["Delirious"],
            "catarinaBloodline" => vec!["Catarina"],
            "breachlordBloodline" => vec!["Breachlord"],
            "aulBloodline" => vec!["Aul"],
            "azmeriBloodline" => vec!["Azmeri", "Warden", "Warlock", "Primalist"],
            "abyssalBloodline" => vec!["Abyssal"],
            "brinerotBloodline" => vec!["Brinerot"],
            "necromanticBloodline" => vec!["Necromantic"],
            _ => Vec::new(),
        }
    };
    for (section, sheet) in sections {
        let Some(filename) = sheet.get("filename").and_then(|v| v.as_str()) else { continue };
        // "https://web.poecdn.com/image/passive-skill/skills-3.jpg?1540b3b6" -> "skills-3.jpg"
        let basename = filename.rsplit('/').next().unwrap_or(filename).split('?').next().unwrap_or(filename);
        let src = src_tree.join(basename);
        if !src.is_file() {
            stats.skipped.push(format!("{section}: {basename} missing"));
            continue;
        }
        if !copied.contains_key(basename) {
            let out = web.join(basename);
            fs::copy(&src, &out).with_context(|| format!("copy {}", src.display()))?;
            let len = fs::metadata(&out)?.len();
            copied.insert(basename.to_string(), len);
            stats.files += 1;
            stats.bytes += len;
        }
        stats.sheets += 1;
        let file = format!("TreeData/{version}/web/{basename}");
        let target = if section.ends_with("Inactive") { &mut manifest.disabled } else { &mut manifest.assets };
        let num = |r: &serde_json::Value, k: &str| r.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0).round() as u32;
        let prefixes = bloodline_prefixes(section);
        for (name, rect) in sheet.get("coords").and_then(|v| v.as_object()).into_iter().flatten() {
            let (w, h) = (num(rect, "w"), num(rect, "h"));
            let r = AssetRect { file: file.clone(), x: num(rect, "x"), y: num(rect, "y"), w, h, ow: w, oh: h };
            // Plates ("ClassesAul") keep their own names; frames are prefixed
            // so they do not replace the regular ones from frame-3.png.
            if prefixes.is_empty() || name.starts_with("Classes") {
                target.insert(name.clone(), r);
            } else {
                for p in &prefixes {
                    target.insert(format!("{p}{name}"), r.clone());
                }
            }
            stats.layers += 1;
        }
    }
    // Standalone images PoB loads outside the sheets: the class illustrations
    // beside the version folders (LoadImage checks TreeData/ first) and the
    // jewel radius rings PassiveTreeView.lua opens by path.
    let src_root = src_tree.parent().and_then(Path::parent).unwrap_or(src_tree);
    let mut standalone: Vec<(String, String)> = Vec::new();
    for name in ["BackgroundStr", "BackgroundDex", "BackgroundInt", "BackgroundStrDex", "BackgroundStrInt", "BackgroundDexInt"] {
        standalone.push((name.to_string(), format!("TreeData/{name}.png")));
    }
    for name in ["EternalEmpire", "Karui", "Maraketh", "Templar", "Vaal", "Kalguuran"] {
        for i in 1..=2 {
            standalone.push((format!("{name}JewelCircle{i}"), format!("TreeData/PassiveSkillScreen{name}JewelCircle{i}.png")));
        }
    }
    standalone.extend(ring_entries());
    // Timeless jewel node art lives in its own sheets (PassiveTree.lua loads
    // TreeData/legion/tree-legion.lua): icon types as zoom-level arrays, plus
    // treeAssets for the Abyss frames.
    let legion_dir = src_root.join("TreeData").join("legion");
    let legion_table = legion_dir.join("tree-legion.lua");
    if legion_table.is_file() {
        let legion = crate::lua_json::eval_file(&legion_table)?;
        let mut sheets: Vec<(&str, &serde_json::Value)> = Vec::new();
        for (kind, entries) in legion.as_object().into_iter().flatten() {
            if kind == "treeAssets" {
                for e in entries.as_array().into_iter().flatten() {
                    sheets.push((kind, e));
                }
            } else if let Some(last) = entries.as_array().and_then(|a| a.last()) {
                sheets.push((kind, last));
            }
        }
        for (kind, sheet) in sheets {
            let Some(filename) = sheet.get("filename").and_then(|v| v.as_str()) else { continue };
            let src = legion_dir.join(filename);
            if !src.is_file() {
                stats.skipped.push(format!("legion: {filename} missing"));
                continue;
            }
            let basename = format!("legion-{filename}");
            if !copied.contains_key(&basename) {
                let out = web.join(&basename);
                fs::copy(&src, &out).with_context(|| format!("copy {}", src.display()))?;
                let len = fs::metadata(&out)?.len();
                copied.insert(basename.clone(), len);
                stats.files += 1;
                stats.bytes += len;
            }
            stats.sheets += 1;
            let file = format!("TreeData/{version}/web/{basename}");
            let target = if kind.ends_with("Inactive") { &mut manifest.disabled } else { &mut manifest.assets };
            let num = |r: &serde_json::Value, k: &str| r.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0).round() as u32;
            for (name, rect) in sheet.get("coords").and_then(|v| v.as_object()).into_iter().flatten() {
                let (w, h) = (num(rect, "w"), num(rect, "h"));
                target.insert(name.clone(), AssetRect { file: file.clone(), x: num(rect, "x"), y: num(rect, "y"), w, h, ow: w, oh: h });
                stats.layers += 1;
            }
        }
    }
    copy_standalone(src_root, &web, version, &standalone, &mut manifest, &mut stats)?;
    fs::write(web.join("manifest.json"), serde_json::to_vec_pretty(&manifest)?)?;
    Ok(stats)
}

/// The jewel radius rings PassiveTreeView.lua opens from Assets/ in both games.
fn ring_entries() -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = ["ShadedOuterRing", "ShadedOuterRingFlipped", "ShadedInnerRing", "ShadedInnerRingFlipped"]
        .iter()
        .map(|name| (name.to_string(), format!("Assets/{name}.png")))
        .collect();
    v.push(("JewelRing".to_string(), "Assets/ring.png".to_string()));
    v
}

/// Copies images PoB opens by path (not sheet rects) into `web/` and keys them
/// by name; `entries` are (asset name, path relative to the PoB source root).
fn copy_standalone(src_root: &Path, web: &Path, version: &str, entries: &[(String, String)], manifest: &mut Manifest, stats: &mut AssetStats) -> Result<()> {
    for (name, rel) in entries {
        let src = src_root.join(rel);
        if !src.is_file() {
            stats.skipped.push(format!("{rel} missing"));
            continue;
        }
        let (w, h) = image::image_dimensions(&src).with_context(|| format!("read {}", src.display()))?;
        let basename = format!("{name}.png");
        let out = web.join(&basename);
        if !out.is_file() {
            fs::copy(&src, &out).with_context(|| format!("copy {}", src.display()))?;
            stats.files += 1;
            stats.bytes += fs::metadata(&out)?.len();
        }
        let file = format!("TreeData/{version}/web/{basename}");
        manifest.assets.insert(name.clone(), AssetRect { file, x: 0, y: 0, w, h, ow: w, oh: h });
    }
    Ok(())
}
