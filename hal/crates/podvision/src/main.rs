//! `podvision` — core's native pod-state runner (#191). One still in, one JSON
//! object out, then it exits; core runs it at `nice` 19 under a timeout and
//! falls back to its TypeScript runner when it fails.
//!
//! Exit codes: 0 scored (or found the still dark or damaged), 1 a bad still,
//! weights file or request, 2 usage.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use podvision::cnn::Model;
use podvision::image::{Rect, Scale};

#[derive(Parser)]
#[command(
    name = "podvision",
    version,
    about = "Score a still's pods with seedypod-cnn weights files; prints JSON"
)]
struct Args {
    /// The still: a JPEG, or a binary PPM (P6). `-` reads it from stdin.
    #[arg(long, default_value = "-")]
    image: String,
    /// Pod boxes as fractions of the frame: {"1":{"x":0.1,"y":0.2,"w":0.1,"h":0.1},…}
    #[arg(long)]
    pods: String,
    /// A pod-state weights file to run, as ID=PATH. Repeat for each revision.
    #[arg(
        long = "model",
        value_name = "ID=PATH",
        required_unless_present = "codes",
        conflicts_with = "codes"
    )]
    models: Vec<String>,
    /// Read each pod's yCube dot code from a full-size pod-ID still instead (#224).
    #[arg(long)]
    codes: bool,
    /// Decode scale: auto (from the crops), or 1, 2, 4 or 8.
    #[arg(long, default_value = "auto")]
    scale: String,
}

fn main() {
    let args = Args::parse();
    if let Err(e) = run(args) {
        eprintln!("podvision: {e:#}");
        std::process::exit(1);
    }
}

/// The still from a path, or stdin for `-`.
fn read_still(image: &str) -> Result<Vec<u8>> {
    if image == "-" {
        let mut b = Vec::new();
        std::io::stdin()
            .read_to_end(&mut b)
            .context("can't read the still from stdin")?;
        Ok(b)
    } else {
        std::fs::read(image).with_context(|| format!("can't read {image}"))
    }
}

fn run(args: Args) -> Result<()> {
    let scale = match args.scale.as_str() {
        "auto" => Scale::Auto,
        "1" | "2" | "4" | "8" => Scale::Fixed(args.scale.parse()?),
        other => bail!("--scale must be auto, 1, 2, 4 or 8, not {other}"),
    };
    let pods: BTreeMap<String, Rect> =
        serde_json::from_str(&args.pods).context("--pods is not a JSON object of boxes")?;
    let pods = pods
        .into_iter()
        .map(|(slot, r)| {
            Ok((
                slot.parse::<u32>()
                    .map_err(|_| anyhow!("pod slot {slot} is not a number"))?,
                r,
            ))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;
    if args.codes {
        let out = podvision::read_codes(&read_still(&args.image)?, &pods)?;
        let mut stdout = std::io::stdout().lock();
        serde_json::to_writer(&mut stdout, &out)?;
        writeln!(stdout)?;
        return Ok(());
    }
    let mut models = Vec::with_capacity(args.models.len());
    for m in &args.models {
        let (id, path) = m
            .split_once('=')
            .ok_or_else(|| anyhow!("--model takes ID=PATH, not {m}"))?;
        let path = PathBuf::from(path);
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("model {id}: can't read {}", path.display()))?;
        let model = Model::parse(&text).with_context(|| format!("model {id} ({})", path.display()))?;
        models.push((id.to_string(), model));
    }
    let out = podvision::run(&read_still(&args.image)?, &pods, &models, scale)?;
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &out)?;
    writeln!(stdout)?;
    Ok(())
}
